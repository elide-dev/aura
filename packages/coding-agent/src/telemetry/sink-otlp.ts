/**
 * Sole telemetry-bus subscriber: maps TelemetryEvent to OTel instruments and
 * structured log records. Publishers stay OTel-free; this module is only
 * registered when an OTLP provider is live (init.ts).
 */
import type { logger } from "@oh-my-pi/pi-utils";
import type { LogAttributes } from "@opentelemetry/api-logs";
import { subscribeTelemetry, type TelemetryEvent } from "./events";
import type { AuraMetricRecorder } from "./metrics";

export type EmitOtelLog = (level: logger.LogLevel, body: string, attributes: LogAttributes, eventName: string) => void;

export interface OtlpSinkDeps {
	recorder?: AuraMetricRecorder;
	emitLog: EmitOtelLog;
}

/** Subscribe the OTLP sink to the telemetry bus; returns a disposer. */
export function registerOtlpSink(deps: OtlpSinkDeps): () => void {
	return subscribeTelemetry(event => handle(deps, event));
}

function handle(deps: OtlpSinkDeps, event: TelemetryEvent): void {
	switch (event.type) {
		case "session.started":
			deps.emitLog(
				"info",
				"session started",
				logAttributes({
					"session.id": event.sessionId,
					"aura.session.mode": event.mode,
					"aura.session.resumed": event.resumed,
				}),
				"aura.session.started",
			);
			break;
		case "session.ended":
			deps.recorder?.recordSessionEnd(event);
			deps.emitLog(
				"info",
				"session ended",
				logAttributes({
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
				}),
				"aura.session.ended",
			);
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
			deps.emitLog(
				event.outcome === "error" ? "warn" : "info",
				"compaction completed",
				logAttributes({
					"session.id": event.sessionId,
					"aura.compaction.strategy": event.strategy,
					"aura.compaction.trigger": event.trigger,
					"aura.compaction.outcome": event.outcome,
					"aura.compaction.tokens_before": event.tokensBefore,
					"aura.compaction.tokens_after": event.tokensAfter,
					"aura.compaction.duration_ms": event.durationMs,
					"aura.compaction.error": event.errorMessage,
				}),
				"aura.compaction.completed",
			);
			break;
		case "compaction.savings":
			deps.recorder?.recordCompactionSavings(event);
			break;
		case "usage_limit.snapshot":
			deps.recorder?.recordUsageLimit(event);
			break;
	}
}

/** Optional event fields arrive as undefined; OTel rejects those, so drop them. */
function logAttributes(fields: Record<string, string | number | boolean | undefined>): LogAttributes {
	const out: LogAttributes = {};
	for (const key in fields) {
		const value = fields[key];
		if (value !== undefined) out[key] = value;
	}
	return out;
}
