import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildDoctorReport,
	DEFAULT_TOOL_GATE_SETTINGS,
	type DoctorInput,
	type DoctorReport,
	formatCheckLine,
	formatDoctorReport,
	resolveToolGating,
	runDoctorCommand,
	SESSION_GATED_TOOL_NAMES,
	SETTINGS_GATED_TOOL_NAMES,
	type ToolGateSettings,
} from "../src/cli/doctor-cli";
import { BUILTIN_TOOL_NAMES } from "../src/tools/builtin-names";

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
		tools: { available: ["read", "bash", "run"], active: ["read", "bash", "run"], gatedOff: [], sessionGated: [] },
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
					available: ["read", "bash", "run", "check"],
					active: ["read", "bash"],
					gatedOff: [
						{ name: "run", reason: "runtime.enabled = false" },
						{ name: "check", reason: "runtime.enabled = false" },
					],
					sessionGated: [],
				},
			}),
		);
		const entries = section(report, "tools").entries;
		expect(entries.map(e => e.detail).join(" ")).toContain("2/4");
		// The gated-off names are named, with the reason, so a missing tool is diagnosable.
		const gated = entries.find(e => e.label === "gated off");
		expect(gated?.detail).toContain("run, check");
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

describe("resolveToolGating", () => {
	const ALL_ON: ToolGateSettings = {
		runtimeEnabled: true,
		debugEnabled: true,
		memoryBackend: "mnemopi",
		autolearnEnabled: true,
	};
	const MEMORY_TOOLS = ["retain", "recall", "reflect", "memory_edit"];
	const RUNTIME_TOOLS = [
		"run",
		"check",
		"build",
		"insights",
		"profile",
		"jvm_run",
		"jvm_disassemble",
		"jvm_format",
		"jvm_jar",
		"jvm_deps",
		"jvm_javadoc",
	];

	test("everything on registers every name", () => {
		const result = resolveToolGating(
			[...RUNTIME_TOOLS, ...MEMORY_TOOLS, "debug", "learn", "manage_skill", "read"],
			ALL_ON,
		);
		expect(result.gatedOff).toEqual([]);
		expect(result.active).toHaveLength(RUNTIME_TOOLS.length + MEMORY_TOOLS.length + 4);
	});

	// The bug this pins: on a default install (`memory.backend: off`) doctor used
	// to print retain/recall/reflect/memory_edit as registered while the memory
	// section of the SAME report said no backend was configured.
	test("memory.backend = off gates off every memory tool", () => {
		const result = resolveToolGating([...MEMORY_TOOLS, "read"], { ...ALL_ON, memoryBackend: "off" });
		for (const name of MEMORY_TOOLS) {
			expect(result.active).not.toContain(name);
			expect(result.gatedOff.find(g => g.name === name)?.reason).toContain("memory.backend = off");
		}
		expect(result.active).toEqual(["read"]);
	});

	test("memory_edit needs mnemopi specifically, the rest accept hindsight", () => {
		const result = resolveToolGating(MEMORY_TOOLS, { ...ALL_ON, memoryBackend: "hindsight" });
		expect(result.active).toEqual(["retain", "recall", "reflect"]);
		expect(result.gatedOff.map(g => g.name)).toEqual(["memory_edit"]);
	});

	test("runtime.enabled = false gates off exactly the runtime and jvm tools", () => {
		const result = resolveToolGating([...RUNTIME_TOOLS, "read", "retain"], { ...ALL_ON, runtimeEnabled: false });
		expect(result.gatedOff.map(g => g.name).sort()).toEqual([...RUNTIME_TOOLS].sort());
		expect(result.gatedOff.every(g => g.reason === "runtime.enabled = false")).toBe(true);
		expect(result.active).toEqual(["read", "retain"]);
	});

	test("debug.enabled = false gates off debug only", () => {
		const result = resolveToolGating(["debug", "read"], { ...ALL_ON, debugEnabled: false });
		expect(result.gatedOff).toEqual([{ name: "debug", reason: "debug.enabled = false" }]);
	});

	test("autolearn.enabled = false gates off learn and manage_skill", () => {
		const result = resolveToolGating(["learn", "manage_skill", "read"], { ...ALL_ON, autolearnEnabled: false });
		expect(result.gatedOff.map(g => g.name)).toEqual(["learn", "manage_skill"]);
		expect(result.gatedOff.every(g => g.reason === "autolearn.enabled = false")).toBe(true);
	});

	test("learn accepts the local backend where the memory tools do not", () => {
		const result = resolveToolGating(["learn", "retain"], { ...ALL_ON, memoryBackend: "local" });
		expect(result.active).toEqual(["learn"]);
		expect(result.gatedOff.map(g => g.name)).toEqual(["retain"]);
	});

	test("session-gated names are reported but stay active", () => {
		const result = resolveToolGating([...SESSION_GATED_TOOL_NAMES, "read"], ALL_ON);
		expect(result.sessionGated).toEqual([...SESSION_GATED_TOOL_NAMES]);
		for (const name of SESSION_GATED_TOOL_NAMES) expect(result.active).toContain(name);
	});

	test("sessionGated never lists a name that is not available", () => {
		expect(resolveToolGating(["read"], ALL_ON).sessionGated).toEqual([]);
	});

	test("the unreadable-settings fallback matches the settings-schema defaults", async () => {
		const { SETTINGS_SCHEMA } = await import("../src/config/settings-schema");
		expect(DEFAULT_TOOL_GATE_SETTINGS.autolearnEnabled).toBe(SETTINGS_SCHEMA["autolearn.enabled"].default);
		expect(DEFAULT_TOOL_GATE_SETTINGS.runtimeEnabled).toBe(SETTINGS_SCHEMA["runtime.enabled"].default);
		expect(DEFAULT_TOOL_GATE_SETTINGS.debugEnabled).toBe(SETTINGS_SCHEMA["debug.enabled"].default);
		expect(DEFAULT_TOOL_GATE_SETTINGS.memoryBackend).toBe(SETTINGS_SCHEMA["memory.backend"].default);
	});

	test("every gated name is a real builtin tool name", () => {
		const builtin = new Set<string>(BUILTIN_TOOL_NAMES);
		for (const name of [...SETTINGS_GATED_TOOL_NAMES, ...SESSION_GATED_TOOL_NAMES]) {
			expect(builtin.has(name)).toBe(true);
		}
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
