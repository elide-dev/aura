import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import jvmFormatDescription from "../prompts/tools/jvm-format.md" with { type: "text" };
import { execResultFailed } from "../runtime/format";
import type { RuntimeJvmResult } from "../runtime/protocol";
import type { ToolSession } from ".";
import { jvmLanguage, renderJvmPayload, requireRuntimeService } from "./jvm-common";

const jvmFormatSchema = type({
	language: jvmLanguage.describe("source language"),
	code: type("string").describe("Java or Kotlin source to format"),
	"timeoutMs?": type("number").describe("kill the formatter after this many milliseconds"),
});

export type JvmFormatToolParams = typeof jvmFormatSchema.infer;

export class JvmFormatTool implements AgentTool<typeof jvmFormatSchema, RuntimeJvmResult> {
	readonly name = "jvm_format";
	readonly approval = "exec" as const;
	readonly label = "JVM Format";
	readonly description = jvmFormatDescription;
	readonly parameters = jvmFormatSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Format Java (Google Java Format) or Kotlin (ktfmt) source";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): JvmFormatTool | null {
		if (!session.settings.get("runtime.enabled")) return null;
		return new JvmFormatTool(session);
	}

	async execute(
		_toolCallId: string,
		params: JvmFormatToolParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<RuntimeJvmResult>> {
		const result = await requireRuntimeService(this.session).jvm(
			{ action: "format", ...params, cwd: this.session.cwd },
			signal,
			this.session.getSessionId?.() ?? undefined,
		);
		return {
			content: [{ type: "text", text: renderJvmPayload(result, result.formatted) }],
			details: result,
			isError: execResultFailed(result),
		};
	}
}
