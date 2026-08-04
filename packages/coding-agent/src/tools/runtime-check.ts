import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import runtimeCheckDescription from "../prompts/tools/runtime-check.md" with { type: "text" };
import { execResultFailed, formatExecResult } from "../runtime/format";
import type { RuntimeExecResult } from "../runtime/protocol";
import type { ToolSession } from ".";

const runtimeCheckSchema = type({
	"cwd?": type("string").describe("project directory (session cwd)"),
	"timeoutMs?": type("number").describe("timeout (ms)"),
});

export type RuntimeCheckToolParams = typeof runtimeCheckSchema.infer;

export class RuntimeCheckTool implements AgentTool<typeof runtimeCheckSchema, RuntimeExecResult> {
	readonly name = "check";
	readonly approval = "exec" as const;
	readonly label = "Check";
	readonly description = runtimeCheckDescription;
	readonly parameters = runtimeCheckSchema;
	readonly strict = true;
	readonly loadMode = "essential" as const;
	readonly summary = "Validate supported project sources without producing deliverable artifacts";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): RuntimeCheckTool | null {
		if (!session.settings.get("runtime.enabled")) return null;
		return new RuntimeCheckTool(session);
	}

	async execute(
		_toolCallId: string,
		params: RuntimeCheckToolParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<RuntimeExecResult>> {
		const service = this.session.getRuntimeService?.();
		if (!service)
			throw new Error(
				"The runtime service is unavailable on this session (runtime.enabled may be false, or this host does not provide it).",
			);
		const result = await service.check(
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
