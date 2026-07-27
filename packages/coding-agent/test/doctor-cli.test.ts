import { describe, expect, test } from "bun:test";
import {
	buildDoctorReport,
	type DoctorInput,
	type DoctorReport,
	formatCheckLine,
	formatDoctorReport,
	runDoctorCommand,
} from "../src/cli/doctor-cli";

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
			},
		},
		natives: { loaded: true, version: "17.1.3", target: "linux-x64-modern" },
		tools: { available: ["read", "bash", "run"], active: ["read", "bash", "run"] },
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
			healthyInput({ tools: { available: ["read", "bash", "run", "check"], active: ["read", "bash"] } }),
		);
		const entries = section(report, "tools").entries;
		expect(entries.map(e => e.detail).join(" ")).toContain("2/4");
		// The gated-off names are named so a missing tool is diagnosable.
		expect(entries.map(e => e.detail).join(" ")).toContain("run");
	});

	test("no active tools warns", () => {
		const report = buildDoctorReport(healthyInput({ tools: { available: ["read"], active: [] } }));
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
