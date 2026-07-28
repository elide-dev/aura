/**
 * OTLP telemetry export bootstrap.
 *
 * oh-my-pi's agent core (`@oh-my-pi/pi-agent-core`) emits OpenTelemetry GenAI
 * spans through the global `@opentelemetry/api` tracer, and exposes run-level
 * callbacks for metrics/log pipelines. This module registers the OTLP/proto
 * trace, log, and metric SDK providers when the standard `OTEL_*` endpoint env
 * vars are set so `omp` can be observed by any OTLP collector without vendor
 * coupling.
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
import { emitTelemetryEvent } from "./events";
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
	settings?: import("../config/settings").Settings;
}

type TelemetrySignal = "trace" | "log" | "metric";
type OtelLogLevel = "none" | logger.LogLevel;

interface SignalConfig {
	readonly trace: boolean;
	readonly log: boolean;
	readonly metric: boolean;
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
			emitTelemetryEvent({ type: "turn.completed", summary, coverage });
			emitRunSummaryLog(summary, coverage);
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
 * through env. Idempotent, and a no-op when no signal has an endpoint (or when
 * the OTEL kill-switches are engaged), so startup can call it unconditionally.
 */
export async function initTelemetryExport(options: InitTelemetryOptions = {}): Promise<void> {
	if (isTelemetryExportEnabled()) return;
	if (initPromise) return initPromise;

	if (process.env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") return;

	const signalConfig = resolveSignalConfig();
	if (!signalConfig.trace && !signalConfig.log && !signalConfig.metric) return;

	initPromise = registerProviders(signalConfig, options);
	return initPromise;
}

async function registerProviders(signalConfig: SignalConfig, _options: InitTelemetryOptions): Promise<void> {
	const resource = resourceFromAttributes(buildResourceAttributes());

	if (signalConfig.trace) {
		const exporter = new OTLPTraceExporter();
		traceProvider = new NodeTracerProvider({
			resource,
			spanProcessors: [new BatchSpanProcessor(exporter)],
		});
		traceProvider.register({ contextManager: new AsyncLocalStorageContextManager().enable() });
	}

	if (signalConfig.metric) {
		const exporter = new OTLPMetricExporter();
		meterProvider = new MeterProvider({
			resource,
			readers: [new PeriodicExportingMetricReader({ exporter })],
		});
		metrics.setGlobalMeterProvider(meterProvider);
		metricRecorder = new AuraMetricRecorder(metrics.getMeter("aura"));
	}

	if (signalConfig.log) {
		const exporter = new OTLPLogExporter();
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

function resolveSignalConfig(): SignalConfig {
	const signalConfig: SignalConfig = {
		trace: signalEnabled(
			"trace",
			process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
			process.env.OTEL_TRACES_EXPORTER,
			process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? process.env.OTEL_EXPORTER_OTLP_PROTOCOL,
		),
		log: signalEnabled(
			"log",
			process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
			process.env.OTEL_LOGS_EXPORTER,
			process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL ?? process.env.OTEL_EXPORTER_OTLP_PROTOCOL,
		),
		metric: signalEnabled(
			"metric",
			process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
			process.env.OTEL_METRICS_EXPORTER,
			process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL ?? process.env.OTEL_EXPORTER_OTLP_PROTOCOL,
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

function emitRunSummaryLog(summary: AgentRunSummary, coverage: AgentRunCoverage): void {
	emitOtelLog(
		"info",
		"agent run completed",
		{
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
