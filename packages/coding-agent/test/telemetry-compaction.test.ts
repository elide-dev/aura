import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
	type CompactionCompletedTelemetry,
	emitTelemetryEvent,
	subscribeTelemetry,
	type TelemetryEvent,
} from "../src/telemetry/events";
import {
	compactionEndToTelemetry,
	createAutoCompactionTelemetry,
	withManualCompactionTelemetry,
	withSnapcompactSavingsTelemetry,
} from "../src/telemetry/publishers/compaction";
import { registerOtlpSink } from "../src/telemetry/sink-otlp";

describe("compaction telemetry mapping", () => {
	it("maps a successful auto_compaction_end to outcome ok with token counts", () => {
		const event = compactionEndToTelemetry({
			sessionId: "s1",
			trigger: "threshold",
			action: "context-full",
			result: { summary: "sum", firstKeptEntryId: "e1", tokensBefore: 100_000 },
			aborted: false,
			willRetry: false,
			skipped: false,
			errorMessage: undefined,
			tokensAfter: 20_000,
			durationMs: 1234,
		});
		expect(event).toMatchObject({
			type: "compaction.completed",
			strategy: "context-full",
			trigger: "threshold",
			outcome: "ok",
			tokensBefore: 100_000,
			tokensAfter: 20_000,
			durationMs: 1234,
		});
	});

	it("classifies aborted, will-retry, skipped, and error outcomes", () => {
		const base = {
			sessionId: "s1",
			trigger: "overflow" as const,
			action: "context-full" as const,
			result: undefined,
			aborted: false,
			willRetry: false,
			skipped: false,
			errorMessage: undefined,
			tokensAfter: undefined,
			durationMs: 10,
		};
		expect(compactionEndToTelemetry({ ...base, aborted: true }).outcome).toBe("aborted");
		expect(compactionEndToTelemetry({ ...base, willRetry: true }).outcome).toBe("will-retry");
		expect(compactionEndToTelemetry({ ...base, skipped: true }).outcome).toBe("skipped");
		expect(compactionEndToTelemetry({ ...base, errorMessage: "boom" }).outcome).toBe("error");
	});

	it("drops tokensAfter for non-ok outcomes", () => {
		const event = compactionEndToTelemetry({
			sessionId: "s1",
			trigger: "threshold",
			action: "handoff",
			result: { summary: "s", firstKeptEntryId: "e", tokensBefore: 900 },
			aborted: true,
			willRetry: false,
			skipped: false,
			errorMessage: undefined,
			tokensAfter: 400,
			durationMs: 5,
		});
		expect(event.tokensAfter).toBeUndefined();
		expect(event.tokensBefore).toBe(900);
	});
});

const testModel = { provider: "anthropic", id: "claude-haiku-4-5" } as unknown as Model;

describe("snapcompact savings telemetry wrapper", () => {
	function capture(): { events: TelemetryEvent[]; dispose: () => void } {
		const events: TelemetryEvent[] = [];
		const dispose = subscribeTelemetry(event => events.push(event));
		return { events, dispose };
	}

	it("emits one savings event per newly imaged tool result and still journals", async () => {
		const { events, dispose } = capture();
		const journaled: Array<{ toolCallId: string; savedTokens: number }> = [];
		const record = withSnapcompactSavingsTelemetry(async savings => {
			journaled.push(...savings);
		});

		await record([{ toolCallId: "t1", savedTokens: 100 }], testModel);

		expect(journaled).toEqual([{ toolCallId: "t1", savedTokens: 100 }]);
		expect(events).toEqual([
			{ type: "compaction.savings", provider: "anthropic", model: "claude-haiku-4-5", savedTokens: 100 },
		]);
		dispose();
	});

	it("does not double count a tool result re-imaged on later requests", async () => {
		const { events, dispose } = capture();
		const record = withSnapcompactSavingsTelemetry(async () => {});

		await record([{ toolCallId: "t1", savedTokens: 100 }], testModel);
		await record(
			[
				{ toolCallId: "t1", savedTokens: 100 },
				{ toolCallId: "t2", savedTokens: 50 },
			],
			testModel,
		);
		await record([{ toolCallId: "t3", savedTokens: 0 }], testModel);

		expect(events.map(e => (e.type === "compaction.savings" ? e.savedTokens : -1))).toEqual([100, 50]);
		dispose();
	});

	it("never lets a journal failure reach the request path, and still emits telemetry", async () => {
		const { events, dispose } = capture();
		const record = withSnapcompactSavingsTelemetry(async () => {
			throw new Error("journal down");
		});

		await record([{ toolCallId: "t1", savedTokens: 7 }], testModel);

		expect(events).toHaveLength(1);
		dispose();
	});
});

