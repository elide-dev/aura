/**
 * Compaction telemetry publishers.
 *
 * Pure mapping from compaction-end facts to a telemetry event (so the
 * classification is testable without an AgentSession), plus the snapcompact
 * savings recorder wrapper wired in `sdk.ts`.
 */

import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { SnapcompactSavingsRecorder } from "../../session/snapcompact-savings-journal";
import { type CompactionCompletedTelemetry, type CompactionTrigger, emitTelemetryEvent } from "../events";

export interface CompactionEndFacts {
	sessionId: string;
	trigger: CompactionTrigger;
	action: string;
	/** The compaction outcome, as carried by `auto_compaction_end`. */
	result: CompactionResult | undefined;
	aborted: boolean;
	willRetry: boolean;
	skipped: boolean | undefined;
	errorMessage: string | undefined;
	tokensAfter: number | undefined;
	durationMs: number;
}

/** Pure mapping from compaction-end facts to a telemetry event. */
export function compactionEndToTelemetry(facts: CompactionEndFacts): CompactionCompletedTelemetry {
	const outcome = facts.aborted
		? "aborted"
		: facts.willRetry
			? "will-retry"
			: facts.skipped
				? "skipped"
				: facts.errorMessage
					? "error"
					: "ok";
	return {
		type: "compaction.completed",
		sessionId: facts.sessionId,
		strategy: facts.action,
		trigger: facts.trigger,
		outcome,
		tokensBefore: facts.result?.tokensBefore,
		// A run that aborted/failed/skipped never rewrote history, so the "after"
		// reading describes the pre-compaction context and would report a bogus
		// effectiveness ratio.
		tokensAfter: outcome === "ok" ? facts.tokensAfter : undefined,
		durationMs: facts.durationMs,
		errorMessage: facts.errorMessage,
	};
}

/**
 * Session-scoped hooks a compaction publisher needs. Every one of these may
 * throw — `contextTokens()` walks the branch and re-estimates tokens — so the
 * publishers below treat them as untrusted and degrade to `undefined`.
 */
export interface CompactionTelemetryHost {
	sessionId: () => string;
	/** Current context tokens; `undefined` when unavailable OR unreadable. */
	contextTokens: () => number | undefined;
	/** Monotonic clock, injectable for tests. */
	now?: () => number;
}

/** Facts an `auto_compaction_end` session event carries. */
export type AutoCompactionEndFacts = Pick<
	CompactionEndFacts,
	"action" | "result" | "aborted" | "willRetry" | "skipped" | "errorMessage"
>;

/** Stopwatch + publisher for one session's automatic compaction runs. */
export interface AutoCompactionTelemetry {
	/** Called on `auto_compaction_start`. */
	start: (trigger: CompactionTrigger) => void;
	/** Called on `auto_compaction_end`; never throws. */
	end: (facts: AutoCompactionEndFacts) => void;
}

/**
 * Pair `auto_compaction_start` with its `auto_compaction_end` so the emitted
 * event carries the triggering reason and a measured duration.
 *
 * An end without a start (a run already in flight when telemetry attached)
 * still reports, with duration 0 and the default `threshold` trigger.
 */
export function createAutoCompactionTelemetry(host: CompactionTelemetryHost): AutoCompactionTelemetry {
	const now = host.now ?? (() => performance.now());
	let started: { at: number; trigger: CompactionTrigger } | undefined;
	return {
		start(trigger) {
			started = { at: now(), trigger };
		},
		end(facts) {
			const start = started;
			started = undefined;
			guarded(() => {
				emitTelemetryEvent(
					compactionEndToTelemetry({
						...facts,
						sessionId: host.sessionId(),
						trigger: start?.trigger ?? "threshold",
						tokensAfter: safeTokens(host),
						durationMs: start ? now() - start.at : 0,
					}),
				);
			});
		},
	};
}

