import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import jvmJavadocDescription from "../prompts/tools/jvm-javadoc.md" with { type: "text" };
import { execResultFailed, formatExecResult } from "../runtime/format";
import type { RuntimeJvmResult } from "../runtime/protocol";
import type { ToolSession } from ".";
import { requireRuntimeService } from "./jvm-common";

const jvmJavadocSchema = type({
	code: type("string").describe("Java source to document"),
	"output?": type("string").describe("output directory, relative to the cwd (default javadoc-out)"),
	"overwrite?": type("boolean").describe("replace an existing output directory"),
	"timeoutMs?": type("number").describe("kill the generator after this many milliseconds"),
});

export type JvmJavadocToolParams = typeof jvmJavadocSchema.infer;

export class JvmJavadocTool implements AgentTool<typeof jvmJavadocSchema, RuntimeJvmResult> {
	readonly name = "jvm_javadoc";
	readonly approval = "exec" as const;
	readonly label = "JVM Javadoc";
	readonly description = jvmJavadocDescription;
	readonly parameters = jvmJavadocSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Generate Javadoc HTML API docs from Java source";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): JvmJavadocTool | null {
		if (!session.settings.get("runtime.enabled")) return null;
		return new JvmJavadocTool(session);
	}

	async execute(
		_toolCallId: string,
		params: JvmJavadocToolParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<RuntimeJvmResult>> {
		const result = await requireRuntimeService(this.session).jvm(
			{ action: "javadoc", ...params, cwd: this.session.cwd },
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
			`Generated API docs for ${result.className} → ${result.output} (${result.entryCount} entries).\n` +
			`Top-level: ${(result.topLevel ?? []).join(", ")}\n` +
			`Tip: open ${result.output}/index.html to browse them.`;
		return { content: [{ type: "text", text }], details: result, isError: execResultFailed(result) };
	}
}
