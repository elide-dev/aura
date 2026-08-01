import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import runtimeProfileDescription from "../prompts/tools/runtime-profile.md" with { type: "text" };
import { execResultFailed, formatExecResult } from "../runtime/format";
import type { RuntimeExecResult } from "../runtime/protocol";
import type { ToolSession } from ".";

const runtimeProfileSchema = type({
	mode: type("'cputracing' | 'cpusampling'").describe("profiler mode"),
	"code?": type("string").describe("inline program source (mutually exclusive with path)"),
	"path?": type("string").describe("existing program file"),
	"language?": type("'js' | 'ts' | 'python'").describe("program language (default ts for inline code)"),
	"args?": type("string[]").describe("arguments passed to the program"),
	"stdin?": type("string").describe("data piped to stdin"),
	"timeoutMs?": type("number").describe("kill the run after this many milliseconds"),
	"cwd?": type("string").describe("working directory (defaults to the session cwd)"),
});

export type RuntimeProfileToolParams = typeof runtimeProfileSchema.infer;

export class RuntimeProfileTool implements AgentTool<typeof runtimeProfileSchema, RuntimeExecResult> {
	readonly name = "profile";
	readonly approval = "exec" as const;
	readonly label = "Profile";
	readonly description = runtimeProfileDescription;
	readonly parameters = runtimeProfileSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Profile a program (cpu tracing or sampling)";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): RuntimeProfileTool | null {
		if (!session.settings.get("runtime.enabled")) return null;
		return new RuntimeProfileTool(session);
	}

	async execute(
		_toolCallId: string,
		params: RuntimeProfileToolParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<RuntimeExecResult>> {
		const service = this.session.getRuntimeService?.();
		if (!service)
			throw new Error(
				"The runtime service is unavailable on this session (runtime.enabled may be false, or this host does not provide it).",
			);
		const result = await service.profile(
			{ ...params, cwd: params.cwd ?? this.session.cwd },
			signal,
			this.session.getSessionId?.() ?? undefined,
		);
		return {
			content: [{ type: "text", text: formatExecResult(result) }],
			details: result,
			isError: execResultFailed(result),
		};
	}
}
