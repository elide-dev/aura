/**
 * Publishes session.started / session.ended telemetry.
 *
 * "Active" time is the sum of chat+tool latency reported by each completed
 * turn (turn.completed events on this same bus) — an approximation of in-turn
 * activity as opposed to wall-clock idle time.
 */
import type { SessionStats } from "../../session/agent-session-types";
import { emitTelemetryEvent, type SessionMode, subscribeTelemetry } from "../events";

export interface SessionLifecycleOptions {
	sessionId: string;
	mode: SessionMode;
	resumed: boolean;
	getStats: () => SessionStats;
}

export interface SessionLifecycleTracker {
	/** Emits session.ended exactly once; later calls are no-ops. */
	end(reason: string): void;
}

export function trackSessionLifecycle(options: SessionLifecycleOptions): SessionLifecycleTracker {
	const startedAt = performance.now();
	let activeMs = 0;
	let ended = false;

	const unsubscribe = subscribeTelemetry(event => {
		if (event.type !== "turn.completed") return;
		activeMs += (event.summary.chats?.totalLatencyMs ?? 0) + (event.summary.tools?.totalLatencyMs ?? 0);
	});

	emitTelemetryEvent({
		type: "session.started",
		sessionId: options.sessionId,
		mode: options.mode,
		resumed: options.resumed,
	});

	return {
		end(reason: string): void {
			if (ended) return;
			ended = true;
			unsubscribe();
			let stats: SessionStats | undefined;
			try {
				stats = options.getStats();
			} catch {
				stats = undefined;
			}
			emitTelemetryEvent({
				type: "session.ended",
				sessionId: options.sessionId,
				mode: options.mode,
				durationMs: performance.now() - startedAt,
				activeMs,
				turns: stats?.userMessages ?? 0,
				tokens: {
					input: stats?.tokens.input ?? 0,
					output: stats?.tokens.output ?? 0,
					cacheRead: stats?.tokens.cacheRead ?? 0,
					cacheWrite: stats?.tokens.cacheWrite ?? 0,
					total: stats?.tokens.total ?? 0,
				},
				estimatedCostUsd: stats?.cost ?? 0,
				endReason: reason,
			});
		},
	};
}
