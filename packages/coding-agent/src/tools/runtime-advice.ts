import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import runtimeAdviceDescription from "../prompts/tools/runtime-advice.md" with { type: "text" };
import { execResultFailed, formatExecResult } from "../runtime/format";
import type { RuntimeExecResult } from "../runtime/protocol";
import type { ToolSession } from ".";

const runtimeAdviceSchema = type({
	"cwd?": type("string").describe("project directory to inspect (defaults to the session cwd)"),
	"timeoutMs?": type("number").describe("give up after this many milliseconds"),
});

export type RuntimeAdviceToolParams = typeof runtimeAdviceSchema.infer;

/**
 * The runtime's own project guidance. `approval` is `"read"`, not the `"exec"`
 * the other runtime tools use: the argv is fixed (`project advice`), the caller
 * supplies no code, no arguments and no output path, and the flow only inspects
 * manifests in a directory the session can already read. Charging an exec
 * approval for a read is what trains users to wave approvals through.
 */
export class RuntimeAdviceTool implements AgentTool<typeof runtimeAdviceSchema, RuntimeExecResult> {
	readonly name = "project_advice";
	readonly approval = "read" as const;
	readonly label = "Project Advice";
	readonly description = runtimeAdviceDescription;
	readonly parameters = runtimeAdviceSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Get the runtime's build/run/test/install guidance for this project";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): RuntimeAdviceTool | null {
		if (!session.settings.get("runtime.enabled")) return null;
		return new RuntimeAdviceTool(session);
	}

	async execute(
		_toolCallId: string,
		params: RuntimeAdviceToolParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<RuntimeExecResult>> {
		const service = this.session.getRuntimeService?.();
		if (!service)
			throw new Error(
				"The runtime service is unavailable on this session (runtime.enabled may be false, or this host does not provide it).",
			);
		const result = await service.advice(
			{ ...params, cwd: params.cwd ?? this.session.cwd },
			signal,
			this.session.getSessionId?.() ?? undefined,
		);
		return {
			content: [{ type: "text", text: formatExecResult(result) }],
			details: result,
			isError: execResultFailed(result),
		};
	}
}
