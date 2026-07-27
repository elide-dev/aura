/**
 * `aura doctor` / `aura --check` — one-shot environment readiness reporting.
 *
 * Two rules shape this module:
 *
 * 1. **Aggregate, never reimplement.** Every section delegates to the probe that
 *    already owns that surface (`resolveStatusEndpointOptions` +
 *    `formatRuntimeStatus` for the runtime, `PluginManager.doctor` for plugins,
 *    `collectTerminalState` for the terminal, `resolveMemoryBackend` for memory).
 *    Doctor's own contribution is the aggregation and the exit contract.
 * 2. **Pure builder, separate gatherer.** {@link buildDoctorReport} is a pure
 *    function over fabricated-or-gathered data, so every exit-code branch is
 *    unit-testable without a runtime, a terminal, or a plugin tree.
 *
 * No model, no network, no provisioning: the runtime probe forces
 * `autoDownload: false`, and the memory section reports whether the backend's
 * `diagnose`/`stats` hooks exist rather than invoking them (the Hindsight
 * backend's would talk to a server).
 */
import {
	APP_NAME,
	CONFIG_DIR_NAME,
	getAgentDir,
	LEGACY_CONFIG_DIR_NAME,
	MIN_BUN_VERSION,
	VERSION,
} from "@oh-my-pi/pi-utils/dirs";
import type { DoctorCheck } from "../extensibility/plugins/types";
import { RUNTIME_PROTOCOL_VERSION } from "../runtime";
import type { RuntimeStatusResult } from "../runtime/protocol";

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

/** Per-entry severity. `fail` is expressive, not automatically fatal — see {@link DoctorReport.hardFailures}. */
export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorEntry {
	label: string;
	status: DoctorStatus;
	detail: string;
}

export interface DoctorSection {
	name: string;
	/** Worst entry status in the section. */
	status: DoctorStatus;
	entries: DoctorEntry[];
}

export interface DoctorReport {
	app: string;
	version: string;
	protocolVersion: number;
	sections: DoctorSection[];
	/**
	 * Human-readable hard failures. Only two conditions qualify: a Bun older than
	 * `MIN_BUN_VERSION`, and a runtime that is *enabled* but unavailable. Optional
	 * misses (runtime disabled, natives absent, memory backend off, a plugin
	 * check erroring) are reported at their real severity but never land here.
	 */
	hardFailures: string[];
	/** Worst status across all sections. Display only. */
	status: DoctorStatus;
	/** `1` when {@link hardFailures} is non-empty, else `0`. */
	exitCode: number;
}

// ---------------------------------------------------------------------------
// Input shape (what the gatherer collects)
// ---------------------------------------------------------------------------

export interface DoctorIdentityInput {
	appName: string;
	version: string;
	minBunVersion: string;
	bunVersion: string;
	configDirName: string;
	agentDir: string;
	/** Absolute path of a pre-rebrand project config dir that is on the read path, if one exists. */
	legacyProjectConfigDir?: string;
}

export interface DoctorRuntimeInput {
	enabled: boolean;
	protocolVersion: number;
	/** Absent when the runtime is disabled, or when the probe itself threw (`error`). */
	status?: RuntimeStatusResult;
	error?: string;
}

export interface DoctorNativesInput {
	loaded: boolean;
	version?: string;
	target?: string;
	error?: string;
}

export interface DoctorToolsInput {
	/** Every tool name the builtin registry knows. */
	available: string[];
	/** The subset that registers under the current settings. */
	active: string[];
}

export interface DoctorPluginsInput {
	checks: DoctorCheck[];
	error?: string;
}

export interface DoctorTerminalInput {
	detectedId: string;
	columns: number;
	rows: number;
	trueColor: boolean;
	notifyProtocol: string;
	osc99Confirmed: boolean;
	multiplexer: string | null;
}

export interface DoctorMemoryInput {
	/** Backend id (`off` when no backend is configured). */
	backend: string;
	diagnose: boolean;
	stats: boolean;
}

export interface DoctorInput {
	identity: DoctorIdentityInput;
	runtime: DoctorRuntimeInput;
	natives: DoctorNativesInput;
	tools: DoctorToolsInput;
	plugins: DoctorPluginsInput;
	terminal: DoctorTerminalInput;
	memory: DoctorMemoryInput;
}

// ---------------------------------------------------------------------------
// Pure report builder
// ---------------------------------------------------------------------------

const SEVERITY: Record<DoctorStatus, number> = { ok: 0, warn: 1, fail: 2 };

