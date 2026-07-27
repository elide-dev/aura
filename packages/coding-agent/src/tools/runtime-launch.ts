/**
 * Shared plumbing for the two long-running runtime flows (`runtime_debug`,
 * `serve`).
 *
 * The split of responsibility is deliberate. `runtime/spawn` composes a launch
 * descriptor — argv, cwd, an environment overlay, and the rules for recognizing
 * the endpoint the process prints — and owns no lifecycle. The `hub` supervisor
 * owns the lifecycle: session-scoped names, log capture, readiness, `stop`,
 * `restart`, `describe`. So these tools hold no process map of their own; the
 * handle they return is a hub job name, which means `hub logs`, `hub stop`, and
 * `/jobs` work on a debugger or a static server for free, and there is no second
 * process registry to keep honest.
 */

import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { DaemonState } from "../launch/protocol";
import type { RuntimeEndpointRule, RuntimeLaunchDescriptor } from "../runtime/protocol";
import type { ToolSession } from ".";
import { executeLaunch } from "./hub/launch";

/** Injection seam for tests: the hub operation these tools drive. */
export type LaunchExecutor = typeof executeLaunch;

/** Seconds to watch the startup output for an endpoint before reporting back. */
export const DEFAULT_ENDPOINT_WAIT_SECONDS = 15;
const MAX_ENDPOINT_WAIT_SECONDS = 300;

/**
 * Startup lines read back for scraping and for the no-endpoint fallback. hub's
 * log stream merges stdout and stderr, which matters: the runtime prints its
 * `serve` banner on stderr, so scraping a single pipe would silently never match.
 */
const STARTUP_LOG_LINES = 200;

/**
 * Trailing status marker `toolContent` appends to a hub `logs` result
 * (`[name: running; cursor=123]`). Stripped so the startup output the model
 * sees is the process's own output and nothing else.
 */
const HUB_LOG_STATUS_SUFFIX = /\n?\[[^\n\]]*\]\s*$/;

export interface RuntimeJobDetails {
	mode: "debug" | "serve";
	/** The hub job name — the handle for `hub logs` / `hub stop` / `hub restart`. */
	jobName: string;
	/** The scraped endpoint, absent when the wait window closed first. */
	endpoint?: string;
	/** Lifecycle state as of the readiness wait returning. */
	state?: DaemonState;
	/** True when the wait window closed without an endpoint — not an error by itself. */
	timedOut: boolean;
	/** Captured startup output, ANSI-stripped. */
	startupOutput: string;
	/** The composed command line, for diagnosing a banner change. */
	argv: string[];
	cwd: string;
}

export interface StartRuntimeJobOptions {
	/** Prefix for the minted job name; the suffix keeps concurrent jobs distinct. */
	namePrefix: string;
	mode: "debug" | "serve";
	waitSeconds?: number;
	signal?: AbortSignal;
	/** Tests supply a stub; production uses the real hub operation. */
	launch?: LaunchExecutor;
}

export interface StartedRuntimeJob {
	details: RuntimeJobDetails;
	/** True when hub reported the process failed to launch at all. */
	failed: boolean;
	/** hub's own summary of the start, used verbatim when the launch failed. */
	launchSummary: string;
}

/** Clamp a caller-supplied wait window into a range a tool call can afford to hold. */
export function resolveWaitSeconds(waitSeconds: number | undefined): number {
	if (waitSeconds === undefined || !Number.isFinite(waitSeconds)) return DEFAULT_ENDPOINT_WAIT_SECONDS;
	return Math.min(MAX_ENDPOINT_WAIT_SECONDS, Math.max(1, Math.round(waitSeconds)));
}

/**
 * Apply the descriptor's rules to captured output and return the first endpoint
 * found. Rules are tried in order; `group` selects a capture and `prefix` adds a
 * scheme when the runtime printed a bare `host:port`. An unparseable rule is
 * skipped rather than thrown: a broken pattern must degrade to "no endpoint
 * scraped, here is the output", never break the launch that already happened.
 */
export function matchRuntimeEndpoint(output: string, rules: readonly RuntimeEndpointRule[]): string | undefined {
	const text = Bun.stripANSI(output);
	for (const rule of rules) {
		let re: RegExp;
		try {
			re = new RegExp(rule.pattern);
		} catch {
			continue;
		}
		const match = re.exec(text);
		if (!match) continue;
		const captured = match[rule.group ?? 0];
		if (!captured) continue;
		// A prefix is a scheme hint, not a rewrite: output that already carries a
		// scheme is passed through as printed.
		const needsPrefix = rule.prefix !== undefined && !/^[a-zA-Z][\w+.-]*:\/\//.test(captured);
		return needsPrefix ? `${rule.prefix}${captured}` : captured;
	}
	return undefined;
}

