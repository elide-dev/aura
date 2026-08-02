import { describe, expect, test, vi } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import type { RuntimeExecResult } from "../src/runtime/protocol";
import type { ToolSession } from "../src/tools";
import { RuntimeInsightsTool } from "../src/tools/runtime-insights";
import { RuntimeProfileTool } from "../src/tools/runtime-profile";

const OK: RuntimeExecResult = { exitCode: 0, stdout: "report", stderr: "", durationMs: 10, killed: false };

function sessionWith(
	service: object | undefined,
	enabled = true,
	pythonEnabled = true,
	pythonEmbedded = true,
): ToolSession {
	return {
		settings: {
			get: (key: string) => {
				if (key === "runtime.enabled") return enabled;
				if (key === "python.enabled") return pythonEnabled;
				if (key === "python.embedded") return pythonEmbedded;
				return undefined;
			},
		},
		getRuntimeService: () => service as never,
	} as unknown as ToolSession;
}

function languages(tool: unknown): string[] {
	const wire = toolWireSchema(tool as AgentTool) as { properties?: { language?: { enum?: string[] } } };
	return [...(wire.properties?.language?.enum ?? [])].sort();
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

	test("both withhold and reject Python when embedded Python is disabled", async () => {
		const insightsCall = vi.fn(async () => OK);
		const profileCall = vi.fn(async () => OK);
		const insights = RuntimeInsightsTool.createIf(sessionWith({ insights: insightsCall }, true, true, false));
		const profile = RuntimeProfileTool.createIf(sessionWith({ profile: profileCall }, true, true, false));

		expect(languages(insights!)).toEqual(["js", "ts"]);
		expect(languages(profile!)).toEqual(["js", "ts"]);
		expect(insights?.description).not.toContain("Python");
		expect(profile?.description).not.toContain("Python");
		await expect(insights?.execute("id", { code: "print(1)", language: "python" } as never)).rejects.toThrow(
			/python\.embedded/,
		);
		await expect(
			profile?.execute("id", { code: "print(1)", language: "python", mode: "cpusampling" } as never),
		).rejects.toThrow(/python\.embedded/);
		expect(insightsCall).not.toHaveBeenCalled();
		expect(profileCall).not.toHaveBeenCalled();
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
