/**
 * `aura setup runtime` — the third setup component.
 *
 * Two contracts are pinned here. `--check`/`--json` must be the *same* answer
 * `aura runtime status` gives (same probe, same renderer, same exit code, no
 * provisioning), and the bare install path must drive the managed download
 * through the runtime's own `ensureBinary`, so every precondition
 * (`runtime.autoDownload`, an explicit `runtime.path`, an off-pin
 * `runtime.version`) and every refusal message stays the runtime's, not a copy.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { ensureRuntimeInstalled, formatRuntimeStatus } from "../src/cli/runtime-cli";
import { parseSetupArgs, type RuntimeSetupDependencies, runRuntimeSetup } from "../src/cli/setup-cli";
import { initTheme } from "../src/modes/theme/theme";
import { type ResolvedRuntime, RUNTIME_PROTOCOL_VERSION, type RuntimeSettingsValues } from "../src/runtime";
import { RuntimeRpcError, type RuntimeStatusResult } from "../src/runtime/protocol";

const SETTINGS: RuntimeSettingsValues = {
	enabled: true,
	autoDownload: true,
	path: "",
	version: "",
	adapter: "process",
	embeddedPath: "",
};

const AVAILABLE: RuntimeStatusResult = {
	available: true,
	version: "1.4.1",
	binaryPath: "/opt/aura/runtime/1.4.1/bin/elide",
	source: "managed",
	protocolVersion: RUNTIME_PROTOCOL_VERSION,
	adapter: "auto",
	effectiveAdapter: "embedded",
	embeddedLibraryPath: "/opt/aura/runtime/1.4.1/lib/libelide_embed.so",
	embeddedLibrarySource: "managed",
	embeddedAbiVersion: 1,
	embeddedSchemaHash: "8a6b5aa3",
};

const MISSING: RuntimeStatusResult = {
	available: false,
	guidance: "The runtime is not installed. It downloads automatically on first use…",
	protocolVersion: RUNTIME_PROTOCOL_VERSION,
};

interface Harness {
	deps: RuntimeSetupDependencies;
	output: () => string;
	installs: RuntimeSettingsValues[];
	probes: number;
	closes: number;
}

/**
 * `statuses` is consumed one per probe, so the install path's before/after pair
 * can differ; the last entry repeats.
 */
function harness(
	statuses: RuntimeStatusResult[],
	options: {
		settings?: Partial<RuntimeSettingsValues>;
		install?: (values: RuntimeSettingsValues, onProgress: (message: string) => void) => Promise<ResolvedRuntime>;
		statusError?: Error;
	} = {},
): Harness {
	const lines: string[] = [];
	const state = { probes: 0, closes: 0 };
	const installs: RuntimeSettingsValues[] = [];
	const deps: RuntimeSetupDependencies = {
		readSettings: () => ({ ...SETTINGS, ...options.settings }),
		createRuntime: values =>
			values.enabled
				? {
						status: async () => {
							if (options.statusError) throw options.statusError;
							const status = statuses[Math.min(state.probes, statuses.length - 1)];
							state.probes += 1;
							if (!status) throw new Error("no status fixture");
							return status;
						},
						close: async () => {
							state.closes += 1;
						},
					}
				: { disabled: true },
		install: async (values, onProgress) => {
			installs.push(values);
			if (options.install) return options.install(values, onProgress);
			onProgress("Downloading runtime 1.4.1…");
			return { binaryPath: "/opt/aura/runtime/1.4.1/bin/elide", source: "managed" };
		},
		print: line => lines.push(line),
		progress: text => lines.push(text),
	};
	return {
		deps,
		output: () => lines.join("\n"),
		installs,
		get probes() {
			return state.probes;
		},
		get closes() {
			return state.closes;
		},
	};
}

