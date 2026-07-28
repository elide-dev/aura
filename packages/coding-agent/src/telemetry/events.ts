/**
 * Typed telemetry event bus.
 *
 * Subsystems publish operational events here without importing OTel; the OTLP
 * sink (sink-otlp.ts) is the sole subscriber in production. Emission is a
 * cheap no-op when nothing is subscribed, and subscriber failures never
 * propagate to publishers.
 */
import type { AgentRunCoverage, AgentRunSummary, ChatUsageEvent, CostDelta } from "@oh-my-pi/pi-agent-core";
import type { UsageHistoryEntry } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";

export type SessionMode = "tui" | "acp" | "rpc" | "print" | "sdk";
export type CompactionTrigger = "threshold" | "overflow" | "idle" | "incomplete" | "manual";
export type CompactionOutcome = "ok" | "aborted" | "error" | "will-retry" | "skipped";
export type ErrorPhase = "chat" | "tool" | "compaction" | "session";

export interface SessionStartedTelemetry {
	type: "session.started";
	sessionId: string;
	mode: SessionMode;
	resumed: boolean;
}

export interface SessionEndedTelemetry {
	type: "session.ended";
	sessionId: string;
	mode: SessionMode;
	/** Wall-clock ms from session.started to end. */
	durationMs: number;
	/** Accumulated chat+tool latency ms across turns (in-turn activity). */
	activeMs: number;
	turns: number;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	estimatedCostUsd: number;
	endReason: string;
}

export interface TurnCompletedTelemetry {
	type: "turn.completed";
	summary: AgentRunSummary;
	coverage: AgentRunCoverage;
}

export interface ChatUsageTelemetry {
	type: "chat.usage";
	event: ChatUsageEvent;
}

export interface CostDeltaTelemetry {
	type: "cost.delta";
	delta: CostDelta;
}

export interface ErrorReportedTelemetry {
	type: "error.reported";
	phase: ErrorPhase;
	errorType: string;
	message: string;
}

export interface CompactionCompletedTelemetry {
	type: "compaction.completed";
	sessionId: string;
	strategy: string;
	trigger: CompactionTrigger;
	outcome: CompactionOutcome;
	tokensBefore?: number;
	tokensAfter?: number;
	durationMs: number;
	errorMessage?: string;
}

export interface CompactionSavingsTelemetry {
	type: "compaction.savings";
	provider: string;
	model: string;
	savedTokens: number;
}

export interface UsageLimitSnapshotTelemetry {
	type: "usage_limit.snapshot";
	entry: UsageHistoryEntry;
}

export type TelemetryEvent =
	| SessionStartedTelemetry
	| SessionEndedTelemetry
	| TurnCompletedTelemetry
	| ChatUsageTelemetry
	| CostDeltaTelemetry
	| ErrorReportedTelemetry
	| CompactionCompletedTelemetry
	| CompactionSavingsTelemetry
	| UsageLimitSnapshotTelemetry;

export type TelemetrySubscriber = (event: TelemetryEvent) => void;

const subscribers = new Set<TelemetrySubscriber>();

/** Register a subscriber; returns a disposer. */
export function subscribeTelemetry(subscriber: TelemetrySubscriber): () => void {
	subscribers.add(subscriber);
	return () => {
		subscribers.delete(subscriber);
	};
}

/** Publish an event. No-op without subscribers; subscriber throws are swallowed. */
export function emitTelemetryEvent(event: TelemetryEvent): void {
	if (subscribers.size === 0) return;
	for (const subscriber of subscribers) {
		try {
			subscriber(event);
		} catch (error) {
			logger.debug("telemetry subscriber failed", { type: event.type, error: String(error) });
		}
	}
}
