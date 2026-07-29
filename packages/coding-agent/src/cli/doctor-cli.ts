/**
 * `aura doctor` / `aura --check` — one-shot environment readiness reporting.
 *
 * Two rules shape this module:
 *
 * 1. **Aggregate, never reimplement.** Every section's *data* comes from the
 *    probe that already owns that surface: `readRuntimeSettings` +
 *    `createStatusRuntime` (hence `resolveStatusEndpointOptions`) for the
 *    runtime, `PluginManager.doctor` for plugins, `collectTerminalState` for the
 *    terminal, `resolveMemoryBackend` for memory. Doctor's own contribution is
 *    the aggregation and the exit contract.
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
import type { DoctorCheck } from "../extensibility/plugins/types";
import { RUNTIME_PROTOCOL_VERSION } from "../runtime";
import type { RuntimeStatusResult } from "../runtime/protocol";
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

function runtimeSection(input: DoctorRuntimeInput): DoctorEntry[] {
	const protocol = protocolEntry(input);
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
	const selection = runtimeSelectionEntries(status);
	if (!status.available) {
		return [
			{
				label: "state",
				status: "fail",
				detail: `enabled, but unavailable${status.guidance ? ` — ${status.guidance}` : ""}`,
			},
			...selection,
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
 * keys the gate table below reads, so {@link resolveToolGating} stays pure and
 * unit-testable against a literal.
 */
export interface ToolGateSettings {
	runtimeEnabled: boolean;
	debugEnabled: boolean;
	memoryBackend: string;
	autolearnEnabled: boolean;
}

/**
 * The gate settings doctor assumes when the settings document cannot be read.
 * Transcribed from `settings-schema.ts` defaults — `runtime.enabled` and
 * `debug.enabled` default on, `memory.backend` off, `autolearn.enabled` off —
 * so a failed read reports what a default install actually has, in neither
 * direction.
 */
export const DEFAULT_TOOL_GATE_SETTINGS: ToolGateSettings = {
	runtimeEnabled: true,
	debugEnabled: true,
	memoryBackend: "off",
	autolearnEnabled: false,
};

/**
 * Names whose `createIf` gate needs a live session or an external probe, so
 * doctor cannot decide them: `ask` needs `session.hasUI`, `checkpoint`/`rewind`
 * need `isTopLevelSession(session)`, `lsp` reads `session.enableLsp`, and
 * `github` runs a `gh` availability probe. These are reported as
 * `sessionGated` and counted as active, because "probably yes" is the honest
 * default for a gate doctor cannot evaluate.
 */
export const SESSION_GATED_TOOL_NAMES: readonly string[] = ["ask", "checkpoint", "rewind", "lsp", "github"];

/**
 * Settings-decidable `createIf` gates, transcribed from the tool classes.
 *
 * Each predicate returns the user-facing reason the tool will NOT register, or
 * `undefined` when it will. Kept as data rather than scattered `if`s so the
 * drift test can enumerate it and compare against the real registry.
 */
const SETTINGS_GATED_TOOLS: Record<string, (s: ToolGateSettings) => string | undefined> = {
	// RuntimeRunTool/CheckTool/BuildTool/InsightsTool/ProfileTool, the two launch
	// tools (RuntimeDebugTool/RuntimeServeTool), the six Jvm*Tool classes, and
	// RuntimeAdviceTool all gate on `runtime.enabled`.
	...Object.fromEntries(
		[
			"run",
			"check",
			"build",
			"insights",
			"profile",
			"runtime_debug",
			"serve",
			"jvm_run",
			"jvm_disassemble",
			"jvm_format",
			"jvm_jar",
			"jvm_deps",
			"jvm_javadoc",
			"project_advice",
		].map(name => [name, (s: ToolGateSettings) => (s.runtimeEnabled ? undefined : "runtime.enabled = false")]),
	),
	// DebugTool.createIf
	debug: s => (s.debugEnabled ? undefined : "debug.enabled = false"),
	// MemoryRetainTool/MemoryRecallTool/MemoryReflectTool.createIf
	...Object.fromEntries(
		["retain", "recall", "reflect"].map(name => [
			name,
			(s: ToolGateSettings) =>
				s.memoryBackend === "hindsight" || s.memoryBackend === "mnemopi"
					? undefined
					: `memory.backend = ${s.memoryBackend}`,
		]),
	),
	// MemoryEditTool.createIf — mnemopi only.
	memory_edit: s => (s.memoryBackend === "mnemopi" ? undefined : `memory.backend = ${s.memoryBackend}`),
	// LearnTool.createIf
	learn: s =>
		!s.autolearnEnabled
			? "autolearn.enabled = false"
			: s.memoryBackend === "hindsight" || s.memoryBackend === "mnemopi" || s.memoryBackend === "local"
				? undefined
				: `memory.backend = ${s.memoryBackend}`,
	// ManageSkillTool.createIf
	manage_skill: s => (s.autolearnEnabled ? undefined : "autolearn.enabled = false"),
};

/** Tool names carrying a settings-decidable gate (exported for the drift test). */
export const SETTINGS_GATED_TOOL_NAMES: readonly string[] = Object.keys(SETTINGS_GATED_TOOLS);

/**
 * Partition tool names into what will register and what a settings gate turns
 * off. Pure — the settings read happens in {@link gatherTools}.
 *
 * `active` is "every available name minus the settings-decidable gates that
 * fail". It is not a promise that every listed tool registers: the
 * {@link SESSION_GATED_TOOL_NAMES} entries stay in `active` and are also called
 * out separately, because their gates read the live session, which doctor
 * deliberately never builds.
 */
export function resolveToolGating(available: readonly string[], gateSettings: ToolGateSettings): DoctorToolsInput {
	const gatedOff: { name: string; reason: string }[] = [];
	const active: string[] = [];
	for (const name of available) {
		const reason = SETTINGS_GATED_TOOLS[name]?.(gateSettings);
		if (reason === undefined) active.push(name);
		else gatedOff.push({ name, reason });
	}
	return {
		available: [...available],
		active,
		gatedOff,
		sessionGated: SESSION_GATED_TOOL_NAMES.filter(name => active.includes(name)),
	};
}

/**
 * Tool names without constructing a session: the builtin registry (the same list
 * `--tools` completes against) partitioned by {@link resolveToolGating}.
 */
async function gatherTools(): Promise<DoctorToolsInput> {
	const [{ BUILTIN_TOOL_NAMES }, { settings }] = await Promise.all([
		import("../tools/builtin-names"),
		import("../config/settings"),
	]);
	const read = await attempt(
		(): ToolGateSettings => ({
			runtimeEnabled: settings.get("runtime.enabled") !== false,
			debugEnabled: settings.get("debug.enabled") !== false,
			memoryBackend: String(settings.get("memory.backend") ?? "off"),
			autolearnEnabled: settings.get("autolearn.enabled") !== false,
		}),
	);
	// An unreadable settings document is not evidence of anything either way, so
	// the fallback is the schema's own defaults; see DEFAULT_TOOL_GATE_SETTINGS.
	const gateSettings: ToolGateSettings = "value" in read ? read.value : DEFAULT_TOOL_GATE_SETTINGS;
	return resolveToolGating([...BUILTIN_TOOL_NAMES], gateSettings);
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
