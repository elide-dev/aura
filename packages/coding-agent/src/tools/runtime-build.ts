import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import runtimeBuildDescription from "../prompts/tools/runtime-build.md" with { type: "text" };
import { execResultFailed, formatExecResult } from "../runtime/format";
import type { RuntimeExecResult } from "../runtime/protocol";
import type { ToolSession } from ".";

const runtimeBuildSchema = type({
	"targets?": type("string[]").describe(
		"':'-prefixed build targets with interleaved options, passed through verbatim",
	),
	"cwd?": type("string").describe("project directory (defaults to the session cwd)"),
	"timeoutMs?": type("number").describe("kill the build after this many milliseconds"),
});

export type RuntimeBuildToolParams = typeof runtimeBuildSchema.infer;

export class RuntimeBuildTool implements AgentTool<typeof runtimeBuildSchema, RuntimeExecResult> {
	readonly name = "build";
	readonly approval = "exec" as const;
	readonly label = "Build";
	readonly description = runtimeBuildDescription;
	readonly parameters = runtimeBuildSchema;
	readonly strict = true;
	readonly loadMode = "essential" as const;
	readonly summary = "Assemble project artifacts on the managed runtime";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): RuntimeBuildTool | null {
		if (!session.settings.get("runtime.enabled")) return null;
		return new RuntimeBuildTool(session);
	}

	async execute(
		_toolCallId: string,
		params: RuntimeBuildToolParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<RuntimeExecResult>> {
		const service = this.session.getRuntimeService?.();
		if (!service)
			throw new Error(
				"The runtime service is unavailable on this session (runtime.enabled may be false, or this host does not provide it).",
			);
		const result = await service.build(
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
