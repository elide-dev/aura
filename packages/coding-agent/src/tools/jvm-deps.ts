import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import jvmDepsDescription from "../prompts/tools/jvm-deps.md" with { type: "text" };
import { execResultFailed, formatExecResult } from "../runtime/format";
import type { RuntimeJvmResult } from "../runtime/protocol";
import type { ToolSession } from ".";
import { jvmLanguage, requireRuntimeService } from "./jvm-common";

const jvmDepsSchema = type({
	"language?": jvmLanguage.describe("source language"),
	"code?": type("string").describe("inline source"),
	"mainClass?": type("string").describe("target class override"),
	"path?": type("string").describe("source, class, JAR, or class directory"),
	"output?": type("string").describe("cwd-relative report output"),
	"overwrite?": type("boolean").describe("replace output"),
	"timeoutMs?": type("number").describe("timeout (ms)"),
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
			this.session.getSessionId?.() ?? undefined,
		);
		const failed = execResultFailed(result);
		const report = formatExecResult(result);
		const text = result.output && !failed ? `Wrote dependency report to ${result.output}\n${report}` : report;
		return {
			content: [{ type: "text", text }],
			details: result,
			isError: failed,
		};
	}
}
