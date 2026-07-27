import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import jvmRunDescription from "../prompts/tools/jvm-run.md" with { type: "text" };
import { formatExecResult } from "../runtime/format";
import type { RuntimeJvmResult } from "../runtime/protocol";
import type { ToolSession } from ".";
import { jvmLanguage, requireRuntimeService } from "./jvm-common";

const jvmRunSchema = type({
	language: jvmLanguage.describe("source language"),
	code: type("string").describe("Java or Kotlin source"),
	"mainClass?": type("string").describe("entrypoint class (default: the public class, or MainKt for Kotlin)"),
	"timeoutMs?": type("number").describe("kill the compile or the run after this many milliseconds"),
});

export type JvmRunToolParams = typeof jvmRunSchema.infer;

export class JvmRunTool implements AgentTool<typeof jvmRunSchema, RuntimeJvmResult> {
	readonly name = "jvm_run";
	readonly approval = "exec" as const;
	readonly label = "JVM Run";
	readonly description = jvmRunDescription;
	readonly parameters = jvmRunSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Compile & run Java/Kotlin on the embedded JVM";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): JvmRunTool | null {
		if (!session.settings.get("runtime.enabled")) return null;
		return new JvmRunTool(session);
	}

	async execute(
		_toolCallId: string,
		params: JvmRunToolParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<RuntimeJvmResult>> {
		const result = await requireRuntimeService(this.session).jvm(
			{ action: "run", ...params, cwd: this.session.cwd },
			signal,
		);
		return { content: [{ type: "text", text: formatExecResult(result) }], details: result };
	}
}
