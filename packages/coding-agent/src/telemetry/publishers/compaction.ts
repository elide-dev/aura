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