function worst(statuses: readonly DoctorStatus[]): DoctorStatus {
	return statuses.reduce<DoctorStatus>((acc, s) => (SEVERITY[s] > SEVERITY[acc] ? s : acc), "ok");
}

function makeSection(name: string, entries: DoctorEntry[]): DoctorSection {
	return { name, status: worst(entries.map(e => e.status)), entries };
}

/** Bun's own comparator, the same one `cli.ts` gates startup on. */
function bunTooOld(found: string, minimum: string): boolean {
	try {
		return Bun.semver.order(found, minimum) < 0;
	} catch {
		// An unparseable version is not evidence of being too old; report it as-is.
		return false;
	}
}

function identitySection(input: DoctorIdentityInput): DoctorEntry[] {
	const tooOld = bunTooOld(input.bunVersion, input.minBunVersion);
	const entries: DoctorEntry[] = [
		{ label: "app", status: "ok", detail: `${input.appName} ${input.version}` },
		{
			label: "bun",
			status: tooOld ? "fail" : "ok",
			detail: tooOld
				? `v${input.bunVersion} is below the required v${input.minBunVersion} — run \`bun upgrade\``
				: `v${input.bunVersion} (requires >= v${input.minBunVersion})`,
		},
		{ label: "config dir", status: "ok", detail: `${input.configDirName} — ${input.agentDir}` },
	];
	if (input.legacyProjectConfigDir !== undefined) {
		entries.push({
			label: "legacy config",
			status: "ok",
			detail: `reading pre-rebrand project config from ${input.legacyProjectConfigDir} (read-only compatibility)`,
		});
	}
	return entries;
}

function runtimeSection(input: DoctorRuntimeInput): DoctorEntry[] {
	const protocol: DoctorEntry = { label: "protocol", status: "ok", detail: `v${input.protocolVersion}` };
	if (!input.enabled) {
		return [
			{
				label: "state",
				status: "warn",
				detail:
					"disabled (runtime.enabled = false) — the innate run/check/build/insights/profile and jvm_* tools do not register",
			},
			protocol,
		];
	}
	if (input.status === undefined) {
		return [
			{
				label: "state",
				status: "fail",
				detail: `enabled, but the status probe failed: ${input.error ?? "unknown error"}`,
			},
			protocol,
		];
	}
	const status = input.status;
	if (!status.available) {
		return [
			{
				label: "state",
				status: "fail",
				detail: `enabled, but unavailable${status.guidance ? ` — ${status.guidance}` : ""}`,
			},
			protocol,
		];
	}
	const entries: DoctorEntry[] = [
		{ label: "state", status: "ok", detail: `available (version ${status.version ?? "unknown"})` },
	];
	if (status.binaryPath) entries.push({ label: "binary", status: "ok", detail: status.binaryPath });
	if (status.source) entries.push({ label: "source", status: "ok", detail: status.source });
	entries.push({ label: "protocol", status: "ok", detail: `v${status.protocolVersion}` });
	return entries;
}

function nativesSection(input: DoctorNativesInput): DoctorEntry[] {
	if (!input.loaded) {
		return [
			{
				label: "addon",
				status: "warn",
				detail: `not loaded${input.error ? ` — ${input.error}` : ""}`,
			},
		];
	}
	return [
		{
			label: "addon",
			status: "ok",
			detail: `loaded — v${input.version ?? "unknown"} (${input.target ?? "unknown target"})`,
		},
	];
}

function toolsSection(input: DoctorToolsInput): DoctorEntry[] {
	const active = new Set(input.active);
	const inactive = input.available.filter(name => !active.has(name));
	const entries: DoctorEntry[] = [
		{
			label: "registered",
			status: input.active.length === 0 ? "warn" : "ok",
			detail: `${input.active.length}/${input.available.length} — ${input.active.join(", ") || "none"}`,
		},
	];
	if (inactive.length > 0) {
		entries.push({ label: "gated off", status: "ok", detail: inactive.join(", ") });
	}
	return entries;
}

const PLUGIN_STATUS: Record<DoctorCheck["status"], DoctorStatus> = { ok: "ok", warning: "warn", error: "fail" };

function pluginsSection(input: DoctorPluginsInput): DoctorEntry[] {
	if (input.error !== undefined) {
		return [{ label: "checks", status: "warn", detail: `could not run plugin health checks — ${input.error}` }];
	}
	if (input.checks.length === 0) {
		return [{ label: "checks", status: "ok", detail: "no plugin health checks reported" }];
	}
	return input.checks.map(check => ({
		label: check.name,
		status: PLUGIN_STATUS[check.status],
		detail: check.fixed ? `${check.message} (fixed)` : check.message,
	}));
}

