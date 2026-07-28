/**
 * OTLP telemetry export bootstrap.
 *
 * oh-my-pi's agent core (`@oh-my-pi/pi-agent-core`) emits OpenTelemetry GenAI
 * spans through the global `@opentelemetry/api` tracer, and exposes run-level
 * callbacks for metrics/log pipelines. This module registers the OTLP/proto
 * trace, log, and metric SDK providers when the standard `OTEL_*` endpoint env
 * vars are set — or the `telemetry.*` settings supply the same values, with env
 * winning per key — so `omp` can be observed by any OTLP collector without
 * vendor coupling.
 *
 * Only the `http/protobuf` transport is supported — an
 * `OTEL_EXPORTER_OTLP*_PROTOCOL` of `grpc` or `http/json` declines rather than
 * misrouting protobuf payloads. The exporter line is pinned to the 0.218/2.7
 * family validated under Bun; the 1.x OTLP line deadlocks when its
 * `req.on("close")` handler fires after a successful export.
 */
import type {
	AgentRunCoverage,
	AgentRunSummary,
	AgentTelemetryConfig,
	AgentTelemetryWarning,
} from "@oh-my-pi/pi-agent-core";
import { logger, postmortem } from "@oh-my-pi/pi-utils";
import { type AttributeValue, context, metrics } from "@opentelemetry/api";
import { type LogAttributes, logs, type Logger as OtelLogger, SeverityNumber } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { Settings } from "../config/settings";
import { emitTelemetryEvent, getActiveTelemetrySessionId } from "./events";
import { buildResourceAttributes } from "./identity";
import { AuraMetricRecorder } from "./metrics";
import { registerOtlpSink } from "./sink-otlp";

/**
 * Periodic flush interval. A long-lived `omp` process (the ACP server is
 * spawned once and reused across many turns) would otherwise hold finished
 * telemetry until a batch window elapses or the process exits.
 */
const FLUSH_INTERVAL_MS = 30_000;

/** Options for {@link initTelemetryExport}. */
export interface InitTelemetryOptions {
	/** Settings instance for telemetry.* config (env always wins). */
	settings?: Settings;
}

export type TelemetrySignal = "trace" | "log" | "metric";
type OtelLogLevel = "none" | logger.LogLevel;

interface SignalConfig {
	readonly trace: boolean;
	readonly log: boolean;
	readonly metric: boolean;
}

/**
 * Per-signal OTLP metadata: the path a base endpoint gets joined with, and the
 * infix in the signal-specific `OTEL_EXPORTER_OTLP_<INFIX>_*` env overrides.
 */
const SIGNAL_OTLP: Record<TelemetrySignal, { path: string; envInfix: string }> = {
	trace: { path: "/v1/traces", envInfix: "TRACES" },
	log: { path: "/v1/logs", envInfix: "LOGS" },
	metric: { path: "/v1/metrics", envInfix: "METRICS" },
};

/** Explicit OTLP exporter constructor config derived from `telemetry.*` settings. */
export interface ExporterConfig {
	url?: string;
	headers?: Record<string, string>;
}

const LOG_SEVERITY: Record<logger.LogLevel, SeverityNumber> = {
	error: SeverityNumber.ERROR,
	warn: SeverityNumber.WARN,
	info: SeverityNumber.INFO,
	debug: SeverityNumber.DEBUG,
};

const LOG_LEVEL_WEIGHT: Record<logger.LogLevel, number> = {
	error: 0,
	warn: 1,
	info: 2,
	debug: 3,
};

let traceProvider: NodeTracerProvider | undefined;
let logProvider: LoggerProvider | undefined;
let meterProvider: MeterProvider | undefined;
let metricRecorder: AuraMetricRecorder | undefined;
let otelLogger: OtelLogger | undefined;
let unregisterLogSink: (() => void) | undefined;
let unregisterTelemetrySink: (() => void) | undefined;
let initPromise: Promise<void> | undefined;

/**
 * Whether {@link initTelemetryExport} registered any real OTLP signal provider.
 * The CLI uses this to decide whether to switch on the agent loop's telemetry
 * hooks; metrics and structured logs need those callbacks even when traces are
 * disabled.
 */
export function isTelemetryExportEnabled(): boolean {
	if (traceProvider) return true;
	if (logProvider) return true;
	if (meterProvider) return true;
	return false;
}

/**
 * Merge OTLP metrics/log hooks into an existing agent telemetry config.
 *
 * The caller still owns content-capture policy, cost estimation, and custom
 * attributes. This only appends host-level metrics/log forwarding for the
 * providers registered by {@link initTelemetryExport}.
 */
