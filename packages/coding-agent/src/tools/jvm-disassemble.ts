import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import jvmDisassembleDescription from "../prompts/tools/jvm-disassemble.md" with { type: "text" };
import type { RuntimeJvmResult } from "../runtime/protocol";
import type { ToolSession } from ".";
import { jvmLanguage, renderJvmPayload, requireRuntimeService } from "./jvm-common";

const jvmDisassembleSchema = type({
	language: jvmLanguage.describe("source language"),
	code: type("string").describe("Java or Kotlin source"),
	"mainClass?": type("string").describe("class to disassemble (default: the public class, or MainKt for Kotlin)"),
	"timeoutMs?": type("number").describe("kill the compile or the disassembly after this many milliseconds"),
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
		);
		return { content: [{ type: "text", text: renderJvmPayload(result, result.stdout) }], details: result };
	}
}
