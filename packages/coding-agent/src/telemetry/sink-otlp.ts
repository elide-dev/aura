/**
 * Sole telemetry-bus subscriber: maps TelemetryEvent to OTel instruments and
 * structured log records. Publishers stay OTel-free; this module is only
 * registered when an OTLP provider is live (init.ts).
 */
import type { logger } from "@oh-my-pi/pi-utils";
import { type Attributes, context, SpanStatusCode, trace } from "@opentelemetry/api";
import type { LogAttributes } from "@opentelemetry/api-logs";
import { type CompactionCompletedTelemetry, subscribeTelemetry, type TelemetryEvent } from "./events";
import type { AuraMetricRecorder } from "./metrics";

export type EmitOtelLog = (level: logger.LogLevel, body: string, attributes: LogAttributes, eventName: string) => void;

export interface OtlpSinkDeps {
	recorder?: AuraMetricRecorder;
	emitLog: EmitOtelLog;
	/**
	 * Whether a real trace provider is registered. Only then does the sink
	 * synthesize spans for events the agent loop does not already trace — without
	 * a provider the global tracer hands back non-recording spans, so the work
	 * would be pure overhead.
	 */
	traceEnabled?: boolean;
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
				otelAttributes({
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
				otelAttributes({
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
		case "runtime.call.completed":
			deps.recorder?.recordRuntimeCall(event);
			deps.emitLog(
				event.outcome === "ok" ? "info" : "warn",
				"runtime call completed",
				otelAttributes({
					"session.id": event.sessionId,
					"aura.runtime.method": event.method,
					"aura.runtime.action": event.action,
					"aura.runtime.language": event.language,
					"aura.runtime.outcome": event.outcome,
					"aura.runtime.duration_ms": event.durationMs,
					"aura.runtime.exit_code": event.exitCode,
					"aura.runtime.killed": event.killed,
					"error.type": event.errorType,
				}),
				"aura.runtime.call.completed",
			);
			break;
		case "error.reported":
			deps.recorder?.recordError(event.phase, event.errorType);
			break;
		case "compaction.completed":
			deps.recorder?.recordCompaction(event);
			deps.emitLog(
				event.outcome === "error" ? "warn" : "info",
				"compaction completed",
				otelAttributes({
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
			if (deps.traceEnabled) synthesizeCompactionSpan(event);
			break;
		case "compaction.savings":
			deps.recorder?.recordCompactionSavings(event);
			break;
		case "usage_limit.snapshot":
			deps.recorder?.recordUsageLimit(event);
			break;
	}
}

/**
 * Emit a retroactive `aura.compaction` span.
 *
 * Compaction is reported to the bus only once it has finished, so the span is
 * back-dated by the measured duration and closed immediately. It is parented to
 * whatever context is active at emit time (usually the turn that triggered the
 * compaction).
 */
function synthesizeCompactionSpan(event: CompactionCompletedTelemetry): void {
	const now = Date.now();
	const span = trace.getTracer("aura-telemetry").startSpan(
		"aura.compaction",
		{
			startTime: new Date(now - Math.max(0, event.durationMs)),
			attributes: otelAttributes({
				"session.id": event.sessionId,
				"aura.compaction.strategy": event.strategy,
				"aura.compaction.trigger": event.trigger,
				"aura.compaction.outcome": event.outcome,
				"aura.compaction.tokens_before": event.tokensBefore,
				"aura.compaction.tokens_after": event.tokensAfter,
			}),
		},
		context.active(),
	);
	if (event.outcome === "error") span.setStatus({ code: SpanStatusCode.ERROR, message: event.errorMessage });
	span.end(new Date(now));
}

/** Optional event fields arrive as undefined; OTel rejects those, so drop them. */
function otelAttributes(fields: Record<string, string | number | boolean | undefined>): Attributes {
	const out: Attributes = {};
	for (const key in fields) {
		const value = fields[key];
		if (value !== undefined) out[key] = value;
	}
	return out;
}
