/**
 * Aura's OTel metric instruments.
 *
 * The recorder owns every instrument the agent reports and is the only place
 * `aura.*` metric names are minted. It is driven exclusively by the OTLP sink
 * (sink-otlp.ts) reading the telemetry event bus, so publishers never touch
 * OpenTelemetry directly. Instruments are created once per meter; a recorder is
 * only constructed when a real MeterProvider is registered.
 */
import type { AgentRunCoverage, AgentRunSummary, ChatUsageEvent, ToolStatus } from "@oh-my-pi/pi-agent-core";
import type { Attributes, Counter, Gauge, Histogram, Meter } from "@opentelemetry/api";
import type {
	CompactionCompletedTelemetry,
	CompactionSavingsTelemetry,
	SessionEndedTelemetry,
	UsageLimitSnapshotTelemetry,
} from "./events";

const TOOL_STATUSES = ["ok", "error", "skipped", "blocked", "timeout", "aborted"] satisfies readonly ToolStatus[];

export class AuraMetricRecorder {
	readonly #tokenUsage: Histogram<Attributes>;
	readonly #chatCostUsd: Counter<Attributes>;
	readonly #runs: Counter<Attributes>;
	readonly #steps: Counter<Attributes>;
	readonly #chatCalls: Counter<Attributes>;
	readonly #chatDurationMs: Histogram<Attributes>;
	readonly #toolCalls: Counter<Attributes>;
	readonly #toolDurationMs: Histogram<Attributes>;
	readonly #errors: Counter<Attributes>;
	readonly #sessionDuration: Histogram<Attributes>;
	readonly #sessionTurns: Histogram<Attributes>;
	readonly #compactions: Counter<Attributes>;
	readonly #compactionTokensSaved: Counter<Attributes>;
	readonly #compactionDuration: Histogram<Attributes>;
	readonly #compactionEffectiveness: Histogram<Attributes>;
	readonly #snapcompactTokensSaved: Counter<Attributes>;
	readonly #usageLimitUtilization: Gauge<Attributes>;

