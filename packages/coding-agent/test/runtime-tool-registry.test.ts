import { describe, expect, test } from "bun:test";
import { BUILTIN_TOOLS, type ToolSession } from "../src/tools";
import { BUILTIN_TOOL_NAMES, normalizeToolName } from "../src/tools/builtin-names";
import { ESSENTIAL_BUILTIN_TOOL_NAMES } from "../src/tools/essential-tools";

const RUNTIME_TOOLS = ["run", "check", "build", "insights", "profile", "runtime_debug", "serve"] as const;

/** The two long-running flows, supervised by hub rather than by the runtime layer. */
const LAUNCH_TOOLS = ["runtime_debug", "serve"] as const;

const JVM_TOOLS = ["jvm_disassemble", "jvm_format", "jvm_jar", "jvm_deps", "jvm_javadoc"] as const;

function stubSession(enabled: boolean): ToolSession {
	return {
		settings: { get: (key: string) => (key === "runtime.enabled" ? enabled : undefined) },
		getRuntimeService: () => undefined,
	} as unknown as ToolSession;
}

describe("runtime tool registry", () => {
	test("all runtime tools are builtin names", () => {
		for (const name of RUNTIME_TOOLS) expect(BUILTIN_TOOL_NAMES).toContain(name);
	});

	test("no runtime tool name collides with a legacy alias", () => {
		for (const name of RUNTIME_TOOLS) expect(normalizeToolName(name)).toBe(name);
	});

	test("run/check/build are essential; insights/profile/debug/serve are not", () => {
		expect(ESSENTIAL_BUILTIN_TOOL_NAMES.run).toBe(true);
		expect(ESSENTIAL_BUILTIN_TOOL_NAMES.check).toBe(true);
		expect(ESSENTIAL_BUILTIN_TOOL_NAMES.build).toBe(true);
		for (const name of ["insights", "profile", ...LAUNCH_TOOLS]) {
			expect(name in ESSENTIAL_BUILTIN_TOOL_NAMES).toBe(false);
		}
	});

	test("the runtime debug tool does NOT claim the built-in `debug` name", async () => {
		// `debug` is the interactive stepping debugger (DebugTool) and must stay so:
		// a collision here would silently replace it in the registry.
		const debugSession = {
			settings: { get: (key: string) => key === "runtime.enabled" || key === "debug.enabled" },
			getRuntimeService: () => undefined,
		} as unknown as ToolSession;
		const debugTool = await BUILTIN_TOOLS.debug(debugSession);
		expect(debugTool?.name).toBe("debug");
		expect(debugTool?.label).not.toBe("Runtime Debug");
		const runtimeDebug = await BUILTIN_TOOLS.runtime_debug(stubSession(true));
		expect(runtimeDebug?.name).toBe("runtime_debug");
		// The registry is keyed by name, so a second `debug` entry could only appear
		// as a duplicate in the name list — assert there are none at all.
		expect(new Set(BUILTIN_TOOL_NAMES).size).toBe(BUILTIN_TOOL_NAMES.length);
		// And no launch tool is reachable under a legacy alias for another tool.
		for (const name of LAUNCH_TOOLS) expect(normalizeToolName(name)).toBe(name);
	});

	test("launch tools are discoverable, exec-approved, and never say the product name", async () => {
		for (const name of LAUNCH_TOOLS) {
			const tool = await BUILTIN_TOOLS[name](stubSession(true));
			expect(tool?.loadMode).toBe("discoverable");
			expect(tool?.approval).toBe("exec");
			const text = `${tool?.description ?? ""} ${tool?.summary ?? ""} ${tool?.label ?? ""}`;
			expect(text.toLowerCase()).not.toContain("elide");
			// The handle is a hub job name — that is the whole point of the design.
			expect(text).toContain("hub");
		}
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
	test("the five specialized JVM tools are builtin names and jvm_run is removed", () => {
		for (const name of JVM_TOOLS) expect(BUILTIN_TOOL_NAMES).toContain(name);
		expect(BUILTIN_TOOL_NAMES).not.toContain("jvm_run");
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

	test("descriptions never name the runtime product", async () => {
		for (const name of JVM_TOOLS) {
			const tool = await BUILTIN_TOOLS[name](stubSession(true));
			const text = `${tool?.description ?? ""} ${tool?.summary ?? ""} ${tool?.label ?? ""}`;
			expect(text.toLowerCase()).not.toContain("elide");
		}
	});
});

describe("project_advice registry", () => {
	test("is a builtin name, collides with no legacy alias, and is not essential", () => {
		expect(BUILTIN_TOOL_NAMES).toContain("project_advice");
		expect(normalizeToolName("project_advice")).toBe("project_advice");
		expect("project_advice" in ESSENTIAL_BUILTIN_TOOL_NAMES).toBe(false);
		expect(new Set(BUILTIN_TOOL_NAMES).size).toBe(BUILTIN_TOOL_NAMES.length);
	});

	test("gates on runtime.enabled and is the one read-approved runtime tool", async () => {
		expect(await BUILTIN_TOOLS.project_advice(stubSession(false))).toBeNull();
		const tool = await BUILTIN_TOOLS.project_advice(stubSession(true));
		expect(tool?.name).toBe("project_advice");
		expect(tool?.loadMode).toBe("discoverable");
		expect(tool?.approval).toBe("read");
		for (const name of [...RUNTIME_TOOLS, ...JVM_TOOLS]) {
			expect((await BUILTIN_TOOLS[name](stubSession(true)))?.approval).toBe("exec");
		}
	});
});
