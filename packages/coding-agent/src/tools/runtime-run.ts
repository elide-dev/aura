import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { isEmbeddedPythonEnabled } from "../config/settings";
import runtimeRunDescriptionTemplate from "../prompts/tools/runtime-run.md" with { type: "text" };
import { disposeCachedRuntimeService } from "../runtime";
import { execResultFailed, formatExecResult } from "../runtime/format";
import { type RuntimeExecResult, RuntimeRpcError, resolveRunTarget } from "../runtime/protocol";
import type { ToolSession } from ".";

const runtimeRunSchema = type({
	"code?": type("string").describe("inline source (exclusive with path)"),
	"path?": type("string").describe("existing file; keeps project cwd/imports"),
	"language?": type("'js' | 'ts' | 'python' | 'java' | 'kotlin'").describe(
		"inline language (default ts; inferred from path)",
	),
	"engine?": type("'bun' | 'elide'").describe("engine override (JS/TS default bun)"),
	"args?": type("string[]").describe("program arguments"),
	"stdin?": type("string").describe("program stdin"),
	"timeoutMs?": type("number").describe("timeout (ms)"),
	"cwd?": type("string").describe("working directory (session cwd)"),
	"mainClass?": type("string").describe("JVM entrypoint override"),
});

const runtimeRunSchemaWithoutPython = type({
	"code?": type("string").describe("inline source (exclusive with path)"),
	"path?": type("string").describe("existing file; keeps project cwd/imports"),
	"language?": type("'js' | 'ts' | 'java' | 'kotlin'").describe("inline language (default ts; inferred from path)"),
	"engine?": type("'bun' | 'elide'").describe("engine override (JS/TS default bun)"),
	"args?": type("string[]").describe("program arguments"),
	"stdin?": type("string").describe("program stdin"),
	"timeoutMs?": type("number").describe("timeout (ms)"),
	"cwd?": type("string").describe("working directory (session cwd)"),
	"mainClass?": type("string").describe("JVM entrypoint override"),
}) as unknown as typeof runtimeRunSchema;

export type RuntimeRunToolParams = typeof runtimeRunSchema.infer;

export class RuntimeRunTool implements AgentTool<typeof runtimeRunSchema, RuntimeExecResult> {
	readonly name = "run";
	readonly approval = "exec" as const;
	readonly label = "Run";
	get description(): string {
		return prompt.render(runtimeRunDescriptionTemplate, { python: this.#embeddedPythonEnabled });
	}
	get parameters(): typeof runtimeRunSchema {
		return this.#embeddedPythonEnabled ? runtimeRunSchema : runtimeRunSchemaWithoutPython;
	}
	readonly strict = true;
	readonly loadMode = "essential" as const;
	get summary(): string {
		return this.#embeddedPythonEnabled
			? "Execute JavaScript, TypeScript, Python, Java, or Kotlin"
			: "Execute JavaScript, TypeScript, Java, or Kotlin";
	}

	readonly #embeddedPythonEnabled: boolean;

	constructor(private readonly session: ToolSession) {
		this.#embeddedPythonEnabled = isEmbeddedPythonEnabled(session.settings);
	}

	static createIf(session: ToolSession): RuntimeRunTool | null {
		if (!session.settings.get("runtime.enabled")) return null;
		return new RuntimeRunTool(session);
	}

	async execute(
		_toolCallId: string,
		params: RuntimeRunToolParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<RuntimeExecResult>> {
		const target = resolveRunTarget(params);
		if (target.language === "python" && !this.#embeddedPythonEnabled) {
			throw new RuntimeRpcError(
				"invalid-params",
				"Python runtime execution is disabled (python.enabled = false or python.embedded = false).",
			);
		}
		const service = this.session.getRuntimeService?.();
		if (!service)
			throw new Error(
				"The runtime service is unavailable on this session (runtime.enabled may be false, or this host does not provide it).",
			);
		let result: RuntimeExecResult;
		try {
			result = await service.run(
				{ ...params, cwd: params.cwd ?? this.session.cwd },
				signal,
				this.session.getSessionId?.() ?? undefined,
			);
		} catch (error) {
			if (error instanceof RuntimeRpcError && error.code === "internal" && this.session.runtimeServiceScope) {
				try {
					await disposeCachedRuntimeService(service, this.session.runtimeServiceScope);
				} catch (disposeError) {
					logger.warn("Failed to retire internally failed runtime service", { error: String(disposeError) });
				}
			}
			throw error;
		}
		return {
			content: [{ type: "text", text: formatExecResult(result) }],
			details: result,
			isError: execResultFailed(result),
		};
	}
}
