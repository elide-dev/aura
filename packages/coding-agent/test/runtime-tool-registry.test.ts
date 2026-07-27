import { describe, expect, test } from "bun:test";
import { BUILTIN_TOOLS, type ToolSession } from "../src/tools";
import { BUILTIN_TOOL_NAMES, normalizeToolName } from "../src/tools/builtin-names";
import { ESSENTIAL_BUILTIN_TOOL_NAMES } from "../src/tools/essential-tools";

const RUNTIME_TOOLS = ["run", "check", "build", "insights", "profile"] as const;

function stubSession(enabled: boolean): ToolSession {
	return {
		settings: { get: (key: string) => (key === "runtime.enabled" ? enabled : undefined) },
		getRuntimeService: () => undefined,
	} as unknown as ToolSession;
}

describe("runtime tool registry", () => {
	test("all five runtime tools are builtin names", () => {
		for (const name of RUNTIME_TOOLS) expect(BUILTIN_TOOL_NAMES).toContain(name);
	});

	test("no runtime tool name collides with a legacy alias", () => {
		for (const name of RUNTIME_TOOLS) expect(normalizeToolName(name)).toBe(name);
	});

	test("run/check/build are essential; insights/profile are not", () => {
		expect(ESSENTIAL_BUILTIN_TOOL_NAMES.run).toBe(true);
		expect(ESSENTIAL_BUILTIN_TOOL_NAMES.check).toBe(true);
		expect(ESSENTIAL_BUILTIN_TOOL_NAMES.build).toBe(true);
		expect("insights" in ESSENTIAL_BUILTIN_TOOL_NAMES).toBe(false);
		expect("profile" in ESSENTIAL_BUILTIN_TOOL_NAMES).toBe(false);
	});

	test("factories gate on runtime.enabled", async () => {
		for (const name of RUNTIME_TOOLS) {
			expect(await BUILTIN_TOOLS[name](stubSession(false))).toBeNull();
			const tool = await BUILTIN_TOOLS[name](stubSession(true));
			expect(tool).not.toBeNull();
			expect(tool?.name).toBe(name);
		}
	});
});
