import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildDoctorReport,
	createToolGateProbe,
	DEFAULT_TOOL_GATE_SETTINGS,
	type DoctorInput,
	type DoctorReport,
	formatCheckLine,
	formatDoctorReport,
	gatherDoctorInput,
	PERMISSIVE_TOOL_GATE_SETTINGS,
	resolveToolGating,
	runDoctorCommand,
	SESSION_GATED_TOOL_NAMES,
	type ToolGateProbe,
	type ToolGateSettings,
} from "../src/cli/doctor-cli";
import { RuntimeService } from "../src/runtime";
import { okResponse, RUNTIME_PROTOCOL_VERSION, RuntimeRpcError } from "../src/runtime/protocol";
import { BUILTIN_TOOL_NAMES } from "../src/tools/builtin-names";
import type { Tool, ToolFactory, ToolSession } from "../src/tools/index";

/**
 * A fully healthy fabricated input. Every branch test starts here and perturbs
 * exactly one field, so a failure names the field that caused it.
 */
function healthyInput(overrides: Partial<DoctorInput> = {}): DoctorInput {
	return {
		identity: {
			appName: "aura",
			version: "17.1.3",
			minBunVersion: "1.3.0",
			bunVersion: "1.3.9",
			configDirName: ".aura",
			agentDir: "/home/u/.aura/agent",
			legacyProjectConfigDir: undefined,
		},
		runtime: {
			enabled: true,
			protocolVersion: 2,
			status: {
				available: true,
				version: "1.4.1",
				binaryPath: "/home/u/.aura/agent/runtime/1.4.1/elide",
				source: "managed",
				protocolVersion: 2,
				adapter: "auto",
				effectiveAdapter: "embedded",
				embeddedLibraryPath: "/home/u/.aura/agent/runtime/1.4.1/lib/libelide_embed.so",
				embeddedLibrarySource: "managed",
				embeddedAbiVersion: 1,
				embeddedSchemaHash: "8a6b5aa3",
			},
		},
		natives: { loaded: true, version: "17.1.3", target: "linux-x64-modern" },
		tools: {
			available: ["read", "bash", "insights"],
			active: ["read", "bash", "insights"],
			gatedOff: [],
			sessionGated: [],
		},
		plugins: { checks: [{ name: "plugins_directory", status: "ok", message: "Found at /x" }] },
		terminal: {
			detectedId: "wezterm",
			columns: 120,
			rows: 40,
			trueColor: true,
			notifyProtocol: "OSC 99 (kitty desktop notifications)",
			osc99Confirmed: true,
			multiplexer: null,
		},
		memory: { backend: "mnemopi", diagnose: true, stats: true },
		...overrides,
	};
}

function section(report: DoctorReport, name: string) {
	const found = report.sections.find(s => s.name === name);
	if (!found) throw new Error(`missing section ${name}: ${report.sections.map(s => s.name).join(", ")}`);
	return found;
}

describe("gatherDoctorInput runtime lifecycle", () => {
	const runtimeSettings = {
		enabled: true,
		autoDownload: false,
		path: "/runtime/bin/elide",
		version: "",
		adapter: "process",
		embeddedPath: "",
	} as const;

	test("closes the status-only runtime service after a successful probe", async () => {
		let closeCount = 0;
		const service = new RuntimeService({
			request: async request =>
				okResponse(request.id, {
					available: true,
					version: "1.4.2",
					protocolVersion: RUNTIME_PROTOCOL_VERSION,
				}),
			close: async () => {
				closeCount += 1;
			},
		});

		const input = await gatherDoctorInput({
			createStatusRuntime: () => service,
			readRuntimeSettings: () => runtimeSettings,
		});

		expect(input.runtime.status).toMatchObject({ available: true, version: "1.4.2" });
		expect(closeCount).toBe(1);
	});

	test("keeps a status failure primary when cleanup also fails", async () => {
		let closeCount = 0;
		const service = new RuntimeService({
			request: async () => {
				throw new RuntimeRpcError("internal", "status probe failed");
			},
			close: async () => {
				closeCount += 1;
				throw new Error("status cleanup failed");
			},
		});

		const input = await gatherDoctorInput({
			createStatusRuntime: () => service,
			readRuntimeSettings: () => runtimeSettings,
		});

		expect(input.runtime.error).toBe("status probe failed");
		expect(closeCount).toBe(1);
	});
});

