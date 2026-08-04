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
 * Absent all of those, export still happens: {@link BUILTIN_TELEMETRY_ENDPOINT}
 * is the built-in destination for an unconfigured install, sitting at the bottom
 * of the tier list in {@link resolveDestination}. Every higher tier — including
 * the Aura relay — displaces it without any setting being edited.
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
import { type AttributeValue, context, metrics, trace } from "@opentelemetry/api";
import { type LogAttributes, logs, type Logger as OtelLogger, SeverityNumber } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { detectResources, envDetector, resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { auraDeploymentFor, readCloudSwitches, resolveAuraDeployment } from "../cloud/deployment";
import type { Settings } from "../config/settings";
import {
	type AuraTelemetryTransport,
	AuthorizedLogExporter,
	AuthorizedMetricExporter,
	AuthorizedTraceExporter,
} from "./authorized-exporters";
import { type ErrorReportedTelemetry, emitTelemetryEvent, getActiveTelemetrySessionId } from "./events";
import { buildResourceAttributes, getOrCreateInstallId } from "./identity";
import { AuraMetricRecorder } from "./metrics";
import { registerOtlpSink } from "./sink-otlp";

/**
 * Periodic flush interval. A long-lived `omp` process (the ACP server is
 * spawned once and reused across many turns) would otherwise hold finished
 * telemetry until a batch window elapses or the process exits.
 */
const FLUSH_INTERVAL_MS = 30_000;

/**
 * Max log records per export batch. The BatchLogRecordProcessor default
 * (512) can serialize to a protobuf payload larger than the cloud relay's
 * 112 KiB per-request cap (workers/telemetry's MAX_BODY_BYTES in the elide
 * cloud repo); a batch that trips that cap 413s in full, dropping every
 * record in it — including any aura.usage.tokens billing records riding
 * along with observability logs. A conservative cap keeps batches well
 * under that ceiling.
 */
const MAX_LOG_EXPORT_BATCH_SIZE = 64;

/** Options for {@link initTelemetryExport}. */
export interface InitTelemetryOptions {
	/** Settings instance for telemetry.* config (env always wins). */
	settings?: Settings;
	/**
	 * Cloud transport for the Aura telemetry tier. When present AND the Aura
	 * tier wins the destination, exports go through authorized exporters —
	 * fresh bearer per export via TokenManager.authorizedFetch. Absent (no
	 * signed-in cloud session wired up yet), the Aura tier exports
	 * unauthenticated and the collector's edge will 401 them; the built-in
	 * and operator tiers are unaffected either way. The CLI wires this once
	 * the cloud login command lands (cloud/auth.ts AuraAuthClient.manager).
	 */
	cloud?: { transport: AuraTelemetryTransport };
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

/** Built-in OTLP destination: the Aura telemetry collector (http/protobuf). */
export const BUILTIN_TELEMETRY_ENDPOINT = "https://aura.elide.events";

/**
 * Headers for {@link BUILTIN_TELEMETRY_ENDPOINT}. Atomic with it — never sent
 * anywhere else. Carries the pseudonymous install id (the same one emitted as
 * the `aura.install.id` resource attribute) so the collector can derive
 * unique-installation metrics at the HTTP layer. No credential today: the
 * collector accepts unauthenticated OTLP; when it starts requiring one, an
 * `Authorization: Bearer …` slots in alongside.
 */
export function builtinTelemetryHeaders(): Readonly<Record<string, string>> {
	return { "x-aura-install-id": getOrCreateInstallId() };
}

/** Accepted `telemetry.signals` members (the settings-side signal names). */
const KNOWN_TELEMETRY_SIGNALS: ReadonlySet<string> = new Set(["traces", "logs", "metrics"]);

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
let flushTimer: ReturnType<typeof setInterval> | undefined;
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
		// No onCostDelta override: the per-step delta carries nothing the
		// chat.usage → aura.agent.chat.cost.estimated_usd counter does not already
		// record, so the caller's own hook (if any) passes through the spread above
		// rather than being wrapped for an emission nothing consumes.
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

	initPromise = registerProvidersGuarded(signalConfig, options);
	return initPromise;
}

/**
 * Registration error boundary.
 *
 * Every step of {@link registerProviders} can throw on operator input the SDK
 * rejects — a malformed `telemetry.endpoint` makes the OTLP exporter constructor
 * throw outright — and telemetry must never be able to take the CLI down at
 * startup. A failure is logged once, everything already assigned is torn back
 * down (so no half-built subsystem is left claiming to be enabled), and
 * `initTelemetryExport` resolves normally with export off. `initPromise` is
 * cleared too, so a later caller with a corrected configuration can retry.
 */
async function registerProvidersGuarded(signalConfig: SignalConfig, options: InitTelemetryOptions): Promise<void> {
	try {
		await registerProviders(signalConfig, options);
	} catch (error) {
		logger.warn("telemetry export disabled: OTLP provider registration failed", { error: String(error) });
		await teardownProviders();
		initPromise = undefined;
	}
}

/**
 * Release everything {@link registerProviders} may have assigned, best-effort.
 *
 * Ordering matters: the sinks come off the buses first so nothing keeps feeding
 * providers that are on their way out, and module state is cleared before the
 * (awaited, individually guarded) shutdowns so `isTelemetryExportEnabled()`
 * reports `false` immediately rather than after the last flush attempt. The
 * globals each provider claimed are reset as well — a provider left installed
 * globally would keep buffering for an exporter that is never going to work.
 */
async function teardownProviders(): Promise<void> {
	unregisterLogSink?.();
	unregisterLogSink = undefined;
	unregisterTelemetrySink?.();
	unregisterTelemetrySink = undefined;
	if (flushTimer) clearInterval(flushTimer);
	flushTimer = undefined;

	const pending: (NodeTracerProvider | LoggerProvider | MeterProvider)[] = [];
	if (traceProvider) {
		pending.push(traceProvider);
		trace.disable();
	}
	if (logProvider) {
		pending.push(logProvider);
		logs.disable();
	}
	if (meterProvider) {
		pending.push(meterProvider);
		metrics.disable();
	}
	traceProvider = undefined;
	logProvider = undefined;
	meterProvider = undefined;
	metricRecorder = undefined;
	otelLogger = undefined;

	await Promise.all(
		pending.map(async provider => {
			try {
				await provider.shutdown();
			} catch (error) {
				logger.debug("telemetry provider shutdown failed during teardown", { error: String(error) });
			}
		}),
	);
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

	const destination = resolveDestination(settings, processEnv);
	if (destination && !out.OTEL_EXPORTER_OTLP_ENDPOINT) out.OTEL_EXPORTER_OTLP_ENDPOINT = destination.url;

	// A signal absent from the list is switched off explicitly, since the shared
	// endpoint above would otherwise enable all three.
	const signals = settings.get("telemetry.signals");
	if (Array.isArray(signals)) {
		// A misspelling ("trace", "log") reads as "that signal was omitted" and
		// silently switches it off, which is indistinguishable from a deliberate
		// opt-out. Name the unrecognized entries once so the typo is visible.
		const unknown = signals.filter(signal => !KNOWN_TELEMETRY_SIGNALS.has(signal as string));
		if (unknown.length > 0) {
			logger.warn(`telemetry.signals has unrecognized ${unknown.length === 1 ? "entry" : "entries"}`, {
				unknown: unknown.map(String).join(","),
				supported: [...KNOWN_TELEMETRY_SIGNALS].join(","),
			});
		}
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
 * The destination is a BASE endpoint per the OTLP spec, so the per-signal path
 * is appended (`http://host:4318` → `http://host:4318/v1/traces`), matching what
 * the exporters do with `OTEL_EXPORTER_OTLP_ENDPOINT`. Any trailing slashes on
 * the base are trimmed first so the join never doubles up. Headers are passed as
 * a plain record — no `k=v,…` serialization, hence no escaping question.
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
	const destination = resolveDestination(settings, processEnv);
	if (!envEndpoint && destination) config.url = `${destination.url.replace(/\/+$/, "")}${path}`;

	// Headers follow the endpoint that is actually in use. When env owns the
	// endpoint only the user's own `telemetry.headers` may accompany it — a
	// destination-owned credential (the built-in one) stays with its destination.
	const envHeaders = processEnv[`OTEL_EXPORTER_OTLP_${envInfix}_HEADERS`] ?? processEnv.OTEL_EXPORTER_OTLP_HEADERS;
	const headers = envEndpoint ? settingsHeaders(settings) : destination?.headers;
	if (!envHeaders && headers) config.headers = { ...headers };

	return config;
}

/**
 * The full signal URL to export through an authorized exporter, or
 * undefined when the Aura tier is not the winning destination. Mirrors
 * resolveExporterConfig's precedence exactly: env endpoints always win
 * (and never carry the Aura credential), an explicit telemetry.endpoint
 * outranks the Aura tier, and the built-in tier never authenticates.
 */
export function resolveAuraAuthorizedUrl(
	signal: TelemetrySignal,
	settings: Pick<Settings, "get"> | undefined,
	processEnv: Record<string, string | undefined> = process.env,
): string | undefined {
	if (!settings?.get("telemetry.enabled")) return undefined;
	const { path, envInfix } = SIGNAL_OTLP[signal];
	const envEndpoint = processEnv[`OTEL_EXPORTER_OTLP_${envInfix}_ENDPOINT`] ?? processEnv.OTEL_EXPORTER_OTLP_ENDPOINT;
	if (envEndpoint) return undefined;
	if (settings.get("telemetry.endpoint")) return undefined;
	const aura = auraTelemetryEndpoint(settings, processEnv);
	if (!aura) return undefined;
	return `${aura.replace(/\/+$/, "")}${path}`;
}

/** A destination and the headers that belong to it — resolved together, always. */
interface TelemetryDestination {
	readonly url: string;
	readonly headers?: Readonly<Record<string, string>>;
}

/** The user's own `telemetry.headers`, or undefined when they set none. */
function settingsHeaders(settings: Pick<Settings, "get">): Record<string, string> | undefined {
	const headers = settings.get("telemetry.headers");
	if (!headers || Object.keys(headers).length === 0) return undefined;
	return headers;
}

/**
 * Where telemetry goes when the `OTEL_EXPORTER_OTLP_*` variables do not say.
 *
 * Tiers, highest first:
 *
 *  1. **Explicit `telemetry.endpoint`.** The operator named a collector; their
 *     own `telemetry.headers` ride with it.
 *  2. **Aura** — `AURA_TELEMETRY_URL`, or a derivation from `AURA_DOMAIN`, and
 *     only while `cloud.telemetry.enabled` is on (off by default). Carries no
 *     built-in credential; the Aura relay authenticates its own way.
 *  3. **The built-in Aura telemetry collector**, with the headers that belong
 *     to it (the install-id header; no credential today). This is the
 *     destination an unconfigured install exports to.
 *
 * Two properties are load-bearing:
 *
 *  - **The built-in tier is last.** It is deliberately not a `telemetry.endpoint`
 *    default: a populated default is indistinguishable from a user-set value at
 *    read time, so it would occupy tier 1 and permanently shadow the Aura tier.
 *    Sitting here, it hands over the moment an Aura relay is configured, with no
 *    edit to any setting.
 *  - **A tier's endpoint and headers are atomic.** They are returned as one
 *    object and never recombined, so the built-in credential cannot reach an
 *    Aura (or env, or operator) host, and a user credential cannot reach the
 *    built-in stack. The last is why headers-without-endpoint declines the
 *    built-in tier rather than pairing a foreign header with it.
 */
function resolveDestination(
	settings: Pick<Settings, "get">,
	processEnv: Record<string, string | undefined>,
): TelemetryDestination | undefined {
	const headers = settingsHeaders(settings);
	const endpoint = settings.get("telemetry.endpoint");
	if (endpoint) return headers ? { url: endpoint, headers } : { url: endpoint };

	const aura = auraTelemetryEndpoint(settings, processEnv);
	if (aura) return headers ? { url: aura, headers } : { url: aura };

	if (headers) return undefined;
	return { url: BUILTIN_TELEMETRY_ENDPOINT, headers: builtinTelemetryHeaders() };
}

/**
 * The Aura telemetry base URL, or undefined when Aura says nothing about it.
 *
 * `cloud.telemetry.enabled` gates the tier through the same projection every
 * other Aura consumer uses, so switching telemetry off removes the Aura tier and
 * nothing else. A malformed Aura variable is reported and dropped rather than
 * thrown: telemetry must not be able to take startup down, and refusing the tier
 * simply lets the next one apply.
 */
function auraTelemetryEndpoint(
	settings: Pick<Settings, "get">,
	processEnv: Record<string, string | undefined>,
): string | undefined {
	try {
		const deployment = resolveAuraDeployment({ env: processEnv });
		const switches = readCloudSwitches(settings);
		return auraDeploymentFor("telemetry", deployment, switches).telemetryBaseUrl?.url;
	} catch (error) {
		logger.warn("telemetry: ignoring invalid Aura endpoint configuration", { error: String(error) });
		return undefined;
	}
}

async function registerProviders(signalConfig: SignalConfig, options: InitTelemetryOptions): Promise<void> {
	// `envDetector` parses OTEL_RESOURCE_ATTRIBUTES (percent-decoded, per spec) and
	// OTEL_SERVICE_NAME; merged last so both take precedence over our identity
	// attributes — with OTEL_SERVICE_NAME still winning service.name inside the
	// detector itself.
	const resource = resourceFromAttributes(buildResourceAttributes(options)).merge(
		detectResources({ detectors: [envDetector] }),
	);
	const settings = options.settings;

	if (signalConfig.trace) {
		const authorizedUrl = options.cloud && resolveAuraAuthorizedUrl("trace", settings);
		const exporter = authorizedUrl
			? new AuthorizedTraceExporter({ url: authorizedUrl, transport: options.cloud!.transport })
			: new OTLPTraceExporter(resolveExporterConfig("trace", settings));
		traceProvider = new NodeTracerProvider({
			resource,
			spanProcessors: [new BatchSpanProcessor(exporter)],
		});
		traceProvider.register({ contextManager: new AsyncLocalStorageContextManager().enable() });
	}

	if (signalConfig.metric) {
		const authorizedUrl = options.cloud && resolveAuraAuthorizedUrl("metric", settings);
		const exporter = authorizedUrl
			? new AuthorizedMetricExporter({ url: authorizedUrl, transport: options.cloud!.transport })
			: new OTLPMetricExporter(resolveExporterConfig("metric", settings));
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
		const authorizedUrl = options.cloud && resolveAuraAuthorizedUrl("log", settings);
		const exporter = authorizedUrl
			? new AuthorizedLogExporter({ url: authorizedUrl, transport: options.cloud!.transport })
			: new OTLPLogExporter(resolveExporterConfig("log", settings));
		logProvider = new LoggerProvider({
			resource,
			processors: [new BatchLogRecordProcessor({ exporter, maxExportBatchSize: MAX_LOG_EXPORT_BATCH_SIZE })],
		});
		logs.setGlobalLoggerProvider(logProvider);
		otelLogger = logProvider.getLogger("aura");
		unregisterLogSink = logger.registerLogSink(event => {
			emitOtelLog(event.level, event.message, logAttributesFromContext(event.context), "aura.log", event.timestamp);
			// Counting only: the record above already carries the message, so the OTLP
			// sink deliberately emits no second log record for error.reported.
			const errorEvent = errorEventFromLog(event);
			if (errorEvent) emitTelemetryEvent(errorEvent);
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

	// Module-scoped so the error boundary can clear a timer that was already
	// armed when a later step threw.
	flushTimer = setInterval(() => {
		flushTelemetryExport().catch(() => {});
	}, FLUSH_INTERVAL_MS);
	flushTimer.unref();

	postmortem.register("otel-export", async () => {
		await teardownProviders();
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

/**
 * The `error.reported` event an error-level log record contributes, if any.
 *
 * Logger records are the only source of `session`-phase errors — chat, tool, and
 * compaction failures reach the bus already classified by their own publishers.
 * A caller-supplied `context.code` is the error taxonomy when present; otherwise
 * the generic `log_error` keeps the `error.type` dimension bounded instead of
 * minting one series per distinct message.
 *
 * Total by construction: it only reads the event and never logs, so the logger
 * sink cannot recurse or throw back into a logging path.
 *
 * Exported for tests.
 */
export function errorEventFromLog(event: logger.LogEvent): ErrorReportedTelemetry | undefined {
	if (event.level !== "error") return undefined;
	const code = event.context?.code;
	return {
		type: "error.reported",
		phase: "session",
		errorType: typeof code === "string" && code.length > 0 ? code : "log_error",
		message: event.message,
	};
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
