/**
 * TUI renderers for the runtime tool family (`run`, `check`, `insights`,
 * `profile`, the four specialized `jvm_*` flows, and hub-backed `serve`).
 *
 * These are deliberately *thin*. The house style for an exec-shaped tool is a
 * status line plus a short output preview (`glob`, `hub`), and everything that
 * would make a runtime frame bulky is already someone else's job: the central
 * artifact spill (`tools/output-meta.ts`) owns truncation and hands back an
 * `artifact://` reference, and `formatExecResult` has already composed the
 * stdout/stderr body the model reads. So a renderer here only has to answer
 * two questions a user scanning the transcript actually asks — *what was
 * invoked* on the call line, and *how did it end* on the result line — and let
 * the shared preview machinery handle the rest.
 *
 * One factory drives all eleven because the result shapes collapse to three:
 * `RuntimeExecResult` (exit code / duration / killed), `RuntimeJvmResult` (that
 * plus the flow's phase and what it produced), and `RuntimeJobDetails` (an
 * endpoint and a hub job handle). Per-tool differences are declarative
 * `describeCall` / `describeResult` functions, which keeps a new runtime tool's
 * renderer a data change rather than another copy of this file.
 *
 * Naming rule: nothing rendered here names the runtime binary. Frames say the
 * tool's own label ("Run", "JVM Jar") or "the runtime".
 */

import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { getProjectDir, isRecord } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import type { RuntimeExecResult, RuntimeJvmResult } from "../runtime/protocol";
import { renderStatusLine, truncateToWidth } from "../tui";
import { formatStyledTruncationWarning, type OutputMeta, stripOutputNotice } from "./output-meta";
import {
	capPreviewLines,
	createCachedComponent,
	formatToolWorkingDirectory,
	replaceTabs,
	shortenPath,
} from "./render-utils";
import type { ToolRenderer } from "./renderers";
import type { RuntimeJobDetails } from "./runtime-launch";

/** Collapsed preview height. The spill already bounds the text; this bounds the frame. */
const COLLAPSED_OUTPUT_LINES = 6;

type WithMeta<T> = T & { meta?: OutputMeta };
type ExecDetails = WithMeta<RuntimeExecResult>;
type JvmDetails = WithMeta<RuntimeJvmResult>;
type JobDetails = WithMeta<RuntimeJobDetails>;
type AnyDetails = ExecDetails | JvmDetails | JobDetails;

/** What a spec contributes to one status line. `meta` entries may be pre-styled. */
interface Frame {
	description?: string;
	meta?: (string | undefined)[];
}

interface RuntimeRendererSpec {
	/** Header title — the tool's own label, never the runtime binary's name. */
	title: string;
	/** The invocation, as it reads before a result exists. */
	describeCall: (args: Args) => Frame;
	/**
	 * The invocation plus whatever the result uniquely revealed (a resolved main
	 * class, a written path, the phase a flow stopped at). Defaults to
	 * {@link describeCall} so a tool whose result adds nothing stays a one-liner.
	 */
	describeResult?: (details: AnyDetails | undefined, args: Args, uiTheme: Theme) => Frame;
	/**
	 * Append a `passed` / `failed` verdict to the result line. For `check`,
	 * whose whole purpose is the verdict, an exit code alone makes the reader
	 * do the translation.
	 */
	passFail?: boolean;
	/** Result details are a hub job descriptor, not an exec result. */
	job?: boolean;
}

// ── argument access ──────────────────────────────────────────────────────────
// Renderers receive whatever the model streamed, including half-parsed objects,
// so every read is defensive: a malformed call must render a plain frame, never
// throw inside a repaint.

type Args = Record<string, unknown> | undefined;