describe("buildDoctorReport", () => {
	test("healthy input reports every section and exits 0", () => {
		const report = buildDoctorReport(healthyInput());
		expect(report.sections.map(s => s.name)).toEqual([
			"identity",
			"runtime",
			"natives",
			"tools",
			"plugins",
			"terminal",
			"memory",
		]);
		expect(report.hardFailures).toEqual([]);
		expect(report.exitCode).toBe(0);
		expect(report.status).toBe("ok");
	});

	test("identity surfaces app name, version, protocol version and bun versions", () => {
		const report = buildDoctorReport(healthyInput());
		expect(report.app).toBe("aura");
		expect(report.version).toBe("17.1.3");
		expect(report.protocolVersion).toBe(2);
		const details = section(report, "identity").entries.map(e => `${e.label}=${e.detail}`);
		expect(details.join(" ")).toContain("1.3.9");
		expect(details.join(" ")).toContain("1.3.0");
		expect(details.join(" ")).toContain("/home/u/.aura/agent");
	});

	test("legacy config dir is reported when one is on the read path", () => {
		const report = buildDoctorReport(
			healthyInput({
				identity: { ...healthyInput().identity, legacyProjectConfigDir: "/proj/.omp" },
			}),
		);
		const entry = section(report, "identity").entries.find(e => e.label === "legacy config");
		expect(entry?.detail).toContain("/proj/.omp");
		// Informational only: a pre-rebrand project dir is a supported read path.
		expect(report.exitCode).toBe(0);
	});

	test("no legacy dir omits the legacy entry", () => {
		const report = buildDoctorReport(healthyInput());
		expect(section(report, "identity").entries.some(e => e.label === "legacy config")).toBe(false);
	});

	// Hard failure #1: the process is running on a Bun older than the floor.
	test("bun below MIN_BUN_VERSION is a hard failure", () => {
		const report = buildDoctorReport(healthyInput({ identity: { ...healthyInput().identity, bunVersion: "1.2.0" } }));
		expect(report.exitCode).toBe(1);
		expect(report.status).toBe("fail");
		expect(report.hardFailures.join(" ")).toContain("Bun");
		const entry = section(report, "identity").entries.find(e => e.label === "bun");
		expect(entry?.status).toBe("fail");
	});

	test("bun exactly at MIN_BUN_VERSION passes", () => {
		const report = buildDoctorReport(healthyInput({ identity: { ...healthyInput().identity, bunVersion: "1.3.0" } }));
		expect(report.exitCode).toBe(0);
	});

	// Hard failure #2: the runtime is enabled but not usable.
	test("enabled-but-unavailable runtime is a hard failure", () => {
		const report = buildDoctorReport(
			healthyInput({
				runtime: {
					enabled: true,
					protocolVersion: 2,
					status: { available: false, guidance: "point AURA_RUNTIME_BIN at a binary", protocolVersion: 2 },
				},
			}),
		);
		expect(report.exitCode).toBe(1);
		expect(report.hardFailures.join(" ").toLowerCase()).toContain("runtime");
		expect(section(report, "runtime").status).toBe("fail");
		expect(
			section(report, "runtime")
				.entries.map(e => e.detail)
				.join(" "),
		).toContain("AURA_RUNTIME_BIN");
	});

	test("disabled runtime is an optional miss: warn, exit 0", () => {
		const report = buildDoctorReport(healthyInput({ runtime: { enabled: false, protocolVersion: 2 } }));
		expect(report.exitCode).toBe(0);
		expect(report.hardFailures).toEqual([]);
		expect(section(report, "runtime").status).toBe("warn");
		expect(section(report, "runtime").entries[0].detail).toContain("runtime.enabled");
	});

	// One label, one source: the endpoint-reported version when a probe landed,
	// the compiled-in constant otherwise, and a visible warning on skew.
	test("protocol entry prefers the endpoint-reported version", () => {
		const entry = section(buildDoctorReport(healthyInput()), "runtime").entries.find(e => e.label === "protocol");
		expect(entry?.detail).toBe("v2");
		expect(entry?.status).toBe("ok");
	});

	test("protocol entry marks itself as compiled-in when the endpoint was not reached", () => {
		const report = buildDoctorReport(healthyInput({ runtime: { enabled: false, protocolVersion: 2 } }));
		const entry = section(report, "runtime").entries.find(e => e.label === "protocol");
		expect(entry?.detail).toContain("compiled in");
		expect(entry?.detail).toContain("v2");
	});

	test("protocol skew between endpoint and build is warned about, not hidden", () => {
		const report = buildDoctorReport(
			healthyInput({
				runtime: {
					enabled: true,
					protocolVersion: 2,
					status: { available: true, version: "1.4.1", protocolVersion: 1 },
				},
			}),
		);
		const entry = section(report, "runtime").entries.find(e => e.label === "protocol");
		expect(entry?.status).toBe("warn");
		expect(entry?.detail).toContain("v1");
		expect(entry?.detail).toContain("v2");
		// A protocol skew is not one of the two hard failures.
		expect(report.exitCode).toBe(0);
	});

	test("runtime diagnostics render requested/effective adapter and sanitized shortened paths", () => {
		const binaryPath = `${path.join(os.homedir(), ".aura", "runtime", "bin", "runtime")}\u001b[31m`;
		const libraryPath = `${path.join(os.homedir(), ".aura", "runtime", "lib", "libelide_embed.so")}\u001b[32m`;
		const report = buildDoctorReport(
			healthyInput({
				runtime: {
					enabled: true,
					protocolVersion: 2,
					status: {
						available: true,
						version: "1.4.1",
						binaryPath,
						source: "managed",
						protocolVersion: 2,
						adapter: "auto",
						effectiveAdapter: "embedded",
						embeddedLibraryPath: libraryPath,
						embeddedLibrarySource: "env",
						embeddedAbiVersion: 1,
						embeddedSchemaHash: "8a6b5aa3",
					},
				},
			}),
		);
		const entries = section(report, "runtime").entries;
		expect(entries.find(entry => entry.label === "adapter")?.detail).toBe("auto");
		expect(entries.find(entry => entry.label === "effective adapter")?.detail).toBe("embedded");
		expect(entries.find(entry => entry.label === "run engines")?.detail).toContain(
			"JavaScript/TypeScript default to Bun",
		);
		expect(entries.find(entry => entry.label === "binary")?.detail).toBe("~/.aura/runtime/bin/runtime");
		expect(entries.find(entry => entry.label === "embedded runtime library")?.detail).toBe(
			"~/.aura/runtime/lib/libelide_embed.so",
		);
		expect(entries.find(entry => entry.label === "embedded runtime library source")?.detail).toBe("env");
		expect(entries.find(entry => entry.label === "ABI")?.detail).toBe("1");
		expect(entries.find(entry => entry.label === "schema")?.detail).toBe("8a6b5aa3");
		const text = formatDoctorReport(report, { color: false });
		expect(text).not.toContain("\u001b");
		expect(text).not.toContain(os.homedir());
	});

	test("doctor keeps binary and library paths on one sanitized terminal row", () => {
		const home = os.homedir();
		const report = buildDoctorReport(
			healthyInput({
				runtime: {
					enabled: true,
					protocolVersion: 2,
					status: {
						available: true,
						version: "1.4.1",
						binaryPath: `${path.join(home, ".aura", "runtime", "bin", "runtime")}\nforged-binary\trow\u001b[31m`,
						source: "managed",
						protocolVersion: 2,
						adapter: "embedded",
						effectiveAdapter: "embedded",
						embeddedLibraryPath: `${path.join(home, ".aura", "runtime", "lib", "runtime.so")}\nforged-library\trow\u001b[32m`,
						embeddedLibrarySource: "setting",
					},
				},
			}),
		);
		const entries = section(report, "runtime").entries;
		const binaryDetail = entries.find(entry => entry.label === "binary")?.detail;
		const libraryDetail = entries.find(entry => entry.label === "embedded runtime library")?.detail;
		expect(binaryDetail).toContain("~/.aura/runtime/bin/runtime\\nforged-binary");
		expect(libraryDetail).toContain("~/.aura/runtime/lib/runtime.so\\nforged-library");
		expect(binaryDetail?.split("\n")).toHaveLength(1);
		expect(libraryDetail?.split("\n")).toHaveLength(1);
		expect(binaryDetail).not.toContain("\t");
		expect(libraryDetail).not.toContain("\t");
		const text = formatDoctorReport(report, { color: false });
		expect(text).not.toContain("\u001b");
		expect(text).not.toContain(home);
	});

	test("unavailable runtime diagnostics retain adapter selection context", () => {
		const report = buildDoctorReport(
			healthyInput({
				runtime: {
					enabled: true,
					protocolVersion: 2,
					status: {
						available: false,
						guidance: "configure the embedded runtime library",
						protocolVersion: 2,
						adapter: "embedded",
						effectiveAdapter: "embedded",
						embeddedLibraryPath: "/opt/aura/lib/runtime.so",
						embeddedLibrarySource: "setting",
					},
				},
			}),
		);
		const entries = section(report, "runtime").entries;
		expect(entries.find(entry => entry.label === "adapter")?.detail).toBe("embedded");
		expect(entries.find(entry => entry.label === "embedded runtime library")?.detail).toBe(
			"/opt/aura/lib/runtime.so",
		);
		expect(report.exitCode).toBe(1);
	});

	test("runtime probe failure without a status is reported, not thrown", () => {
		const report = buildDoctorReport(
			healthyInput({ runtime: { enabled: true, protocolVersion: 2, error: "spawn EACCES" } }),
		);
		expect(report.exitCode).toBe(1);
		expect(
			section(report, "runtime")
				.entries.map(e => e.detail)
				.join(" "),
		).toContain("spawn EACCES");
	});

	test("missing natives warn but never fail the exit code", () => {
		const report = buildDoctorReport(healthyInput({ natives: { loaded: false, error: "unsupported platform" } }));
		expect(section(report, "natives").status).toBe("warn");
		expect(section(report, "natives").entries[0].detail).toContain("unsupported platform");
		expect(report.exitCode).toBe(0);
	});

	test("natives report version and target when loaded", () => {
		const detail = section(buildDoctorReport(healthyInput()), "natives").entries[0].detail;
		expect(detail).toContain("17.1.3");
		expect(detail).toContain("linux-x64-modern");
	});

	test("tools report the active/available split", () => {
		const report = buildDoctorReport(
			healthyInput({
				tools: {
					available: ["read", "bash", "insights", "profile"],
					active: ["read", "bash"],
					gatedOff: [
						{ name: "insights", reason: "runtime.enabled = false" },
						{ name: "profile", reason: "runtime.enabled = false" },
					],
					sessionGated: [],
				},
			}),
		);
		const entries = section(report, "tools").entries;
		expect(entries.map(e => e.detail).join(" ")).toContain("2/4");
		// The gated-off names are named, with the reason, so a missing tool is diagnosable.
		const gated = entries.find(e => e.label === "gated off");
		expect(gated?.detail).toContain("insights, profile");
		expect(gated?.detail).toContain("runtime.enabled = false");
	});

	test("session-gated names are listed separately and still counted active", () => {
		const report = buildDoctorReport(
			healthyInput({
				tools: { available: ["read", "ask"], active: ["read", "ask"], gatedOff: [], sessionGated: ["ask"] },
			}),
		);
		const entry = section(report, "tools").entries.find(e => e.label === "session-gated");
		expect(entry?.detail).toContain("ask");
		// `github`'s gate is a `gh` probe, not the session, so the wording covers both.
		expect(entry?.detail).toContain("live session or an external tool");
	});

	test("no active tools warns", () => {
		const report = buildDoctorReport(
			healthyInput({ tools: { available: ["read"], active: [], gatedOff: [], sessionGated: [] } }),
		);
		expect(section(report, "tools").status).toBe("warn");
		expect(report.exitCode).toBe(0);
	});

	test("plugin checks map onto entries and an error never fails the exit code", () => {
		const report = buildDoctorReport(
			healthyInput({
				plugins: {
					checks: [
						{ name: "plugins_directory", status: "ok", message: "Found at /x" },
						{ name: "git", status: "warning", message: "not found" },
						{ name: "package.json", status: "error", message: "unreadable" },
					],
				},
			}),
		);
		const entries = section(report, "plugins").entries;
		expect(entries).toHaveLength(3);
		expect(entries.map(e => e.status)).toEqual(["ok", "warn", "fail"]);
		expect(section(report, "plugins").status).toBe("fail");
		expect(report.exitCode).toBe(0);
		expect(report.hardFailures).toEqual([]);
	});

	test("plugin gather error is surfaced as a warning entry", () => {
		const report = buildDoctorReport(healthyInput({ plugins: { checks: [], error: "manager blew up" } }));
		expect(section(report, "plugins").entries[0].detail).toContain("manager blew up");
		expect(report.exitCode).toBe(0);
	});

	test("terminal section reports capabilities read-only", () => {
		const entries = section(buildDoctorReport(healthyInput()), "terminal").entries;
		const joined = entries.map(e => `${e.label}=${e.detail}`).join(" ");
		expect(joined).toContain("wezterm");
		expect(joined).toContain("120x40");
		expect(joined).toContain("OSC 99");
		expect(section(buildDoctorReport(healthyInput()), "terminal").status).toBe("ok");
	});

	test("a failed memory probe is distinct from a backend the user turned off", () => {
		const report = buildDoctorReport(
			healthyInput({ memory: { backend: "unknown", diagnose: false, stats: false, error: "import blew up" } }),
		);
		const detail = section(report, "memory").entries[0].detail;
		expect(detail).toContain("import blew up");
		expect(detail).not.toContain("memory.backend = off");
		expect(section(report, "memory").status).toBe("warn");
		expect(report.exitCode).toBe(0);
	});

	test("memory backend off is an optional miss", () => {
		const report = buildDoctorReport(healthyInput({ memory: { backend: "off", diagnose: false, stats: false } }));
		expect(section(report, "memory").status).toBe("warn");
		expect(report.exitCode).toBe(0);
	});

	test("configured memory backend reports its diagnose/stats hooks", () => {
		const joined = section(buildDoctorReport(healthyInput()), "memory")
			.entries.map(e => e.detail)
			.join(" ");
		expect(joined).toContain("mnemopi");
		expect(joined).toContain("diagnose");
	});

	// Naming rule: no user-facing "Elide" anywhere in the rendered report. The
	// binary path is the one place the vendor name can legitimately appear, and it
	// is a filesystem fact, so the check targets prose only.
	test("report prose never names the runtime vendor", () => {
		const report = buildDoctorReport(healthyInput({ runtime: { enabled: false, protocolVersion: 2 } }));
		const prose = report.sections.flatMap(s => [s.name, ...s.entries.map(e => `${e.label} ${e.detail}`)]).join("\n");
		expect(prose.toLowerCase()).not.toContain("elide");
	});

	test("buildDoctorReport is pure: the same input yields an equal report", () => {
		expect(buildDoctorReport(healthyInput())).toEqual(buildDoctorReport(healthyInput()));
	});
});