function terminalSection(input: DoctorTerminalInput): DoctorEntry[] {
	return [
		{
			label: "detected",
			status: "ok",
			detail: `${input.detectedId}${input.multiplexer ? ` under ${input.multiplexer}` : ""}`,
		},
		{ label: "geometry", status: "ok", detail: `${input.columns}x${input.rows} cells` },
		{ label: "color", status: "ok", detail: input.trueColor ? "true color (24-bit SGR)" : "256-color or plain" },
		{
			label: "notify",
			status: "ok",
			detail: `${input.notifyProtocol}${input.osc99Confirmed ? " · confirmed via DA" : ""}`,
		},
	];
}

function memorySection(input: DoctorMemoryInput): DoctorEntry[] {
	if (input.backend === "off") {
		return [
			{ label: "backend", status: "warn", detail: "off (memory.backend = off) — no memory backend configured" },
		];
	}
	const hooks = [input.diagnose ? "diagnose" : undefined, input.stats ? "stats" : undefined].filter(Boolean);
	return [
		{ label: "backend", status: "ok", detail: input.backend },
		{
			label: "hooks",
			status: "ok",
			detail:
				hooks.length > 0
					? `${hooks.join(", ")} available — run \`/memory ${hooks[0]}\``
					: "this backend exposes no diagnostics hooks",
		},
	];
}

/**
 * Build the structured readiness report. Pure: no I/O, no clock, no env reads.
 *
 * Exit contract: `exitCode` is 1 only for the two hard failures named in
 * {@link DoctorReport.hardFailures}. Section statuses are free to be `fail`
 * (a plugin check erroring, say) without changing the exit code.
 */
