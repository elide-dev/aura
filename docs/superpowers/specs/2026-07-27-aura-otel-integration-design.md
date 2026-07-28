# Aura OpenTelemetry Integration — Design

**Date:** 2026-07-27
**Status:** Approved (brainstorm) — pending implementation plan

## Goal

A first-class, settings-gated OpenTelemetry integration any Aura user can point
at their own OTLP collector (Grafana, Honeycomb, PostHog, …). It exports the
operational story of the agent: session lifecycle and length, structured
errors, token usage, cost (estimated USD **and** subscription-limit
utilization), and compaction events with effectiveness.

## Context: what already exists

- `packages/agent/src/telemetry.ts` — GenAI-semconv span instrumentation
  (`invoke_agent` → `chat` / `execute_tool`) with hooks: `onChatUsage`,
  `onCostDelta`, `onRunEnd`, `costEstimator`, `resolveAttributes`. Unchanged by
  this design.
- `packages/coding-agent/src/telemetry-export.ts` — OTLP http/protobuf
  bootstrap off `OTEL_*` env vars; `AgentMetricRecorder` (token usage, chat
  cost, runs, steps, tool calls, errors); log sink. Exporters pinned to the
  0.218/2.7 family (the 1.x OTLP line deadlocks under Bun) — keep that pin.
- Compaction emits `auto_compaction_start`/`auto_compaction_end` extension
  events carrying `CompactionResult` (`tokensBefore`, no `tokensAfter`);
  snapcompact savings are journaled to `snapcompact-savings.jsonl`.
- `omp usage` machinery (pi-ai `UsageReport`/`UsageLimit`,
  `resolveUsedFraction`, usage-limit history) tracks subscription windows per
  credential.

Gap: session lifecycle, structured errors, subscription utilization, and
compaction effectiveness all exist as local data but are not exported.

## Decisions (from brainstorm)

1. **Audience:** product feature for all users; privacy-safe defaults.
2. **Cost:** export both estimated USD and subscription-window utilization.
3. **Privacy:** pseudonymous by default — `session.id`, salted-hash install
   id, provider/model/agent names. No email, org, hostname, or workspace paths
   unless opted in. Content capture stays governed by
   `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`.
4. **Activation:** `telemetry.*` settings + standard `OTEL_*` env vars; env
   always wins (standard OTel contract).
5. **Branding:** all identifiers are Aura's — metric/log/attribute namespace
   `aura.*`, `service.name=aura`. Pre-existing `pi.omp.*` instruments and
   `pi.omp.*` event names are **renamed** to `aura.*`; `service.name`
   default changes from `oh-my-pi` to `aura`.

## Architecture

New subsystem `packages/coding-agent/src/telemetry/`, replacing
`telemetry-export.ts`:

```
telemetry/
├── events.ts     # Typed TelemetryEvent union; emitTelemetryEvent(); subscribe()
├── init.ts       # Provider bootstrap (settings + OTEL_* env), lifecycle, flush
├── sink-otlp.ts  # Sole subscriber: maps events → OTel metrics/log records/spans
├── metrics.ts    # Instrument definitions (AgentMetricRecorder moves here + new)
├── identity.ts   # Resource attrs: service.name/version, session.id, install-id hash, opt-ins
└── index.ts      # Public surface (init, flush, emit, isEnabled)
```

**Principle:** publishers never import OTel. Subsystems call
`emitTelemetryEvent(event)` — a cheap no-op when telemetry is disabled. Only
`sink-otlp.ts` touches `@opentelemetry/*`. The GenAI span layer in
`pi-agent-core` is untouched; this subsystem adds host-level signals around it.

`isTelemetryExportEnabled` / `createTelemetryExportConfig` /
`flushTelemetryExport` keep their contracts (re-exported from
`telemetry/index.ts`) so `main.ts` / `sdk.ts` call sites change minimally.

## Event surface

`TelemetryEvent` is a discriminated union:

| Event | Source | Payload |
|---|---|---|
| `session.started` | agent-session lifecycle | session.id, mode (tui/acp/rpc/sdk), resumed flag |
| `session.ended` | session close + postmortem fallback | wall-clock duration ms, active (in-turn) duration ms, turn count, token totals, estimated USD total, end reason (quit/handoff/crash/idle) |
| `turn.completed` | existing `onRunEnd` hook | current `AgentRunSummary`/`AgentRunCoverage` mapping, unchanged semantics |
| `error.reported` | logger error sink, unexpected-stop classifier, tool failures | `error.type`, sanitized message, phase: `chat` \| `tool` \| `compaction` \| `session` |
| `compaction.completed` | `auto_compaction_end`, manual `/compact`, shake | strategy, trigger (auto/manual/mid-turn), tokensBefore, tokensAfter, durationMs, outcome (ok/aborted/error/will-retry) |
| `compaction.savings` | snapcompact savings recorder | savedTokens, provider, model |
| `usage_limit.snapshot` | pi-ai usage-limit capture (response headers; `omp usage` refresh path) | provider, window kind (5h/weekly/…), usedFraction, resetAt, plan tier; account attrs only with `identity.account` opt-in |
| `cost.delta` | existing `onCostDelta` | estimated USD per chat step, provider, model |

