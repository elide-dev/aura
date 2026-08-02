# Telemetry (OpenTelemetry Export)

Aura can export its own operational telemetry — traces, structured logs, and metrics — to an OpenTelemetry collector over OTLP. **Nothing is exported until you configure an endpoint.** There is no bundled collector, no default endpoint, and no embedded credential: `telemetry.endpoint` ships empty, `telemetry.headers` ships empty, and every signal stays off while there is nowhere to send it.

To turn export on, point `telemetry.endpoint` (or `OTEL_EXPORTER_OTLP_ENDPOINT`) at a collector you control and supply whatever auth it needs via `telemetry.headers` (or `OTEL_EXPORTER_OTLP_HEADERS`) — env always wins per key. `telemetry.enabled` defaults to `true`, but it is only the master switch for the *settings-driven* route: with it on and no endpoint configured, the exporters are still never constructed. `telemetry.enabled: false` (or `OTEL_SDK_DISABLED=true`) additionally suppresses the settings route entirely.

Everything below is standard OTLP: any collector that speaks `http/protobuf` (the OpenTelemetry Collector, Grafana Alloy, Honeycomb, Datadog's OTLP intake, a local `otel-tui`, …) works without further adaptation.

## Key implementation files

- `packages/coding-agent/src/telemetry/init.ts` (bootstrap: env/settings resolution, provider registration, log bridge)
- `packages/coding-agent/src/telemetry/events.ts` (the typed telemetry event bus every publisher writes to)
- `packages/coding-agent/src/telemetry/sink-otlp.ts` (the sole bus subscriber; maps events onto instruments and log records)
- `packages/coding-agent/src/telemetry/metrics.ts` (every `aura.*` instrument)
- `packages/coding-agent/src/telemetry/identity.ts` (resource attributes and the install id)
- `packages/coding-agent/src/telemetry/publishers/` (session lifecycle, compaction)
- `packages/agent/src/telemetry.ts` (the agent loop's GenAI semconv spans)

## What gets exported

### Metrics

Instrument scope (`otel_scope_name`) is `aura`.

| Metric                                | Kind      | Unit       | Reported when                                                        |
| ------------------------------------- | --------- | ---------- | -------------------------------------------------------------------- |
| `gen_ai.client.token.usage`           | histogram | `{token}`  | Every chat call, split by `gen_ai.token.type`                        |
| `aura.agent.chat.cost.estimated_usd`  | counter   | `USD`      | Every chat call with a resolvable cost                               |
| `aura.agent.runs`                     | counter   | `{run}`    | Each completed agent run (one prompt turn)                           |
| `aura.agent.steps`                    | counter   | `{step}`   | Loop steps inside a run                                              |
| `aura.agent.chat.calls`               | counter   | `{call}`   | Chat calls in a run, by `gen_ai.response.finish_reason`              |
| `aura.agent.chat.duration`            | histogram | `ms`       | Total chat latency observed in a run                                 |
| `aura.agent.tool.calls`               | counter   | `{call}`   | Tool calls in a run, by `gen_ai.tool.name` and `aura.tool.status`    |
| `aura.agent.tool.duration`            | histogram | `ms`       | Total tool latency in a run, by tool                                 |
| `aura.agent.errors`                   | counter   | `{error}`  | Chat, tool, compaction, and session-phase failures                   |
| `aura.session.duration`               | histogram | `s`        | Session end                                                          |
| `aura.session.turns`                  | histogram | `{turn}`   | Session end                                                          |
| `aura.compaction.count`               | counter   | `{compaction}` | Every compaction attempt, by strategy/trigger/outcome            |
| `aura.compaction.tokens_saved`        | counter   | `{token}`  | Successful compactions with both token readings                      |
| `aura.compaction.duration`            | histogram | `ms`       | Every compaction attempt that took measurable time                   |
| `aura.compaction.effectiveness`       | histogram | `1`        | Successful compactions: `1 - after/before`                           |
| `aura.snapcompact.tokens_saved`       | counter   | `{token}`  | Tokens kept off the wire by snapcompact tool-result imaging          |
| `aura.usage_limit.utilization`        | gauge     | `1`        | Every fresh subscription usage-limit snapshot (0–1)                  |

Common attributes: `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.operation.name`, `gen_ai.tool.name`, `gen_ai.response.finish_reason`, `aura.agent.id`, `aura.agent.name`, `aura.tool.status`, `aura.error.phase` (`chat` | `tool` | `compaction` | `session`), `error.type`, `aura.session.mode` (`tui` | `acp` | `rpc` | `print` | `sdk`), `aura.session.end_reason`, `aura.compaction.strategy` (`context-full` | `handoff` | `shake` | `snapcompact`), `aura.compaction.trigger` (`threshold` | `overflow` | `idle` | `incomplete` | `manual`), `aura.compaction.outcome` (`ok` | `aborted` | `error` | `will-retry` | `skipped`), `aura.usage_limit.id`, `aura.usage_limit.window`.

`aura.usage_limit.utilization` deliberately carries neither the window's reset timestamp nor the plan tier. A reset timestamp is unbounded-cardinality — every snapshot would mint a new series — and the tier is not reliably known at snapshot time, so a partial `aura.account.tier` would be worse than none. Read the window with `aura.usage_limit.window` and get reset timing from the gauge dropping back toward zero.

`aura.session.mode` has no built-in `sdk` producer: the value exists for hosts embedding aura through the SDK. To opt in, call `trackSessionLifecycle({ mode: "sdk", … })` (exported from the telemetry barrel, `packages/coding-agent/src/telemetry/index.ts`) around your session, and its start/end events flow through the same bus and instruments as the first-party modes.

### Log records

Log scope (`otel_scope_name`) is `aura`. Each record carries an `eventName`:

| `eventName`                 | Emitted for                                                                    |
| --------------------------- | ------------------------------------------------------------------------------ |
| `aura.log`                  | Every record written through aura's internal logger, with its context fields   |
| `aura.agent.run.completed`  | Run summary: steps, chat/tool counters, token usage, cost, tool coverage       |
| `aura.session.started`      | Session start (id, mode, whether resumed)                                      |
| `aura.session.ended`        | Session end (duration, active time, turns, tokens, estimated cost, end reason) |
| `aura.compaction.completed` | One compaction attempt and its outcome                                         |
| `aura.telemetry.warning`    | The agent loop reporting a telemetry-internal problem (e.g. no cost data)      |

`OTEL_LOG_LEVEL` filters these (`none`, `error`, `warn`, `info`, `debug`; default `info`).

### Spans

The agent loop's spans follow the [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) and are unchanged by this integration — they come from `@oh-my-pi/pi-agent-core` and carry that scope name:

```text
invoke_agent {agent}        gen_ai.operation.name=invoke_agent
├── chat {model}            gen_ai.operation.name=chat
├── execute_tool {tool}     gen_ai.operation.name=execute_tool
└── ...
```

`handoff` spans are emitted when a host routes work between named agents. Aura adds one span of its own, `aura.compaction` (scope `aura-telemetry`), synthesized after a compaction finishes and back-dated by its measured duration, so it nests under the turn that triggered it.

## Enabling export

Two equivalent routes: settings, or the standard `OTEL_*` environment variables.

### Settings

```yaml
# ~/.aura/agent/config.yml
telemetry:
  enabled: true
  endpoint: http://localhost:4318
  headers:
    x-api-key: "…"
  signals: [traces, logs, metrics]
```

| Setting                        | Type    | Default                     | Meaning                                                              |
| ------------------------------ | ------- | --------------------------- | -------------------------------------------------------------------- |
| `telemetry.enabled`            | boolean | `true`                      | Master switch for the settings-driven route: `telemetry.endpoint`, `.headers`, and `.signals` are ignored while this is false. |
| `telemetry.endpoint`           | string  | `""` (nothing exported)     | **Base** OTLP endpoint; the per-signal path is appended. Empty means no exporter is constructed at all. |
| `telemetry.headers`            | record  | `{}`                        | Headers sent with every OTLP request (config-file only, no UI). No credential is bundled — supply your collector's own. |
| `telemetry.signals`            | array   | `[logs, metrics]`           | Signals to export. Omitting one switches it off (add `traces` for GenAI spans). |
| `telemetry.identity.hostname`  | boolean | `false`                     | Attach `host.name`.                                                  |
| `telemetry.identity.account`   | boolean | `false`                     | Attach account email/key to usage-limit metrics instead of a hash.   |
| `telemetry.identity.workspace` | boolean | `false`                     | Attach `aura.workspace.path` (the working directory).                |

`telemetry.endpoint` is a base endpoint per the OTLP spec: `http://localhost:4318` becomes `http://localhost:4318/v1/traces`, `/v1/logs`, and `/v1/metrics`.

The three `telemetry.identity.*` opt-ins are **not** gated on `telemetry.enabled`. They are consent flags, not transport config: they govern what identity is attached whenever telemetry is active, however it was activated. So if you enable export purely through the environment (`OTEL_EXPORTER_OTLP_ENDPOINT`) and leave `telemetry.enabled: false`, a `telemetry.identity.hostname: true` in your config still attaches `host.name`. Turn the opt-ins off — don't rely on `telemetry.enabled` to suppress them.

### Environment variables

| Variable                                          | Effect                                                                            |
| ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                     | Base endpoint for all three signals                                               |
| `OTEL_EXPORTER_OTLP_{TRACES,LOGS,METRICS}_ENDPOINT` | Full per-signal URL (including `/v1/…`), overriding the base                    |
| `OTEL_EXPORTER_OTLP_HEADERS`                      | `k=v,k=v` headers for all signals                                                 |
| `OTEL_EXPORTER_OTLP_{TRACES,LOGS,METRICS}_HEADERS` | Per-signal headers                                                                |
| `OTEL_EXPORTER_OTLP_PROTOCOL`                     | Must be `http/protobuf`; see below                                                |
| `OTEL_EXPORTER_OTLP_{TRACES,LOGS,METRICS}_PROTOCOL` | Per-signal protocol, same restriction                                            |
| `OTEL_{TRACES,LOGS,METRICS}_EXPORTER=none`        | Switch one signal off                                                             |
| `OTEL_SDK_DISABLED=true`                          | Kill switch: nothing registers, whatever the settings say                         |
| `OTEL_SERVICE_NAME`                               | Override the `service.name` resource attribute (default `aura`)                   |
| `OTEL_METRIC_EXPORT_INTERVAL`                     | Metric reader interval in ms (standard SDK default)                               |
| `OTEL_LOG_LEVEL`                                  | Minimum level for exported log records (`none` disables them)                     |
| `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` | Opt in to prompt/completion content on spans — see [Privacy](#privacy)         |

### Precedence

1. **`OTEL_SDK_DISABLED=true` wins over everything.** It is read from the raw process environment only; no setting can re-enable export against it.
2. **Environment wins per key.** A `telemetry.*` value is used only when neither the signal-specific nor the generic `OTEL_*` key for that value is set. Endpoint and headers are resolved independently, so you can point the endpoint at a collector via env while keeping headers in settings.
3. **`telemetry.enabled: false` contributes no endpoint, headers, or signal selection** — but env-only activation still works. Setting just `OTEL_EXPORTER_OTLP_ENDPOINT` in the environment enables export without touching settings. The `telemetry.identity.*` opt-ins are the exception: they apply to env-activated telemetry too (see above).
4. A signal is exported when it has an endpoint (per-signal or base) **and** its `OTEL_*_EXPORTER` is not `none`. Listing `telemetry.signals` without a signal sets that variable to `none` for you.

### `http/protobuf` only

Only the OTLP `http/protobuf` transport is supported. An `OTEL_EXPORTER_OTLP*_PROTOCOL` of `grpc` or `http/json` **disables** that signal with a warning rather than shipping protobuf payloads to a port that cannot read them. Point aura at your collector's HTTP receiver (`4318` by convention), not its gRPC one (`4317`).

Buffered telemetry is flushed every 30 seconds and again at process exit, so a long-lived ACP server surfaces finished work promptly instead of holding it for a batch window.

## Privacy

Aura's telemetry is **pseudonymous by default**. Nothing that identifies you or your work leaves the process unless you opt in.

- **`aura.install.id`** is a random UUID minted once per install and stored at `<configRoot>/telemetry-install-id` — `~/.aura/telemetry-install-id` by default, mode `0600`. (`PI_CONFIG_DIR` renames that directory, and an active profile moves it under `profiles/<name>/`. `aura config path` prints the agent directory, whose parent is the config root.) It is random, not derived from anything about your machine, so it is strictly non-reversible. **Delete the file to rotate it.** It is deliberately separate from the general-purpose install id in [install-id.md](install-id.md), so rotating telemetry identity does not disturb unrelated install-scoped state.
- **`service.name`** defaults to `aura` and **`service.version`** to the running build's version. Those and the install id are the only resource attributes present by default.
- **Usage-limit metrics carry `aura.account.hash` by default** — the first 12 hex characters of the SHA-256 digest of the internal account key. That is enough to keep one account's utilization series separate from another's, and not enough to recover the email or credential behind it. Setting `telemetry.identity.account: true` replaces the hash with the real `aura.account.email` and `aura.account.key`; leave it off unless the collector is yours and you need the account named.
- **`telemetry.identity.hostname: true`** adds `host.name`; **`telemetry.identity.workspace: true`** adds `aura.workspace.path` (an absolute path, which usually names your project). Both are off by default.
- **Prompt and completion content is never exported** unless `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` is set, matching the OTel semconv toggle. Without it, spans carry model names, token counts, latencies, and finish reasons — no message bodies.
- Log records exported as `aura.log` carry whatever structured context the internal logger was given. That context is operational (codes, counts, identifiers), but it is not content-audited; if your collector is shared, consider `OTEL_LOG_LEVEL=warn` to narrow it.

## Example: a local collector

Run a collector that prints everything it receives:

```yaml
# otel-collector.yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

exporters:
  debug:
    verbosity: detailed

service:
  pipelines:
    traces:  { receivers: [otlp], exporters: [debug] }
    logs:    { receivers: [otlp], exporters: [debug] }
    metrics: { receivers: [otlp], exporters: [debug] }
```

```bash
docker run --rm -p 4318:4318 \
  -v "$PWD/otel-collector.yaml:/etc/otelcol/config.yaml" \
  otel/opentelemetry-collector --config /etc/otelcol/config.yaml
```

Then either:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 aura
```

or persist it:

```yaml
# ~/.aura/agent/config.yml
telemetry:
  enabled: true
  endpoint: http://localhost:4318
```

Run a prompt, and the collector's debug exporter shows `invoke_agent`/`chat`/`execute_tool` spans, an `aura.agent.run.completed` log record, and `aura.agent.*` metric points.

## Dashboard caveats

Two things surprise people building panels on this data:

- **Handoff compactions produce a count but no effectiveness or savings data.** `aura.compaction.effectiveness` and `aura.compaction.tokens_saved` are only recorded for a successful run that reported both a "before" and an "after" token reading. The handoff path rewrites history through a fresh document rather than a summarization result, so it ends with no token readings attached and contributes only to `aura.compaction.count` and `aura.compaction.duration`. Expect `aura.compaction.count{aura.compaction.strategy="handoff"}` to have no matching effectiveness series, and compute effectiveness rates against the count for the strategies you are actually measuring rather than against the total.
- **Unfiltered `sum(aura.agent.errors)` can double-count a single failure.** A chat or tool failure is counted from the run summary with `aura.error.phase` of `chat` or `tool`; if the same failure also produced an `error`-level log record, the logger bridge counts it again with `aura.error.phase="session"`. Filter by `aura.error.phase` — sum the `chat`/`tool`/`compaction` phases for execution failures, and treat `session` as a separate "something logged an error" series.

## See also

- [settings.md](settings.md) — where `config.yml` lives and how precedence works.
- [environment-variables.md](environment-variables.md) — the wider env-var reference.
- [compaction.md](compaction.md) — what the compaction strategies and triggers mean.
- [install-id.md](install-id.md) — the unrelated, non-telemetry install id.
