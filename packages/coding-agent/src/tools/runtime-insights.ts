import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { isEmbeddedPythonEnabled } from "../config/settings";
import runtimeInsightsDescriptionTemplate from "../prompts/tools/runtime-insights.md" with { type: "text" };
import { callRuntime, execResultFailed, formatExecResult, type RuntimeErrorDetails } from "../runtime/format";
import { type RuntimeExecResult, RuntimeRpcError, resolveRunTarget } from "../runtime/protocol";
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

const runtimeInsightsSchemaWithoutPython = type({
	"code?": type("string").describe("inline program (exclusive with path)"),
	"path?": type("string").describe("existing program file"),
	"insight?": type("string").describe("inline JS instrumentation"),
	"insightPath?": type("string").describe("instrumentation file"),
	"language?": type("'js' | 'ts'").describe("inline language (default ts)"),
	"args?": type("string[]").describe("program arguments"),
	"stdin?": type("string").describe("program stdin"),
	"timeoutMs?": type("number").describe("timeout (ms)"),
	"cwd?": type("string").describe("working directory (session cwd)"),
}) as unknown as typeof runtimeInsightsSchema;

export type RuntimeInsightsToolParams = typeof runtimeInsightsSchema.infer;

export class RuntimeInsightsTool
	implements AgentTool<typeof runtimeInsightsSchema, RuntimeExecResult | RuntimeErrorDetails>
{
	readonly name = "insights";
	readonly approval = "exec" as const;
	readonly label = "Insights";
	get description(): string {
		return prompt.render(runtimeInsightsDescriptionTemplate, { python: this.#embeddedPythonEnabled });
	}
	get parameters(): typeof runtimeInsightsSchema {
		return this.#embeddedPythonEnabled ? runtimeInsightsSchema : runtimeInsightsSchemaWithoutPython;
	}
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Run code with instrumentation hooks attached";

	readonly #embeddedPythonEnabled: boolean;

	constructor(private readonly session: ToolSession) {
		this.#embeddedPythonEnabled = isEmbeddedPythonEnabled(session.settings);
	}

	static createIf(session: ToolSession): RuntimeInsightsTool | null {
		if (!session.settings.get("runtime.enabled")) return null;
		return new RuntimeInsightsTool(session);
	}

	async execute(
		_toolCallId: string,
		params: RuntimeInsightsToolParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<RuntimeExecResult | RuntimeErrorDetails>> {
		const service = this.session.getRuntimeService?.();
		if (!service)
			throw new Error(
				"The runtime service is unavailable on this session (runtime.enabled may be false, or this host does not provide it).",
			);
		const target = resolveRunTarget(params);
		if (target.language === "python" && !this.#embeddedPythonEnabled) {
			throw new RuntimeRpcError(
				"invalid-params",
				"Python runtime instrumentation is disabled (python.enabled = false or python.embedded = false).",
			);
		}
		const call = await callRuntime(
			() =>
				service.insights(
					{ ...params, cwd: params.cwd ?? this.session.cwd },
					signal,
					this.session.getSessionId?.() ?? undefined,
				),
			{ root: this.session.cwd },
		);
		if (!call.ok) return call.result;
		const result = call.value;
		return {
			content: [{ type: "text", text: formatExecResult(result) }],
			details: result,
			isError: execResultFailed(result),
		};
	}
}
