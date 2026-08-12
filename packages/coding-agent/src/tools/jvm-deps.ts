import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import jvmDepsDescription from "../prompts/tools/jvm-deps.md" with { type: "text" };
import { execResultFailed, formatExecResult, type RuntimeErrorDetails } from "../runtime/format";
import type { RuntimeJvmResult } from "../runtime/protocol";
import type { ToolSession } from ".";
import { callJvm, jvmLanguage } from "./jvm-common";
import { enforcePlanModeWrite } from "./plan-mode-guard";

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

export class JvmDepsTool implements AgentTool<typeof jvmDepsSchema, RuntimeJvmResult | RuntimeErrorDetails> {
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
	): Promise<AgentToolResult<RuntimeJvmResult | RuntimeErrorDetails>> {
		// `output` is the only thing this tool can put on disk; without it the report
		// exists only in the transcript, which plan mode has no quarrel with. The
		// truthiness test matches the transport's own (`params.output ? … :
		// undefined`), so an empty string is not refused for a write that would
		// never happen.
		//
		// Resolved first, for the reason spelled out in `jvm-jar.ts`: the transport
		// resolves this field against cwd and knows no URL scheme, so guarding the
		// raw string would let `local://deps.txt` take the sandbox exemption and
		// still land in the working tree.
		if (params.output) {
			enforcePlanModeWrite(this.session, path.resolve(this.session.cwd, params.output), { op: "create" });
		}
		const call = await callJvm(this.session, { action: "deps", ...params, cwd: this.session.cwd }, signal);
		if (!call.ok) return call.result;
		const result = call.value;
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
