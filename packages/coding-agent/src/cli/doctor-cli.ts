/**
 * `aura doctor` / `aura --check` — one-shot environment readiness reporting.
 *
 * Two rules shape this module:
 *
 * 1. **Aggregate, never reimplement.** Every section's *data* comes from the
 *    probe that already owns that surface: `readRuntimeSettings` +
 *    `createStatusRuntime` (hence `resolveStatusEndpointOptions`) for the
 *    runtime, `PluginManager.doctor` for plugins, `collectTerminalState` for the
 *    terminal, `resolveMemoryBackend` for memory, and `BUILTIN_TOOLS` itself for
 *    the tool gates — doctor constructs each factory against a stub session and
 *    reports the ones that return `null`, instead of keeping a copy of their
 *    `createIf` conditions. Doctor's own contribution is the aggregation and the
 *    exit contract.
 *
 *    Rendering is the one place doctor does not reuse: the runtime section
 *    re-renders `RuntimeStatusResult`'s fields as {@link DoctorEntry}s rather
 *    than embedding `formatRuntimeStatus`'s pre-joined block, because a report
 *    made of uniform entries is what `--json` and the per-entry glyphs need.
 *    `aura runtime status` remains the canonical text rendering of that struct.
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
import type { Settings } from "../config/settings";
import type { DoctorCheck } from "../extensibility/plugins/types";
import { RUNTIME_PROTOCOL_VERSION } from "../runtime";
import type { RuntimeStatusResult } from "../runtime/protocol";
import type { ToolFactory, ToolSession } from "../tools/index";
import { formatDisplayPath } from "../utils/display-path";
import {
	createStatusRuntime as defaultCreateStatusRuntime,
	readRuntimeSettings as defaultReadRuntimeSettings,
	RUNTIME_DISABLED,
} from "./runtime-cli";

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
	/**
	 * Names that will register: every available name whose `createIf` gate is
	 * either absent or decidable from settings and passing. Excludes names in
	 * {@link gatedOff}; still *includes* names in {@link sessionGated}, whose
	 * gate cannot be evaluated here.
	 */
	active: string[];
	/** Names a settings-decidable gate turns off, each with the reason. */
	gatedOff: { name: string; reason: string }[];
	/**
	 * Names whose gate needs a live session or an external probe, so doctor
	 * cannot say either way (`ask` needs a UI, `checkpoint`/`rewind` a top-level
	 * session, `lsp` the session's `enableLsp`, `github` a working `gh`).
	 */
	sessionGated: string[];
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
	/**
	 * Set when resolving the backend threw. Distinct from `backend: "off"`, which
	 * is a user choice — a probe failure must never be rendered as one.
	 */
	error?: string;
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

/**
 * The `protocol` entry, from one source for every branch: the version the
 * endpoint actually reported, falling back to the compiled-in constant when no
 * probe succeeded. A skew between the two is a real bug (a stale endpoint
 * answering a newer client), so it is rendered as a warning rather than being
 * silently resolved in favor of either side.
 */
function protocolEntry(input: DoctorRuntimeInput): DoctorEntry {
	const reported = input.status?.protocolVersion;
	if (reported === undefined) {
		return {
			label: "protocol",
			status: "ok",
			detail: `v${input.protocolVersion} (compiled in; endpoint not reached)`,
		};
	}
	if (reported !== input.protocolVersion) {
		return {
			label: "protocol",
			status: "warn",
			detail: `endpoint reports v${reported} but this build speaks v${input.protocolVersion}`,
		};
	}
	return { label: "protocol", status: "ok", detail: `v${reported}` };
}

function runtimeSelectionEntries(status: RuntimeStatusResult): DoctorEntry[] {
	const entries: DoctorEntry[] = [];
	if (status.adapter) entries.push({ label: "adapter", status: "ok", detail: status.adapter });
	if (status.effectiveAdapter) {
		entries.push({ label: "effective adapter", status: "ok", detail: status.effectiveAdapter });
	}
	if (status.embeddedLibraryPath) {
		entries.push({
			label: "embedded runtime library",
			status: "ok",
			detail: formatDisplayPath(status.embeddedLibraryPath),
		});
	}
	if (status.embeddedLibrarySource) {
		entries.push({
			label: "embedded runtime library source",
			status: "ok",
			detail: status.embeddedLibrarySource,
		});
	}
	if (status.embeddedAbiVersion !== undefined) {
		entries.push({ label: "ABI", status: "ok", detail: String(status.embeddedAbiVersion) });
	}
	if (status.embeddedSchemaHash !== undefined) {
		entries.push({ label: "schema", status: "ok", detail: status.embeddedSchemaHash });
	}
	return entries;
}

