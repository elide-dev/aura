import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import runtimeDebugDescription from "../prompts/tools/runtime-debug.md" with { type: "text" };
import type { RuntimeDebugProtocol } from "../runtime/protocol";
import type { ToolSession } from ".";
import { requireRuntimeService } from "./jvm-common";
import {
	failedLaunchBody,
	jobHandleLine,
	type LaunchExecutor,
	noEndpointReport,
	type RuntimeJobDetails,
	resolveWaitSeconds,
	runtimeJobResult,
	startRuntimeJob,
} from "./runtime-launch";

const runtimeDebugSchema = type({
	path: type("string").describe("program file to debug"),
	"protocol?": type("'cdp' | 'dap'").describe("debug wire protocol (default cdp — Chrome DevTools)"),
	"language?": type("'js' | 'ts' | 'python'").describe("program language (inferred from the extension)"),
	"args?": type("string[]").describe("arguments passed to the program"),
	"cwd?": type("string").describe("working directory (defaults to the session cwd)"),
	"timeoutMs?": type("number").describe("guest execution timeout in milliseconds"),
	"waitSeconds?": type("number").describe("how long to watch startup output for the endpoint (default 15)"),
});

export type RuntimeDebugToolParams = typeof runtimeDebugSchema.infer;

/** How to use the endpoint, per protocol — the one thing the model cannot infer. */
const ATTACH_HINT: Record<RuntimeDebugProtocol, string> = {
	cdp: "Open it in Chrome DevTools.",
	dap: "Attach a DAP client (for example VS Code).",
};

/**
 * Publish a debug endpoint for a guest program and hand back the hub job that
 * owns it.
 *
 * Named `runtime_debug` rather than `debug`: `debug` is already the built-in
 * interactive stepping debugger this agent drives itself (`DebugTool`), and the
 * two are genuinely different tools — that one steps through code on the agent's
 * behalf, this one starts a server for an *external* debugger to attach to.
 */
export class RuntimeDebugTool implements AgentTool<typeof runtimeDebugSchema, RuntimeJobDetails> {
	readonly name = "runtime_debug";
	readonly approval = "exec" as const;
	readonly label = "Runtime Debug";
	readonly description = runtimeDebugDescription;
	readonly parameters = runtimeDebugSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Start a CDP/DAP debug endpoint for a program, as a hub job";

	constructor(
		private readonly session: ToolSession,
		private readonly launch?: LaunchExecutor,
	) {}

	static createIf(session: ToolSession): RuntimeDebugTool | null {
		if (!session.settings.get("runtime.enabled")) return null;
		return new RuntimeDebugTool(session);
	}

	async execute(
		_toolCallId: string,
		params: RuntimeDebugToolParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<RuntimeJobDetails>> {
		const protocol: RuntimeDebugProtocol = params.protocol ?? "cdp";
		const descriptor = await requireRuntimeService(this.session).spawn(
			{
				mode: "debug",
				path: params.path,
				protocol,
				language: params.language,
				args: params.args,
				timeoutMs: params.timeoutMs,
				cwd: params.cwd ?? this.session.cwd,
			},
			signal,
		);
		const waitSeconds = resolveWaitSeconds(params.waitSeconds);
		const job = await startRuntimeJob(this.session, descriptor, {
			namePrefix: `runtime-debug-${protocol}`,
			mode: "debug",
			waitSeconds,
			signal,
			launch: this.launch,
		});
		if (job.failed) return runtimeJobResult(failedLaunchBody(job), job, descriptor);
		const endpoint = job.details.endpoint;
		const body =
			endpoint === undefined
				? noEndpointReport(`The ${protocol.toUpperCase()} debugger`, job.details, waitSeconds)
				: [
						`${protocol.toUpperCase()} debugger listening at ${endpoint}`,
						`${ATTACH_HINT[protocol]} The program is suspended until a client attaches.`,
						jobHandleLine(job.details),
					].join("\n");
		return runtimeJobResult(body, job, descriptor);
	}
}