/**
 * Machinery tests for the derivation, driven by fabricated gates. The real
 * registry's gates are asserted in `doctor-tool-gate-drift.test.ts`; here the
 * question is only whether doctor reads a factory's answer correctly and
 * attributes it to the right setting.
 */
describe("resolveToolGating", () => {
	const ALL_ON = PERMISSIVE_TOOL_GATE_SETTINGS;

	/** A probe over fabricated `createIf` predicates; unlisted names always register. */
	function probeOver(gates: Record<string, (s: ToolGateSettings) => boolean>): ToolGateProbe {
		return (name, gateSettings) => (gates[name] ?? (() => true))(gateSettings);
	}

	const RUNTIME_GATE = (s: ToolGateSettings) => s.runtimeEnabled;
	const MNEMOPI_GATE = (s: ToolGateSettings) => s.memoryBackend === "mnemopi";

	test("a factory that returns a tool is active, one that returns null is gated off", async () => {
		const result = await resolveToolGating(
			["run", "read"],
			{ ...ALL_ON, runtimeEnabled: false },
			probeOver({ run: RUNTIME_GATE }),
		);
		expect(result.active).toEqual(["read"]);
		expect(result.gatedOff).toEqual([{ name: "run", reason: "runtime.enabled = false" }]);
		expect(result.available).toEqual(["run", "read"]);
	});

	test("nothing is gated off when every gate passes", async () => {
		const result = await resolveToolGating(
			["run", "memory_edit"],
			ALL_ON,
			probeOver({ run: RUNTIME_GATE, memory_edit: MNEMOPI_GATE }),
		);
		expect(result.gatedOff).toEqual([]);
		expect(result.active).toEqual(["run", "memory_edit"]);
	});

	test("the reason quotes the setting's configured value, not a boolean", async () => {
		const result = await resolveToolGating(
			["memory_edit"],
			{ ...ALL_ON, memoryBackend: "hindsight" },
			probeOver({ memory_edit: MNEMOPI_GATE }),
		);
		expect(result.gatedOff).toEqual([{ name: "memory_edit", reason: "memory.backend = hindsight" }]);
	});

	// Attribution, not enumeration: two settings are away from their permissive
	// value, but only one of them is why this tool declines to register.
	test("a restrictive setting the gate does not read is never blamed", async () => {
		const result = await resolveToolGating(
			["run"],
			{ ...ALL_ON, runtimeEnabled: false, memoryBackend: "off" },
			probeOver({ run: RUNTIME_GATE }),
		);
		expect(result.gatedOff).toEqual([{ name: "run", reason: "runtime.enabled = false" }]);
	});

	test("a gate blocked by two settings at once names both", async () => {
		const result = await resolveToolGating(
			["learn"],
			{ ...ALL_ON, autolearnEnabled: false, memoryBackend: "off" },
			probeOver({ learn: s => s.autolearnEnabled && s.memoryBackend !== "off" }),
		);
		const reason = result.gatedOff[0]?.reason ?? "";
		expect(reason).toContain("autolearn.enabled = false");
		expect(reason).toContain("memory.backend = off");
	});

	// The honest answer when a gate reads something outside doctor's vector: say
	// so, rather than blame whichever setting happens to be off.
	test("a gate doctor cannot attribute is reported as unattributed", async () => {
		const result = await resolveToolGating(["mystery"], ALL_ON, probeOver({ mystery: () => false }));
		expect(result.gatedOff[0]?.name).toBe("mystery");
		expect(result.gatedOff[0]?.reason).toContain("runtime.enabled");
		expect(result.gatedOff[0]?.reason).not.toBe("runtime.enabled = false");
	});

	test("session-gated names are never probed and stay active", async () => {
		const probe: ToolGateProbe = name => {
			if (SESSION_GATED_TOOL_NAMES.includes(name)) throw new Error(`probed the session-gated ${name}`);
			return true;
		};
		const result = await resolveToolGating([...SESSION_GATED_TOOL_NAMES, "read"], ALL_ON, probe);
		expect(result.sessionGated).toEqual([...SESSION_GATED_TOOL_NAMES]);
		for (const name of SESSION_GATED_TOOL_NAMES) expect(result.active).toContain(name);
	});

	test("sessionGated never lists a name that is not available", async () => {
		expect((await resolveToolGating(["read"], ALL_ON, probeOver({}))).sessionGated).toEqual([]);
	});

	test("the unreadable-settings fallback matches the settings-schema defaults", async () => {
		const { SETTINGS_SCHEMA } = await import("../src/config/settings-schema");
		expect(DEFAULT_TOOL_GATE_SETTINGS.autolearnEnabled).toBe(SETTINGS_SCHEMA["autolearn.enabled"].default);
		expect(DEFAULT_TOOL_GATE_SETTINGS.runtimeEnabled).toBe(SETTINGS_SCHEMA["runtime.enabled"].default);
		expect(DEFAULT_TOOL_GATE_SETTINGS.debugEnabled).toBe(SETTINGS_SCHEMA["debug.enabled"].default);
		expect(DEFAULT_TOOL_GATE_SETTINGS.memoryBackend).toBe(SETTINGS_SCHEMA["memory.backend"].default);
	});

	test("every session-gated name is a real builtin tool name", () => {
		const builtin = new Set<string>(BUILTIN_TOOL_NAMES);
		for (const name of SESSION_GATED_TOOL_NAMES) expect(builtin.has(name)).toBe(true);
	});
});

