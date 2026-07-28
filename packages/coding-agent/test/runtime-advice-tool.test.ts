import { describe, expect, test } from "bun:test";
import type { RuntimeExecResult } from "../src/runtime/protocol";
import type { ToolSession } from "../src/tools";
import { RuntimeAdviceTool } from "../src/tools/runtime-advice";

const REPORT: RuntimeExecResult = {
	exitCode: 0,
	stdout: "## Project Advice\n\n- Project Name: `probe`\n",
	stderr: "",
	durationMs: 12,
	killed: false,
};

function sessionWith(service: object | undefined, enabled = true, cwd = "/session/cwd"): ToolSession {
	return {
		cwd,
		settings: { get: (key: string) => (key === "runtime.enabled" ? enabled : undefined) },
		getRuntimeService: () => service as never,
	} as unknown as ToolSession;
}

describe("project_advice tool", () => {
	test("is discoverable, gated on runtime.enabled, and read-approved", () => {
		expect(RuntimeAdviceTool.createIf(sessionWith(undefined, false))).toBeNull();
		const tool = RuntimeAdviceTool.createIf(sessionWith({}));
		expect(tool).not.toBeNull();
		expect(tool!.name).toBe("project_advice");
		expect(tool!.loadMode).toBe("discoverable");
		// Read, not exec: fixed argv, no caller-supplied code, arguments, or output path.
		expect(tool!.approval).toBe("read");
	});

	test("never names the runtime product in model- or user-facing text", () => {
		const tool = RuntimeAdviceTool.createIf(sessionWith({}));
		const text = `${tool!.description} ${tool!.summary} ${tool!.label}`;
		expect(text.toLowerCase()).not.toContain("elide");
		expect(text).toContain("runtime");
	});

	test("defaults cwd to the session directory and forwards timeoutMs", async () => {
		let received: unknown;
		const tool = RuntimeAdviceTool.createIf(
			sessionWith({
				advice: async (p: unknown) => {
					received = p;
					return REPORT;
				},
			}),
		);
		const r = await tool!.execute("id", { timeoutMs: 5_000 }, new AbortController().signal);
		expect(received).toEqual({ cwd: "/session/cwd", timeoutMs: 5_000 });
		expect((r.content[0] as { text: string }).text).toContain("Project Advice");
		expect(r.details).toMatchObject({ exitCode: 0 });
	});

	test("an explicit cwd wins over the session directory", async () => {
		let received: unknown;
		const tool = RuntimeAdviceTool.createIf(
			sessionWith({
				advice: async (p: unknown) => {
					received = p;
					return REPORT;
				},
			}),
		);
		await tool!.execute("id", { cwd: "/elsewhere" }, new AbortController().signal);
		expect(received).toEqual({ cwd: "/elsewhere" });
	});

	test("every param is optional — an empty object validates", () => {
		const tool = RuntimeAdviceTool.createIf(sessionWith({}));
		expect(tool!.parameters.allows({})).toBe(true);
	});

	test("the runtime's own failure is surfaced, not reinterpreted", async () => {
		const tool = RuntimeAdviceTool.createIf(
			sessionWith({
				advice: async () => ({
					exitCode: 1,
					stdout: "",
					stderr: "advice is unavailable on this build",
					durationMs: 4,
					killed: false,
				}),
			}),
		);
		const r = await tool!.execute("id", {}, new AbortController().signal);
		const text = (r.content[0] as { text: string }).text;
		expect(text).toContain("advice is unavailable on this build");
		expect(text).toContain("(exit code 1)");
	});

	test("throws when the runtime service is unavailable", async () => {
		const tool = RuntimeAdviceTool.createIf(sessionWith(undefined));
		await expect(tool!.execute("id", {}, new AbortController().signal)).rejects.toThrow(
			/The runtime service is unavailable on this session/,
		);
	});
});
