# Aura OpenTelemetry Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a settings-gated OpenTelemetry integration exporting session lifecycle, errors, token usage, cost (estimated USD + subscription-limit utilization), and compaction effectiveness — all under `aura.*` / `service.name=aura`.

**Architecture:** A typed telemetry event bus (`packages/coding-agent/src/telemetry/events.ts`) that subsystems publish into without importing OTel; one OTLP sink (`sink-otlp.ts`) maps events to metrics/log records/spans. The existing `telemetry-export.ts` is split into `telemetry/{init,identity,metrics,sink-otlp,events}.ts` with a re-export shim so existing import paths keep working.

**Tech Stack:** Bun, TypeScript, `@opentelemetry/*` pinned to the 0.218/2.7 exporter family (1.x OTLP deadlocks under Bun — do NOT upgrade), http/protobuf transport only.

**Spec:** `docs/superpowers/specs/2026-07-27-aura-otel-integration-design.md`

## Global Constraints

- All new metric/log/attribute names use the `aura.*` namespace; default `service.name` is `aura` (renamed from `oh-my-pi`). Existing `pi.omp.*` instruments/event names are renamed to `aura.*`.
- Telemetry must never break the agent: emits are fire-and-forget; subscriber/sink failures are caught and logged at debug; init failure disables telemetry for the process.
- http/protobuf OTLP only; other protocols decline with a warning (existing behavior — preserve).
- Env (`OTEL_*`) always wins over `telemetry.*` settings; `OTEL_SDK_DISABLED=true` kill-switch always wins.
- Pseudonymous by default: no email, org, hostname, or workspace path in any attribute unless the matching `telemetry.identity.*` setting is true.
- Repo conventions: tabs for indentation, biome formatting (`bun run check` in `packages/coding-agent`), type check via `bun run check:types`. Commit after each task.
- Run a single test file: `bun test packages/coding-agent/test/<file>.test.ts` from the repo root.
- Keep the public contract of `initTelemetryExport` / `isTelemetryExportEnabled` / `createTelemetryExportConfig` / `flushTelemetryExport` (they are imported by `main.ts`, `print-mode.ts`, tests, and the `@oh-my-pi/pi-coding-agent/telemetry-export` subpath).

---

### Task 1: Telemetry event bus (`telemetry/events.ts`)

**Files:**
- Create: `packages/coding-agent/src/telemetry/events.ts`
- Test: `packages/coding-agent/test/telemetry-events.test.ts`

**Interfaces:**
- Consumes: types from `@oh-my-pi/pi-agent-core` (`AgentRunSummary`, `AgentRunCoverage`, `ChatUsageEvent`, `CostDelta`) and `@oh-my-pi/pi-ai` (`UsageHistoryEntry`). If `CostDelta` is not re-exported from the package root, add it to `packages/agent/src/index.ts` exports (it is defined at `packages/agent/src/telemetry.ts:214`).
- Produces (later tasks rely on these exact names):
  - `type TelemetryEvent` (discriminated union below)
  - `emitTelemetryEvent(event: TelemetryEvent): void`
  - `subscribeTelemetry(subscriber: (event: TelemetryEvent) => void): () => void`
  - `telemetryEventTypes` — nothing else; no classes.

- [ ] **Step 1: Write the failing test**

```ts
// packages/coding-agent/test/telemetry-events.test.ts
import { describe, expect, it } from "bun:test";
import {
	emitTelemetryEvent,
	subscribeTelemetry,
	type TelemetryEvent,
} from "../src/telemetry/events";

describe("telemetry event bus", () => {
	it("delivers events to subscribers and supports unsubscribe", () => {
		const seen: TelemetryEvent[] = [];
		const unsubscribe = subscribeTelemetry(event => seen.push(event));
		emitTelemetryEvent({ type: "session.started", sessionId: "s1", mode: "print", resumed: false });
		unsubscribe();
		emitTelemetryEvent({ type: "session.started", sessionId: "s2", mode: "print", resumed: false });
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ type: "session.started", sessionId: "s1" });
	});

	it("swallows subscriber throws and still delivers to other subscribers", () => {
		const seen: string[] = [];
		const u1 = subscribeTelemetry(() => {
			throw new Error("boom");
		});
		const u2 = subscribeTelemetry(event => seen.push(event.type));
		expect(() =>
			emitTelemetryEvent({ type: "compaction.savings", provider: "anthropic", model: "m", savedTokens: 10 }),
		).not.toThrow();
		expect(seen).toEqual(["compaction.savings"]);
		u1();
		u2();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/coding-agent/test/telemetry-events.test.ts`
Expected: FAIL — cannot resolve `../src/telemetry/events`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/coding-agent/src/telemetry/events.ts
/**
 * Typed telemetry event bus.
 *
 * Subsystems publish operational events here without importing OTel; the OTLP
 * sink (sink-otlp.ts) is the sole subscriber in production. Emission is a
 * cheap no-op when nothing is subscribed, and subscriber failures never
 * propagate to publishers.
 */
import type { AgentRunCoverage, AgentRunSummary, ChatUsageEvent, CostDelta } from "@oh-my-pi/pi-agent-core";
import type { UsageHistoryEntry } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";

export type SessionMode = "tui" | "acp" | "rpc" | "print" | "sdk";
export type CompactionTrigger = "threshold" | "overflow" | "idle" | "incomplete" | "manual";
export type CompactionOutcome = "ok" | "aborted" | "error" | "will-retry" | "skipped";
export type ErrorPhase = "chat" | "tool" | "compaction" | "session";

export interface SessionStartedTelemetry {
	type: "session.started";
	sessionId: string;
	mode: SessionMode;
	resumed: boolean;
}

export interface SessionEndedTelemetry {
	type: "session.ended";
	sessionId: string;
	mode: SessionMode;
	/** Wall-clock ms from session.started to end. */
	durationMs: number;
	/** Accumulated chat+tool latency ms across turns (in-turn activity). */
	activeMs: number;
	turns: number;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	estimatedCostUsd: number;
	endReason: string;
}

export interface TurnCompletedTelemetry {
	type: "turn.completed";
	summary: AgentRunSummary;
	coverage: AgentRunCoverage;
}

export interface ChatUsageTelemetry {
	type: "chat.usage";
	event: ChatUsageEvent;
}

export interface CostDeltaTelemetry {
	type: "cost.delta";
	delta: CostDelta;
}

export interface ErrorReportedTelemetry {
	type: "error.reported";
	phase: ErrorPhase;
	errorType: string;
	message: string;
}

export interface CompactionCompletedTelemetry {
	type: "compaction.completed";
	sessionId: string;
	strategy: string;
	trigger: CompactionTrigger;
	outcome: CompactionOutcome;
	tokensBefore?: number;
	tokensAfter?: number;
	durationMs: number;
	errorMessage?: string;
}

export interface CompactionSavingsTelemetry {
	type: "compaction.savings";
	provider: string;
	model: string;
	savedTokens: number;
}

export interface UsageLimitSnapshotTelemetry {
	type: "usage_limit.snapshot";
	entry: UsageHistoryEntry;
}

export type TelemetryEvent =
	| SessionStartedTelemetry
	| SessionEndedTelemetry
	| TurnCompletedTelemetry
	| ChatUsageTelemetry
	| CostDeltaTelemetry
	| ErrorReportedTelemetry
	| CompactionCompletedTelemetry
	| CompactionSavingsTelemetry
	| UsageLimitSnapshotTelemetry;

export type TelemetrySubscriber = (event: TelemetryEvent) => void;

const subscribers = new Set<TelemetrySubscriber>();

/** Register a subscriber; returns a disposer. */
export function subscribeTelemetry(subscriber: TelemetrySubscriber): () => void {
	subscribers.add(subscriber);
	return () => {
		subscribers.delete(subscriber);
	};
}

