import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { isEmbeddedPythonEnabled } from "../config/settings";
import runtimeProfileDescriptionTemplate from "../prompts/tools/runtime-profile.md" with { type: "text" };
import { callRuntime, execResultFailed, formatExecResult, type RuntimeErrorDetails } from "../runtime/format";
import { type RuntimeExecResult, RuntimeRpcError, resolveRunTarget } from "../runtime/protocol";
import type { ToolSession } from ".";

const runtimeProfileSchema = type({
	mode: type("'cputracing' | 'cpusampling'").describe("profiler mode"),
	"code?": type("string").describe("inline program (exclusive with path)"),
	"path?": type("string").describe("existing program file"),
	"language?": type("'js' | 'ts' | 'python'").describe("inline language (default ts)"),
	"args?": type("string[]").describe("program arguments"),
	"stdin?": type("string").describe("program stdin"),
	"timeoutMs?": type("number").describe("timeout (ms)"),
	"cwd?": type("string").describe("working directory (session cwd)"),
});

const runtimeProfileSchemaWithoutPython = type({
	mode: type("'cputracing' | 'cpusampling'").describe("profiler mode"),
	"code?": type("string").describe("inline program (exclusive with path)"),
	"path?": type("string").describe("existing program file"),
	"language?": type("'js' | 'ts'").describe("inline language (default ts)"),
	"args?": type("string[]").describe("program arguments"),
	"stdin?": type("string").describe("program stdin"),
	"timeoutMs?": type("number").describe("timeout (ms)"),
	"cwd?": type("string").describe("working directory (session cwd)"),
}) as unknown as typeof runtimeProfileSchema;

export type RuntimeProfileToolParams = typeof runtimeProfileSchema.infer;

export class RuntimeProfileTool
	implements AgentTool<typeof runtimeProfileSchema, RuntimeExecResult | RuntimeErrorDetails>
{
	readonly name = "profile";
	readonly approval = "exec" as const;
	readonly label = "Profile";
	get description(): string {
		return prompt.render(runtimeProfileDescriptionTemplate, { python: this.#embeddedPythonEnabled });
	}
	get parameters(): typeof runtimeProfileSchema {
		return this.#embeddedPythonEnabled ? runtimeProfileSchema : runtimeProfileSchemaWithoutPython;
	}
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Profile a program (cpu tracing or sampling)";

	readonly #embeddedPythonEnabled: boolean;

	constructor(private readonly session: ToolSession) {
		this.#embeddedPythonEnabled = isEmbeddedPythonEnabled(session.settings);
	}

	static createIf(session: ToolSession): RuntimeProfileTool | null {
		if (!session.settings.get("runtime.enabled")) return null;
		return new RuntimeProfileTool(session);
	}

	async execute(
		_toolCallId: string,
		params: RuntimeProfileToolParams,
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
				"Python runtime profiling is disabled (python.enabled = false or python.embedded = false).",
			);
		}
		const call = await callRuntime(
			() =>
				service.profile(
					{ ...params, cwd: params.cwd ?? this.session.cwd },
					signal,
					this.session.getSessionId?.() ?? undefined,
				),
			{ root: this.session.cwd, service, scope: this.session.runtimeServiceScope },
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