export function createTelemetryExportConfig(
	config: AgentTelemetryConfig | undefined,
): AgentTelemetryConfig | undefined {
	if (!isTelemetryExportEnabled()) return config;
	return {
		...config,
		onChatUsage: async event => {
			await config?.onChatUsage?.(event);
			emitTelemetryEvent({ type: "chat.usage", event });
		},
		onRunEnd: (summary, coverage) => {
			config?.onRunEnd?.(summary, coverage);
			// The loop reports run aggregates without session identity; the host
			// stamps the owning session (see setActiveTelemetrySessionId). One
			// telemetry config is shared by every session in the process — notably
			// the ACP server's — so this must be read per event, never captured.
			const sessionId = getActiveTelemetrySessionId();
			emitTelemetryEvent({ type: "turn.completed", sessionId, summary, coverage });
			emitRunSummaryLog(sessionId, summary, coverage);
		},
		onCostDelta: delta => {
			config?.onCostDelta?.(delta);
			emitTelemetryEvent({ type: "cost.delta", delta });
		},
		onTelemetryWarning: warning => {
			config?.onTelemetryWarning?.(warning);
			emitTelemetryWarningLog(warning);
		},
	};
}

/**
 * Register global trace/log/meter providers when OTLP endpoints are configured
 * through env or `options.settings`. Idempotent, and a no-op when no signal has
 * an endpoint (or when the OTEL kill-switches are engaged), so startup can call
 * it unconditionally. `OTEL_SDK_DISABLED` is checked against the raw env only:
 * it is an operator kill switch that no setting may re-enable.
 */