	constructor(meter: Meter) {
		this.#tokenUsage = meter.createHistogram("gen_ai.client.token.usage", {
			description: "Token usage reported by GenAI chat calls.",
			unit: "{token}",
		});
		this.#chatCostUsd = meter.createCounter("aura.agent.chat.cost.estimated_usd", {
			description: "Estimated USD cost for completed chat calls.",
			unit: "USD",
		});
		this.#runs = meter.createCounter("aura.agent.runs", {
			description: "Completed agent runs.",
			unit: "{run}",
		});
		this.#steps = meter.createCounter("aura.agent.steps", {
			description: "Agent loop steps completed inside a run.",
			unit: "{step}",
		});
		this.#chatCalls = meter.createCounter("aura.agent.chat.calls", {
			description: "Chat calls completed inside agent runs.",
			unit: "{call}",
		});
		this.#chatDurationMs = meter.createHistogram("aura.agent.chat.duration", {
			description: "Total chat latency observed in an agent run.",
			unit: "ms",
		});
		this.#toolCalls = meter.createCounter("aura.agent.tool.calls", {
			description: "Tool calls completed inside agent runs.",
			unit: "{call}",
		});
		this.#toolDurationMs = meter.createHistogram("aura.agent.tool.duration", {
			description: "Total tool latency observed in an agent run.",
			unit: "ms",
		});
		this.#errors = meter.createCounter("aura.agent.errors", {
			description: "Errors observed in chat and tool execution.",
			unit: "{error}",
		});
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
	}

	recordChatUsage(event: ChatUsageEvent): void {
		const baseAttrs = metricAttributes({
			"gen_ai.operation.name": "chat",
			"gen_ai.provider.name": event.provider,
			"gen_ai.request.model": event.model,
			"gen_ai.response.service_tier": event.serviceTier,
			"aura.agent.id": event.agent?.id,
			"aura.agent.name": event.agent?.name,
		});

		this.#recordToken(event.usage.inputTokens, baseAttrs, "input");
		this.#recordToken(event.usage.outputTokens, baseAttrs, "output");
		this.#recordToken(event.usage.totalTokens, baseAttrs, "total");
		this.#recordToken(event.usage.cachedInputTokens, baseAttrs, "cache_read_input");
		this.#recordToken(event.usage.cacheWriteTokens, baseAttrs, "cache_write_input");
		this.#recordToken(event.usage.reasoningOutputTokens, baseAttrs, "reasoning_output");

		if (event.cost && "usd" in event.cost && event.cost.usd > 0) {
			this.#chatCostUsd.add(event.cost.usd, baseAttrs);
		}
	}

	recordRun(summary: AgentRunSummary, coverage: AgentRunCoverage): void {
		const runAttrs = metricAttributes({
			"aura.agent.models_used.count": coverage.modelsUsed.length,
			"aura.agent.providers_used.count": coverage.providersUsed.length,
			"aura.agent.tools_available.count": coverage.toolsAvailable.length,
			"aura.agent.tools_invoked.count": coverage.toolsInvoked.length,
			"aura.agent.tools_unused.count": coverage.toolsUnused.length,
		});

		this.#runs.add(1, runAttrs);
		if (summary.stepCount > 0) this.#steps.add(summary.stepCount, runAttrs);
		if (summary.chats.totalLatencyMs > 0) this.#chatDurationMs.record(summary.chats.totalLatencyMs, runAttrs);

		for (const reason in summary.chats.byStopReason) {
			const count = summary.chats.byStopReason[reason];
			if (count > 0)
				this.#chatCalls.add(count, metricAttributes({ ...runAttrs, "gen_ai.response.finish_reason": reason }));
		}
		for (const toolName in summary.tools.byName) {
			const counters = summary.tools.byName[toolName];
			const toolAttrs = metricAttributes({ ...runAttrs, "gen_ai.tool.name": toolName });
			if (counters.totalLatencyMs > 0) this.#toolDurationMs.record(counters.totalLatencyMs, toolAttrs);
			for (const status of TOOL_STATUSES) {
				const count = counters[status];
				if (count > 0) this.#toolCalls.add(count, metricAttributes({ ...toolAttrs, "aura.tool.status": status }));
			}
		}
		for (const errorType in summary.errors.byType) {
			const count = summary.errors.byType[errorType];
			if (count > 0) this.#errors.add(count, metricAttributes({ ...runAttrs, "error.type": errorType }));
		}
	}

	recordSessionEnd(event: SessionEndedTelemetry): void {
		const attrs = metricAttributes({
			"aura.session.mode": event.mode,
			"aura.session.end_reason": event.endReason,
		});
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
			this.#compactionEffectiveness.record(
				Math.min(1, Math.max(0, 1 - event.tokensAfter / event.tokensBefore)),
				attrs,
			);
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
		this.#usageLimitUtilization.record(
			entry.usedFraction,
			metricAttributes({
				"gen_ai.provider.name": entry.provider,
				"aura.usage_limit.id": entry.limitId,
				"aura.usage_limit.window": entry.windowLabel,
				"aura.account.key": entry.accountKey,
			}),
		);
	}

	recordError(phase: string, errorType: string): void {
		this.#errors.add(1, metricAttributes({ "error.type": errorType, "aura.error.phase": phase }));
	}

	#recordToken(value: number | undefined, baseAttrs: Attributes, tokenType: string): void {
		if (!value || value <= 0) return;
		this.#tokenUsage.record(value, metricAttributes({ ...baseAttrs, "gen_ai.token.type": tokenType }));
	}
}

/** Drop null/undefined and coerce non-primitives so OTel never sees an invalid attribute value. */
export function metricAttributes(fields: Readonly<Record<string, unknown>>): Attributes {
	const out: Attributes = {};
	for (const key in fields) {
		const value = fields[key];
		if (value === undefined || value === null) continue;
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			out[key] = value;
			continue;
		}
		const text = String(value);
		if (text.length > 0) out[key] = text;
	}
	return out;
}
