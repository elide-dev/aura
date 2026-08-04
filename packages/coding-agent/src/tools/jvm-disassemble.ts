import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import jvmDisassembleDescription from "../prompts/tools/jvm-disassemble.md" with { type: "text" };
import { execResultFailed } from "../runtime/format";
import type { RuntimeJvmResult } from "../runtime/protocol";
import type { ToolSession } from ".";
import { jvmLanguage, renderJvmPayload, requireRuntimeService } from "./jvm-common";

const jvmDisassembleSchema = type({
	language: jvmLanguage.describe("source language"),
	code: type("string").describe("source to compile"),
	"mainClass?": type("string").describe("target class (derived by default)"),
	"timeoutMs?": type("number").describe("timeout (ms)"),
});

export type JvmDisassembleToolParams = typeof jvmDisassembleSchema.infer;

export class JvmDisassembleTool implements AgentTool<typeof jvmDisassembleSchema, RuntimeJvmResult> {
	readonly name = "jvm_disassemble";
	readonly approval = "exec" as const;
	readonly label = "JVM Disassemble";
	readonly description = jvmDisassembleDescription;
	readonly parameters = jvmDisassembleSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Disassemble Java/Kotlin bytecode with javap -c";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): JvmDisassembleTool | null {
		if (!session.settings.get("runtime.enabled")) return null;
		return new JvmDisassembleTool(session);
	}

	async execute(
		_toolCallId: string,
		params: JvmDisassembleToolParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<RuntimeJvmResult>> {
		const result = await requireRuntimeService(this.session).jvm(
			{ action: "disassemble", ...params, cwd: this.session.cwd },
			signal,
			this.session.getSessionId?.() ?? undefined,
		);
		return {
			content: [{ type: "text", text: renderJvmPayload(result, result.stdout) }],
			details: result,
			isError: execResultFailed(result),
		};
	}
}