export async function initTelemetryExport(options: InitTelemetryOptions = {}): Promise<void> {
	if (isTelemetryExportEnabled()) return;
	if (initPromise) return initPromise;

	if (process.env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") return;

	const env = resolveTelemetryEnv(options.settings);
	const signalConfig = resolveSignalConfig(env);
	if (!signalConfig.trace && !signalConfig.log && !signalConfig.metric) return;

	initPromise = registerProviders(signalConfig, options);
	return initPromise;
}

/**
 * Computed OTEL env view: process env merged over `telemetry.*` settings.
 *
 * This drives *gating* only — which signals have an endpoint and which are
 * switched off — so a settings-supplied endpoint activates the same signals an
 * env-supplied one would. The endpoint/header values the exporters actually use
 * come from {@link resolveExporterConfig}; nothing here is ever written back to
 * `process.env`.
 *
 * Env always wins per key, and `telemetry.enabled=false` contributes nothing
 * (env-only activation still works). Exported for tests.
 */
export function resolveTelemetryEnv(
	settings: Pick<Settings, "get"> | undefined,
	processEnv: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
	const out: Record<string, string | undefined> = { ...processEnv };
	if (!settings?.get("telemetry.enabled")) return out;

	const endpoint = settings.get("telemetry.endpoint");
	if (endpoint && !out.OTEL_EXPORTER_OTLP_ENDPOINT) out.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint;

	// A signal absent from the list is switched off explicitly, since the shared
	// endpoint above would otherwise enable all three.
	const signals = settings.get("telemetry.signals");
	if (Array.isArray(signals)) {
		if (!signals.includes("traces") && !out.OTEL_TRACES_EXPORTER) out.OTEL_TRACES_EXPORTER = "none";
		if (!signals.includes("logs") && !out.OTEL_LOGS_EXPORTER) out.OTEL_LOGS_EXPORTER = "none";
		if (!signals.includes("metrics") && !out.OTEL_METRICS_EXPORTER) out.OTEL_METRICS_EXPORTER = "none";
	}
	return out;
}

/**
 * OTLP exporter constructor config for one signal, derived from `telemetry.*`.
 *
 * Empty whenever env owns the value: the exporters read `OTEL_EXPORTER_OTLP_*`
 * themselves, so passing nothing leaves their standard env handling in charge —
 * which is what "env wins per key" means here. A settings value is passed
 * explicitly only when neither the signal-specific nor the generic env key is
 * set.
 *
 * `telemetry.endpoint` is a BASE endpoint per the OTLP spec, so the per-signal
 * path is appended (`http://host:4318` → `http://host:4318/v1/traces`), matching
 * what the exporters do with `OTEL_EXPORTER_OTLP_ENDPOINT`. Any trailing slashes
 * on the base are trimmed first so the join never doubles up. Headers are passed
 * as a plain record — no `k=v,…` serialization, hence no escaping question.
 *
 * Exported for tests.
 */
export function resolveExporterConfig(
	signal: TelemetrySignal,
	settings: Pick<Settings, "get"> | undefined,
	processEnv: Record<string, string | undefined> = process.env,
): ExporterConfig {
	const config: ExporterConfig = {};
	if (!settings?.get("telemetry.enabled")) return config;
	const { path, envInfix } = SIGNAL_OTLP[signal];

	const envEndpoint = processEnv[`OTEL_EXPORTER_OTLP_${envInfix}_ENDPOINT`] ?? processEnv.OTEL_EXPORTER_OTLP_ENDPOINT;
	const endpoint = settings.get("telemetry.endpoint");
	if (!envEndpoint && endpoint) config.url = `${endpoint.replace(/\/+$/, "")}${path}`;

	const envHeaders = processEnv[`OTEL_EXPORTER_OTLP_${envInfix}_HEADERS`] ?? processEnv.OTEL_EXPORTER_OTLP_HEADERS;
	const headers = settings.get("telemetry.headers");
	if (!envHeaders && headers && Object.keys(headers).length > 0) config.headers = { ...headers };

	return config;
}

async function registerProviders(signalConfig: SignalConfig, options: InitTelemetryOptions): Promise<void> {
	const resource = resourceFromAttributes(buildResourceAttributes(options));
	const settings = options.settings;

	if (signalConfig.trace) {
		const exporter = new OTLPTraceExporter(resolveExporterConfig("trace", settings));
		traceProvider = new NodeTracerProvider({
			resource,
			spanProcessors: [new BatchSpanProcessor(exporter)],
		});
		traceProvider.register({ contextManager: new AsyncLocalStorageContextManager().enable() });
	}

	if (signalConfig.metric) {
		const exporter = new OTLPMetricExporter(resolveExporterConfig("metric", settings));
		meterProvider = new MeterProvider({
			resource,
			readers: [new PeriodicExportingMetricReader({ exporter })],
		});
		metrics.setGlobalMeterProvider(meterProvider);
		metricRecorder = new AuraMetricRecorder(metrics.getMeter("aura"), {
			includeAccountIdentity: settings?.get("telemetry.identity.account") ?? false,
		});
	}

	if (signalConfig.log) {
		const exporter = new OTLPLogExporter(resolveExporterConfig("log", settings));
		logProvider = new LoggerProvider({
			resource,
			processors: [new BatchLogRecordProcessor({ exporter })],
		});
		logs.setGlobalLoggerProvider(logProvider);
		otelLogger = logProvider.getLogger("aura");
		unregisterLogSink = logger.registerLogSink(event => {
			emitOtelLog(event.level, event.message, logAttributesFromContext(event.context), "aura.log", event.timestamp);
		});
	}

	// Sole bus subscriber. Registered whenever any provider is live: the sink
	// fans out to metrics and structured logs independently, so a logs-only or
	// metrics-only configuration still gets its half.
	unregisterTelemetrySink = registerOtlpSink({
		recorder: metricRecorder,
		emitLog: (level, body, attributes, eventName) => emitOtelLog(level, body, attributes, eventName),
		traceEnabled: traceProvider !== undefined,
	});

	const flushTimer = setInterval(() => {
		flushTelemetryExport().catch(() => {});
	}, FLUSH_INTERVAL_MS);
	flushTimer.unref();

	postmortem.register("otel-export", async () => {
		clearInterval(flushTimer);
		unregisterLogSink?.();
		unregisterLogSink = undefined;
		unregisterTelemetrySink?.();
		unregisterTelemetrySink = undefined;
		const shutdowns: Promise<void>[] = [];
		if (traceProvider) shutdowns.push(traceProvider.shutdown());
		if (logProvider) shutdowns.push(logProvider.shutdown());
		if (meterProvider) shutdowns.push(meterProvider.shutdown());
		await Promise.all(shutdowns);
	});
}

function resolveSignalConfig(env: Record<string, string | undefined>): SignalConfig {
	const signalConfig: SignalConfig = {
		trace: signalEnabled(
			"trace",
			env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_ENDPOINT,
			env.OTEL_TRACES_EXPORTER,
			env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL,
		),
		log: signalEnabled(
			"log",
			env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_ENDPOINT,
			env.OTEL_LOGS_EXPORTER,
			env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL,
		),
		metric: signalEnabled(
			"metric",
			env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_ENDPOINT,
			env.OTEL_METRICS_EXPORTER,
			env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL,
		),
	};
	return signalConfig;
}

function signalEnabled(
	signal: TelemetrySignal,
	endpoint: string | undefined,
	exporterSelection: string | undefined,
	protocolSelection: string | undefined,
): boolean {
	if (exporterSelection) {
		for (const entry of exporterSelection.split(",")) {
			if (entry.trim().toLowerCase() === "none") return false;
		}
	}
	if (!endpoint) return false;

	const protocol = protocolSelection?.trim().toLowerCase();
	if (protocol && protocol !== "http/protobuf") {
		logger.warn(`OTEL ${signal} export disabled: OTEL_EXPORTER_OTLP_PROTOCOL=${protocol} is unsupported`, {
			supported: "http/protobuf",
		});
		return false;
	}
	return true;
}

function emitRunSummaryLog(sessionId: string | undefined, summary: AgentRunSummary, coverage: AgentRunCoverage): void {
	emitOtelLog(
		"info",
		"agent run completed",
		{
			...(sessionId ? { "session.id": sessionId } : {}),
			"aura.agent.step_count": summary.stepCount,
			"aura.agent.chats.total": summary.chats.total,
			"aura.agent.chats.total_latency_ms": summary.chats.totalLatencyMs,
			"aura.agent.tools.total": summary.tools.total,
			"aura.agent.tools.ok": summary.tools.ok,
			"aura.agent.tools.error": summary.tools.error,
			"aura.agent.tools.skipped": summary.tools.skipped,
			"aura.agent.tools.blocked": summary.tools.blocked,
			"aura.agent.tools.timeout": summary.tools.timeout,
			"aura.agent.tools.aborted": summary.tools.aborted,
			"aura.agent.tools.total_latency_ms": summary.tools.totalLatencyMs,
			"aura.agent.usage.input_tokens": summary.usage.inputTokens,
			"aura.agent.usage.output_tokens": summary.usage.outputTokens,
			"aura.agent.usage.cached_input_tokens": summary.usage.cachedInputTokens,
			"aura.agent.usage.cache_write_tokens": summary.usage.cacheWriteTokens,
			"aura.agent.usage.reasoning_output_tokens": summary.usage.reasoningOutputTokens,
			"aura.agent.usage.total_tokens": summary.usage.totalTokens,
			"aura.agent.cost.estimated_usd": summary.cost.estimatedUsd,
			"aura.agent.cost.unavailable_reasons": summary.cost.unavailableReasons.join(","),
			"aura.agent.errors.total": summary.errors.total,
			"aura.agent.coverage.tools_available": coverage.toolsAvailable.join(","),
			"aura.agent.coverage.tools_invoked": coverage.toolsInvoked.join(","),
			"aura.agent.coverage.tools_unused": coverage.toolsUnused.join(","),
			"aura.agent.coverage.models_used": coverage.modelsUsed.join(","),
			"aura.agent.coverage.providers_used": coverage.providersUsed.join(","),
		},
		"aura.agent.run.completed",
	);
}

function emitTelemetryWarningLog(warning: AgentTelemetryWarning): void {
	const attrs = logAttributesFromContext({
		code: warning.code,
		error: warning.error,
	});
	emitOtelLog("warn", warning.message, attrs, "aura.telemetry.warning");
}

function emitOtelLog(
	level: logger.LogLevel,
	body: string,
	attributes: LogAttributes,
	eventName: string,
	timestamp = new Date(),
): void {
	if (!otelLogger) return;
	const minLevel = parseOtelLogLevel(process.env.OTEL_LOG_LEVEL);
	if (minLevel === "none") return;
	if (LOG_LEVEL_WEIGHT[level] > LOG_LEVEL_WEIGHT[minLevel]) return;
	otelLogger.emit({
		eventName,
		timestamp,
		observedTimestamp: new Date(),
		severityNumber: LOG_SEVERITY[level],
		severityText: level.toUpperCase(),
		body,
		attributes,
		context: context.active(),
	});
}

function parseOtelLogLevel(raw: string | undefined): OtelLogLevel {
	if (!raw) return "info";
	switch (raw.trim().toLowerCase()) {
		case "none":
			return "none";
		case "error":
			return "error";
		case "warn":
		case "warning":
			return "warn";
		case "debug":
			return "debug";
		default:
			return "info";
	}
}

function logAttributesFromContext(input: Record<string, unknown> | undefined): LogAttributes {
	const out: LogAttributes = { "process.pid": process.pid };
	if (!input) return out;
	for (const key in input) {
		const attr = logAttributeValue(input[key]);
		if (attr !== undefined) out[key] = attr;
	}
	return out;
}

function logAttributeValue(value: unknown): AttributeValue | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	if (value instanceof Error) {
		return `${value.name}: ${value.message}`;
	}
	try {
		const text = JSON.stringify(value);
		if (text && text.length > 0) return text;
	} catch {
		return String(value);
	}
	return String(value);
}

/**
 * Flush buffered spans, log records, and metrics. No-op when export is disabled.
 * Hosts embedding the agent can call this at natural boundaries (e.g. the end
 * of a turn) so telemetry surfaces promptly rather than on the batch interval.
 */
export async function flushTelemetryExport(): Promise<void> {
	const flushes: Promise<void>[] = [];
	if (traceProvider) flushes.push(traceProvider.forceFlush());
	if (logProvider) flushes.push(logProvider.forceFlush());
	if (meterProvider) flushes.push(meterProvider.forceFlush());
	await Promise.all(flushes);
}