describe("createToolGateProbe", () => {
	const TOOL = {} as Tool;
	const factories = (map: Record<string, ToolFactory>) => createToolGateProbe(map);

	test("a null return is the gate; a tool is registration", async () => {
		const probe = factories({ off: () => null, on: () => TOOL });
		expect(await probe("off", PERMISSIVE_TOOL_GATE_SETTINGS)).toBe(false);
		expect(await probe("on", PERMISSIVE_TOOL_GATE_SETTINGS)).toBe(true);
	});

	test("an async factory is awaited before it is read", async () => {
		const probe = factories({ slow: async () => null });
		expect(await probe("slow", PERMISSIVE_TOOL_GATE_SETTINGS)).toBe(false);
	});

	// A throw is a bug or a stub-session gap, not a gate: it happens under every
	// vector, so counting it as registering keeps the report stable.
	test("a factory that throws counts as registering", async () => {
		const probe = factories({
			broken: () => {
				throw new Error("no session file");
			},
		});
		expect(await probe("broken", PERMISSIVE_TOOL_GATE_SETTINGS)).toBe(true);
	});

	test("a name the registry does not know counts as registering", async () => {
		expect(await factories({})("ghost", PERMISSIVE_TOOL_GATE_SETTINGS)).toBe(true);
	});

	test("the stub session answers settings.get for exactly the gate keys", async () => {
		let seen: ToolSession | undefined;
		const probe = factories({
			spy: session => {
				seen = session;
				return TOOL;
			},
		});
		await probe("spy", {
			runtimeEnabled: false,
			launchEnabled: true,
			debugEnabled: true,
			memoryBackend: "hindsight",
			autolearnEnabled: false,
		});
		expect(seen?.settings.get("runtime.enabled")).toBe(false);
		expect(seen?.settings.get("launch.enabled")).toBe(true);
		expect(seen?.settings.get("debug.enabled")).toBe(true);
		expect(seen?.settings.get("memory.backend")).toBe("hindsight");
		expect(seen?.settings.get("autolearn.enabled")).toBe(false);
		expect(seen?.hasUI).toBe(false);
	});
});

