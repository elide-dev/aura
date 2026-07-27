import { describe, expect, test } from "bun:test";
import { BUILTIN_TOOLS, type ToolSession } from "../src/tools";
import { BUILTIN_TOOL_NAMES, normalizeToolName } from "../src/tools/builtin-names";
import { ESSENTIAL_BUILTIN_TOOL_NAMES } from "../src/tools/essential-tools";

const RUNTIME_TOOLS = ["run", "check", "build", "insights", "profile"] as const;

const JVM_TOOLS = ["jvm_run", "jvm_disassemble", "jvm_format", "jvm_jar", "jvm_deps", "jvm_javadoc"] as const;

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

describe("JVM tool registry", () => {
	test("all six JVM tools are builtin names", () => {
		for (const name of JVM_TOOLS) expect(BUILTIN_TOOL_NAMES).toContain(name);
	});

	test("no JVM tool name collides with a legacy alias", () => {
		for (const name of JVM_TOOLS) expect(normalizeToolName(name)).toBe(name);
	});

	test("no JVM tool is essential — they are reached through discovery", () => {
		for (const name of JVM_TOOLS) expect(name in ESSENTIAL_BUILTIN_TOOL_NAMES).toBe(false);
	});

	test("factories gate on runtime.enabled and declare the discoverable load mode", async () => {
		for (const name of JVM_TOOLS) {
			expect(await BUILTIN_TOOLS[name](stubSession(false))).toBeNull();
			const tool = await BUILTIN_TOOLS[name](stubSession(true));
			expect(tool).not.toBeNull();
			expect(tool?.name).toBe(name);
			expect(tool?.loadMode).toBe("discoverable");
			expect(tool?.approval).toBe("exec");
		}
	});

	test("descriptions never name the runtime product and say what a JVM tool runs on", async () => {
		for (const name of JVM_TOOLS) {
			const tool = await BUILTIN_TOOLS[name](stubSession(true));
			const text = `${tool?.description ?? ""} ${tool?.summary ?? ""} ${tool?.label ?? ""}`;
			expect(text.toLowerCase()).not.toContain("elide");
		}
		const run = await BUILTIN_TOOLS.jvm_run(stubSession(true));
		expect(run?.summary).toContain("embedded JVM");
	});
});
