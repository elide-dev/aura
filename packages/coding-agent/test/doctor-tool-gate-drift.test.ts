/**
 * Drift guard for doctor's tool-gate table.
 *
 * `resolveToolGating` transcribes the settings-decidable `createIf` gates from
 * the tool classes. A transcription is a second source of truth, so this test
 * derives the truth *empirically* from the real `BUILTIN_TOOLS` registry —
 * constructing each tool against a stub session under a given settings vector
 * and recording which factories return `null` — then asserts doctor predicts
 * the same set. A future `jvm_*` tool, or a gate that changes which backends it
 * accepts, fails here instead of silently making `aura doctor` lie.
 *
 * The {@link SESSION_GATED_TOOL_NAMES} entries are excluded from the comparison
 * on purpose: their gates read the live session (`hasUI`, top-level-ness,
 * `enableLsp`) or run an external probe (`gh`), which is exactly why doctor
 * declines to decide them.
 */
import { describe, expect, test } from "bun:test";
import {
	resolveToolGating,
	SESSION_GATED_TOOL_NAMES,
	type ToolGateSettings,
} from "@oh-my-pi/pi-coding-agent/cli/doctor-cli";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { BUILTIN_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/builtin-names";
import { BUILTIN_TOOLS, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";

/** Settings keys the gate table claims to read, mapped from the vector under test. */
function settingsFor(vector: ToolGateSettings): Record<string, unknown> {
	return {
		"runtime.enabled": vector.runtimeEnabled,
		"debug.enabled": vector.debugEnabled,
		"memory.backend": vector.memoryBackend,
		"autolearn.enabled": vector.autolearnEnabled,
	};
}

/**
 * A stub session sufficient for `createIf`: the gates only read `settings.get`
 * plus a few session flags. Unknown settings keys answer `undefined`, which is
 * safe because no gate under test reads one.
 */
function stubSession(vector: ToolGateSettings): ToolSession {
	const values = settingsFor(vector);
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: { get: (key: string) => values[key] } as unknown as Settings,
		getSessionFile: () => null,
		getSessionId: () => null,
		getSessionSpawns: () => null,
	} as unknown as ToolSession;
}

/** Names excluded from the comparison because their gate is not settings-decidable. */
const EXCLUDED = new Set<string>(SESSION_GATED_TOOL_NAMES);

/**
 * Names the real registry actually produces a tool for, under `vector`.
 *
 * A factory that throws is counted as registering: a throw is a bug or a missing
 * session field, not a gate, and it behaves identically under every vector so it
 * cannot make the comparison drift.
 */
async function registryActive(vector: ToolGateSettings): Promise<Set<string>> {
	const session = stubSession(vector);
	const active = new Set<string>();
	for (const name of BUILTIN_TOOL_NAMES) {
		if (EXCLUDED.has(name)) continue;
		try {
			const tool = await BUILTIN_TOOLS[name](session);
			if (tool !== null && tool !== undefined) active.add(name);
		} catch {
			active.add(name);
		}
	}
	return active;
}

/** Doctor's prediction for the same vector, over the same name set. */
function doctorActive(vector: ToolGateSettings): Set<string> {
	const names = BUILTIN_TOOL_NAMES.filter(name => !EXCLUDED.has(name));
	return new Set(resolveToolGating(names, vector).active);
}

const ALL_ON: ToolGateSettings = {
	runtimeEnabled: true,
	debugEnabled: true,
	memoryBackend: "mnemopi",
	autolearnEnabled: true,
};

/** One vector per gate, plus the default-install shape and an everything-off shape. */
const VECTORS: [string, ToolGateSettings][] = [
	["everything on (memory.backend = mnemopi)", ALL_ON],
	["default install (memory.backend = off)", { ...ALL_ON, memoryBackend: "off" }],
	["memory.backend = hindsight", { ...ALL_ON, memoryBackend: "hindsight" }],
	["memory.backend = local", { ...ALL_ON, memoryBackend: "local" }],
	["runtime.enabled = false", { ...ALL_ON, runtimeEnabled: false }],
	["debug.enabled = false", { ...ALL_ON, debugEnabled: false }],
	["autolearn.enabled = false", { ...ALL_ON, autolearnEnabled: false }],
	["everything off", { runtimeEnabled: false, debugEnabled: false, memoryBackend: "off", autolearnEnabled: false }],
];

describe("doctor's tool-gate table matches the real registry", () => {
	for (const [label, vector] of VECTORS) {
		test(label, async () => {
			const fromRegistry = [...(await registryActive(vector))].sort();
			const fromDoctor = [...doctorActive(vector)].sort();
			expect(fromDoctor).toEqual(fromRegistry);
		});
	}

	test("at least one vector actually gates something off, so the comparison is not vacuous", async () => {
		const allOn = await registryActive(ALL_ON);
		const allOff = await registryActive({
			runtimeEnabled: false,
			debugEnabled: false,
			memoryBackend: "off",
			autolearnEnabled: false,
		});
		expect(allOff.size).toBeLessThan(allOn.size);
	});

	test("the runtime and jvm families are the ones runtime.enabled controls", async () => {
		const on = await registryActive(ALL_ON);
		const off = await registryActive({ ...ALL_ON, runtimeEnabled: false });
		const dropped = [...on].filter(name => !off.has(name)).sort();
		expect(dropped).toEqual(
			[
				"build",
				"check",
				"insights",
				"jvm_deps",
				"jvm_disassemble",
				"jvm_format",
				"jvm_jar",
				"jvm_javadoc",
				"profile",
				// Read-only, but registered on the same gate: no runtime, no advice.
				"project_advice",
				"run",
				// The two long-running flows ride the same gate.
				"runtime_debug",
				"serve",
			].sort(),
		);
	});

	test("memory.backend = off drops exactly the memory tool family", async () => {
		const on = await registryActive(ALL_ON);
		const off = await registryActive({ ...ALL_ON, memoryBackend: "off" });
		const dropped = [...on].filter(name => !off.has(name)).sort();
		expect(dropped).toEqual(["learn", "memory_edit", "recall", "reflect", "retain"].sort());
	});
});