export function buildDoctorReport(input: DoctorInput): DoctorReport {
	const sections: DoctorSection[] = [
		makeSection("identity", identitySection(input.identity)),
		makeSection("runtime", runtimeSection(input.runtime)),
		makeSection("natives", nativesSection(input.natives)),
		makeSection("tools", toolsSection(input.tools)),
		makeSection("plugins", pluginsSection(input.plugins)),
		makeSection("terminal", terminalSection(input.terminal)),
		makeSection("memory", memorySection(input.memory)),
	];

	const hardFailures: string[] = [];
	if (bunTooOld(input.identity.bunVersion, input.identity.minBunVersion)) {
		hardFailures.push(`Bun v${input.identity.bunVersion} is below the required v${input.identity.minBunVersion}`);
	}
	if (input.runtime.enabled && input.runtime.status?.available !== true) {
		hardFailures.push("the runtime is enabled but unavailable");
	}

	return {
		app: input.identity.appName,
		version: input.identity.version,
		protocolVersion: input.runtime.protocolVersion,
		sections,
		hardFailures,
		status: worst(sections.map(s => s.status)),
		exitCode: hardFailures.length > 0 ? 1 : 0,
	};
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const GLYPH: Record<DoctorStatus, string> = { ok: "✓", warn: "!", fail: "✗" };
const SGR: Record<DoctorStatus, string> = { ok: "32", warn: "33", fail: "31" };

/** Sectioned human-readable report. */
export function formatDoctorReport(report: DoctorReport, opts: { color?: boolean } = {}): string {
	const paint = (status: DoctorStatus, text: string) => (opts.color ? `\x1b[${SGR[status]}m${text}\x1b[0m` : text);
	const lines: string[] = [`${report.app} ${report.version} (runtime protocol v${report.protocolVersion})`, ""];
	for (const section of report.sections) {
		lines.push(`${paint(section.status, GLYPH[section.status])} ${section.name}`);
		for (const entry of section.entries) {
			lines.push(`    ${paint(entry.status, GLYPH[entry.status])} ${entry.label.padEnd(14)} ${entry.detail}`);
		}
		lines.push("");
	}
	if (report.hardFailures.length > 0) {
		lines.push(paint("fail", `not ready — ${report.hardFailures.join("; ")}`));
	} else if (report.status === "ok") {
		lines.push(paint("ok", "ready — no problems found"));
	} else {
		lines.push(paint("warn", "ready — with warnings above"));
	}
	return lines.join("\n");
}

/** Single-line probe for clean-env CI checks (`aura --check`). */
export function formatCheckLine(report: DoctorReport): string {
	const runtime = report.sections.find(s => s.name === "runtime");
	const runtimeState = runtime?.entries.find(e => e.label === "state");
	const runtimeWord =
		runtimeState?.status === "ok" ? "available" : runtimeState?.status === "warn" ? "disabled" : "unavailable";
	const tools = report.sections.find(s => s.name === "tools")?.entries[0]?.detail.split(" — ")[0] ?? "0/0";
	const natives = report.sections.find(s => s.name === "natives")?.status === "ok" ? "loaded" : "missing";
	const verdict = report.hardFailures.length > 0 ? `not ready — ${report.hardFailures.join("; ")}` : "ready";
	return (
		`${report.app} ${report.version} (protocol v${report.protocolVersion}) — ` +
		`runtime ${runtimeWord}; natives ${natives}; tools ${tools}; ${verdict}`
	);
}

// ---------------------------------------------------------------------------
// Gathering
// ---------------------------------------------------------------------------

/** Best-effort helper: never let one probe's failure take down the report. */
async function attempt<T>(probe: () => Promise<T> | T): Promise<{ value: T } | { error: string }> {
	try {
		return { value: await probe() };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

async function gatherIdentity(): Promise<DoctorIdentityInput> {
	const { getConfigDirs } = await import("../config");
	// The legacy `.omp` project base is read-only compat; report it only when it
	// actually exists, since that is when a read can resolve there.
	const legacy = (await attempt(() => getConfigDirs("", { user: false, existingOnly: true }))) as
		| { value: { path: string; source: string }[] }
		| { error: string };
	const legacyDir =
		"value" in legacy ? legacy.value.find(entry => entry.source === LEGACY_CONFIG_DIR_NAME)?.path : undefined;
	return {
		appName: APP_NAME,
		version: VERSION,
		minBunVersion: MIN_BUN_VERSION,
		bunVersion: Bun.version,
		configDirName: CONFIG_DIR_NAME,
		agentDir: getAgentDir(),
		legacyProjectConfigDir: legacyDir,
	};
}

async function gatherRuntime(): Promise<DoctorRuntimeInput> {
	const { createStatusRuntime, RUNTIME_DISABLED, readRuntimeSettings } = await import("./runtime-cli");
	const service = await attempt(() => createStatusRuntime(readRuntimeSettings()));
	if ("error" in service) {
		return { enabled: true, protocolVersion: RUNTIME_PROTOCOL_VERSION, error: service.error };
	}
	if (service.value === RUNTIME_DISABLED || "disabled" in service.value) {
		return { enabled: false, protocolVersion: RUNTIME_PROTOCOL_VERSION };
	}
	const probed = await attempt(() => (service.value as { status: () => Promise<RuntimeStatusResult> }).status());
	return "error" in probed
		? { enabled: true, protocolVersion: RUNTIME_PROTOCOL_VERSION, error: probed.error }
		: { enabled: true, protocolVersion: RUNTIME_PROTOCOL_VERSION, status: probed.value };
}

async function gatherNatives(): Promise<DoctorNativesInput> {
	const loaded = await attempt(async () => {
		const mod = (await import("@oh-my-pi/pi-natives")) as unknown as Record<string, unknown>;
		// The addon exports a version sentinel (`__piNativesV<major>_<minor>_<patch>`)
		// that the loader validates against the package version; recovering the
		// version from it avoids a second source of truth.
		const sentinel = Object.keys(mod).find(key => key.startsWith("__piNativesV"));
		const version = sentinel?.slice("__piNativesV".length).replaceAll("_", ".");
		// `PI_NATIVE_VARIANT` is the loader's own x64 CPU-variant override; the
		// resolved tag is otherwise computed privately inside the loader.
		const variant = Bun.env.PI_NATIVE_VARIANT;
		const target = `${process.platform}-${process.arch}${variant ? `-${variant}` : ""}`;
		return { version, target };
	});
	return "error" in loaded
		? { loaded: false, error: loaded.error }
		: { loaded: true, version: loaded.value.version, target: loaded.value.target };
}

/**
 * Tool names without constructing a session.
 *
 * `available` is the builtin registry (the same list `--tools` completes
 * against). `active` drops the tools whose registration gate is decidable from
 * settings alone — today that is the `runtime.enabled` family. Gates that need a
 * live session (a GitHub token, an LSP server, a memory backend) are not
 * resolved here on purpose: doctor must not build a session or reach a network.
 */
async function gatherTools(): Promise<DoctorToolsInput> {
	const [{ BUILTIN_TOOL_NAMES }, { settings }] = await Promise.all([
		import("../tools/builtin-names"),
		import("../config/settings"),
	]);
	const available = [...BUILTIN_TOOL_NAMES];
	const runtimeEnabled = (await attempt(() => settings.get("runtime.enabled"))) as
		| { value: boolean }
		| { error: string };
	const runtimeOff = "value" in runtimeEnabled && runtimeEnabled.value === false;
	const RUNTIME_TOOLS = new Set([
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
	]);
	return { available, active: runtimeOff ? available.filter(name => !RUNTIME_TOOLS.has(name)) : available };
}

async function gatherPlugins(): Promise<DoctorPluginsInput> {
	const probed = await attempt(async () => {
		const { PluginManager } = await import("../extensibility/plugins");
		return await new PluginManager().doctor({ fix: false });
	});
	return "error" in probed ? { checks: [], error: probed.error } : { checks: probed.value };
}

async function gatherTerminal(): Promise<DoctorTerminalInput> {
	const probed = await attempt(async () => {
		const { collectTerminalState } = await import("../debug/terminal-info");
		return collectTerminalState({
			columns: process.stdout.columns ?? 80,
			rows: process.stdout.rows ?? 24,
			// Doctor is not the TUI renderer, so no synchronized-output wrapper is active.
			// `osc99Confirmed` is likewise always false here: it flips only after the
			// TUI's `OSC 99 p=?` device-attributes query, which doctor must not send.
			synchronizedOutput: false,
		});
	});
	if ("error" in probed) {
		return {
			detectedId: `unknown (${probed.error})`,
			columns: process.stdout.columns ?? 0,
			rows: process.stdout.rows ?? 0,
			trueColor: false,
			notifyProtocol: "unknown",
			osc99Confirmed: false,
			multiplexer: null,
		};
	}
	const state = probed.value;
	return {
		detectedId: state.detectedId,
		columns: state.columns,
		rows: state.rows,
		trueColor: state.trueColor,
		notifyProtocol: state.notifyProtocol,
		osc99Confirmed: state.osc99Confirmed,
		multiplexer: state.multiplexer,
	};
}

async function gatherMemory(): Promise<DoctorMemoryInput> {
	const probed = await attempt(async () => {
		const [{ resolveMemoryBackend }, { settings }] = await Promise.all([
			import("../memory-backend/resolve"),
			import("../config/settings"),
		]);
		const backend = await resolveMemoryBackend(settings);
		// Presence of the hooks only — invoking `diagnose` on a remote backend
		// would make doctor a network call.
		return {
			backend: backend.id,
			diagnose: typeof backend.diagnose === "function",
			stats: typeof backend.stats === "function",
		};
	});
	return "error" in probed ? { backend: "off", diagnose: false, stats: false } : probed.value;
}

/**
 * Collect every section's live data. Each probe is independently fault-isolated:
 * a section that cannot be read reports that fact instead of aborting the run.
 */
export async function gatherDoctorInput(): Promise<DoctorInput> {
	const [identity, runtime, natives, tools, plugins, terminal, memory] = await Promise.all([
		gatherIdentity(),
		gatherRuntime(),
		gatherNatives(),
		gatherTools(),
		gatherPlugins(),
		gatherTerminal(),
		gatherMemory(),
	]);
	return { identity, runtime, natives, tools, plugins, terminal, memory };
}

// ---------------------------------------------------------------------------
// Command entry
// ---------------------------------------------------------------------------

export interface DoctorCommandArgs {
	flags: {
		json?: boolean;
		/** One-line output for `aura --check`. */
		check?: boolean;
	};
}

/**
 * Run the doctor surface and return the process exit code.
 *
 * The gatherer and the sink are injectable so tests drive every branch with
 * fabricated input and capture output line-by-line (runtime-cli.ts precedent).
 */
export async function runDoctorCommand(
	cmd: DoctorCommandArgs,
	gather: () => Promise<DoctorInput> = gatherDoctorInput,
	print: (line: string) => void = line => process.stdout.write(`${line}\n`),
): Promise<number> {
	const report = buildDoctorReport(await gather());
	if (cmd.flags.json) {
		print(JSON.stringify(report, null, 2));
	} else if (cmd.flags.check) {
		print(formatCheckLine(report));
	} else {
		print(formatDoctorReport(report, { color: Boolean(process.stdout.isTTY) }));
	}
	return report.exitCode;
}
