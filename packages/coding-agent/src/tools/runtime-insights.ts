import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import runtimeInsightsDescription from "../prompts/tools/runtime-insights.md" with { type: "text" };
import { execResultFailed, formatExecResult } from "../runtime/format";
import type { RuntimeExecResult } from "../runtime/protocol";
import type { ToolSession } from ".";

const runtimeInsightsSchema = type({
	"code?": type("string").describe("inline program (exclusive with path)"),
	"path?": type("string").describe("existing program file"),
	"insight?": type("string").describe("inline JS instrumentation"),
	"insightPath?": type("string").describe("instrumentation file"),
	"language?": type("'js' | 'ts' | 'python'").describe("inline language (default ts)"),
	"args?": type("string[]").describe("program arguments"),
	"stdin?": type("string").describe("program stdin"),
	"timeoutMs?": type("number").describe("timeout (ms)"),
	"cwd?": type("string").describe("working directory (session cwd)"),
});

export type RuntimeInsightsToolParams = typeof runtimeInsightsSchema.infer;

export class RuntimeInsightsTool implements AgentTool<typeof runtimeInsightsSchema, RuntimeExecResult> {
	readonly name = "insights";
	readonly approval = "exec" as const;
	readonly label = "Insights";
	readonly description = runtimeInsightsDescription;
	readonly parameters = runtimeInsightsSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Run code with instrumentation hooks attached";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): RuntimeInsightsTool | null {
		if (!session.settings.get("runtime.enabled")) return null;
		return new RuntimeInsightsTool(session);
	}

	async execute(
		_toolCallId: string,
		params: RuntimeInsightsToolParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<RuntimeExecResult>> {
		const service = this.session.getRuntimeService?.();
		if (!service)
			throw new Error(
				"The runtime service is unavailable on this session (runtime.enabled may be false, or this host does not provide it).",
			);
		const result = await service.insights(
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
