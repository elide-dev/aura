/**
 * Drift guard for doctor's tool-gate report.
 *
 * Doctor no longer transcribes the settings-decidable `createIf` gates: it
 * derives them by constructing each `BUILTIN_TOOLS` factory against a stub
 * session under a settings vector and reading which factories return `null`.
 * That removes the class of drift this file used to catch, so what is left to
 * guard is the *vector* and the *annotations* around the derivation:
 *
 * 1. {@link PERMISSIVE_TOOL_GATE_SETTINGS} is genuinely permissive — under it,
 *    no builtin tool declines to register. A new gate on a setting doctor does
 *    not track (say a future `serve.enabled`) breaks this and is reported as
 *    unattributable instead of silently blamed on an unrelated setting.
 * 2. Every reason doctor prints is attributable: it names a tracked settings key
 *    at its configured value, and restoring that key to its permissive value
 *    really does make the factory produce a tool.
 * 3. {@link SESSION_GATED_TOOL_NAMES} — the one annotation doctor still carries
 *    by hand — stays a subset of the gates that are genuinely not
 *    settings-decidable: every name in it must be a real builtin whose
 *    registration is unchanged by every settings vector below.
 */
import { describe, expect, test } from "bun:test";
import {
	createBuiltinToolGateProbe,
	isolateToolGate,
	PERMISSIVE_TOOL_GATE_SETTINGS,
	resolveToolGating,
	SESSION_GATED_TOOL_NAMES,
	TOOL_GATE_SETTINGS,
	type ToolGateSettings,
} from "@oh-my-pi/pi-coding-agent/cli/doctor-cli";
import { BUILTIN_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/builtin-names";

const ALL_ON = PERMISSIVE_TOOL_GATE_SETTINGS;
const ALL_OFF: ToolGateSettings = {
	runtimeEnabled: false,
	launchEnabled: false,
	debugEnabled: false,
	memoryBackend: "off",
	autolearnEnabled: false,
};

/** One vector per gate, plus the default-install shape and an everything-off shape. */
const VECTORS: [string, ToolGateSettings][] = [
	["everything on (memory.backend = mnemopi)", ALL_ON],
	["default install (memory.backend = off)", { ...ALL_ON, memoryBackend: "off" }],
	["memory.backend = hindsight", { ...ALL_ON, memoryBackend: "hindsight" }],
	["memory.backend = local", { ...ALL_ON, memoryBackend: "local" }],
	["runtime.enabled = false", { ...ALL_ON, runtimeEnabled: false }],
	["launch.enabled = false", { ...ALL_ON, launchEnabled: false }],
	["debug.enabled = false", { ...ALL_ON, debugEnabled: false }],
	["autolearn.enabled = false", { ...ALL_ON, autolearnEnabled: false }],
	["everything off", ALL_OFF],
];

const probe = await createBuiltinToolGateProbe();

/** Doctor's own report over the whole builtin registry, for one vector. */
function gating(vector: ToolGateSettings) {
	return resolveToolGating([...BUILTIN_TOOL_NAMES], vector, probe);
}

describe("doctor derives its tool gates from the real registry", () => {
	test("the permissive vector gates nothing off", async () => {
		const result = await gating(ALL_ON);
		expect(result.gatedOff).toEqual([]);
		expect(result.active).toEqual([...BUILTIN_TOOL_NAMES]);
	});

	test("at least one vector actually gates something off, so the checks are not vacuous", async () => {
		expect((await gating(ALL_OFF)).gatedOff.length).toBeGreaterThan(0);
	});

	for (const [label, vector] of VECTORS) {
		test(`every reason is attributable: ${label}`, async () => {
			for (const { name, reason } of (await gating(vector)).gatedOff) {
				// The reason names at least one tracked key at its configured value…
				const named = TOOL_GATE_SETTINGS.filter(gate =>
					reason.includes(`${gate.key} = ${String(vector[gate.field])}`),
				);
				if (named.length === 0) {
					throw new Error(`doctor blamed no tracked setting for gated-off ${name}: "${reason}"`);
				}
				// …and each named key really is one that blocks this tool on its own.
				for (const gate of named) {
					expect(await probe(name, isolateToolGate(vector, gate))).toBe(false);
				}
			}
		});
	}

	test("session-gated names are real builtins whose registration no settings vector changes", async () => {
		const builtin = new Set<string>(BUILTIN_TOOL_NAMES);
		for (const name of SESSION_GATED_TOOL_NAMES) {
			expect(builtin.has(name)).toBe(true);
			const outcomes = new Set<boolean>();
			for (const [, vector] of VECTORS) outcomes.add(await probe(name, vector));
			// A settings-decidable outcome here would mean doctor is punting on a
			// gate it could have answered.
			expect([...outcomes]).toHaveLength(1);
		}
	});

	test("the runtime and jvm families are the ones runtime.enabled controls", async () => {
		const dropped = (await gating({ ...ALL_ON, runtimeEnabled: false })).gatedOff;
		expect(dropped.map(entry => entry.name).sort()).toEqual(
			["insights", "jvm_deps", "jvm_disassemble", "jvm_format", "jvm_jar", "profile", "serve"].sort(),
		);
		expect(dropped.every(entry => entry.reason === "runtime.enabled = false")).toBe(true);
	});

	/**
	 * serve is the one runtime tool with a second gate: it starts a hub job, so
	 * upstream's process-supervision kill switch withholds it even with the whole
	 * runtime family enabled. hub itself is not in this list because it always
	 * registers and refuses per-op instead.
	 *
	 * It is also the only conjunction in the registry, so it is where the derived
	 * reason has to prove itself: name the key that actually withheld the tool,
	 * and when both did, name both — fixing one of them would not bring serve back.
	 */
	test("launch.enabled = false drops serve and nothing else", async () => {
		expect((await gating({ ...ALL_ON, launchEnabled: false })).gatedOff).toEqual([
			{ name: "serve", reason: "launch.enabled = false" },
		]);
	});

	test("serve's reason names whichever of its two gates is off", async () => {
		const runtimeOff = (await gating({ ...ALL_ON, runtimeEnabled: false })).gatedOff;
		expect(runtimeOff.find(entry => entry.name === "serve")?.reason).toBe("runtime.enabled = false");

		const bothOff = (await gating({ ...ALL_ON, runtimeEnabled: false, launchEnabled: false })).gatedOff;
		expect(bothOff.find(entry => entry.name === "serve")?.reason).toBe(
			"runtime.enabled = false and launch.enabled = false",
		);
	});

	test("memory.backend = off drops exactly the memory tool family", async () => {
		const dropped = (await gating({ ...ALL_ON, memoryBackend: "off" })).gatedOff;
		expect(dropped.map(entry => entry.name).sort()).toEqual(
			["learn", "memory_edit", "recall", "reflect", "retain"].sort(),
		);
		expect(dropped.every(entry => entry.reason === "memory.backend = off")).toBe(true);
	});
});
