import { describe, expect, test } from "bun:test";
import { formatExecResult } from "../src/runtime/format";
import type { RuntimeExecResult } from "../src/runtime/protocol";
import type { ToolSession } from "../src/tools";
import { RuntimeRunTool } from "../src/tools/runtime-run";

function sessionWith(overrides: { enabled?: boolean; run?: (p: unknown) => Promise<RuntimeExecResult> }): ToolSession {
	const service = overrides.run ? { run: overrides.run } : undefined;
	return {
		settings: { get: (key: string) => (key === "runtime.enabled" ? (overrides.enabled ?? true) : undefined) },
		getRuntimeService: () => (overrides.enabled === false ? undefined : (service as never)),
	} as unknown as ToolSession;
}

describe("run tool", () => {
	test("createIf returns null when runtime.enabled is false", () => {
		expect(RuntimeRunTool.createIf(sessionWith({ enabled: false }))).toBeNull();
	});

	test("createIf constructs when enabled", () => {
		const tool = RuntimeRunTool.createIf(sessionWith({ enabled: true }));
		expect(tool?.name).toBe("run");
		expect(tool?.loadMode).toBe("essential");
		expect(tool?.approval).toBe("exec");
	});

	test("execute forwards params to the service and formats the result", async () => {
		let received: unknown;
		const tool = RuntimeRunTool.createIf(
			sessionWith({
				run: async p => {
					received = p;
					return { exitCode: 0, stdout: "hello\n", stderr: "", durationMs: 5, killed: false };
				},
			}),
		);
		const result = await tool?.execute(
			"id1",
			{ code: "console.log('hello')", language: "ts" } as never,
			new AbortController().signal,
		);
		expect((received as { code: string }).code).toBe("console.log('hello')");
		const block = result?.content[0] as { type: "text"; text: string } | undefined;
		expect(block?.text).toContain("hello");
		expect(result?.details).toMatchObject({ exitCode: 0 });
	});

	test("nonzero exit is surfaced in the formatted output", () => {
		const text = formatExecResult({ exitCode: 2, stdout: "", stderr: "boom", durationMs: 3, killed: false });
		expect(text).toContain("exit code 2");
		expect(text).toContain("boom");
	});
});
