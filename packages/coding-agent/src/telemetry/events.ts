/**
 * Typed telemetry event bus.
 *
 * Subsystems publish operational events here without importing OTel; the OTLP
 * sink (sink-otlp.ts) is the sole subscriber in production. Emission is a
 * cheap no-op when nothing is subscribed, and subscriber failures never
 * propagate to publishers.
 */
import type { AgentRunCoverage, AgentRunSummary, ChatUsageEvent } from "@oh-my-pi/pi-agent-core";
import type { UsageHistoryEntry } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type {
	RuntimeErrorCode,
	RuntimeJvmAction,
	RuntimeLanguage,
	RuntimeMethod,
	RuntimeSpawnMode,
} from "../runtime/protocol";

export type SessionMode = "tui" | "acp" | "rpc" | "print" | "sdk";
export type CompactionTrigger = "threshold" | "overflow" | "idle" | "incomplete" | "manual";
/**
 * The compaction path that actually ran. Closed vocabulary, matching
 * `AutoCompactionEndEvent.action`: the manual path maps its `/compact`
 * subcommand through `COMPACT_MODES`, which only ever yields members of this
 * set, so both producers stay inside it and `aura.compaction.strategy` keeps a
 * bounded cardinality.
 */
export type CompactionStrategy = "context-full" | "handoff" | "shake" | "snapcompact";
export type CompactionOutcome = "ok" | "aborted" | "error" | "will-retry" | "skipped";
export type ErrorPhase = "chat" | "tool" | "compaction" | "session";

export type RuntimeCallOutcome = "ok" | "error" | "timeout" | "cancelled";
export type RuntimeCallErrorType = RuntimeErrorCode | "non_zero_exit" | "killed" | "unknown";

export interface RuntimeCallCompletedTelemetry {
	type: "runtime.call.completed";
	sessionId: string | undefined;
	method: RuntimeMethod;
	action?: RuntimeJvmAction | RuntimeSpawnMode;
	language?: RuntimeLanguage;
	outcome: RuntimeCallOutcome;
	durationMs: number;
	exitCode?: number;
	killed?: boolean;
	errorType?: RuntimeCallErrorType;
}

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
	/**
	 * Session the turn ran under, or `undefined` when the producer could not
	 * attribute it. The agent loop's `onRunEnd` hook carries no session identity,
	 * so this is stamped from {@link getActiveTelemetrySessionId}; consumers must
	 * treat `undefined` as "unattributed" rather than assuming a session.
	 */
	sessionId: string | undefined;
	summary: AgentRunSummary;
	coverage: AgentRunCoverage;
}

export interface ChatUsageTelemetry {
	type: "chat.usage";
	event: ChatUsageEvent;
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
	strategy: CompactionStrategy;
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
	| ErrorReportedTelemetry
	| CompactionCompletedTelemetry
	| CompactionSavingsTelemetry
	| RuntimeCallCompletedTelemetry
	| UsageLimitSnapshotTelemetry;

export type TelemetrySubscriber = (event: TelemetryEvent) => void;

/**
 * Session currently attributed with agent-loop activity in this process.
 *
 * The loop's run-level callbacks (`onRunEnd`) report aggregates with no session
 * identity attached, so the host stamps it here: single-session hosts (tui/rpc/
 * print) set it once after the session is created, and the ACP server — which
 * multiplexes many sessions over one process — sets it at each prompt turn,
 * where the owning session IS known. Concurrent prompts on two ACP sessions can
 * still race; the loser's turn is attributed to the other session rather than to
 * both, which keeps per-process totals honest.
 */
let activeSessionId: string | undefined;

/** Set (or clear, with `undefined`) the session that owns subsequent turns. */
export function setActiveTelemetrySessionId(sessionId: string | undefined): void {
	const trimmed = sessionId?.trim();
	activeSessionId = trimmed ? trimmed : undefined;
}

/** The session turn-level telemetry is currently attributed to, if any. */
export function getActiveTelemetrySessionId(): string | undefined {
	return activeSessionId;
}

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
