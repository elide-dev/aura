import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import runtimeRunDescription from "../prompts/tools/runtime-run.md" with { type: "text" };
import { formatExecResult } from "../runtime/format";
import type { RuntimeExecResult } from "../runtime/protocol";
import type { ToolSession } from ".";

const runtimeRunSchema = type({
	"code?": type("string").describe("inline source to execute (mutually exclusive with path)"),
	"path?": type("string").describe("existing file to run; preserves project cwd/imports"),
	"language?": type("'js' | 'ts' | 'python'").describe("language for inline code (default ts)"),
	"args?": type("string[]").describe("arguments passed to the program"),
	"stdin?": type("string").describe("data piped to the program's stdin"),
	"timeoutMs?": type("number").describe("kill the run after this many milliseconds"),
	"cwd?": type("string").describe("working directory (defaults to the session cwd)"),
});

export type RuntimeRunToolParams = typeof runtimeRunSchema.infer;

export class RuntimeRunTool implements AgentTool<typeof runtimeRunSchema, RuntimeExecResult> {
	readonly name = "run";
	readonly approval = "exec" as const;
	readonly label = "Run";
	readonly description = runtimeRunDescription;
	readonly parameters = runtimeRunSchema;
	readonly strict = true;
	readonly loadMode = "essential" as const;
	readonly summary = "Execute js/ts/python on the managed runtime";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): RuntimeRunTool | null {
		if (!session.settings.get("runtime.enabled")) return null;
		return new RuntimeRunTool(session);
	}

	async execute(
		_toolCallId: string,
		params: RuntimeRunToolParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<RuntimeExecResult>> {
		const service = this.session.getRuntimeService?.();
		if (!service)
			throw new Error(
				"The runtime service is unavailable on this session (runtime.enabled may be false, or this host does not provide it).",
			);
		const result = await service.run({ ...params, cwd: params.cwd ?? this.session.cwd }, signal);
		return {
			content: [{ type: "text", text: formatExecResult(result) }],
			details: result,
		};
	}
}
