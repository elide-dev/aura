import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import jvmDepsDescription from "../prompts/tools/jvm-deps.md" with { type: "text" };
import { formatExecResult } from "../runtime/format";
import type { RuntimeJvmResult } from "../runtime/protocol";
import type { ToolSession } from ".";
import { jvmLanguage, requireRuntimeService } from "./jvm-common";

const jvmDepsSchema = type({
	"language?": jvmLanguage.describe("source language (with code)"),
	"code?": type("string").describe("source to compile and analyze"),
	"mainClass?": type("string").describe("entrypoint class (default: the public class, or MainKt for Kotlin)"),
	"path?": type("string").describe("existing .class, .jar, or class directory to analyze (relative to the cwd)"),
	"timeoutMs?": type("number").describe("kill the analysis after this many milliseconds"),
});

export type JvmDepsToolParams = typeof jvmDepsSchema.infer;

export class JvmDepsTool implements AgentTool<typeof jvmDepsSchema, RuntimeJvmResult> {
	readonly name = "jvm_deps";
	readonly approval = "exec" as const;
	readonly label = "JVM Deps";
	readonly description = jvmDepsDescription;
	readonly parameters = jvmDepsSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Analyze JVM class/jar dependencies with jdeps";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): JvmDepsTool | null {
		if (!session.settings.get("runtime.enabled")) return null;
		return new JvmDepsTool(session);
	}

	async execute(
		_toolCallId: string,
		params: JvmDepsToolParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<RuntimeJvmResult>> {
		const result = await requireRuntimeService(this.session).jvm(
			{ action: "deps", ...params, cwd: this.session.cwd },
			signal,
		);
		return { content: [{ type: "text", text: formatExecResult(result) }], details: result };
	}
}