/** Publish an event. No-op without subscribers; subscriber throws are swallowed. */
export function emitTelemetryEvent(event: TelemetryEvent): void {
	if (subscribers.size === 0) return;
	for (const subscriber of subscribers) {
		try {
			subscriber(event);
		} catch (error) {
			logger.debug("telemetry subscriber failed", { type: event.type, error: String(error) });
		}
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/coding-agent/test/telemetry-events.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Type check and commit**

```bash
cd packages/coding-agent && bun run check:types && cd ../..
git add packages/coding-agent/src/telemetry/events.ts packages/coding-agent/test/telemetry-events.test.ts
git commit -m "feat(telemetry): typed telemetry event bus"
```

---

### Task 2: Bootstrap refactor, identity module, and the `aura` rename

**Files:**
- Create: `packages/coding-agent/src/telemetry/init.ts` (moved bootstrap from `telemetry-export.ts`)
- Create: `packages/coding-agent/src/telemetry/identity.ts`
- Create: `packages/coding-agent/src/telemetry/index.ts`
- Modify: `packages/coding-agent/src/telemetry-export.ts` → becomes a re-export shim
- Modify: `packages/coding-agent/test/otel-signals-probe.ts` (event/metric name expectations move in Task 3; here only service-name defaults if asserted)
- Test: `packages/coding-agent/test/telemetry-identity.test.ts`

**Interfaces:**
- Consumes: `VERSION`, `getConfigRootDir`, `logger`, `postmortem` from `@oh-my-pi/pi-utils` (`VERSION` at `packages/utils/src/dirs.ts:36`; `getConfigRootDir()` at `:437`).
- Produces:
  - `telemetry/init.ts`: `initTelemetryExport(options?: InitTelemetryOptions): Promise<void>`, `isTelemetryExportEnabled(): boolean`, `createTelemetryExportConfig(config)`, `flushTelemetryExport(): Promise<void>` — same behavior as today, plus `InitTelemetryOptions { settings?: Settings }` (settings resolution lands in Task 4; define the options type now).
  - `telemetry/identity.ts`: `buildResourceAttributes(options?: { settings?: Settings }): Record<string, string>` and `getOrCreateInstallId(): string`.
  - `telemetry/index.ts` re-exports all of the above plus `events.ts` exports.
  - `telemetry-export.ts` shim: `export * from "./telemetry";` (keeps `@oh-my-pi/pi-coding-agent/telemetry-export` subpath and `main.ts`/`print-mode.ts` imports working unchanged).

- [ ] **Step 1: Write the failing identity test**

```ts
// packages/coding-agent/test/telemetry-identity.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let tmpDir: string;
let savedConfigDir: string | undefined;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-telemetry-id-"));
	savedConfigDir = process.env.PI_CONFIG_DIR;
	process.env.PI_CONFIG_DIR = tmpDir;
});

afterEach(() => {
	if (savedConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
	else process.env.PI_CONFIG_DIR = savedConfigDir;
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("telemetry identity", () => {
	it("generates a stable install id and persists it", async () => {
		const { refreshDirsFromEnv } = await import("@oh-my-pi/pi-utils/dirs");
		refreshDirsFromEnv();
		const { getOrCreateInstallId } = await import("../src/telemetry/identity");
		const first = getOrCreateInstallId();
		const second = getOrCreateInstallId();
		expect(first).toMatch(/^[0-9a-f-]{36}$/);
		expect(second).toBe(first);
	});

	it("default resource attributes are pseudonymous", async () => {
		const { refreshDirsFromEnv } = await import("@oh-my-pi/pi-utils/dirs");
		refreshDirsFromEnv();
		const { buildResourceAttributes } = await import("../src/telemetry/identity");
		const attrs = buildResourceAttributes();
		expect(attrs["service.name"]).toBe("aura");
		expect(attrs["service.version"]).toBeString();
		expect(attrs["aura.install.id"]).toMatch(/^[0-9a-f-]{36}$/);
		expect(attrs["host.name"]).toBeUndefined();
	});
});
```

Note: if `refreshDirsFromEnv` is not exported from `@oh-my-pi/pi-utils/dirs` (it is declared at `packages/utils/src/dirs.ts:425` — verify it is exported), have `getOrCreateInstallId` resolve `getConfigRootDir()` lazily at call time instead and drop the refresh calls.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/coding-agent/test/telemetry-identity.test.ts`
Expected: FAIL — cannot resolve `../src/telemetry/identity`.

- [ ] **Step 3: Write `identity.ts`**

```ts
// packages/coding-agent/src/telemetry/identity.ts
/**
 * Telemetry resource identity.
 *
 * Pseudonymous by default: a random install id persisted under the config
 * root, service name/version, and nothing that identifies the human. Opt-in
 * identity attributes (hostname, workspace) are added only when the matching
 * telemetry.identity.* setting is true (account identity is handled at the
 * usage-limit event level, not as a resource attribute).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigRootDir, logger, VERSION } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";

const SERVICE_NAME = "aura";

let cachedInstallId: string | undefined;

/**
 * A random UUID generated once per install, persisted at
 * `<configRoot>/telemetry-install-id`. Random (not machine-derived), so it is
 * strictly non-reversible; deleting the file rotates the id.
 */
export function getOrCreateInstallId(): string {
	if (cachedInstallId) return cachedInstallId;
	const file = path.join(getConfigRootDir(), "telemetry-install-id");
	try {
		const existing = fs.readFileSync(file, "utf8").trim();
		if (/^[0-9a-f-]{36}$/.test(existing)) {
			cachedInstallId = existing;
			return existing;
		}
	} catch {
		// fall through to mint
	}
	const minted = crypto.randomUUID();
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `${minted}\n`, { mode: 0o600 });
	} catch (error) {
		logger.debug("telemetry: could not persist install id", { error: String(error) });
	}
	cachedInstallId = minted;
	return minted;
}

/** Resource attributes for all providers. `OTEL_SERVICE_NAME` env overrides the name. */
export function buildResourceAttributes(options?: { settings?: Settings }): Record<string, string> {
	const attrs: Record<string, string> = {
		"service.name": process.env.OTEL_SERVICE_NAME ?? SERVICE_NAME,
		"service.version": VERSION,
		"aura.install.id": getOrCreateInstallId(),
	};
	const settings = options?.settings;
	if (settings?.get("telemetry.identity.hostname")) attrs["host.name"] = os.hostname();
	if (settings?.get("telemetry.identity.workspace")) attrs["aura.workspace.path"] = process.cwd();
	return attrs;
}
```

Note: `settings.get("telemetry.identity.hostname")` will not type-check until Task 4 adds the schema keys. For THIS task, accept `options?: { settings?: Settings }` but guard with `settings?.get(...)` behind a `try`/optional call only if the keys exist — simplest: in this task, ship the function with the settings-based branches commented OUT (a `// Task 4 enables identity opt-ins` marker is not allowed — instead, ship without the two `if (settings?...)` lines and without the `Settings` import; Task 4 adds them together with the schema). The test above only asserts the default path.

- [ ] **Step 4: Move the bootstrap into `telemetry/init.ts`**

Move the ENTIRE current content of `packages/coding-agent/src/telemetry-export.ts` (all 500 lines) to `packages/coding-agent/src/telemetry/init.ts`, with exactly these changes:

1. Replace the `SERVICE_NAME` const and the resource construction (`telemetry-export.ts:53` and `:149-151`) with:

```ts
import { resourceFromAttributes } from "@opentelemetry/resources";
import { buildResourceAttributes } from "./identity";
// inside registerProviders(...):
const resource = resourceFromAttributes(buildResourceAttributes(options));
```

2. Change `initTelemetryExport` signature to `initTelemetryExport(options: InitTelemetryOptions = {}): Promise<void>` with:

```ts
export interface InitTelemetryOptions {
	/** Settings instance for telemetry.* config (env always wins). */
	settings?: import("../config/settings").Settings;
}
```

Thread `options` through to `registerProviders(signalConfig, options)`.

3. Rename log event names: `"pi.omp.log"` → `"aura.log"`, `"pi.omp.agent.run.completed"` → `"aura.agent.run.completed"`, `"pi.omp.telemetry.warning"` → `"aura.telemetry.warning"`, and all `pi.omp.agent.*` LOG ATTRIBUTE keys in `emitRunSummaryLog` → `aura.agent.*` (e.g. `"aura.agent.step_count"`).

4. Keep `AgentMetricRecorder` here for now (Task 3 moves it to `metrics.ts` and renames instruments) but rename its instrument names NOW to avoid a second probe churn: `pi.omp.agent.chat.cost.estimated_usd` → `aura.agent.chat.cost.estimated_usd`, `pi.omp.agent.runs` → `aura.agent.runs`, `pi.omp.agent.steps` → `aura.agent.steps`, `pi.omp.agent.chat.calls` → `aura.agent.chat.calls`, `pi.omp.agent.chat.duration` → `aura.agent.chat.duration`, `pi.omp.agent.tool.calls` → `aura.agent.tool.calls`, `pi.omp.agent.tool.duration` → `aura.agent.tool.duration`, `pi.omp.agent.errors` → `aura.agent.errors`, and attribute keys `pi.omp.tool.status` → `aura.tool.status`, `pi.omp.agent.models_used.count` → `aura.agent.models_used.count` (and the other four coverage counts), `pi.gen_ai.agent.id`/`pi.gen_ai.agent.name` → `aura.agent.id`/`aura.agent.name`. `gen_ai.client.token.usage` and `gen_ai.*` semconv keys stay unchanged.

Then create the barrel and shim:

```ts
// packages/coding-agent/src/telemetry/index.ts
export * from "./events";
export * from "./identity";
export * from "./init";
```

```ts
// packages/coding-agent/src/telemetry-export.ts (entire new content)
/** Back-compat shim: the telemetry subsystem now lives in ./telemetry. */
export * from "./telemetry";
```

5. Update `packages/coding-agent/test/otel-signals-probe.ts`: its metric-name assertions reference `pi.omp.agent.chat.calls`, `pi.omp.agent.tool.calls`, `pi.omp.agent.tool.duration` — rename all three to the `aura.agent.*` equivalents.

- [ ] **Step 5: Run the full telemetry test suite**

