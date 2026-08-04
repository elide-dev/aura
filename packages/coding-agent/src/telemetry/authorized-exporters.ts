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
		init: { method?: string; headers?: Bun.HeadersInit; body?: Bun.BodyInit; eligibleOrigin?: string },
	): Promise<Response>;
}

export interface AuthorizedExporterOptions {
	/** Full signal URL, e.g. https://telemetry.elide.cloud/v1/logs. */
	url: string;
	transport: AuraTelemetryTransport;
}

/** Exported for tests (like errorEventFromLog in init.ts). */
export function sendAuthorized(
	options: AuthorizedExporterOptions,
	body: Uint8Array | undefined,
	resultCallback: (result: ExportResult) => void,
): void {
	if (body === undefined || body.byteLength === 0) {
		resultCallback({ code: ExportResultCode.SUCCESS });
		return;
	}
	const eligibleOrigin = new URL(options.url).origin;
	options.transport
		.authorizedFetch(options.url, {
			method: "POST",
			headers: { "content-type": "application/x-protobuf" },
			body: body as unknown as Bun.BodyInit,
			eligibleOrigin,
		})
		.then(async response => {
			await response.body?.cancel();
			if (response.ok) resultCallback({ code: ExportResultCode.SUCCESS });
			else
				resultCallback({ code: ExportResultCode.FAILED, error: new Error(`collector status ${response.status}`) });
		})
		.catch(error => {
			resultCallback({
				code: ExportResultCode.FAILED,
				error: error instanceof Error ? error : new Error(String(error)),
			});
		});
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