describe("formatDoctorReport", () => {
	test("renders one block per section with a summary line", () => {
		const text = formatDoctorReport(buildDoctorReport(healthyInput()), { color: false });
		for (const name of ["identity", "runtime", "natives", "tools", "plugins", "terminal", "memory"]) {
			expect(text).toContain(name);
		}
		expect(text).toContain("aura 17.1.3");
		expect(text).not.toContain("\x1b[");
	});

	test("color mode emits SGR codes", () => {
		expect(formatDoctorReport(buildDoctorReport(healthyInput()), { color: true })).toContain("\x1b[");
	});

	test("hard failures are echoed in the summary", () => {
		const report = buildDoctorReport(healthyInput({ identity: { ...healthyInput().identity, bunVersion: "1.0.0" } }));
		expect(formatDoctorReport(report, { color: false })).toContain("Bun");
	});
});

describe("formatCheckLine", () => {
	test("healthy environment renders a single ready line", () => {
		const line = formatCheckLine(buildDoctorReport(healthyInput()));
		expect(line.split("\n")).toHaveLength(1);
		expect(line).toContain("aura 17.1.3");
		expect(line).toContain("ready");
		expect(line).toContain("runtime available");
	});

	test("hard failure renders a single not-ready line naming the failure", () => {
		const line = formatCheckLine(
			buildDoctorReport(healthyInput({ identity: { ...healthyInput().identity, bunVersion: "1.0.0" } })),
		);
		expect(line.split("\n")).toHaveLength(1);
		expect(line).toContain("not ready");
		expect(line).toContain("Bun");
	});

	test("check line never names the runtime vendor", () => {
		const line = formatCheckLine(
			buildDoctorReport(healthyInput({ runtime: { enabled: false, protocolVersion: 2 } })),
		);
		expect(line.toLowerCase()).not.toContain("elide");
	});
});