const asArgs = (args: unknown): Args => (isRecord(args) ? args : undefined);
const str = (args: Args, key: string): string | undefined => {
	const value = args?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
};
const num = (args: Args, key: string): number | undefined => {
	const value = args?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

/** `run`/`insights`/`profile` all take either inline source or an existing file. */
function describeSource(args: Args): string {
	const filePath = str(args, "path");
	return filePath ? shortenPath(filePath) : "inline";
}

// ── result summaries ─────────────────────────────────────────────────────────

/**
 * Narrow a settled result's `details` for rendering. The declared type is the
 * union of the three runtime detail shapes, but a renderer must also survive
 * details it did not produce (a framework-generated error, a replayed
 * transcript from an older build), so the shape is asserted here and every
 * field read downstream goes through a guard rather than trusting it.
 */
function toDetails(details: unknown): AnyDetails | undefined {
	return isRecord(details) ? (details as unknown as AnyDetails) : undefined;
}

function isExecDetails(details: AnyDetails | undefined): details is ExecDetails {
	return details !== undefined && typeof (details as ExecDetails).exitCode === "number";
}

function isJobDetails(details: AnyDetails | undefined): details is JobDetails {
	return details !== undefined && typeof (details as JobDetails).jobName === "string";
}

function formatDuration(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** How the invocation ended: killed, non-zero exit, and how long it took. */
function execMeta(details: ExecDetails | undefined): (string | undefined)[] {
	if (!details) return [];
	return [
		details.killed ? "killed" : undefined,
		details.exitCode !== 0 ? `exit ${details.exitCode}` : undefined,
		typeof details.durationMs === "number" ? formatDuration(details.durationMs) : undefined,
	];
}

function execSucceeded(details: AnyDetails | undefined, isError: boolean): boolean {
	if (isError) return false;
	if (isExecDetails(details)) return details.exitCode === 0 && !details.killed;
	return true;
}

// ── shared frame rendering ───────────────────────────────────────────────────

function metaOf(frame: Frame): string[] {
	return (frame.meta ?? []).filter((value): value is string => value !== undefined && value.length > 0);
}

/**
 * Drop the exit/killed annotations `formatExecResult` bakes into the body. They
 * exist for the model, which sees only the text; the header already states both,
 * and printing them twice is what makes a two-line frame read as noise. Mirrors
 * `bash`'s `stripExitCodeNotice` — matched against *this* result's values so a
 * program that legitimately printed `(exit code 1)` on a clean exit keeps it.
 */
function stripExecNotices(text: string, details: AnyDetails | undefined): string {
	if (!isExecDetails(details)) return text;
	const notices = [
		`(no output, exit code ${details.exitCode})`,
		`(exit code ${details.exitCode})`,
		"(process was killed: timeout or cancellation)",
	];
	let out = text.trimEnd();
	let stripped = true;
	while (stripped) {
		stripped = false;
		for (const notice of notices) {
			if (out.endsWith(notice)) {
				out = out.slice(0, -notice.length).trimEnd();
				stripped = true;
			}
		}
	}
	return out;
}

/**
 * The output body: the tool's own text, minus the notice the spill appended
 * (the styled warning below re-states it), tail-capped, with the artifact
 * reference kept — the same head/tail-plus-artifact presentation `bash` gives.
 */
function outputBody(
	text: string,
	details: AnyDetails | undefined,
	uiTheme: Theme,
	width: number,
	expanded: boolean,
): string[] {
	const stripped = stripExecNotices(stripOutputNotice(text, details?.meta), details);
	const lines = stripped
		? stripped.split("\n").map(line => uiTheme.fg("toolOutput", truncateToWidth(replaceTabs(line), width)))
		: [];
	const capped = capPreviewLines(lines, uiTheme, { expanded, max: COLLAPSED_OUTPUT_LINES });
	const warning = formatStyledTruncationWarning(details?.meta, uiTheme);
	return warning ? [...capped, warning] : capped;
}

export function createRuntimeToolRenderer(spec: RuntimeRendererSpec): ToolRenderer {
	return {
		inline: true,
		animatedPendingPreview: true,
		// The result header restates the call line in full, so keeping the pending
		// call painted above it would double every runtime row (`hub` merges for
		// the same reason).
		mergeCallAndResult: true,

		renderCall(rawArgs: unknown, options: RenderResultOptions, uiTheme: Theme): Component {
			const frame = spec.describeCall(asArgs(rawArgs));
			const line = renderStatusLine(
				{
					icon: options.spinnerFrame !== undefined ? "running" : "pending",
					spinnerFrame: options.spinnerFrame,
					title: spec.title,
					titleColor: "toolTitle",
					description: frame.description,
					meta: metaOf(frame),
				},
				uiTheme,
			);
			return new Text(line, 1, 0);
		},

		renderResult(
			result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
			options: RenderResultOptions,
			uiTheme: Theme,
			rawArgs?: unknown,
		): Component {
			const args = asArgs(rawArgs);
			const details = toDetails(result.details);
			const isPartial = options.isPartial === true;
			const success = !isPartial && execSucceeded(details, result.isError === true);
			// `describeCall` takes only args; the default result frame is the call
			// frame, so the arities must be bridged rather than the functions swapped.
			const frame = spec.describeResult ? spec.describeResult(details, args, uiTheme) : spec.describeCall(args);

			const meta = metaOf(frame);
			if (spec.passFail && !isPartial) {
				meta.push(success ? uiTheme.fg("success", "passed") : uiTheme.fg("error", "failed"));
			}
			if (!spec.job) meta.push(...metaOf({ meta: execMeta(isExecDetails(details) ? details : undefined) }));

			// A job that launched but printed no endpoint inside the wait window is
			// neither a success nor an error: the process may be running fine behind
			// a changed banner. Warn, so the row does not read as clean when the one
			// thing the caller wanted — the endpoint — is missing.
			// A launch hub rejected outright still arrives endpoint-less, and that IS
			// an error (`runtimeJobResult` sets `isError`), so it must not be softened.
			const unscrapedJob =
				spec.job === true && result.isError !== true && isJobDetails(details) && details.endpoint === undefined;

			const header = renderStatusLine(
				{
					icon: isPartial ? "pending" : unscrapedJob ? "warning" : success ? "done" : "error",
					spinnerFrame: isPartial ? options.spinnerFrame : undefined,
					title: spec.title,
					titleColor: "toolTitle",
					description: frame.description,
					meta,
				},
				uiTheme,
			);

			const text = result.content?.find(block => block.type === "text")?.text ?? "";
			return createCachedComponent(
				() => options.expanded === true,
				(width, expanded) => [header, ...outputBody(text, details, uiTheme, width, expanded)],
				{ paddingX: 1 },
			);
		},
	};
}

// ── per-tool specs ───────────────────────────────────────────────────────────

/** `describeResult` for the JVM flows: what the flow resolved, and where it stopped. */
function jvmResultFrame(fallback: (args: Args) => Frame) {
	return (details: AnyDetails | undefined, args: Args): Frame => {
		const jvm = details as JvmDetails | undefined;
		const base = fallback(args);
		if (!jvm) return base;
		const stoppedEarly = jvm.phase !== undefined && jvm.phase !== jvm.action && jvm.exitCode !== 0;
		const written = jvm.output ?? jvm.jar;
		return {
			description: (written ? shortenPath(written) : undefined) ?? jvm.className ?? base.description,
			meta: [...(base.meta ?? []), stoppedEarly ? `stopped at ${jvm.phase}` : undefined],
		};
	};
}

/** `describeResult` for the supervised static-server tool. */
function jobResultFrame(fallback: (args: Args) => Frame) {
	return (details: AnyDetails | undefined, args: Args): Frame => {
		if (!isJobDetails(details)) return fallback(args);
		const target = fallback(args).description;
		return {
			description: details.endpoint ?? "no endpoint",
			meta: [target, details.jobName, details.timedOut ? "timed out" : undefined, details.state],
		};
	};
}

const runCallFrame = (args: Args): Frame => ({
	description: describeSource(args),
	meta: [str(args, "language") ?? (str(args, "path") ? undefined : "ts"), str(args, "engine"), str(args, "mainClass")],
});

const serveCallFrame = (args: Args): Frame => {
	const port = num(args, "port");
	return {
		description: str(args, "directory") ?? ".",
		meta: [port !== undefined ? `port ${port}` : undefined],
	};
};

const jvmRunCallFrame = (args: Args): Frame => ({
	description: str(args, "mainClass") ?? str(args, "language"),
	meta: [str(args, "mainClass") ? str(args, "language") : undefined],
});

const jvmJarCallFrame = (args: Args): Frame => {
	const action = str(args, "action");
	const target = action === "inspect" ? str(args, "jar") : (str(args, "output") ?? str(args, "mainClass"));
	return {
		description: target ? shortenPath(target) : str(args, "language"),
		meta: [action],
	};
};

const jvmDepsCallFrame = (args: Args): Frame => {
	const target = str(args, "path");
	return {
		description: target ? shortenPath(target) : (str(args, "mainClass") ?? str(args, "language") ?? "inline"),
		meta: [],
	};
};

const RUNTIME_RENDERER_SPECS: Record<string, RuntimeRendererSpec> = {
	run: { title: "Run", describeCall: runCallFrame, describeResult: jvmResultFrame(runCallFrame) },

	check: {
		title: "Check",
		passFail: true,
		describeCall: args => ({
			description: formatToolWorkingDirectory(str(args, "cwd"), getProjectDir()) ?? "project",
		}),
	},

	insights: {
		title: "Insights",
		describeCall: args => {
			const insightPath = str(args, "insightPath");
			return {
				description: describeSource(args),
				meta: [insightPath ? shortenPath(insightPath) : str(args, "insight") ? "inline insight" : undefined],
			};
		},
	},

	profile: {
		title: "Profile",
		describeCall: args => ({ description: describeSource(args), meta: [str(args, "mode")] }),
	},

	jvm_disassemble: {
		title: "JVM Disassemble",
		describeCall: jvmRunCallFrame,
		describeResult: jvmResultFrame(jvmRunCallFrame),
	},

	jvm_format: {
		title: "JVM Format",
		describeCall: args => ({ description: str(args, "language") }),
		describeResult: jvmResultFrame(args => ({ description: str(args, "language") })),
	},

	jvm_jar: { title: "JVM Jar", describeCall: jvmJarCallFrame, describeResult: jvmResultFrame(jvmJarCallFrame) },

	jvm_deps: { title: "JVM Deps", describeCall: jvmDepsCallFrame, describeResult: jvmResultFrame(jvmDepsCallFrame) },

	serve: {
		title: "Serve",
		job: true,
		describeCall: serveCallFrame,
		describeResult: jobResultFrame(serveCallFrame),
	},
};

/** Renderer-registry entries for the runtime tool family, keyed by tool name. */
export const runtimeToolRenderers: Record<string, ToolRenderer> = Object.fromEntries(
	Object.entries(RUNTIME_RENDERER_SPECS).map(([name, spec]) => [name, createRuntimeToolRenderer(spec)]),
);

/** The tool names this module renders. Pinned by the renderer coverage test. */
export const RUNTIME_RENDERER_TOOL_NAMES: readonly string[] = Object.keys(RUNTIME_RENDERER_SPECS);