describe("compaction span synthesis", () => {
	it("synthesizes a retroactive aura.compaction span when trace export is live", async () => {
		const exporter = new InMemorySpanExporter();
		const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
		trace.disable();
		trace.setGlobalTracerProvider(provider);
		const unregister = registerOtlpSink({ emitLog: () => {}, traceEnabled: true });

		emitTelemetryEvent({
			type: "compaction.completed",
			sessionId: "s1",
			strategy: "context-full",
			trigger: "threshold",
			outcome: "ok",
			tokensBefore: 100_000,
			tokensAfter: 20_000,
			durationMs: 900,
		});

		await provider.forceFlush();
		const spans = exporter.getFinishedSpans();
		expect(spans.map(s => s.name)).toEqual(["aura.compaction"]);
		const span = spans[0];
		expect(span?.attributes["aura.compaction.strategy"]).toBe("context-full");
		expect(span?.attributes["aura.compaction.trigger"]).toBe("threshold");
		expect(span?.attributes["aura.compaction.outcome"]).toBe("ok");
		expect(span?.attributes["aura.compaction.tokens_before"]).toBe(100_000);
		expect(span?.attributes["aura.compaction.tokens_after"]).toBe(20_000);
		expect(span?.attributes["session.id"]).toBe("s1");

		unregister();
		await provider.shutdown();
		trace.disable();
	});

	it("marks error outcomes and skips span synthesis without trace export", async () => {
		const exporter = new InMemorySpanExporter();
		const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
		trace.disable();
		trace.setGlobalTracerProvider(provider);

		const withoutTraces = registerOtlpSink({ emitLog: () => {} });
		emitTelemetryEvent({
			type: "compaction.completed",
			sessionId: "s1",
			strategy: "context-full",
			trigger: "manual",
			outcome: "error",
			durationMs: 10,
			errorMessage: "boom",
		});
		withoutTraces();
		expect(exporter.getFinishedSpans()).toHaveLength(0);

		const withTraces = registerOtlpSink({ emitLog: () => {}, traceEnabled: true });
		emitTelemetryEvent({
			type: "compaction.completed",
			sessionId: "s1",
			strategy: "context-full",
			trigger: "manual",
			outcome: "error",
			durationMs: 10,
			errorMessage: "boom",
		});
		withTraces();

		await provider.forceFlush();
		const spans = exporter.getFinishedSpans();
		expect(spans).toHaveLength(1);
		expect(spans[0]?.status.code).toBe(2 /* SpanStatusCode.ERROR */);
		expect(spans[0]?.status.message).toBe("boom");

		await provider.shutdown();
		trace.disable();
	});
});

/** Collect compaction.completed events published while `run` executes. */
async function captureCompactions(run: () => Promise<void> | void): Promise<CompactionCompletedTelemetry[]> {
	const events: CompactionCompletedTelemetry[] = [];
	const dispose = subscribeTelemetry(event => {
		if (event.type === "compaction.completed") events.push(event);
	});
	try {
		await run();
	} finally {
		dispose();
	}
	return events;
}