/**
 * Run a manual compaction, publishing `compaction.completed` either way.
 *
 * The invariant this encodes: telemetry can never change what `compact()` does.
 * The result is returned and the original error re-thrown untouched, the token
 * reads are guarded (they run the estimator over the whole branch, so they CAN
 * throw), and the success-path emit deliberately sits outside the try that
 * observes `run()` — otherwise a telemetry throw would be reported as a failed
 * compaction and reject a call that actually succeeded.
 */
export async function withManualCompactionTelemetry(
	host: CompactionTelemetryHost & { strategy: () => string },
	run: () => Promise<CompactionResult>,
): Promise<CompactionResult> {
	const now = host.now ?? (() => performance.now());
	const startedAt = now();
	const tokensBefore = safeTokens(host);
	const emit = (event: Omit<CompactionCompletedTelemetry, "type" | "sessionId" | "trigger" | "durationMs">) => {
		guarded(() => {
			emitTelemetryEvent({
				type: "compaction.completed",
				sessionId: host.sessionId(),
				trigger: "manual",
				durationMs: now() - startedAt,
				...event,
			});
		});
	};

	let result: CompactionResult;
	try {
		result = await run();
	} catch (error) {
		emit({
			strategy: safeStrategy(host),
			outcome: "error",
			tokensBefore,
			errorMessage: error instanceof Error ? error.message : String(error),
		});
		// The ORIGINAL failure, never a telemetry-derived one.
		throw error;
	}
	emit({
		strategy: safeStrategy(host),
		outcome: "ok",
		tokensBefore: result.tokensBefore || tokensBefore,
		tokensAfter: safeTokens(host),
	});
	return result;
}

function safeTokens(host: CompactionTelemetryHost): number | undefined {
	try {
		return host.contextTokens();
	} catch (err) {
		logger.debug("context usage read for compaction telemetry failed", { err: String(err) });
		return undefined;
	}
}

function safeStrategy(host: { strategy: () => string }): string {
	try {
		return host.strategy();
	} catch (err) {
		logger.debug("compaction strategy read for telemetry failed", { err: String(err) });
		return "context-full";
	}
}

function guarded(emit: () => void): void {
	try {
		emit();
	} catch (err) {
		logger.debug("compaction telemetry emit failed", { err: String(err) });
	}
}

/**
 * Mirror snapcompact tool-result savings onto the telemetry bus, delegating the
 * durable record to `journal`.
 *
 * Wrapping OUTSIDE `createSnapcompactSavingsRecorder` is deliberate: the journal
 * skips runs with no session file (in-memory / SDK embedding), but those runs
 * still keep tokens off the wire and telemetry should observe them. The journal's
 * own toolCallId dedup is therefore not reachable from here, so this keeps its
 * own — the inline transformer reports EVERY imaged tool result on EVERY request,
 * and counting those repeats would inflate `aura.snapcompact.tokens_saved` by a
 * factor of the turn count.
 *
 * Never throws into the request path: a journal failure is logged at debug and
 * telemetry is emitted regardless.
 */
export function withSnapcompactSavingsTelemetry(journal: SnapcompactSavingsRecorder): SnapcompactSavingsRecorder {
	const counted = new Set<string>();
	return async (savings, model) => {
		try {
			await journal(savings, model);
		} catch (err) {
			logger.debug("snapcompact savings journal failed", { err: String(err) });
		}
		emitSnapcompactSavings(counted, savings, model);
	};
}

function emitSnapcompactSavings(
	counted: Set<string>,
	savings: ReadonlyArray<{ toolCallId: string; savedTokens: number }>,
	model: Model,
): void {
	for (const { toolCallId, savedTokens } of savings) {
		if (savedTokens <= 0 || counted.has(toolCallId)) continue;
		counted.add(toolCallId);
		emitTelemetryEvent({
			type: "compaction.savings",
			provider: model.provider,
			model: model.id,
			savedTokens,
		});
	}
}
