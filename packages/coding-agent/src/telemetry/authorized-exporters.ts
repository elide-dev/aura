/**
 * OTLP exporters for the Aura telemetry tier.
 *
 * The stock OTLP exporters take static headers at construction; an Aura
 * access token lives ≤15 minutes and may only ever be attached by
 * `TokenManager.authorizedFetch` (the single bearer-attachment point). These
 * exporters serialize with the same otlp-transformer the stock exporters
 * use, then send through an injected `authorizedFetch` — fresh token per
 * export, 401-refresh-retry and redirect guards included. Only the Aura
 * tier constructs them (init.ts); every other destination keeps the stock
 * exporters and never sees a credential.
 *
 * `sendAuthorized` mirrors, in spirit, the stock otlp-exporter-base retry
 * behavior: a 429/502/503/504 or a network-level rejection is retried with
 * jittered exponential backoff (honoring `Retry-After` when the collector
 * sends one) up to {@link MAX_ATTEMPTS} attempts, and every attempt is bounded
 * by {@link EXPORT_TIMEOUT_MS} — otherwise `BatchLogRecordProcessor` marks a
 * hung export FAILED but never re-queues it, so a transient collector blip or
 * a wedged connection would permanently drop the batch, billing records
 * included.
 */
import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import {
	ProtobufLogsSerializer,
	ProtobufMetricsSerializer,
	ProtobufTraceSerializer,
} from "@opentelemetry/otlp-transformer";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { PushMetricExporter, ResourceMetrics } from "@opentelemetry/sdk-metrics";
import { AggregationTemporality } from "@opentelemetry/sdk-metrics";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

export interface AuraTelemetryTransport {
	authorizedFetch(
		url: string,
		init: {
			method?: string;
			headers?: Bun.HeadersInit;
			body?: Bun.BodyInit;
			eligibleOrigin?: string;
			signal?: AbortSignal;
		},
	): Promise<Response>;
}

export interface AuthorizedExporterOptions {
	/** Full signal URL, e.g. https://aura.elide.events/v1/logs. */
	url: string;
	transport: AuraTelemetryTransport;
	/**
	 * Backoff delay override, for tests: given the computed delay in
	 * milliseconds, resolve whenever the test is ready to let the retry
	 * proceed. Defaults to a real `setTimeout`-based sleep.
	 */
	sleep?: (ms: number) => Promise<void>;
}

/** Up to 3 attempts total (the initial send plus 2 retries). */
const MAX_ATTEMPTS = 3;
/** Collector statuses worth retrying — transient overload/unavailability, per the OTLP spec. */
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 5000;
const BACKOFF_MULTIPLIER = 2;
/** Jitter fraction applied symmetrically around the computed backoff. */
const JITTER = 0.2;
/** Per-attempt bound, matching the stock OTLP exporters' default export timeout. */
const EXPORT_TIMEOUT_MS = 10_000;

function jitteredBackoff(baseMs: number): number {
	const jitter = Math.random() * (2 * JITTER) - JITTER;
	return Math.max(0, Math.min(baseMs * (1 + jitter), MAX_BACKOFF_MS));
}

/** `Retry-After`, in ms: an integer is seconds, otherwise an HTTP-date. Undefined when absent or unparsable. */
function parseRetryAfterMs(value: string | null): number | undefined {
	if (!value) return undefined;
	const seconds = Number.parseInt(value, 10);
	if (Number.isInteger(seconds) && String(seconds) === value.trim()) return Math.max(0, seconds * 1000);
	const delay = new Date(value).getTime() - Date.now();
	return Number.isNaN(delay) ? undefined : Math.max(0, delay);
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/** Exported for tests (like errorEventFromLog in init.ts). */
export async function sendAuthorized(
	options: AuthorizedExporterOptions,
	body: Uint8Array | undefined,
	resultCallback: (result: ExportResult) => void,
): Promise<void> {
	if (body === undefined || body.byteLength === 0) {
		resultCallback({ code: ExportResultCode.SUCCESS });
		return;
	}
	const eligibleOrigin = new URL(options.url).origin;
	const sleep = options.sleep ?? defaultSleep;
	let backoffMs = INITIAL_BACKOFF_MS;

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const lastAttempt = attempt === MAX_ATTEMPTS;
		try {
			const response = await options.transport.authorizedFetch(options.url, {
				method: "POST",
				headers: { "content-type": "application/x-protobuf" },
				body: body as unknown as Bun.BodyInit,
				eligibleOrigin,
				signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
			});
			await response.body?.cancel();
			if (response.ok) {
				resultCallback({ code: ExportResultCode.SUCCESS });
				return;
			}
			if (!RETRYABLE_STATUSES.has(response.status) || lastAttempt) {
				resultCallback({ code: ExportResultCode.FAILED, error: new Error(`collector status ${response.status}`) });
				return;
			}
			const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
			await sleep(retryAfterMs ?? jitteredBackoff(backoffMs));
		} catch (error) {
			if (lastAttempt) {
				resultCallback({
					code: ExportResultCode.FAILED,
					error: error instanceof Error ? error : new Error(String(error)),
				});
				return;
			}
			await sleep(jitteredBackoff(backoffMs));
		}
		backoffMs *= BACKOFF_MULTIPLIER;
	}
}

export class AuthorizedLogExporter implements LogRecordExporter {
	constructor(private readonly options: AuthorizedExporterOptions) {}

	export(logs: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
		sendAuthorized(
			this.options,
			logs.length === 0 ? undefined : ProtobufLogsSerializer.serializeRequest(logs),
			resultCallback,
		);
	}

	/** Nothing buffered — every export() call sends immediately. */
	async forceFlush(): Promise<void> {}

	async shutdown(): Promise<void> {}
}

export class AuthorizedTraceExporter implements SpanExporter {
	constructor(private readonly options: AuthorizedExporterOptions) {}

	export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
		sendAuthorized(
			this.options,
			spans.length === 0 ? undefined : ProtobufTraceSerializer.serializeRequest(spans),
			resultCallback,
		);
	}

	async shutdown(): Promise<void> {}
}

export class AuthorizedMetricExporter implements PushMetricExporter {
	constructor(private readonly options: AuthorizedExporterOptions) {}

	export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
		sendAuthorized(this.options, ProtobufMetricsSerializer.serializeRequest(metrics), resultCallback);
	}

	/** Cumulative, matching the stock exporter default — billing reads logs, not metrics. */
	selectAggregationTemporality(): AggregationTemporality {
		return AggregationTemporality.CUMULATIVE;
	}

	async forceFlush(): Promise<void> {}

	async shutdown(): Promise<void> {}
}
