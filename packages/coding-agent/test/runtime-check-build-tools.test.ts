import { describe, expect, test } from "bun:test";
import type { RuntimeExecResult } from "../src/runtime/protocol";
import type { ToolSession } from "../src/tools";
import { RuntimeBuildTool } from "../src/tools/runtime-build";
import { RuntimeCheckTool } from "../src/tools/runtime-check";

const OK: RuntimeExecResult = { exitCode: 0, stdout: "Build successful", stderr: "", durationMs: 10, killed: false };

function sessionWith(service: object | undefined, enabled = true): ToolSession {
	return {
		settings: { get: (key: string) => (key === "runtime.enabled" ? enabled : undefined) },
		getRuntimeService: () => service as never,
	} as unknown as ToolSession;
}

describe("check/build tools", () => {
	test("createIf gates on runtime.enabled", () => {
		expect(RuntimeCheckTool.createIf(sessionWith(undefined, false))).toBeNull();
		expect(RuntimeBuildTool.createIf(sessionWith(undefined, false))).toBeNull();
		expect(RuntimeCheckTool.createIf(sessionWith({}))?.name).toBe("check");
		expect(RuntimeBuildTool.createIf(sessionWith({}))?.name).toBe("build");
	});

	test("check/build advertise essential load mode and exec approval", () => {
		const check = RuntimeCheckTool.createIf(sessionWith({}));
		expect(check?.loadMode).toBe("essential");
		expect(check?.approval).toBe("exec");
		const build = RuntimeBuildTool.createIf(sessionWith({}));
		expect(build?.loadMode).toBe("essential");
		expect(build?.approval).toBe("exec");
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

	test("build passes targets through", async () => {
		let received: unknown;
		const tool = RuntimeBuildTool.createIf(
			sessionWith({
				build: async (p: unknown) => {
					received = p;
					return OK;
				},
			}),
		);
		expect(tool).not.toBeNull();
		await tool!.execute("id", { targets: [":deps", "--fresh"] } as never, new AbortController().signal);
		expect(received).toMatchObject({ targets: [":deps", "--fresh"] });
	});

	test("execute throws when the runtime service is unavailable", async () => {
		const tool = RuntimeCheckTool.createIf(sessionWith(undefined));
		expect(tool).not.toBeNull();
		await expect(tool!.execute("id", {} as never, new AbortController().signal)).rejects.toThrow(
			/The runtime service is unavailable on this session/,
		);
	});
});
