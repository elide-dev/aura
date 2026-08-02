import { describe, expect, test } from "bun:test";
import type { RuntimeExecResult } from "../src/runtime/protocol";
import type { ToolSession } from "../src/tools";
import { RuntimeCheckTool } from "../src/tools/runtime-check";

const OK: RuntimeExecResult = { exitCode: 0, stdout: "Build successful", stderr: "", durationMs: 10, killed: false };

function sessionWith(service: object | undefined, enabled = true): ToolSession {
	return {
		settings: { get: (key: string) => (key === "runtime.enabled" ? enabled : undefined) },
		getRuntimeService: () => service as never,
	} as unknown as ToolSession;
}

describe("check tool", () => {
	test("createIf gates on runtime.enabled", () => {
		expect(RuntimeCheckTool.createIf(sessionWith(undefined, false))).toBeNull();
		expect(RuntimeCheckTool.createIf(sessionWith({}))?.name).toBe("check");
	});

	test("advertises essential load mode and exec approval", () => {
		const check = RuntimeCheckTool.createIf(sessionWith({}));
		expect(check?.loadMode).toBe("essential");
		expect(check?.approval).toBe("exec");
	});

	test("check calls service.check with no targets", async () => {
		let received: unknown;
		const tool = RuntimeCheckTool.createIf(
			sessionWith({
				check: async (p: unknown) => {
					received = p;
					return OK;
				},
			}),
		);
		expect(tool).not.toBeNull();
		const r = await tool!.execute("id", {} as never, new AbortController().signal);
		expect(received).not.toHaveProperty("targets");
		expect((r.content[0] as { text: string }).text).toContain("Build successful");
		expect(r.details).toMatchObject({ exitCode: 0 });
	});

	test("execute throws when the runtime service is unavailable", async () => {
		const tool = RuntimeCheckTool.createIf(sessionWith(undefined));
		expect(tool).not.toBeNull();
		await expect(tool!.execute("id", {} as never, new AbortController().signal)).rejects.toThrow(
			/The runtime service is unavailable on this session/,
		);
	});
});
