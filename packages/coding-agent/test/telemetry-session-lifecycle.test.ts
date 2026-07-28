import { describe, expect, it } from "bun:test";
import type { SessionStats } from "../src/session/agent-session-types";
import { emitTelemetryEvent, subscribeTelemetry, type TelemetryEvent } from "../src/telemetry/events";
import { trackSessionLifecycle } from "../src/telemetry/publishers/session-lifecycle";

const stats: SessionStats = {
	sessionFile: undefined,
	sessionId: "s1",
	userMessages: 3,
	assistantMessages: 3,
	toolCalls: 5,
	toolResults: 5,
	totalMessages: 11,
	tokens: { input: 1000, output: 400, reasoning: 0, cacheRead: 200, cacheWrite: 100, total: 1400 },
	premiumRequests: 0,
	cost: 0.05,
};

describe("session lifecycle publisher", () => {
	it("emits started immediately and ended exactly once with stats totals", () => {
		const seen: TelemetryEvent[] = [];
		const unsubscribe = subscribeTelemetry(e => seen.push(e));
		try {
			const tracker = trackSessionLifecycle({
				sessionId: "s1",
				mode: "tui",
				resumed: true,
				getStats: () => stats,
			});

			// a completed turn accumulates active time
			emitTelemetryEvent({
				type: "turn.completed",
				sessionId: undefined,
				summary: { chats: { totalLatencyMs: 2000 }, tools: { totalLatencyMs: 500 } } as never,
				coverage: {} as never,
			});

			tracker.end("exit");
			tracker.end("exit"); // duplicate must not re-emit

			const started = seen.filter(e => e.type === "session.started");
			const ended = seen.filter(e => e.type === "session.ended");
			expect(started).toHaveLength(1);
			expect(started[0]).toMatchObject({ sessionId: "s1", mode: "tui", resumed: true });
			expect(ended).toHaveLength(1);
			expect(ended[0]).toMatchObject({
				sessionId: "s1",
				turns: 3, // userMessages
				activeMs: 2500,
				estimatedCostUsd: 0.05,
				endReason: "exit",
				tokens: { input: 1000, output: 400, cacheRead: 200, cacheWrite: 100, total: 1400 },
			});
		} finally {
			unsubscribe();
		}
	});

	it("still emits session.ended when getStats() throws", () => {
		const seen: TelemetryEvent[] = [];
		const unsubscribe = subscribeTelemetry(e => seen.push(e));
		try {
			const tracker = trackSessionLifecycle({
				sessionId: "s2",
				mode: "print",
				resumed: false,
				getStats: () => {
					throw new Error("boom");
				},
			});
			expect(() => tracker.end("crash")).not.toThrow();

			const ended = seen.filter(e => e.type === "session.ended");
			expect(ended).toHaveLength(1);
			expect(ended[0]).toMatchObject({
				sessionId: "s2",
				mode: "print",
				turns: 0,
				estimatedCostUsd: 0,
				endReason: "crash",
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			});
		} finally {
			unsubscribe();
		}
	});

	it("stops accumulating turn latency after end()", () => {
		const seen: TelemetryEvent[] = [];
		const unsubscribe = subscribeTelemetry(e => seen.push(e));
		try {
			const tracker = trackSessionLifecycle({
				sessionId: "s3",
				mode: "rpc",
				resumed: false,
				getStats: () => stats,
			});
			tracker.end("exit");
			emitTelemetryEvent({
				type: "turn.completed",
				sessionId: undefined,
				summary: { chats: { totalLatencyMs: 900 }, tools: { totalLatencyMs: 100 } } as never,
				coverage: {} as never,
			});

			const ended = seen.filter(e => e.type === "session.ended");
			expect(ended).toHaveLength(1);
			expect(ended[0]).toMatchObject({ activeMs: 0 });
		} finally {
			unsubscribe();
		}
	});

	it("scopes activeMs to its own sessionId (unattributed turns still count)", () => {
		const seen: TelemetryEvent[] = [];
		const unsubscribe = subscribeTelemetry(e => seen.push(e));
		try {
			const tracker = trackSessionLifecycle({
				sessionId: "s4",
				mode: "acp",
				resumed: false,
				getStats: () => stats,
			});

			emitTurn("other-session", 300, 200); // foreign: must not inflate
			emitTurn("s4", 100, 0); // own turn
			emitTurn(undefined, 50, 0); // unattributed: backward-safe, counts

			tracker.end("acp_session_disposed");

			const ended = seen.filter(e => e.type === "session.ended");
			expect(ended).toHaveLength(1);
			expect(ended[0]).toMatchObject({ sessionId: "s4", mode: "acp", activeMs: 150 });
		} finally {
			unsubscribe();
		}
	});

	it("keeps concurrent trackers independent", () => {
		const seen: TelemetryEvent[] = [];
		const unsubscribe = subscribeTelemetry(e => seen.push(e));
		try {
			const a = trackSessionLifecycle({ sessionId: "a", mode: "acp", resumed: false, getStats: () => stats });
			const b = trackSessionLifecycle({ sessionId: "b", mode: "acp", resumed: true, getStats: () => stats });

			emitTurn("a", 10, 5);
			emitTurn("b", 1000, 0);

			a.end("closed");
			b.end("closed");

			const ended = seen.filter(e => e.type === "session.ended");
			expect(ended.map(e => (e.type === "session.ended" ? [e.sessionId, e.activeMs] : []))).toEqual([
				["a", 15],
				["b", 1000],
			]);
		} finally {
			unsubscribe();
		}
	});
});

function emitTurn(sessionId: string | undefined, chatMs: number, toolMs: number): void {
	emitTelemetryEvent({
		type: "turn.completed",
		sessionId,
		summary: { chats: { totalLatencyMs: chatMs }, tools: { totalLatencyMs: toolMs } } as never,
		coverage: {} as never,
	});
}