describe("auto compaction publisher", () => {
	it("pairs start with end, carrying the start trigger and the measured duration", async () => {
		let clock = 1_000;
		const telemetry = createAutoCompactionTelemetry({
			sessionId: () => "s1",
			contextTokens: () => 18_000,
			now: () => clock,
		});

		const events = await captureCompactions(() => {
			telemetry.start("overflow");
			clock = 1_450;
			telemetry.end({
				action: "context-full",
				result: { summary: "s", firstKeptEntryId: "e", tokensBefore: 90_000 },
				aborted: false,
				willRetry: false,
				skipped: false,
				errorMessage: undefined,
			});
		});

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			trigger: "overflow",
			strategy: "context-full",
			outcome: "ok",
			tokensBefore: 90_000,
			// Read AFTER the rewrite, so it reflects the compacted context.
			tokensAfter: 18_000,
			durationMs: 450,
		});
	});

	it("reports an end with no matching start, and never reuses a consumed start", async () => {
		const telemetry = createAutoCompactionTelemetry({
			sessionId: () => "s1",
			contextTokens: () => undefined,
			now: () => 0,
		});
		const end = {
			action: "shake" as const,
			result: undefined,
			aborted: false,
			willRetry: false,
			skipped: true,
			errorMessage: undefined,
		};

		const events = await captureCompactions(() => {
			telemetry.start("idle");
			telemetry.end(end);
			telemetry.end(end);
		});

		expect(events.map(e => e.trigger)).toEqual(["idle", "threshold"]);
		expect(events.every(e => e.durationMs === 0)).toBe(true);
	});

	it("swallows a failing context read rather than breaking the session-event dispatcher", async () => {
		const telemetry = createAutoCompactionTelemetry({
			sessionId: () => "s1",
			contextTokens: () => {
				throw new Error("estimator blew up");
			},
			now: () => 0,
		});

		const events = await captureCompactions(() => {
			telemetry.start("threshold");
			expect(() =>
				telemetry.end({
					action: "context-full",
					result: { summary: "s", firstKeptEntryId: "e", tokensBefore: 5 },
					aborted: false,
					willRetry: false,
					skipped: false,
					errorMessage: undefined,
				}),
			).not.toThrow();
		});

		expect(events).toHaveLength(1);
		expect(events[0]?.tokensAfter).toBeUndefined();
	});
});

describe("manual compaction publisher", () => {
	const result = { summary: "s", firstKeptEntryId: "e", tokensBefore: 80_000 };

	it("emits ok with before/after tokens and the resolved strategy", async () => {
		let clock = 0;
		let tokens = 80_000;
		const events = await captureCompactions(async () => {
			const returned = await withManualCompactionTelemetry(
				{
					sessionId: () => "s1",
					contextTokens: () => tokens,
					strategy: () => "snapcompact",
					now: () => clock,
				},
				async () => {
					clock = 700;
					tokens = 12_000;
					return result;
				},
			);
			expect(returned).toBe(result);
		});

		expect(events).toEqual([
			{
				type: "compaction.completed",
				sessionId: "s1",
				trigger: "manual",
				strategy: "snapcompact",
				outcome: "ok",
				tokensBefore: 80_000,
				tokensAfter: 12_000,
				durationMs: 700,
			},
		]);
	});

	it("re-throws the ORIGINAL error instance and emits outcome error", async () => {
		const failure = new Error("Nothing to compact (session too small)");
		let thrown: unknown;

		const events = await captureCompactions(async () => {
			try {
				await withManualCompactionTelemetry(
					{
						sessionId: () => "s1",
						contextTokens: () => 42,
						strategy: () => "context-full",
						now: () => 0,
					},
					async () => {
						throw failure;
					},
				);
			} catch (err) {
				thrown = err;
			}
		});

		expect(thrown).toBe(failure);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			outcome: "error",
			trigger: "manual",
			tokensBefore: 42,
			errorMessage: "Nothing to compact (session too small)",
		});
		expect(events[0]?.tokensAfter).toBeUndefined();
	});

	it("still returns the result when the post-success context read throws", async () => {
		let compacted = false;
		const events = await captureCompactions(async () => {
			const returned = await withManualCompactionTelemetry(
				{
					sessionId: () => "s1",
					contextTokens: () => {
						// Mirrors getContextUsage() re-estimating the whole branch: cheap
						// before, and blowing up on the rewritten history afterwards.
						if (compacted) throw new Error("estimator blew up");
						return 80_000;
					},
					strategy: () => "context-full",
					now: () => 0,
				},
				async () => {
					compacted = true;
					return result;
				},
			);
			expect(returned).toBe(result);
		});

		expect(events).toHaveLength(1);
		expect(events[0]?.outcome).toBe("ok");
		expect(events[0]?.tokensAfter).toBeUndefined();
	});

	it("never lets a subscriber or sessionId failure reject a successful compact", async () => {
		const dispose = subscribeTelemetry(() => {
			throw new Error("subscriber exploded");
		});
		try {
			const returned = await withManualCompactionTelemetry(
				{
					sessionId: () => {
						throw new Error("no session");
					},
					contextTokens: () => 1,
					strategy: () => "context-full",
					now: () => 0,
				},
				async () => result,
			);
			expect(returned).toBe(result);
		} finally {
			dispose();
		}
	});
});
