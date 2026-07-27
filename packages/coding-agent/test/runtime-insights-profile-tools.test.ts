import { describe, expect, test } from "bun:test";
import type { RuntimeExecResult } from "../src/runtime/protocol";
import type { ToolSession } from "../src/tools";
import { RuntimeInsightsTool } from "../src/tools/runtime-insights";
import { RuntimeProfileTool } from "../src/tools/runtime-profile";

const OK: RuntimeExecResult = { exitCode: 0, stdout: "report", stderr: "", durationMs: 10, killed: false };

function sessionWith(service: object | undefined, enabled = true): ToolSession {
	return {
		settings: { get: (key: string) => (key === "runtime.enabled" ? enabled : undefined) },
		getRuntimeService: () => service as never,
	} as unknown as ToolSession;
}

describe("insights/profile tools", () => {
	test("both are discoverable and gated", () => {
		expect(RuntimeInsightsTool.createIf(sessionWith(undefined, false))).toBeNull();
		expect(RuntimeProfileTool.createIf(sessionWith(undefined, false))).toBeNull();
		const i = RuntimeInsightsTool.createIf(sessionWith({}));
		const p = RuntimeProfileTool.createIf(sessionWith({}));
		expect(i).not.toBeNull();
		expect(p).not.toBeNull();
		expect(i!.name).toBe("insights");
		expect(i!.loadMode).toBe("discoverable");
		expect(i!.approval).toBe("exec");
		expect(p!.name).toBe("profile");
		expect(p!.loadMode).toBe("discoverable");
		expect(p!.approval).toBe("exec");
	});

	test("insights forwards insight script params", async () => {
		let received: unknown;
		const tool = RuntimeInsightsTool.createIf(
			sessionWith({
				insights: async (p: unknown) => {
					received = p;
					return OK;
				},
			}),
		);
		expect(tool).not.toBeNull();
		const r = await tool!.execute("id", { code: "1", insight: "hook()" } as never, new AbortController().signal);
		expect(received).toMatchObject({ code: "1", insight: "hook()" });
		expect((r.content[0] as { text: string }).text).toContain("report");
		expect(r.details).toMatchObject({ exitCode: 0 });
	});

	test("profile requires a mode and forwards it", async () => {
		let received: unknown;
		const tool = RuntimeProfileTool.createIf(
			sessionWith({
				profile: async (p: unknown) => {
					received = p;
					return OK;
				},
			}),
		);
		expect(tool).not.toBeNull();
		await tool!.execute("id", { code: "1", mode: "cputracing" } as never, new AbortController().signal);
		expect(received).toMatchObject({ mode: "cputracing" });
	});

	test("both throw when the runtime service is unavailable", async () => {
		const insights = RuntimeInsightsTool.createIf(sessionWith(undefined));
		const profile = RuntimeProfileTool.createIf(sessionWith(undefined));
		expect(insights).not.toBeNull();
		expect(profile).not.toBeNull();
		await expect(insights!.execute("id", {} as never, new AbortController().signal)).rejects.toThrow(
			/The runtime service is unavailable on this session/,
		);
		await expect(
			profile!.execute("id", { mode: "cpusampling" } as never, new AbortController().signal),
		).rejects.toThrow(/The runtime service is unavailable on this session/);
	});
});
