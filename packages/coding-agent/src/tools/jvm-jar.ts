import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import jvmJarDescription from "../prompts/tools/jvm-jar.md" with { type: "text" };
import { execResultFailed, formatExecResult, type RuntimeErrorDetails } from "../runtime/format";
import type { RuntimeJvmResult } from "../runtime/protocol";
import type { ToolSession } from ".";
import { callJvm, jvmLanguage } from "./jvm-common";
import { enforcePlanModeWrite } from "./plan-mode-guard";

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

export class JvmJarTool implements AgentTool<typeof jvmJarSchema, RuntimeJvmResult | RuntimeErrorDetails> {
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
	): Promise<AgentToolResult<RuntimeJvmResult | RuntimeErrorDetails>> {
		const { action, ...rest } = params;
		// `create` lands a JAR in the working tree, so it is a write and plan mode
		// owns the decision — same guard `write`/`edit` call, because the runtime
		// service on the far side of this call has no idea the session is planning.
		// `inspect` only lists an existing archive and is left alone.
		if (action === "create" && rest.output !== undefined) {
			enforcePlanModeWrite(this.session, rest.output, { op: "create" });
		}
		// The protocol's `action` is the flow selector (`jar`); create/inspect is its `mode`.
		const call = await callJvm(this.session, { action: "jar", mode: action, ...rest, cwd: this.session.cwd }, signal);
		if (!call.ok) return call.result;
		const result = call.value;
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