`tokensAfter` is not on `CompactionResult`; the publisher computes it from the
post-compaction context estimate (the `SessionStatsTracker` prompt-token path)
so **effectiveness = 1 − tokensAfter/tokensBefore** is derivable, and
tokens-saved is emitted directly.

## Signals

### Metrics (all `aura.*`; existing nine instruments renamed from `pi.omp.*`)

Kept (renamed): `gen_ai.client.token.usage` (semconv, unchanged),
`aura.agent.chat.cost.estimated_usd`, `aura.agent.runs`, `aura.agent.steps`,
`aura.agent.chat.calls`, `aura.agent.chat.duration`, `aura.agent.tool.calls`,
`aura.agent.tool.duration`, `aura.agent.errors`.

New:

- `aura.session.duration` — histogram, seconds, attr `aura.session.end_reason`
- `aura.session.turns` — histogram, `{turn}` per session
- `aura.compaction.count` — counter, attrs strategy/trigger/outcome
- `aura.compaction.tokens_saved` — counter, `{token}`
- `aura.compaction.duration` — histogram, ms
- `aura.compaction.effectiveness` — histogram, ratio 0–1
- `aura.snapcompact.tokens_saved` — counter, `{token}`
- `aura.usage_limit.utilization` — gauge, ratio, attrs provider/window/plan
- `aura.agent.errors` gains attr `aura.error.phase`

### Logs / events

One structured log record per telemetry event, `eventName` =
`aura.session.started`, `aura.compaction.completed`, etc., emitted in the
active trace context. The existing run-summary log and logger sink migrate to
`aura.log` / `aura.agent.run.completed` names. Error events include stack
traces only when content capture is enabled.

### Traces

GenAI spans unchanged. One addition: a real `aura.compaction` span (compaction
is a timed operation containing an LLM call), so compactions are visible on
traces, with the same attrs as the `compaction.completed` event.

## Configuration

Settings (in `settings-schema.ts`), env always winning:

- `telemetry.enabled` — default `false`
- `telemetry.endpoint` — OTLP base endpoint (maps to `OTEL_EXPORTER_OTLP_ENDPOINT`)
- `telemetry.headers` — auth headers map
- `telemetry.signals` — subset of `traces` / `logs` / `metrics`; default all
- `telemetry.identity.hostname` / `.account` / `.workspace` — booleans, default `false`

Resolution: env-var config (existing behavior) OR settings-based config
activates the same init path; when both present, env wins per key. Protocol
support remains http/protobuf only, declining others with a warning.

Resource attributes: `service.name=aura` (overridable via `OTEL_SERVICE_NAME`),
`service.version` (build version), `session.id`, `aura.install.id`
(salted hash persisted under the config dir). Opt-ins add `host.name`,
account email/org, workspace path.

## Error handling

Telemetry must never break the agent:

- `emitTelemetryEvent` is fire-and-forget; subscriber exceptions are caught
  and logged at debug.
- Init failure logs a warning and leaves the subsystem disabled for the
  process lifetime.
- Export failures stay inside the batch processors (existing behavior);
  periodic 30s flush and postmortem shutdown flush are preserved.

## Testing

- Unit tests per event mapping using in-memory exporters (pattern exists in
  `telemetry-export.test.ts`): each event type → expected instruments,
  attributes, log records.
- Identity tests: default resource attrs are pseudonymous; opt-ins add exactly
  the declared attrs; install-id hash is stable across runs.
- Settings tests: settings-only activation, env-override precedence,
  kill-switch (`OTEL_SDK_DISABLED`) still wins.
- End-to-end probe: extend `otel-export-probe.ts`/`otel-signals-probe.ts` to
  run a scripted session (turns, forced compaction, injected error) against a
  local OTLP mock and assert every new signal arrives with `service.name=aura`.
- Acceptance: a real session against a live collector shows session,
  compaction, and usage-limit dashboards populating.

## Non-goals

- No gRPC / http/json OTLP transports (Bun pin stays).
- No vendor-specific exporters; OTLP only.
- No telemetry backend/dashboard shipping in-repo (dashboard JSON may come later).
- No changes to `pi-agent-core`'s GenAI span layer beyond consuming its hooks.
