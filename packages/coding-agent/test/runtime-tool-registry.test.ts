import { describe, expect, test } from "bun:test";
import { toolWireSchema } from "@oh-my-pi/pi-ai";
import { BUILTIN_TOOLS, type ToolSession } from "../src/tools";
import { BUILTIN_TOOL_NAMES, normalizeToolName } from "../src/tools/builtin-names";
import { ESSENTIAL_BUILTIN_TOOL_NAMES } from "../src/tools/essential-tools";

const RUNTIME_TOOLS = ["insights", "profile", "serve"] as const;

/** The long-running flow supervised by hub rather than by the runtime layer. */
const LAUNCH_TOOLS = ["serve"] as const;

const JVM_TOOLS = ["jvm_disassemble", "jvm_format", "jvm_jar", "jvm_deps"] as const;

/**
 * `launch.enabled` defaults on, as the schema does: it is a second gate only
 * `serve` reads, so every other case here wants it out of the way.
 */
function stubSession(enabled: boolean, launchEnabled = true): ToolSession {
	return {
		settings: {
			get: (key: string) => {
				if (key === "runtime.enabled") return enabled;
				if (key === "launch.enabled") return launchEnabled;
				return undefined;
			},
		},
		getRuntimeService: () => undefined,
	} as unknown as ToolSession;
}

async function providerPayloadBytes(names: readonly (keyof typeof BUILTIN_TOOLS)[]): Promise<number> {
	let bytes = 0;
	for (const name of names) {
		const tool = await BUILTIN_TOOLS[name](stubSession(true));
		if (!tool) throw new Error(`Expected ${name} to be available`);
		bytes += Buffer.byteLength(tool.description ?? "");
		bytes += Buffer.byteLength(JSON.stringify(toolWireSchema(tool)));
	}
	return bytes;
}

describe("runtime tool registry", () => {
	test("all runtime tools are builtin names", () => {
		for (const name of RUNTIME_TOOLS) expect(BUILTIN_TOOL_NAMES).toContain(name);
	});

	test("no runtime tool name collides with a legacy alias", () => {
		for (const name of RUNTIME_TOOLS) expect(normalizeToolName(name)).toBe(name);
	});

	test("no runtime tool is essential; removed runtime surfaces stay absent", () => {
		// `run` and `check` were the fork's parallel execution surface. `eval` and
		// `bash` own execution now, so nothing in the runtime family is top-level.
		expect(BUILTIN_TOOL_NAMES).not.toContain("run");
		expect(BUILTIN_TOOL_NAMES).not.toContain("check");
		expect("run" in BUILTIN_TOOLS).toBe(false);
		expect("check" in BUILTIN_TOOLS).toBe(false);
		expect("run" in ESSENTIAL_BUILTIN_TOOL_NAMES).toBe(false);
		expect("check" in ESSENTIAL_BUILTIN_TOOL_NAMES).toBe(false);
		expect(BUILTIN_TOOL_NAMES).not.toContain("build");
		expect(BUILTIN_TOOL_NAMES).not.toContain("project_advice");
		expect("build" in BUILTIN_TOOLS).toBe(false);
		expect("project_advice" in BUILTIN_TOOLS).toBe(false);
		expect(BUILTIN_TOOL_NAMES).not.toContain("jvm_javadoc");
		expect("jvm_javadoc" in BUILTIN_TOOLS).toBe(false);
		expect(BUILTIN_TOOL_NAMES).not.toContain("runtime_debug");
		expect("runtime_debug" in BUILTIN_TOOLS).toBe(false);
		for (const name of [...RUNTIME_TOOLS]) {
			expect(name in ESSENTIAL_BUILTIN_TOOL_NAMES).toBe(false);
		}
	});
	test("keeps inherent runtime provider payloads compact", async () => {
		expect(await providerPayloadBytes([...RUNTIME_TOOLS, ...JVM_TOOLS])).toBeLessThanOrEqual(8_500);
	});

	test("the interactive debugger remains the sole debug surface", async () => {
		const debugSession = {
			settings: { get: (key: string) => key === "runtime.enabled" || key === "debug.enabled" },
			getRuntimeService: () => undefined,
		} as unknown as ToolSession;
		const debugTool = await BUILTIN_TOOLS.debug(debugSession);
		expect(debugTool?.name).toBe("debug");
		expect(BUILTIN_TOOL_NAMES).not.toContain("runtime_debug");
		expect(new Set(BUILTIN_TOOL_NAMES).size).toBe(BUILTIN_TOOL_NAMES.length);
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

	/**
	 * The launch family starts hub jobs, so it also answers to upstream's
	 * process-supervision kill switch — a session that turned supervision off must
	 * not be handed a second door to the broker.
	 */
	test("launch tools additionally gate on launch.enabled", async () => {
		for (const name of LAUNCH_TOOLS) {
			expect(await BUILTIN_TOOLS[name](stubSession(true, false))).toBeNull();
		}
		// The rest of the runtime family has no business with process supervision.
		for (const name of RUNTIME_TOOLS.filter(n => !LAUNCH_TOOLS.includes(n as never))) {
			expect(await BUILTIN_TOOLS[name](stubSession(true, false))).not.toBeNull();
		}
	});
});

describe("JVM tool registry", () => {
	test("the four specialized JVM tools are builtin names and jvm_run is removed", () => {
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
