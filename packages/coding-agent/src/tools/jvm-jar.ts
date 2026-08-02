import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import jvmJarDescription from "../prompts/tools/jvm-jar.md" with { type: "text" };
import { execResultFailed, formatExecResult } from "../runtime/format";
import type { RuntimeJvmResult } from "../runtime/protocol";
import type { ToolSession } from ".";
import { jvmLanguage, requireRuntimeService } from "./jvm-common";

const jvmJarSchema = type({
	action: type("'create' | 'inspect'").describe("create or inspect"),
	"language?": jvmLanguage.describe("source language (create)"),
	"code?": type("string").describe("source (create)"),
	"mainClass?": type("string").describe("manifest entrypoint override"),
	"output?": type("string").describe("cwd-relative JAR output (create)"),
	"overwrite?": type("boolean").describe("replace output (create)"),
	"jar?": type("string").describe("cwd-relative JAR (inspect)"),
	"timeoutMs?": type("number").describe("timeout (ms)"),
});

export type JvmJarToolParams = typeof jvmJarSchema.infer;

export class JvmJarTool implements AgentTool<typeof jvmJarSchema, RuntimeJvmResult> {
	readonly name = "jvm_jar";
	readonly approval = "exec" as const;
	readonly label = "JVM Jar";
	readonly description = jvmJarDescription;
	readonly parameters = jvmJarSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Build a JAR from Java/Kotlin source, or list an existing one";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): JvmJarTool | null {
		if (!session.settings.get("runtime.enabled")) return null;
		return new JvmJarTool(session);
	}

	async execute(
		_toolCallId: string,
		params: JvmJarToolParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<RuntimeJvmResult>> {
		const { action, ...rest } = params;
		// The protocol's `action` is the flow selector (`jar`); create/inspect is its `mode`.
		const result = await requireRuntimeService(this.session).jvm(
			{ action: "jar", mode: action, ...rest, cwd: this.session.cwd },
			signal,
			this.session.getSessionId?.() ?? undefined,
		);
		if (result.exitCode !== 0 || result.killed) {
			return {
				content: [{ type: "text", text: formatExecResult(result) }],
				details: result,
				isError: execResultFailed(result),
			};
		}
		const text =
			result.output === undefined
				? `Entries of ${result.jar}:\n${result.listing ?? ""}`
				: `Built ${result.output} (main class ${result.className}).\n[contents]\n${result.listing ?? ""}`;
		return { content: [{ type: "text", text }], details: result, isError: execResultFailed(result) };
	}
}