const RUN_ENGINE_ENTRY: DoctorEntry = {
	label: "run engines",
	status: "ok",
	detail: "JavaScript/TypeScript default to Bun; Python/Java/Kotlin use the embedded engine",
};

function runtimeSection(input: DoctorRuntimeInput): DoctorEntry[] {
	const protocol = protocolEntry(input);
	if (!input.enabled) {
		return [
			{
				label: "state",
				status: "warn",
				detail:
					"disabled (runtime.enabled = false) — run/check/insights/profile and the four specialized jvm_* tools do not register",
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
	const selection = runtimeSelectionEntries(status);
	if (!status.available) {
		return [
			{
				label: "state",
				status: "fail",
				detail: `enabled, but unavailable${status.guidance ? ` — ${status.guidance}` : ""}`,
			},
			...selection,
			RUN_ENGINE_ENTRY,
			protocol,
		];
	}
	const entries: DoctorEntry[] = [
		{ label: "state", status: "ok", detail: `available (version ${status.version ?? "unknown"})` },
	];
	if (status.binaryPath) {
		entries.push({ label: "binary", status: "ok", detail: formatDisplayPath(status.binaryPath) });
	}
	if (status.source) entries.push({ label: "source", status: "ok", detail: status.source });
	entries.push(RUN_ENGINE_ENTRY);
	entries.push(...selection, protocol);
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
	const entries: DoctorEntry[] = [
		{
			label: "registered",
			status: input.active.length === 0 ? "warn" : "ok",
			detail: `${input.active.length}/${input.available.length} — ${input.active.join(", ") || "none"}`,
		},
	];
	if (input.gatedOff.length > 0) {
		// Grouped by reason so `memory.backend = off` is stated once, not per tool.
		const byReason = new Map<string, string[]>();
		for (const { name, reason } of input.gatedOff) {
			const bucket = byReason.get(reason);
			if (bucket) bucket.push(name);
			else byReason.set(reason, [name]);
		}
		entries.push({
			label: "gated off",
			status: "ok",
			detail: [...byReason].map(([reason, names]) => `${names.join(", ")} (${reason})`).join("; "),
		});
	}
	if (input.sessionGated.length > 0) {
		entries.push({
			label: "session-gated",
			status: "ok",
			detail: `${input.sessionGated.join(", ")} — registration depends on the live session or an external tool, not settings`,
		});
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
	if (input.error !== undefined) {
		return [{ label: "backend", status: "warn", detail: `could not resolve the memory backend — ${input.error}` }];
	}
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

interface GatherRuntimeDependencies {
	createStatusRuntime?: typeof defaultCreateStatusRuntime;
	readRuntimeSettings?: typeof defaultReadRuntimeSettings;
}

async function gatherRuntime(dependencies: GatherRuntimeDependencies = {}): Promise<DoctorRuntimeInput> {
	const createStatusRuntime = dependencies.createStatusRuntime ?? defaultCreateStatusRuntime;
	const readRuntimeSettings = dependencies.readRuntimeSettings ?? defaultReadRuntimeSettings;
	const service = await attempt(() => createStatusRuntime(readRuntimeSettings()));
	if ("error" in service) {
		return { enabled: true, protocolVersion: RUNTIME_PROTOCOL_VERSION, error: service.error };
	}
	if (service.value === RUNTIME_DISABLED || "disabled" in service.value) {
		return { enabled: false, protocolVersion: RUNTIME_PROTOCOL_VERSION };
	}
	const runtime = service.value;

	let cleanupError: string | undefined;
	const probed = await (async () => {
		try {
			return await attempt(() => runtime.status());
		} finally {
			const closed = await attempt(() => runtime.close());
			if ("error" in closed) cleanupError = closed.error;
		}
	})();
	if ("error" in probed) {
		return { enabled: true, protocolVersion: RUNTIME_PROTOCOL_VERSION, error: probed.error };
	}
	if (cleanupError !== undefined) {
		return { enabled: true, protocolVersion: RUNTIME_PROTOCOL_VERSION, error: cleanupError };
	}
	return { enabled: true, protocolVersion: RUNTIME_PROTOCOL_VERSION, status: probed.value };
}

async function gatherNatives(): Promise<DoctorNativesInput> {
	const loaded = await attempt(async () => {
		const mod = (await import("@oh-my-pi/pi-natives")) as unknown as Record<string, unknown>;
		// The addon exports a version sentinel (`__piNativesV<major>_<minor>_<patch>`)
		// that the loader validates against the package version; recovering the
		// version from it avoids a second source of truth.
		const sentinel = Object.keys(mod).find(key => key.startsWith("__piNativesV"));
		const version = sentinel?.slice("__piNativesV".length).replaceAll("_", ".");
		// The x64 CPU variant decides WHICH addon file loaded
		// (`pi_natives.linux-x64-modern.node` vs `…-baseline.node`), so the reported
		// target has to include it or it names a file that is not on disk. Read the
		// user override first, then `__PI_NATIVE_VARIANT_CACHE` — the hidden key the
		// loader writes once variant detection settles, so it is populated by the
		// time this import resolves. When neither is set (non-x64, where the loader
		// selects no variant) omit the suffix rather than invent one.
		// Read `process.env` specifically: that is the object the loader writes the
		// cache key onto.
		const variant = process.env.PI_NATIVE_VARIANT ?? process.env.__PI_NATIVE_VARIANT_CACHE;
		const target = `${process.platform}-${process.arch}${variant ? `-${variant}` : ""}`;
		return { version, target };
	});
	return "error" in loaded
		? { loaded: false, error: loaded.error }
		: { loaded: true, version: loaded.value.version, target: loaded.value.target };
}

/**
 * The settings a tool's `createIf` gate can consult. Narrowed to exactly the
 * keys {@link TOOL_GATE_SETTINGS} declares, so {@link resolveToolGating} stays a
 * function over a literal plus an injectable probe.
 */
export interface ToolGateSettings {
	runtimeEnabled: boolean;
	launchEnabled: boolean;
	debugEnabled: boolean;
	memoryBackend: string;
	autolearnEnabled: boolean;
}

/**
 * The gate settings doctor assumes when the settings document cannot be read.
 * Transcribed from `settings-schema.ts` defaults — `runtime.enabled`,
 * `launch.enabled`, and `debug.enabled` default on, `memory.backend` off,
 * `autolearn.enabled` off — so a failed read reports what a default install
 * actually has, in neither direction.
 */
export const DEFAULT_TOOL_GATE_SETTINGS: ToolGateSettings = {
	runtimeEnabled: true,
	launchEnabled: true,
	debugEnabled: true,
	memoryBackend: "off",
	autolearnEnabled: false,
};

/**
 * Names whose `createIf` gate needs a live session or an external probe, so
 * doctor declines to decide them: `ask` needs `session.hasUI`,
 * `checkpoint`/`rewind` and `lsp` read live session state, and `github` runs a
 * `gh` availability probe. These are reported as `sessionGated`, counted as
 * active, and never probed at all — "probably yes" is the honest default for a
 * gate doctor cannot evaluate, and a diagnostic must not shell out to answer it.
 *
 * This is the one hand-maintained annotation left in the gate report, so
 * `doctor-tool-gate-drift.test.ts` holds it to being a subset of the gates that
 * really are not settings-decidable.
 */
export const SESSION_GATED_TOOL_NAMES: readonly string[] = ["ask", "checkpoint", "rewind", "lsp", "github"];

/**
 * One settings key a `createIf` gate may read, paired with the value at which it
 * gates nothing. This table is the whole settings vocabulary of the gate report:
 * it drives the probe's stub settings document, the permissive vector, and the
 * reason strings. It says nothing about *which* tools read a key — that is
 * derived from the registry, so a new or renamed tool needs no edit here.
 */
export interface ToolGateSetting {
	/** Field on {@link ToolGateSettings} mirroring this key. */
	readonly field: keyof ToolGateSettings;
	/** Settings-document key the tool factories read. */
	readonly key: string;
	/** Value at which this setting gates no tool. */
	readonly permissive: boolean | string;
}

export const TOOL_GATE_SETTINGS: readonly ToolGateSetting[] = [
	{ field: "runtimeEnabled", key: "runtime.enabled", permissive: true },
	// `serve` needs this one on top of `runtime.enabled`: it starts a hub job, so
	// upstream's process-supervision kill switch withholds it too.
	{ field: "launchEnabled", key: "launch.enabled", permissive: true },
	{ field: "debugEnabled", key: "debug.enabled", permissive: true },
	// `mnemopi` is the most permissive backend: it satisfies the memory family,
	// `memory_edit` (which accepts nothing else), and `learn`.
	{ field: "memoryBackend", key: "memory.backend", permissive: "mnemopi" },
	{ field: "autolearnEnabled", key: "autolearn.enabled", permissive: true },
];

/** The vector under which no settings-decidable gate turns any tool off. */
export const PERMISSIVE_TOOL_GATE_SETTINGS: ToolGateSettings = Object.fromEntries(
	TOOL_GATE_SETTINGS.map(gate => [gate.field, gate.permissive]),
) as unknown as ToolGateSettings;

/** `gateSettings` with one field replaced. The cast is the computed-key widening only. */
function withGateSetting(
	gateSettings: ToolGateSettings,
	field: keyof ToolGateSettings,
	value: boolean | string,
): ToolGateSettings {
	return { ...gateSettings, [field]: value } as ToolGateSettings;
}

/**
 * The permissive vector with exactly `gate` held at its configured value: the
 * probe that answers "does this setting, on its own, turn the tool off?".
 */
export function isolateToolGate(gateSettings: ToolGateSettings, gate: ToolGateSetting): ToolGateSettings {
	return withGateSetting(PERMISSIVE_TOOL_GATE_SETTINGS, gate.field, gateSettings[gate.field]);
}

/** How this setting reads in a reason string, at the value it is configured to. */
function describeGate(gate: ToolGateSetting, gateSettings: ToolGateSettings): string {
	return `${gate.key} = ${String(gateSettings[gate.field])}`;
}

/**
 * Does `name` register under `gateSettings`? The seam between doctor and the
 * tool registry: injectable so the report's logic is testable without the tool
 * graph, and so the registry stays the only source of truth about gates.
 */
export type ToolGateProbe = (name: string, gateSettings: ToolGateSettings) => boolean | Promise<boolean>;

/**
 * A probe over a factory registry: construct the tool against a stub session
 * built from `gateSettings` and report whether the factory produced one.
 *
 * A factory that throws counts as *registering*: a throw is a bug or a field the
 * stub session does not carry, not a gate, and it behaves identically under
 * every vector, so counting it either way is stable — and "registers" is the
 * answer that does not invent a gate that is not there.
 */
export function createToolGateProbe(registry: Readonly<Record<string, ToolFactory>>): ToolGateProbe {
	return async (name, gateSettings) => {
		const factory = registry[name];
		if (factory === undefined) return true;
		try {
			const tool = await factory(createToolGateProbeSession(gateSettings));
			return tool !== null && tool !== undefined;
		} catch {
			return true;
		}
	};
}

/** {@link createToolGateProbe} over the real `BUILTIN_TOOLS`, imported on demand. */
export async function createBuiltinToolGateProbe(): Promise<ToolGateProbe> {
	const { BUILTIN_TOOLS } = await import("../tools/index");
	return createToolGateProbe(BUILTIN_TOOLS);
}

/**
 * The minimum session a `createIf` gate needs: the settings it reads plus the
 * few flags the session-gated factories consult. Unknown keys answer `undefined`
 * — a factory that gates on one of those is reported as unattributable rather
 * than blamed on a tracked setting.
 */
export function createToolGateProbeSession(gateSettings: ToolGateSettings): ToolSession {
	const values: Record<string, unknown> = Object.fromEntries(
		TOOL_GATE_SETTINGS.map(gate => [gate.key, gateSettings[gate.field]]),
	);
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: { get: (key: string) => values[key] } as unknown as Settings,
		getSessionFile: () => null,
		getSessionId: () => null,
		getSessionSpawns: () => null,
	} as unknown as ToolSession;
}

/**
 * Why a factory declined, derived rather than transcribed: hold every tracked
 * setting at its permissive value except one, and whichever ones still turn the
 * tool off are the ones to name. Settings that are merely non-default but that
 * this gate does not read are never blamed.
 */
async function deriveGateReason(name: string, gateSettings: ToolGateSettings, probe: ToolGateProbe): Promise<string> {
	const restrictive = TOOL_GATE_SETTINGS.filter(gate => gateSettings[gate.field] !== gate.permissive);
	const causes: ToolGateSetting[] = [];
	for (const gate of restrictive) {
		if (!(await probe(name, isolateToolGate(gateSettings, gate)))) causes.push(gate);
	}
	// Several causes means several fixes: each one turns the tool off by itself.
	if (causes.length > 0) return causes.map(gate => describeGate(gate, gateSettings)).join(" and ");
	// No single setting is sufficient, yet the permissive vector registers: the
	// gate reads a combination of them.
	if (restrictive.length > 0 && (await probe(name, PERMISSIVE_TOOL_GATE_SETTINGS))) {
		return restrictive.map(gate => describeGate(gate, gateSettings)).join(" with ");
	}
	return `a registration gate outside ${TOOL_GATE_SETTINGS.map(gate => gate.key).join(", ")}`;
}

/**
 * Partition tool names into what registers and what a gate turns off, by asking
 * the registry rather than by consulting a copy of its gates.
 *
 * `active` is "every available name whose factory produced a tool". It is not a
 * promise that every listed tool registers in a real session: the
 * {@link SESSION_GATED_TOOL_NAMES} entries are never probed, stay in `active`,
 * and are called out separately, because their gates read the live session,
 * which doctor deliberately never builds.
 */
export async function resolveToolGating(
	available: readonly string[],
	gateSettings: ToolGateSettings,
	probe: ToolGateProbe,
): Promise<DoctorToolsInput> {
	const gatedOff: { name: string; reason: string }[] = [];
	const active: string[] = [];
	for (const name of available) {
		if (SESSION_GATED_TOOL_NAMES.includes(name) || (await probe(name, gateSettings))) {
			active.push(name);
			continue;
		}
		gatedOff.push({ name, reason: await deriveGateReason(name, gateSettings, probe) });
	}
	return {
		available: [...available],
		active,
		gatedOff,
		sessionGated: SESSION_GATED_TOOL_NAMES.filter(name => active.includes(name)),
	};
}

/**
 * Tool gating without a live session: the builtin registry (the same list
 * `--tools` completes against) partitioned by {@link resolveToolGating} against
 * a stub session carrying the real values of every {@link TOOL_GATE_SETTINGS}
 * key.
 */
async function gatherTools(): Promise<DoctorToolsInput> {
	const [{ BUILTIN_TOOL_NAMES }, { settings }, probe] = await Promise.all([
		import("../tools/builtin-names"),
		import("../config/settings"),
		createBuiltinToolGateProbe(),
	]);
	const read = await attempt(
		(): ToolGateSettings => ({
			runtimeEnabled: settings.get("runtime.enabled") !== false,
			launchEnabled: settings.get("launch.enabled") !== false,
			debugEnabled: settings.get("debug.enabled") !== false,
			memoryBackend: String(settings.get("memory.backend") ?? "off"),
			autolearnEnabled: settings.get("autolearn.enabled") !== false,
		}),
	);
	// An unreadable settings document is not evidence of anything either way, so
	// the fallback is the schema's own defaults; see DEFAULT_TOOL_GATE_SETTINGS.
	const gateSettings: ToolGateSettings = "value" in read ? read.value : DEFAULT_TOOL_GATE_SETTINGS;
	return resolveToolGating([...BUILTIN_TOOL_NAMES], gateSettings, probe);
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
	// A failed probe reports `error`, never `backend: "off"` — "off" is a setting
	// the user chose, and rendering a failure as a choice hides the failure.
	return "error" in probed ? { backend: "unknown", diagnose: false, stats: false, error: probed.error } : probed.value;
}

/**
 * Collect every section's live data. Each probe is independently fault-isolated:
 * a section that cannot be read reports that fact instead of aborting the run.
 */
export async function gatherDoctorInput(dependencies: GatherRuntimeDependencies = {}): Promise<DoctorInput> {
	const [identity, runtime, natives, tools, plugins, terminal, memory] = await Promise.all([
		gatherIdentity(),
		gatherRuntime(dependencies),
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