Run: `bun test packages/coding-agent/test/telemetry-identity.test.ts packages/coding-agent/test/telemetry-export.test.ts`
Expected: PASS. The export/signals probes run in subprocesses — this verifies renames end-to-end.

- [ ] **Step 6: Type check, lint, commit**

```bash
cd packages/coding-agent && bun run check:types && bunx biome check src/telemetry src/telemetry-export.ts && cd ../..
git add -A packages/coding-agent/src/telemetry packages/coding-agent/src/telemetry-export.ts packages/coding-agent/test
git commit -m "refactor(telemetry): split bootstrap into telemetry/ subsystem; rename pi.omp.*/oh-my-pi to aura"
```

---

### Task 3: Metrics module + OTLP sink consuming the event bus

**Files:**
- Create: `packages/coding-agent/src/telemetry/metrics.ts` (AgentMetricRecorder moves here, renamed `AuraMetricRecorder`, plus new instruments)
- Create: `packages/coding-agent/src/telemetry/sink-otlp.ts`
- Modify: `packages/coding-agent/src/telemetry/init.ts` (hooks emit events; sink registration)
- Test: `packages/coding-agent/test/telemetry-sink.test.ts`

**Interfaces:**
- Consumes: Task 1 bus (`subscribeTelemetry`, `TelemetryEvent`), Task 2 init internals.
- Produces:
  - `metrics.ts`: `class AuraMetricRecorder { constructor(meter: Meter); recordChatUsage(event: ChatUsageEvent): void; recordRun(summary: AgentRunSummary, coverage: AgentRunCoverage): void; recordSessionEnd(event: SessionEndedTelemetry): void; recordCompaction(event: CompactionCompletedTelemetry): void; recordCompactionSavings(event: CompactionSavingsTelemetry): void; recordUsageLimit(event: UsageLimitSnapshotTelemetry): void; recordError(phase: string, errorType: string): void }`
  - `sink-otlp.ts`: `registerOtlpSink(deps: { recorder?: AuraMetricRecorder; emitLog: EmitOtelLog }): () => void` where `EmitOtelLog = (level: logger.LogLevel, body: string, attributes: LogAttributes, eventName: string) => void` (init.ts's existing `emitOtelLog` minus the timestamp param).

- [ ] **Step 1: Write the failing sink test**

Use the OTel in-memory metric reader so no subprocess is needed:

```ts
// packages/coding-agent/test/telemetry-sink.test.ts
import { describe, expect, it } from "bun:test";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { AuraMetricRecorder } from "../src/telemetry/metrics";
import { registerOtlpSink } from "../src/telemetry/sink-otlp";
import { emitTelemetryEvent } from "../src/telemetry/events";

// InMemoryMetricExporter + PeriodicExportingMetricReader is the 2.x pattern;
// simpler: use the provider's forceFlush with a ManualMetricReader if available.
import { InMemoryMetricExporter, PeriodicExportingMetricReader, AggregationTemporality } from "@opentelemetry/sdk-metrics";

async function collect(exporter: InMemoryMetricExporter, provider: MeterProvider) {
	await provider.forceFlush();
	return exporter.getMetrics().flatMap(rm => rm.scopeMetrics.flatMap(sm => sm.metrics));
}

describe("otlp sink", () => {
	it("maps session.ended and compaction.completed events to aura.* instruments", async () => {
		const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
		const provider = new MeterProvider({
			readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
		});
		const recorder = new AuraMetricRecorder(provider.getMeter("test"));
		const logs: Array<{ eventName: string }> = [];
		const unregister = registerOtlpSink({
			recorder,
			emitLog: (_level, _body, _attrs, eventName) => logs.push({ eventName }),
		});

		emitTelemetryEvent({
			type: "session.ended",
			sessionId: "s1",
			mode: "print",
			durationMs: 120_000,
			activeMs: 30_000,
			turns: 4,
			tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
			estimatedCostUsd: 0.02,
			endReason: "exit",
		});
		emitTelemetryEvent({
			type: "compaction.completed",
			sessionId: "s1",
			strategy: "context-full",
			trigger: "threshold",
			outcome: "ok",
			tokensBefore: 100_000,
			tokensAfter: 20_000,
			durationMs: 900,
		});

		const metrics = await collect(exporter, provider);
		const names = metrics.map(m => m.descriptor.name);
		expect(names).toContain("aura.session.duration");
		expect(names).toContain("aura.session.turns");
		expect(names).toContain("aura.compaction.count");
		expect(names).toContain("aura.compaction.tokens_saved");
		expect(names).toContain("aura.compaction.effectiveness");
		expect(logs.map(l => l.eventName)).toContain("aura.session.ended");
		expect(logs.map(l => l.eventName)).toContain("aura.compaction.completed");

		const effectiveness = metrics.find(m => m.descriptor.name === "aura.compaction.effectiveness");
		// 1 - 20000/100000 = 0.8
		expect((effectiveness?.dataPoints[0]?.value as { sum?: number })?.sum).toBeCloseTo(0.8);

		unregister();
		await provider.shutdown();
	});
});
```

(If `InMemoryMetricExporter` is not exported by the pinned `@opentelemetry/sdk-metrics`, fall back to a minimal local `class TestMetricExporter implements PushMetricExporter` that stores `ResourceMetrics` — ~15 lines; keep the same assertions.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/coding-agent/test/telemetry-sink.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement `metrics.ts`**

Move `AgentMetricRecorder`, `metricAttributes`, and `TOOL_STATUSES` from `init.ts` into `metrics.ts`; rename the class `AuraMetricRecorder`; keep `recordChatUsage`/`recordRun` bodies unchanged. Add new instruments in the constructor and the new record methods:

```ts
// additions inside the constructor
this.#sessionDuration = meter.createHistogram("aura.session.duration", {
	description: "Wall-clock session duration.",
	unit: "s",
});
this.#sessionTurns = meter.createHistogram("aura.session.turns", {
	description: "User turns completed in a session.",
	unit: "{turn}",
});
this.#compactions = meter.createCounter("aura.compaction.count", {
	description: "Compaction attempts by strategy, trigger, and outcome.",
	unit: "{compaction}",
});
this.#compactionTokensSaved = meter.createCounter("aura.compaction.tokens_saved", {
	description: "Context tokens removed by compaction (before minus after).",
	unit: "{token}",
});
this.#compactionDuration = meter.createHistogram("aura.compaction.duration", {
	description: "Compaction latency.",
	unit: "ms",
});
this.#compactionEffectiveness = meter.createHistogram("aura.compaction.effectiveness", {
	description: "Fraction of context removed by compaction (1 - after/before).",
	unit: "1",
});
this.#snapcompactTokensSaved = meter.createCounter("aura.snapcompact.tokens_saved", {
	description: "Tokens kept off the wire by snapcompact tool-result imaging.",
	unit: "{token}",
});
this.#usageLimitUtilization = meter.createGauge("aura.usage_limit.utilization", {
	description: "Subscription usage-limit window utilization (0-1).",
	unit: "1",
});
```

```ts
recordSessionEnd(event: SessionEndedTelemetry): void {
	const attrs = metricAttributes({ "aura.session.mode": event.mode, "aura.session.end_reason": event.endReason });
	this.#sessionDuration.record(event.durationMs / 1000, attrs);
	this.#sessionTurns.record(event.turns, attrs);
}

recordCompaction(event: CompactionCompletedTelemetry): void {
	const attrs = metricAttributes({
		"aura.compaction.strategy": event.strategy,
		"aura.compaction.trigger": event.trigger,
		"aura.compaction.outcome": event.outcome,
	});
	this.#compactions.add(1, attrs);
	if (event.durationMs > 0) this.#compactionDuration.record(event.durationMs, attrs);
	if (event.outcome === "ok" && event.tokensBefore && event.tokensAfter !== undefined && event.tokensBefore > 0) {
		const saved = Math.max(0, event.tokensBefore - event.tokensAfter);
		if (saved > 0) this.#compactionTokensSaved.add(saved, attrs);
		this.#compactionEffectiveness.record(Math.min(1, Math.max(0, 1 - event.tokensAfter / event.tokensBefore)), attrs);
	}
	if (event.outcome === "error") this.recordError("compaction", "compaction_error");
}

recordCompactionSavings(event: CompactionSavingsTelemetry): void {
	this.#snapcompactTokensSaved.add(
		event.savedTokens,
		metricAttributes({ "gen_ai.provider.name": event.provider, "gen_ai.request.model": event.model }),
	);
}

recordUsageLimit(event: UsageLimitSnapshotTelemetry): void {
	const entry = event.entry;
	if (entry.usedFraction === undefined) return;
	this.#usageLimitUtilization.record(entry.usedFraction, metricAttributes({
		"gen_ai.provider.name": entry.provider,
		"aura.usage_limit.id": entry.limitId,
		"aura.usage_limit.window": entry.windowLabel,
		"aura.account.key": entry.accountKey, // replaced by hash/email per identity settings in Task 7
	}));
}

recordError(phase: string, errorType: string): void {
	this.#errors.add(1, metricAttributes({ "error.type": errorType, "aura.error.phase": phase }));
}
```

Note: if `meter.createGauge` is unavailable in the pinned `@opentelemetry/sdk-metrics` line, use `createObservableGauge` with a `Map<string, { value: number; attrs: Attributes }>` updated by `recordUsageLimit` and reported in the observable callback — key = `${provider}/${entry.accountKey}/${entry.limitId}`.

- [ ] **Step 4: Implement `sink-otlp.ts`**

```ts
// packages/coding-agent/src/telemetry/sink-otlp.ts
/**
 * Sole telemetry-bus subscriber: maps TelemetryEvent to OTel instruments and
 * structured log records. Publishers stay OTel-free; this module is only
 * registered when an OTLP provider is live (init.ts).
 */
import type { LogAttributes } from "@opentelemetry/api-logs";
import type { logger } from "@oh-my-pi/pi-utils";
import { subscribeTelemetry, type TelemetryEvent } from "./events";
import type { AuraMetricRecorder } from "./metrics";

export type EmitOtelLog = (
	level: logger.LogLevel,
	body: string,
	attributes: LogAttributes,
	eventName: string,
) => void;

export interface OtlpSinkDeps {
	recorder?: AuraMetricRecorder;
	emitLog: EmitOtelLog;
}

export function registerOtlpSink(deps: OtlpSinkDeps): () => void {
	return subscribeTelemetry(event => handle(deps, event));
}

function handle(deps: OtlpSinkDeps, event: TelemetryEvent): void {
	switch (event.type) {
		case "session.started":
			deps.emitLog("info", "session started", {
				"session.id": event.sessionId,
				"aura.session.mode": event.mode,
				"aura.session.resumed": event.resumed,
			}, "aura.session.started");
			break;
		case "session.ended":
			deps.recorder?.recordSessionEnd(event);
			deps.emitLog("info", "session ended", {
				"session.id": event.sessionId,
				"aura.session.mode": event.mode,
				"aura.session.duration_ms": event.durationMs,
				"aura.session.active_ms": event.activeMs,
				"aura.session.turns": event.turns,
				"aura.session.end_reason": event.endReason,
				"aura.agent.usage.input_tokens": event.tokens.input,
				"aura.agent.usage.output_tokens": event.tokens.output,
				"aura.agent.usage.total_tokens": event.tokens.total,
				"aura.agent.cost.estimated_usd": event.estimatedCostUsd,
			}, "aura.session.ended");
			break;
		case "turn.completed":
			deps.recorder?.recordRun(event.summary, event.coverage);
			break;
		case "chat.usage":
			deps.recorder?.recordChatUsage(event.event);
			break;
		case "cost.delta":
			// covered by chat.usage cost counter; reserved for future per-step logs
			break;
		case "error.reported":
			deps.recorder?.recordError(event.phase, event.errorType);
			break;
		case "compaction.completed":
			deps.recorder?.recordCompaction(event);
			deps.emitLog(event.outcome === "error" ? "warn" : "info", "compaction completed", {
				"session.id": event.sessionId,
				"aura.compaction.strategy": event.strategy,
				"aura.compaction.trigger": event.trigger,
				"aura.compaction.outcome": event.outcome,
				"aura.compaction.tokens_before": event.tokensBefore,
				"aura.compaction.tokens_after": event.tokensAfter,
				"aura.compaction.duration_ms": event.durationMs,
				"aura.compaction.error": event.errorMessage,
			}, "aura.compaction.completed");
			break;
		case "compaction.savings":
			deps.recorder?.recordCompactionSavings(event);
			break;
		case "usage_limit.snapshot":
			deps.recorder?.recordUsageLimit(event);
			break;
	}
}
```

(Attribute records may contain `undefined` values — reuse the existing `logAttributesFromContext` filter from init.ts by exporting it, or filter inline before calling `emitLog`.)

- [ ] **Step 5: Rewire `init.ts`**

In `registerProviders`: after the metric/log providers are set up, construct `metricRecorder = new AuraMetricRecorder(...)` (import from `./metrics`) and register the sink; store the disposer and call it in the postmortem shutdown:

```ts
unregisterSink = registerOtlpSink({
	recorder: metricRecorder,
	emitLog: (level, body, attributes, eventName) => emitOtelLog(level, body, attributes, eventName),
});
```

In `createTelemetryExportConfig`, replace direct recorder calls with bus emissions (the sink now does the recording), and add `onCostDelta`:

```ts
onChatUsage: async event => {
	await config?.onChatUsage?.(event);
	emitTelemetryEvent({ type: "chat.usage", event });
},
onRunEnd: (summary, coverage) => {
	config?.onRunEnd?.(summary, coverage);
	emitTelemetryEvent({ type: "turn.completed", summary, coverage });
	emitRunSummaryLog(summary, coverage);
},
onCostDelta: delta => {
	config?.onCostDelta?.(delta);
	emitTelemetryEvent({ type: "cost.delta", delta });
},
```

- [ ] **Step 6: Run tests**

Run: `bun test packages/coding-agent/test/telemetry-sink.test.ts packages/coding-agent/test/telemetry-export.test.ts packages/coding-agent/test/telemetry-events.test.ts`
Expected: PASS (signals probe subprocess still validates the OTLP wire path with renamed instruments).

- [ ] **Step 7: Type check and commit**

```bash
cd packages/coding-agent && bun run check:types && cd ../..
git add -A packages/coding-agent/src/telemetry packages/coding-agent/test
git commit -m "feat(telemetry): aura metric instruments + OTLP sink over the event bus"
```

---

### Task 4: `telemetry.*` settings + settings-driven activation

**Files:**
- Modify: `packages/coding-agent/src/config/settings-schema.ts` (new keys; follow the entry shapes at `settings-schema.ts:190-280`; 3-segment dotted keys are established convention, e.g. `"auth.broker.url"`)
- Modify: `packages/coding-agent/src/telemetry/init.ts` (settings fallback in signal resolution)
- Modify: `packages/coding-agent/src/telemetry/identity.ts` (enable the identity opt-in branches)
- Modify: `packages/coding-agent/src/main.ts:1414-1430` (pass settings into init)
- Test: `packages/coding-agent/test/telemetry-settings.test.ts`

**Interfaces:**
- Consumes: `Settings.get` (`packages/coding-agent/src/config/settings.ts:458`), Task 2 `InitTelemetryOptions`.
- Produces: setting keys `telemetry.enabled`, `telemetry.endpoint`, `telemetry.headers`, `telemetry.signals`, `telemetry.identity.hostname`, `telemetry.identity.account`, `telemetry.identity.workspace`.

- [ ] **Step 1: Add schema entries**

In `settings-schema.ts`, add (new "Telemetry" group under an appropriate existing tab — use the same tab as other diagnostics settings; check `TAB_GROUPS` and add `"Telemetry"` to that tab's group list):

```ts
	// Telemetry: OpenTelemetry export (off by default; OTEL_* env always wins)
	"telemetry.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "app",
			group: "Telemetry",
			label: "Telemetry Export",
			description: "Export session, usage, cost, error, and compaction telemetry to your own OpenTelemetry collector (OTLP http/protobuf).",
		},
	},
	"telemetry.endpoint": {
		type: "string",
		default: undefined,
		ui: {
			tab: "app",
			group: "Telemetry",
			label: "OTLP Endpoint",
			description: "Base OTLP endpoint, e.g. http://localhost:4318. Equivalent to OTEL_EXPORTER_OTLP_ENDPOINT (env wins).",
		},
	},
	"telemetry.headers": {
		type: "record",
		default: {},
	},
	"telemetry.signals": {
		type: "array",
		default: ["traces", "logs", "metrics"],
	},
	"telemetry.identity.hostname": {
		type: "boolean",
		default: false,
		ui: {
			tab: "app",
			group: "Telemetry",
			label: "Include Hostname",
			description: "Attach host.name to exported telemetry.",
		},
	},
	"telemetry.identity.account": {
		type: "boolean",
		default: false,
		ui: {
			tab: "app",
			group: "Telemetry",
			label: "Include Account Identity",
			description: "Attach account email to usage-limit telemetry (otherwise a hashed account key is used).",
		},
	},
	"telemetry.identity.workspace": {
		type: "boolean",
		default: false,
		ui: {
			tab: "app",
			group: "Telemetry",
			label: "Include Workspace Path",
			description: "Attach the workspace directory path to exported telemetry.",
		},
	},
```

If the chosen `tab` value `"app"` doesn't exist, pick the tab used by `statusLine.*` or logging-adjacent settings; the `record`/`array` entries stay UI-less (config-file only) like `"gc.retainNewestPerCwd"` (`settings-schema.ts:5590`).

- [ ] **Step 2: Write the failing settings-resolution test**

```ts
// packages/coding-agent/test/telemetry-settings.test.ts
import { describe, expect, it } from "bun:test";
import { resolveTelemetryEnv } from "../src/telemetry/init";

function fakeSettings(values: Record<string, unknown>) {
	return { get: (path: string) => values[path] } as never;
}

describe("settings-driven telemetry activation", () => {
	it("maps telemetry.* settings to OTEL env fallbacks", () => {
		const env = resolveTelemetryEnv(
			fakeSettings({
				"telemetry.enabled": true,
				"telemetry.endpoint": "http://localhost:4318",
				"telemetry.headers": { "x-api-key": "k" },
				"telemetry.signals": ["metrics", "logs"],
			}),
			{}, // current process.env view
		);
		expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://localhost:4318");
		expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBe("x-api-key=k");
		expect(env.OTEL_TRACES_EXPORTER).toBe("none"); // traces not in signals list
	});

	it("env always wins and disabled settings contribute nothing", () => {
		const withEnv = resolveTelemetryEnv(
			fakeSettings({ "telemetry.enabled": true, "telemetry.endpoint": "http://settings:4318" }),
			{ OTEL_EXPORTER_OTLP_ENDPOINT: "http://env:4318" },
		);
		expect(withEnv.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://env:4318");

		const disabled = resolveTelemetryEnv(
			fakeSettings({ "telemetry.enabled": false, "telemetry.endpoint": "http://settings:4318" }),
			{},
		);
		expect(disabled.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
	});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/coding-agent/test/telemetry-settings.test.ts`
Expected: FAIL — `resolveTelemetryEnv` not exported.

- [ ] **Step 4: Implement resolution in `init.ts`**

```ts
/** Computed OTEL env view: process env merged over telemetry.* settings. Exported for tests. */
export function resolveTelemetryEnv(
	settings: Pick<Settings, "get"> | undefined,
	processEnv: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
	const out: Record<string, string | undefined> = { ...processEnv };
	if (!settings?.get("telemetry.enabled")) return out;
	const endpoint = settings.get("telemetry.endpoint");
	if (endpoint && !out.OTEL_EXPORTER_OTLP_ENDPOINT) out.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint;
	const headers = settings.get("telemetry.headers");
	if (headers && Object.keys(headers).length > 0 && !out.OTEL_EXPORTER_OTLP_HEADERS) {
		out.OTEL_EXPORTER_OTLP_HEADERS = Object.entries(headers)
			.map(([k, v]) => `${k}=${v}`)
			.join(",");
	}
	const signals = settings.get("telemetry.signals");
	if (Array.isArray(signals)) {
		if (!signals.includes("traces") && !out.OTEL_TRACES_EXPORTER) out.OTEL_TRACES_EXPORTER = "none";
		if (!signals.includes("logs") && !out.OTEL_LOGS_EXPORTER) out.OTEL_LOGS_EXPORTER = "none";
		if (!signals.includes("metrics") && !out.OTEL_METRICS_EXPORTER) out.OTEL_METRICS_EXPORTER = "none";
	}
	return out;
}
```

Change `resolveSignalConfig()` and the exporter construction to read from `resolveTelemetryEnv(options.settings)` instead of raw `process.env`. IMPORTANT: the OTLP exporters read `OTEL_EXPORTER_OTLP_*` from `process.env` at construction — when the settings path (not env) supplied the endpoint/headers, assign the computed values back onto `process.env` before constructing exporters (only keys that were previously unset), and note this in a comment.

Enable the two identity branches in `identity.ts` (from Task 2 Step 3 note) now that the schema keys exist, and thread `options.settings` from `registerProviders` into `buildResourceAttributes`.

- [ ] **Step 5: Wire `main.ts`**

At `main.ts:1423`, change `await logger.time("initTelemetryExport", initTelemetryExport);` to:

```ts
await logger.time("initTelemetryExport", () => initTelemetryExport({ settings: settingsInstance }));
```

- [ ] **Step 6: Run tests, type check, commit**

Run: `bun test packages/coding-agent/test/telemetry-settings.test.ts packages/coding-agent/test/telemetry-export.test.ts` — expected PASS.

```bash
cd packages/coding-agent && bun run check:types && cd ../..
git add -A packages/coding-agent/src packages/coding-agent/test
git commit -m "feat(telemetry): telemetry.* settings with OTEL env precedence + identity opt-ins"
```

---

### Task 5: Session lifecycle publisher

**Files:**
- Create: `packages/coding-agent/src/telemetry/publishers/session-lifecycle.ts`
- Modify: `packages/coding-agent/src/main.ts` (wire after session creation)
- Test: `packages/coding-agent/test/telemetry-session-lifecycle.test.ts`

**Interfaces:**
- Consumes: Task 1 bus; `SessionStats` (`packages/coding-agent/src/session/agent-session-types.ts:307`); `postmortem.register` (`packages/utils/src/postmortem.ts:279`).
- Produces: `trackSessionLifecycle(options: SessionLifecycleOptions): SessionLifecycleTracker` with:

```ts
export interface SessionLifecycleOptions {
	sessionId: string;
	mode: SessionMode;
	resumed: boolean;
	getStats: () => SessionStats;
}
export interface SessionLifecycleTracker {
	/** Emits session.ended exactly once; later calls are no-ops. */
	end(reason: string): void;
}
```

- [ ] **Step 1: Write the failing test**

```ts
// packages/coding-agent/test/telemetry-session-lifecycle.test.ts
import { describe, expect, it } from "bun:test";
import { subscribeTelemetry, emitTelemetryEvent, type TelemetryEvent } from "../src/telemetry/events";
import { trackSessionLifecycle } from "../src/telemetry/publishers/session-lifecycle";
import type { SessionStats } from "../src/session/agent-session-types";

const stats: SessionStats = {
	sessionFile: undefined,
	sessionId: "s1",
	userMessages: 3,
	assistantMessages: 3,
	toolCalls: 5,
	toolResults: 5,
	totalMessages: 11,
	tokens: { input: 1000, output: 400, reasoning: 0, cacheRead: 200, cacheWrite: 100, total: 1400 },
	premiumRequests: 0,
	cost: 0.05,
};

describe("session lifecycle publisher", () => {
	it("emits started immediately and ended exactly once with stats totals", () => {
		const seen: TelemetryEvent[] = [];
		const unsubscribe = subscribeTelemetry(e => seen.push(e));
		const tracker = trackSessionLifecycle({ sessionId: "s1", mode: "tui", resumed: true, getStats: () => stats });

		// a completed turn accumulates active time
		emitTelemetryEvent({
			type: "turn.completed",
			summary: { chats: { totalLatencyMs: 2000 }, tools: { totalLatencyMs: 500 } } as never,
			coverage: {} as never,
		});

		tracker.end("exit");
		tracker.end("exit"); // duplicate must not re-emit

		const started = seen.filter(e => e.type === "session.started");
		const ended = seen.filter(e => e.type === "session.ended");
		expect(started).toHaveLength(1);
		expect(started[0]).toMatchObject({ sessionId: "s1", mode: "tui", resumed: true });
		expect(ended).toHaveLength(1);
		expect(ended[0]).toMatchObject({
			sessionId: "s1",
			turns: 3, // userMessages
			activeMs: 2500,
			estimatedCostUsd: 0.05,
			endReason: "exit",
			tokens: { input: 1000, output: 400, cacheRead: 200, cacheWrite: 100, total: 1400 },
		});
		unsubscribe();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/coding-agent/test/telemetry-session-lifecycle.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the publisher**

```ts
// packages/coding-agent/src/telemetry/publishers/session-lifecycle.ts
/**
 * Publishes session.started / session.ended telemetry.
 *
 * "Active" time is the sum of chat+tool latency reported by each completed
 * turn (turn.completed events on this same bus) — an approximation of in-turn
 * activity as opposed to wall-clock idle time.
 */
import type { SessionStats } from "../../session/agent-session-types";
import { emitTelemetryEvent, type SessionMode, subscribeTelemetry } from "../events";

export interface SessionLifecycleOptions {
	sessionId: string;
	mode: SessionMode;
	resumed: boolean;
	getStats: () => SessionStats;
}

export interface SessionLifecycleTracker {
	end(reason: string): void;
}

export function trackSessionLifecycle(options: SessionLifecycleOptions): SessionLifecycleTracker {
	const startedAt = performance.now();
	let activeMs = 0;
	let ended = false;

	const unsubscribe = subscribeTelemetry(event => {
		if (event.type !== "turn.completed") return;
		activeMs += (event.summary.chats?.totalLatencyMs ?? 0) + (event.summary.tools?.totalLatencyMs ?? 0);
	});

	emitTelemetryEvent({
		type: "session.started",
		sessionId: options.sessionId,
		mode: options.mode,
		resumed: options.resumed,
	});

	return {
		end(reason: string): void {
			if (ended) return;
			ended = true;
			unsubscribe();
			let stats: SessionStats | undefined;
			try {
				stats = options.getStats();
			} catch {
				stats = undefined;
			}
			emitTelemetryEvent({
				type: "session.ended",
				sessionId: options.sessionId,
				mode: options.mode,
				durationMs: performance.now() - startedAt,
				activeMs,
				turns: stats?.userMessages ?? 0,
				tokens: {
					input: stats?.tokens.input ?? 0,
					output: stats?.tokens.output ?? 0,
					cacheRead: stats?.tokens.cacheRead ?? 0,
					cacheWrite: stats?.tokens.cacheWrite ?? 0,
					total: stats?.tokens.total ?? 0,
				},
				estimatedCostUsd: stats?.cost ?? 0,
				endReason: reason,
			});
		},
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/coding-agent/test/telemetry-session-lifecycle.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire `main.ts`**

In `main.ts`, after the session is created and telemetry is initialized (the block at `main.ts:1414-1430` runs BEFORE session creation — add the lifecycle wiring where the created session is available; search for the `createAgentSession(` call result in main.ts). Mode/resumed come from existing locals (`main.ts:1161, 1210-1215`; `parsed.continue`/`parsed.resume`/`parsed.fork` around `main.ts:622-778`):

```ts
if (isTelemetryExportEnabled()) {
	const telemetryMode = mode === "acp" ? "acp" : mode === "rpc" || mode === "rpc-ui" ? "rpc" : isInteractive ? "tui" : "print";
	const lifecycle = trackSessionLifecycle({
		sessionId: session.sessionManager.getSessionId(),
		mode: telemetryMode,
		resumed: Boolean(parsedArgs.continue || parsedArgs.resume || parsedArgs.fork),
		getStats: () => session.getSessionStats(),
	});
	// Registered AFTER initTelemetryExport's own postmortem hook, so (reverse
	// order) this runs first and the ended event is flushed by the OTel shutdown.
	postmortem.register("telemetry-session-lifecycle", reason => lifecycle.end(String(reason)));
}
```

Verify `session.getSessionStats()` is the public accessor (SessionStatsTracker `getSessionStats` at `packages/coding-agent/src/session/session-stats.ts:43` is exposed on AgentSession — grep `getSessionStats` in `agent-session.ts` for the exact public method; adapt the call if it's named differently, e.g. via a stats getter).

- [ ] **Step 6: Type check, run telemetry tests, commit**

```bash
cd packages/coding-agent && bun run check:types && cd ../..
bun test packages/coding-agent/test/telemetry-session-lifecycle.test.ts
git add -A packages/coding-agent/src packages/coding-agent/test
git commit -m "feat(telemetry): session lifecycle events + session duration/turn metrics"
```

---

### Task 6: Compaction telemetry (auto + manual + snapcompact savings)

**Files:**
- Modify: `packages/coding-agent/src/session/agent-session.ts` (instrument the `auto_compaction_start`/`auto_compaction_end` re-emit branches at `agent-session.ts:3191-3207`, and the `compact()` method at `agent-session.ts:4040-4042`)
- Modify: `packages/coding-agent/src/sdk.ts:2922` (wrap the snapcompact savings recorder)
- Modify: `packages/coding-agent/src/telemetry/sink-otlp.ts` (synthesize the `aura.compaction` span)
- Test: `packages/coding-agent/test/telemetry-compaction.test.ts`

**Interfaces:**
- Consumes: `emitTelemetryEvent`, `CompactionCompletedTelemetry`, `CompactionSavingsTelemetry` (Task 1); `AutoCompactionStartEvent`/`AutoCompactionEndEvent` (`packages/coding-agent/src/extensibility/shared-events.ts:221-238`); `CompactionResult.tokensBefore` (`packages/agent/src/compaction/compaction.ts:146`); `AgentSession.getContextUsage()` (`agent-session.ts:7741`); `SnapcompactSavingsRecorder` (`packages/coding-agent/src/session/snapcompact-savings-journal.ts:49`).
- Produces: no new exports; events on the bus.

- [ ] **Step 1: Write the failing unit test for the event mapping helper**

Put the mapping logic in a small pure helper so it is testable without an AgentSession. Create it as part of this task in `packages/coding-agent/src/telemetry/publishers/compaction.ts`:

```ts
// packages/coding-agent/test/telemetry-compaction.test.ts
import { describe, expect, it } from "bun:test";
import { compactionEndToTelemetry } from "../src/telemetry/publishers/compaction";

describe("compaction telemetry mapping", () => {
	it("maps a successful auto_compaction_end to outcome ok with token counts", () => {
		const event = compactionEndToTelemetry({
			sessionId: "s1",
			trigger: "threshold",
			action: "context-full",
			result: { summary: "sum", firstKeptEntryId: "e1", tokensBefore: 100_000 },
			aborted: false,
			willRetry: false,
			skipped: false,
			errorMessage: undefined,
			tokensAfter: 20_000,
			durationMs: 1234,
		});
		expect(event).toMatchObject({
			type: "compaction.completed",
			strategy: "context-full",
			trigger: "threshold",
			outcome: "ok",
			tokensBefore: 100_000,
			tokensAfter: 20_000,
			durationMs: 1234,
		});
	});

	it("classifies aborted, will-retry, skipped, and error outcomes", () => {
		const base = {
			sessionId: "s1",
			trigger: "overflow" as const,
			action: "context-full" as const,
			result: undefined,
			aborted: false,
			willRetry: false,
			skipped: false,
			errorMessage: undefined,
			tokensAfter: undefined,
			durationMs: 10,
		};
		expect(compactionEndToTelemetry({ ...base, aborted: true }).outcome).toBe("aborted");
		expect(compactionEndToTelemetry({ ...base, willRetry: true }).outcome).toBe("will-retry");
		expect(compactionEndToTelemetry({ ...base, skipped: true }).outcome).toBe("skipped");
		expect(compactionEndToTelemetry({ ...base, errorMessage: "boom" }).outcome).toBe("error");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/coding-agent/test/telemetry-compaction.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the mapping helper**

```ts
// packages/coding-agent/src/telemetry/publishers/compaction.ts
/** Pure mapping from compaction-end facts to a telemetry event. */
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { CompactionCompletedTelemetry, CompactionTrigger } from "../events";

export interface CompactionEndFacts {
	sessionId: string;
	trigger: CompactionTrigger;
	action: string;
	result: Pick<CompactionResult, "tokensBefore"> | undefined;
	aborted: boolean;
	willRetry: boolean;
	skipped: boolean | undefined;
	errorMessage: string | undefined;
	tokensAfter: number | undefined;
	durationMs: number;
}

export function compactionEndToTelemetry(facts: CompactionEndFacts): CompactionCompletedTelemetry {
	const outcome = facts.aborted
		? "aborted"
		: facts.willRetry
			? "will-retry"
			: facts.skipped
				? "skipped"
				: facts.errorMessage
					? "error"
					: "ok";
	return {
		type: "compaction.completed",
		sessionId: facts.sessionId,
		strategy: facts.action,
		trigger: facts.trigger,
		outcome,
		tokensBefore: facts.result?.tokensBefore,
		tokensAfter: outcome === "ok" ? facts.tokensAfter : undefined,
		durationMs: facts.durationMs,
		errorMessage: facts.errorMessage,
	};
}
```

Run: `bun test packages/coding-agent/test/telemetry-compaction.test.ts` — expected PASS.

- [ ] **Step 4: Instrument auto compaction in `agent-session.ts`**

In the `#handleSessionEvent` dispatcher (`agent-session.ts:3191-3207`):
- On the `auto_compaction_start` branch: record `this.#compactionTelemetryStart = { at: performance.now(), trigger: event.reason };` (new private field `#compactionTelemetryStart: { at: number; trigger: CompactionTrigger } | undefined`).
- On the `auto_compaction_end` branch, after the extension re-emit:

```ts
const start = this.#compactionTelemetryStart;
this.#compactionTelemetryStart = undefined;
emitTelemetryEvent(
	compactionEndToTelemetry({
		sessionId: this.sessionManager.getSessionId(),
		trigger: start?.trigger ?? "threshold",
		action: event.action,
		result: event.result,
		aborted: event.aborted,
		willRetry: event.willRetry,
		skipped: event.skipped,
		errorMessage: event.errorMessage,
		tokensAfter: this.getContextUsage()?.tokens,
		durationMs: start ? performance.now() - start.at : 0,
	}),
);
```

- [ ] **Step 5: Instrument manual compaction in `AgentSession.compact()`**

Replace the body at `agent-session.ts:4040-4042`:

```ts
/** Compact the active session history. */
async compact(customInstructions?: string, options?: CompactOptions): Promise<CompactionResult> {
	const startedAt = performance.now();
	const tokensBefore = this.getContextUsage()?.tokens;
	try {
		const result = await this.#maintenance.compact(customInstructions, options);
		emitTelemetryEvent({
			type: "compaction.completed",
			sessionId: this.sessionManager.getSessionId(),
			strategy: options?.mode ?? "context-full",
			trigger: "manual",
			outcome: "ok",
			tokensBefore: result.tokensBefore || tokensBefore,
			tokensAfter: this.getContextUsage()?.tokens,
			durationMs: performance.now() - startedAt,
		});
		return result;
	} catch (error) {
		emitTelemetryEvent({
			type: "compaction.completed",
			sessionId: this.sessionManager.getSessionId(),
			strategy: options?.mode ?? "context-full",
			trigger: "manual",
			outcome: "error",
			tokensBefore,
			durationMs: performance.now() - startedAt,
			errorMessage: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}
```

(Check `CompactOptions` for the exact strategy/mode field name — `compact-modes.ts` overrides use `strategy?: "context-full" | "snapcompact"`; use whatever field `CompactOptions` actually exposes, falling back to `"context-full"`.)

- [ ] **Step 6: Wrap the snapcompact savings recorder in `sdk.ts`**

At `sdk.ts:2922`, replace the recorder argument:

```ts
// Journal the tokens each imaged tool result keeps off the wire, and mirror
// the savings onto the telemetry bus (frames never reach session.jsonl).
(() => {
	const journal = createSnapcompactSavingsRecorder(() => sessionManager.getSessionFile() ?? null);
	const record: SnapcompactSavingsRecorder = async (savings, model) => {
		await journal(savings, model);
		for (const saving of savings) {
			if (saving.savedTokens > 0) {
				emitTelemetryEvent({
					type: "compaction.savings",
					provider: model.provider,
					model: model.id,
					savedTokens: saving.savedTokens,
				});
			}
		}
	};
	return record;
})(),
```

(Wrapping OUTSIDE the factory is required: the journal skips null-session runs, but telemetry should still observe them — see the guard notes in `snapcompact-savings-journal.ts:41-48`. Verify `model.id` is the model identifier field used in `SnapcompactSavingsRecord`; the journal writes `model.id`-like fields — match it.)

- [ ] **Step 7: Synthesize the compaction span in the sink**

In `sink-otlp.ts`'s `compaction.completed` case, additionally create a retroactive span (import `trace`, `context` from `@opentelemetry/api`):

```ts
const tracer = trace.getTracer("aura-telemetry");
const now = Date.now();
const span = tracer.startSpan("aura.compaction", {
	startTime: new Date(now - event.durationMs),
	attributes: {
		"aura.compaction.strategy": event.strategy,
		"aura.compaction.trigger": event.trigger,
		"aura.compaction.outcome": event.outcome,
		"aura.compaction.tokens_before": event.tokensBefore,
		"aura.compaction.tokens_after": event.tokensAfter,
	},
}, context.active());
if (event.outcome === "error") span.setStatus({ code: SpanStatusCode.ERROR, message: event.errorMessage });
span.end(new Date(now));
```

Guard: only when the trace provider is registered (expose `isTraceExportEnabled()` from init.ts or pass a flag into `OtlpSinkDeps`).

- [ ] **Step 8: Run tests, type check, commit**

```bash
bun test packages/coding-agent/test/telemetry-compaction.test.ts packages/coding-agent/test/compaction.test.ts
cd packages/coding-agent && bun run check:types && cd ../..
git add -A packages/coding-agent/src packages/coding-agent/test
git commit -m "feat(telemetry): compaction events, effectiveness metrics, span, and snapcompact savings"
```

---

### Task 7: Usage-limit snapshots (subscription utilization)

**Files:**
- Modify: `packages/ai/src/auth-storage.ts` (snapshot listener)
- Modify: `packages/coding-agent/src/main.ts` (register listener when telemetry enabled)
- Modify: `packages/coding-agent/src/telemetry/metrics.ts` (account identity handling per settings)
- Test: `packages/ai/test/auth-storage-usage-listener.test.ts` (place beside existing auth-storage tests; check `packages/ai/test/` for the actual directory convention and follow it)

**Interfaces:**
- Consumes: `UsageHistoryEntry` (`packages/ai/src/usage.ts:137-162`), `#recordUsageHistory` (`packages/ai/src/auth-storage.ts:3128-3166`), `ingestUsageHeaders` (`auth-storage.ts:3280-3300`).
- Produces: on `AuthStorage`:

```ts
/** Observer invoked whenever fresh usage-limit snapshots are recorded (polled reports and header ingests). */
setUsageSnapshotListener(listener: ((entries: UsageHistoryEntry[]) => void) | undefined): void
```

- [ ] **Step 1: Write the failing test**

Follow the existing AuthStorage test-construction pattern (find an existing test that builds an AuthStorage with an in-memory/temp store and fetches or ingests usage; mimic its setup). The assertion core:

```ts
// packages/ai/test/auth-storage-usage-listener.test.ts (adapt setup to existing pattern)
import { describe, expect, it } from "bun:test";
import type { UsageHistoryEntry } from "../src/usage";

describe("usage snapshot listener", () => {
	it("fires when usage history is recorded", async () => {
		const authStorage = /* construct per existing test pattern */;
		const seen: UsageHistoryEntry[][] = [];
		authStorage.setUsageSnapshotListener(entries => seen.push(entries));

		// Drive the same path an existing usage-history test drives (fetch-with-
		// mocked-provider or direct #recordUsageHistory via its public caller).
		/* ... trigger a usage report fetch/ingest ... */

		expect(seen.length).toBeGreaterThan(0);
		expect(seen[0][0]).toHaveProperty("provider");
		expect(seen[0][0]).toHaveProperty("limitId");
	});

	it("listener throws never propagate", async () => {
		const authStorage = /* same setup */;
		authStorage.setUsageSnapshotListener(() => {
			throw new Error("boom");
		});
		/* trigger the same path */ // must not throw
	});
});
```

The implementer MUST replace the `/* ... */` sections with the concrete setup copied from the nearest existing usage-history test (search `packages/ai` tests for `recordUsageSnapshots` or `listUsageHistory`). If no such test exists, construct the SQLite-store AuthStorage against a temp dir and call the public `recordUsageSnapshots` passthrough (`auth-storage.ts:3168-3170`) — in that case the listener hook belongs in that passthrough as well.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/ai/test/auth-storage-usage-listener.test.ts`
Expected: FAIL — `setUsageSnapshotListener` does not exist.

- [ ] **Step 3: Implement the listener in `auth-storage.ts`**

Add a private field + setter on `AuthStorage`:

```ts
#usageSnapshotListener: ((entries: UsageHistoryEntry[]) => void) | undefined;

setUsageSnapshotListener(listener: ((entries: UsageHistoryEntry[]) => void) | undefined): void {
	this.#usageSnapshotListener = listener;
}

#notifyUsageSnapshots(entries: UsageHistoryEntry[]): void {
	if (!this.#usageSnapshotListener || entries.length === 0) return;
	try {
		this.#usageSnapshotListener(entries);
	} catch {
		// Telemetry observer; must never affect auth/usage paths.
	}
}
```

Call `this.#notifyUsageSnapshots(entries)`:
1. In `#recordUsageHistory` (`auth-storage.ts:3128-3166`) right after `this.#store.recordUsageSnapshots(entries)` — this covers polled reports (`omp usage`, status line, `/usage`).
2. In `ingestUsageHeaders` (`auth-storage.ts:3280+`) after a successful parse/merge — map the parsed report's limits to `UsageHistoryEntry[]` the same way `#recordUsageHistory` does (extract that mapping into a private helper `#usageEntriesFromReport(...)` and reuse it in both places) — this covers live per-chat header ingestion.

- [ ] **Step 4: Run the test to verify it passes; run the broader ai suite**

Run: `bun test packages/ai/test/auth-storage-usage-listener.test.ts` — PASS.
Run the package's existing auth-storage tests to catch regressions (find them via `ls packages/ai/test | grep -i auth`).

- [ ] **Step 5: Wire `main.ts` and account identity**

In `main.ts`, in the telemetry block (after `initTelemetryExport`, where `authStorage` is in scope — see `main.ts:1414-1416`):

```ts
if (isTelemetryExportEnabled()) {
	authStorage.setUsageSnapshotListener(entries => {
		for (const entry of entries) emitTelemetryEvent({ type: "usage_limit.snapshot", entry });
	});
}
```

In `metrics.ts` `recordUsageLimit`, apply identity policy: the recorder constructor gains an optional `options?: { includeAccountIdentity?: boolean }` (init.ts passes `settings?.get("telemetry.identity.account") ?? false`). When false, replace `aura.account.key` with `aura.account.hash` computed as:

```ts
import { createHash } from "node:crypto";
const accountHash = createHash("sha256").update(entry.accountKey).digest("hex").slice(0, 12);
```

When true, emit `aura.account.email` (`entry.email`) and `aura.account.key` (`entry.accountKey`).

- [ ] **Step 6: Type check both packages, commit**

```bash
cd packages/ai && bun run check:types 2>/dev/null || bunx tsgo -p tsconfig.json --noEmit; cd ../..
cd packages/coding-agent && bun run check:types && cd ../..
git add -A packages/ai packages/coding-agent
git commit -m "feat(telemetry): subscription usage-limit utilization export"
```

---

### Task 8: Structured error reporting

**Files:**
- Modify: `packages/coding-agent/src/telemetry/init.ts` (logger sink also publishes `error.reported`)
- Modify: `packages/coding-agent/src/telemetry/metrics.ts` (`recordRun` errors gain `aura.error.phase`)
- Test: extend `packages/coding-agent/test/telemetry-sink.test.ts`

**Interfaces:**
- Consumes: `LogEvent` (`packages/utils/src/logger.ts:24-30`); `AgentRunSummary.errors.byType` (`packages/agent/src/run-collector.ts:99-104`); tool error-type constants (`tool_error`/`tool_skipped`/`tool_blocked`/`tool_timeout`/`tool_aborted` from `packages/agent/src/telemetry.ts:1856-1862`; chat stop reasons contribute `error`/`aborted`).
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests (extend telemetry-sink.test.ts)**

```ts
it("counts error.reported with phase attribute", async () => {
	// (reuse the exporter/provider/recorder/sink setup from the first test)
	emitTelemetryEvent({ type: "error.reported", phase: "session", errorType: "log_error", message: "boom" });
	const metrics = await collect(exporter, provider);
	const errors = metrics.find(m => m.descriptor.name === "aura.agent.errors");
	expect(errors).toBeDefined();
	expect(errors?.dataPoints[0]?.attributes["aura.error.phase"]).toBe("session");
	expect(errors?.dataPoints[0]?.attributes["error.type"]).toBe("log_error");
});

it("stamps run-summary error types with chat/tool phase", async () => {
	emitTelemetryEvent({
		type: "turn.completed",
		summary: {
			stepCount: 1,
			chats: { total: 1, totalLatencyMs: 10, byStopReason: {} },
			tools: { total: 1, ok: 0, error: 1, skipped: 0, blocked: 0, timeout: 0, aborted: 0, totalLatencyMs: 5, byName: {} },
			usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
			cost: { estimatedUsd: 0, unavailableReasons: [] },
			errors: { total: 2, byType: { tool_timeout: 1, error: 1 } },
		} as never,
		coverage: { modelsUsed: [], providersUsed: [], toolsAvailable: [], toolsInvoked: [], toolsUnused: [] } as never,
	});
	const metrics = await collect(exporter, provider);
	const errors = metrics.find(m => m.descriptor.name === "aura.agent.errors");
	const phases = errors?.dataPoints.map(p => [p.attributes["error.type"], p.attributes["aura.error.phase"]]);
	expect(phases).toContainEqual(["tool_timeout", "tool"]);
	expect(phases).toContainEqual(["error", "chat"]);
});
```

(Adjust the synthetic `summary` literal to satisfy `AgentRunSummary` — copy the shape used by `otel-signals-probe.ts`, which already builds one.)

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/coding-agent/test/telemetry-sink.test.ts`
Expected: new tests FAIL (no phase attr; error.reported not counted).

- [ ] **Step 3: Implement**

In `metrics.ts` `recordRun`, when iterating `summary.errors.byType`, classify:

```ts
const TOOL_ERROR_TYPES = new Set(["tool_error", "tool_skipped", "tool_blocked", "tool_timeout", "tool_aborted"]);
const CHAT_ERROR_TYPES = new Set(["error", "aborted"]);
// inside the loop:
const phase = TOOL_ERROR_TYPES.has(errorType) ? "tool" : CHAT_ERROR_TYPES.has(errorType) ? "chat" : "tool";
this.#errors.add(count, metricAttributes({ ...runAttrs, "error.type": errorType, "aura.error.phase": phase }));
```

(Unknown types default to `"tool"` because thrown tool errors surface as JS error class names — see `packages/agent/src/telemetry.ts:1826-1843`.)

In `init.ts`'s logger sink registration (the `registerLogSink` callback), publish an error event for error-level records IN ADDITION to the existing log forwarding:

```ts
unregisterLogSink = logger.registerLogSink(event => {
	emitOtelLog(event.level, event.message, logAttributesFromContext(event.context), "aura.log", event.timestamp);
	if (event.level === "error") {
		emitTelemetryEvent({
			type: "error.reported",
			phase: "session",
			errorType: typeof event.context?.code === "string" ? event.context.code : "log_error",
			message: event.message,
		});
	}
});
```

Compaction errors already increment the counter with phase `compaction` via `recordCompaction` (Task 3). Do NOT emit a duplicate log record for `error.reported` in the sink — the logger sink already forwarded the log line; the event exists for metric counting.

- [ ] **Step 4: Run tests, type check, commit**

```bash
bun test packages/coding-agent/test/telemetry-sink.test.ts packages/coding-agent/test/telemetry-export.test.ts
cd packages/coding-agent && bun run check:types && cd ../..
git add -A packages/coding-agent/src packages/coding-agent/test
git commit -m "feat(telemetry): structured error reporting with phase attribution"
```

---

### Task 9: End-to-end probe + documentation

**Files:**
- Modify: `packages/coding-agent/test/otel-signals-probe.ts` (drive the new events; assert new instruments)
- Modify: `packages/coding-agent/test/telemetry-export.test.ts` (assert the probe's new output markers if it prints per-signal lines)
- Create: `docs/telemetry.md`
- Test: the probe itself (subprocess-driven from telemetry-export.test.ts)

**Interfaces:**
- Consumes: everything above.
- Produces: user-facing docs.

- [ ] **Step 1: Extend the signals probe**

In `otel-signals-probe.ts`, after the existing `onChatUsage`/`onRunEnd` driving, emit one of each new event through the public bus and assert data points for the new instruments using the probe's existing protobuf field parser (`pointCountForMetric`):

```ts
import { emitTelemetryEvent } from "@oh-my-pi/pi-coding-agent/telemetry-export";

emitTelemetryEvent({ type: "session.started", sessionId: "probe", mode: "print", resumed: false });
emitTelemetryEvent({
	type: "session.ended", sessionId: "probe", mode: "print", durationMs: 1000, activeMs: 500, turns: 1,
	tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, estimatedCostUsd: 0, endReason: "probe",
});
emitTelemetryEvent({
	type: "compaction.completed", sessionId: "probe", strategy: "context-full", trigger: "manual",
	outcome: "ok", tokensBefore: 1000, tokensAfter: 100, durationMs: 50,
});
emitTelemetryEvent({ type: "compaction.savings", provider: "anthropic", model: "probe-model", savedTokens: 42 });
emitTelemetryEvent({
	type: "usage_limit.snapshot",
	entry: { recordedAt: 1, provider: "anthropic", accountKey: "acct", limitId: "l1", label: "5h", usedFraction: 0.4 },
});
emitTelemetryEvent({ type: "error.reported", phase: "session", errorType: "probe_error", message: "probe" });
```

Add assertions (same style as the existing three) that `aura.session.duration`, `aura.compaction.count`, `aura.compaction.tokens_saved`, `aura.snapcompact.tokens_saved`, `aura.usage_limit.utilization`, and `aura.agent.errors` each landed at least one data point, and that a log record with eventName `aura.session.ended` arrived on the logs endpoint.

Note: `emitTelemetryEvent` must be exported through the `telemetry-export` shim (it is, via `telemetry/index.ts` → `events.ts`).

- [ ] **Step 2: Run the probe via its test**

Run: `bun test packages/coding-agent/test/telemetry-export.test.ts`
Expected: PASS with the extended probe.

- [ ] **Step 3: Write `docs/telemetry.md`**

Cover, in this order (follow the tone/format of sibling docs like `docs/compaction.md`):
1. What is exported (table of the metrics from Task 3 + log event names + span types, including the unchanged GenAI semconv spans from the agent core).
2. Enabling: `telemetry.enabled` + `telemetry.endpoint` settings, full `OTEL_*` env equivalents, precedence rules, `OTEL_SDK_DISABLED` kill switch, http/protobuf-only note.
3. Privacy: pseudonymous defaults (`aura.install.id` is a random UUID, rotate by deleting `<configRoot>/telemetry-install-id`), the three `telemetry.identity.*` opt-ins, content capture via `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`, account hashing on usage-limit metrics.
4. Example: minimal collector config snippet (a `docker run` of `otel/opentelemetry-collector` with an OTLP receiver + logging exporter) and settings YAML.

- [ ] **Step 4: Full suite + lint + commit**

```bash
cd packages/coding-agent && bun run check && cd ../..
bun test packages/coding-agent/test/telemetry-events.test.ts packages/coding-agent/test/telemetry-identity.test.ts packages/coding-agent/test/telemetry-sink.test.ts packages/coding-agent/test/telemetry-settings.test.ts packages/coding-agent/test/telemetry-session-lifecycle.test.ts packages/coding-agent/test/telemetry-compaction.test.ts packages/coding-agent/test/telemetry-export.test.ts
git add -A packages/coding-agent docs/telemetry.md
git commit -m "feat(telemetry): end-to-end signal probe coverage + telemetry docs"
```

---

## Task dependency order

1 → 2 → 3 → 4 → {5, 6, 7, 8 in any order (7 also touches packages/ai)} → 9.

Tasks 5, 6, 7, 8 are independent of each other and can run in parallel worktree-free ONLY if executed sequentially in one branch; under subagent-driven development, run them sequentially in the shared worktree to avoid conflicts in `main.ts` (Tasks 5 and 7 both touch the telemetry block) and `sink-otlp.ts`/`metrics.ts` (Tasks 6 and 8).
