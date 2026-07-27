import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import runtimeInsightsDescription from "../prompts/tools/runtime-insights.md" with { type: "text" };
import { formatExecResult } from "../runtime/format";
import type { RuntimeExecResult } from "../runtime/protocol";
import type { ToolSession } from ".";

const runtimeInsightsSchema = type({
	"code?": type("string").describe("inline program source (mutually exclusive with path)"),
	"path?": type("string").describe("existing program file"),
	"insight?": type("string").describe("inline insight instrumentation script (JavaScript)"),
	"insightPath?": type("string").describe("existing insight script path"),
	"language?": type("'js' | 'ts' | 'python'").describe("program language (default ts for inline code)"),
	"args?": type("string[]").describe("arguments passed to the program"),
	"stdin?": type("string").describe("data piped to stdin"),
	"timeoutMs?": type("number").describe("kill the run after this many milliseconds"),
	"cwd?": type("string").describe("working directory (defaults to the session cwd)"),
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
		if (!service) throw new Error("Runtime capabilities are disabled (runtime.enabled = false).");
		const result = await service.insights({ ...params, cwd: params.cwd ?? this.session.cwd }, signal);
		return {
			content: [{ type: "text", text: formatExecResult(result) }],
			details: result,
		};
	}
}