/** A short, collision-resistant suffix so two concurrent jobs never share a name. */
function mintJobName(prefix: string): string {
	return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * A single hub-facing readiness pattern that matches any of the descriptor's
 * rules, so hub's own readiness wait does the waiting and this tool does not
 * poll. The precise endpoint is still extracted from the captured output by
 * {@link matchRuntimeEndpoint}, because hub reports the matched *line*, not the
 * capture group the caller wants.
 */
function readinessPattern(rules: readonly RuntimeEndpointRule[]): string | undefined {
	const valid = rules.filter(rule => {
		try {
			new RegExp(rule.pattern);
			return true;
		} catch {
			return false;
		}
	});
	if (valid.length === 0) return undefined;
	return valid.map(rule => `(?:${rule.pattern})`).join("|");
}

function textOf(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text")
		.map(item => item.text)
		.join("\n");
}

/**
 * Start a descriptor as a hub job, wait out the endpoint window, and read back
 * the startup output. Never throws on a missing endpoint: the job exists either
 * way, and its name is the only thing the caller needs to inspect or stop it.
 */
export async function startRuntimeJob(
	session: ToolSession,
	descriptor: RuntimeLaunchDescriptor,
	opts: StartRuntimeJobOptions,
): Promise<StartedRuntimeJob> {
	const launch = opts.launch ?? executeLaunch;
	const jobName = mintJobName(opts.namePrefix);
	const waitSeconds = resolveWaitSeconds(opts.waitSeconds);
	const ready = readinessPattern(descriptor.endpointPattern);
	const started = await launch(
		session,
		{
			op: "start",
			name: jobName,
			application: descriptor.argv[0] ?? "",
			args: descriptor.argv.slice(1),
			env: descriptor.env,
			cwd: descriptor.cwd,
			// Pipes, not a PTY: the endpoint banner is scraped from this output, and a
			// PTY interleaves cursor control into it. Nothing here needs stdin.
			pty: false,
			ready: ready === undefined ? undefined : { log: ready, timeout: waitSeconds },
		},
		opts.signal,
	);
	const daemon = started.details?.daemon;
	const failed = daemon?.state === "failed";
	const logs = failed
		? undefined
		: await launch(session, { op: "logs", name: jobName, lines: STARTUP_LOG_LINES, head: true }, opts.signal);
	const startupOutput = Bun.stripANSI((logs === undefined ? "" : textOf(logs)).replace(HUB_LOG_STATUS_SUFFIX, ""));
	const endpoint = matchRuntimeEndpoint(startupOutput, descriptor.endpointPattern);
	return {
		details: {
			mode: opts.mode,
			jobName,
			endpoint,
			state: daemon?.state,
			timedOut: endpoint === undefined,
			startupOutput,
			argv: descriptor.argv,
			cwd: descriptor.cwd,
		},
		failed,
		launchSummary: textOf(started),
	};
}

/** The line every one of these tools ends on: how to look at it and how to stop it. */
export function jobHandleLine(details: RuntimeJobDetails): string {
	const state = details.state === undefined ? "" : ` (state: ${details.state})`;
	return (
		`Job: ${details.jobName}${state} — read its output with hub {op:"logs", name:"${details.jobName}"} ` +
		`and stop it with hub {op:"stop", name:"${details.jobName}"}.`
	);
}

/**
 * The "no endpoint yet" fallback: the job is real and may still be starting, so
 * this reports the handle plus what the process actually printed, which is what
 * makes a changed startup banner diagnosable instead of mysterious.
 */
export function noEndpointReport(subject: string, details: RuntimeJobDetails, waitSeconds: number): string {
	const output = details.startupOutput.trim();
	return [
		`${subject} did not report an endpoint within the wait window (${waitSeconds}s); it may still be starting.`,
		jobHandleLine(details),
		`Startup output:\n${output || "(no output yet)"}`,
	].join("\n");
}

/** Compose the tool result shared by both flows from a body and the job details. */
export function runtimeJobResult(
	body: string,
	job: StartedRuntimeJob,
	descriptor: RuntimeLaunchDescriptor,
): AgentToolResult<RuntimeJobDetails> {
	const lines = [body];
	if (descriptor.shimWarning) lines.push(`Note: ${descriptor.shimWarning}`);
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: job.details,
		...(job.failed ? { isError: true } : {}),
	};
}

/** The body used when hub could not start the process at all. */
export function failedLaunchBody(job: StartedRuntimeJob): string {
	return [job.launchSummary, jobHandleLine(job.details)].join("\n");
}