describe("aura setup runtime", () => {
	// The command initializes the theme before dispatching (`commands/setup.ts`);
	// the status glyphs these assertions read come from it.
	beforeAll(async () => {
		await initTheme();
	});

	test("`runtime` is a setup component with the shared --check/--json flags", () => {
		expect(parseSetupArgs(["setup", "runtime", "--check"])).toEqual({
			component: "runtime",
			flags: { check: true },
		});
		expect(parseSetupArgs(["setup", "runtime", "-c"])?.flags).toEqual({ check: true });
		expect(parseSetupArgs(["setup", "runtime", "--json"])?.flags).toEqual({ json: true });
	});

	test("the setup command advertises runtime alongside python and speech", async () => {
		const Setup = (await import("../src/commands/setup")).default;
		expect(Setup.args.component.options).toEqual(["python", "speech", "runtime"]);
	});

	test("--check renders exactly the `aura runtime status` block and exits 0", async () => {
		const h = harness([AVAILABLE]);
		expect(await runRuntimeSetup({ check: true }, h.deps)).toBe(0);
		expect(h.output()).toBe(formatRuntimeStatus(AVAILABLE));
		expect(h.installs).toHaveLength(0);
		expect(h.closes).toBe(1);
	});

	// The whole point of `--check`: report, never provision.
	test("--check on a missing runtime prints the guidance, exits 1, and installs nothing", async () => {
		const h = harness([MISSING]);
		expect(await runRuntimeSetup({ check: true }, h.deps)).toBe(1);
		expect(h.output()).toContain("runtime: unavailable");
		expect(h.output()).toContain("downloads automatically on first use");
		expect(h.installs).toHaveLength(0);
	});

	test("--json emits the runtime status document verbatim", async () => {
		const h = harness([AVAILABLE]);
		expect(await runRuntimeSetup({ json: true }, h.deps)).toBe(0);
		expect(JSON.parse(h.output())).toEqual(AVAILABLE);
		expect(h.installs).toHaveLength(0);
	});

	test("runtime.enabled = false is reported without probing or installing", async () => {
		const h = harness([AVAILABLE], { settings: { enabled: false } });
		expect(await runRuntimeSetup({}, h.deps)).toBe(1);
		expect(h.output()).toContain("runtime.enabled = false");
		expect(h.output()).toContain("runtime.enabled true");
		expect(h.probes).toBe(0);
		expect(h.installs).toHaveLength(0);
	});

	test("an already-available runtime is reported ready without downloading", async () => {
		const h = harness([AVAILABLE]);
		expect(await runRuntimeSetup({}, h.deps)).toBe(0);
		expect(h.output()).toContain("runtime: available");
		expect(h.installs).toHaveLength(0);
	});

	test("the install path provisions the managed runtime, then re-probes", async () => {
		const h = harness([MISSING, AVAILABLE]);
		expect(await runRuntimeSetup({}, h.deps)).toBe(0);
		expect(h.installs).toEqual([SETTINGS]);
		expect(h.output()).toContain("Downloading runtime 1.4.1…");
		expect(h.output()).toContain("runtime: available");
		// Once before the install and once after: the report is the real state.
		expect(h.probes).toBe(2);
		expect(h.closes).toBe(2);
	});

	test("a refused provision reports the runtime's own guidance and exits 1", async () => {
		const h = harness([MISSING], {
			install: async () => {
				throw new RuntimeRpcError("runtime-missing", "runtime.autoDownload is off; set runtime.path instead.");
			},
		});
		expect(await runRuntimeSetup({}, h.deps)).toBe(1);
		expect(h.output()).toContain("runtime.autoDownload is off");
	});

	test("an install that lands an unusable runtime still exits nonzero", async () => {
		const h = harness([MISSING, MISSING]);
		expect(await runRuntimeSetup({}, h.deps)).toBe(1);
		expect(h.installs).toHaveLength(1);
	});

	test("a status probe that throws is reported instead of triggering a download", async () => {
		const h = harness([AVAILABLE], { statusError: new Error("endpoint exploded") });
		expect(await runRuntimeSetup({}, h.deps)).toBe(1);
		expect(h.output()).toContain("endpoint exploded");
		expect(h.installs).toHaveLength(0);
	});
});

describe("ensureRuntimeInstalled", () => {
	const absent = async () => null;

	test("provisions the pinned managed runtime when auto-download is on", async () => {
		const progress: string[] = [];
		let provisioned: { version?: string; targetRoot?: string } | undefined;
		const resolved = await ensureRuntimeInstalled(SETTINGS, message => progress.push(message), {
			resolve: absent,
			provision: async (opts = {}) => {
				provisioned = { version: opts.version, targetRoot: opts.targetRoot };
				opts.onProgress?.("Downloading runtime…");
				return "/tmp/aura-runtime/bin/elide";
			},
			managedRoot: "/tmp/aura-runtime",
		});
		expect(resolved).toEqual({ binaryPath: "/tmp/aura-runtime/bin/elide", source: "managed" });
		expect(provisioned).toEqual({ version: undefined, targetRoot: "/tmp/aura-runtime" });
		expect(progress).toEqual(["Downloading runtime…"]);
	});

	// The preconditions live in the runtime endpoint, not in the setup command:
	// these two cases must produce the endpoint's own refusal, unmodified.
	test("refuses to download when runtime.autoDownload is off", async () => {
		const error = await ensureRuntimeInstalled({ ...SETTINGS, autoDownload: false }, () => {}, {
			resolve: absent,
			provision: async () => "/never",
		}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(RuntimeRpcError);
		expect((error as RuntimeRpcError).message).toContain("runtime.autoDownload");
	});

	test("refuses to download an off-pin runtime.version", async () => {
		const error = await ensureRuntimeInstalled({ ...SETTINGS, version: "0.0.1-not-pinned" }, () => {}, {
			resolve: absent,
			provision: async () => "/never",
		}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(RuntimeRpcError);
		expect((error as RuntimeRpcError).message).toContain("0.0.1-not-pinned");
	});

	test("an existing install short-circuits the download", async () => {
		let provisions = 0;
		const resolved = await ensureRuntimeInstalled(SETTINGS, () => {}, {
			resolve: async () => ({ binaryPath: "/opt/rt/bin/elide", source: "managed" }),
			provision: async () => {
				provisions += 1;
				return "/never";
			},
		});
		expect(resolved).toEqual({ binaryPath: "/opt/rt/bin/elide", source: "managed" });
		expect(provisions).toBe(0);
	});

	test("a disabled runtime is refused rather than silently provisioned", async () => {
		const error = await ensureRuntimeInstalled({ ...SETTINGS, enabled: false }, () => {}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(RuntimeRpcError);
		expect((error as RuntimeRpcError).message).toContain("runtime.enabled");
	});
});