describe("runDoctorCommand", () => {
	test("human output prints the sectioned report and returns the exit code", async () => {
		const lines: string[] = [];
		const code = await runDoctorCommand(
			{ flags: {} },
			async () => healthyInput(),
			line => lines.push(line),
		);
		expect(code).toBe(0);
		expect(lines.join("\n")).toContain("runtime");
	});

	test("--json emits the structured report", async () => {
		const lines: string[] = [];
		const code = await runDoctorCommand(
			{ flags: { json: true } },
			async () => healthyInput(),
			line => lines.push(line),
		);
		expect(code).toBe(0);
		const parsed = JSON.parse(lines.join("\n"));
		expect(parsed.app).toBe("aura");
		expect(parsed.exitCode).toBe(0);
		expect(parsed.sections.map((s: { name: string }) => s.name)).toContain("plugins");
	});

	test("nonzero exit propagates through both output modes", async () => {
		const broken = healthyInput({ identity: { ...healthyInput().identity, bunVersion: "1.0.0" } });
		expect(
			await runDoctorCommand(
				{ flags: {} },
				async () => broken,
				() => {},
			),
		).toBe(1);
		expect(
			await runDoctorCommand(
				{ flags: { json: true } },
				async () => broken,
				() => {},
			),
		).toBe(1);
	});

	test("--check prints exactly one line", async () => {
		const lines: string[] = [];
		const code = await runDoctorCommand(
			{ flags: { check: true } },
			async () => healthyInput(),
			line => lines.push(line),
		);
		expect(code).toBe(0);
		expect(lines).toHaveLength(1);
	});
});
