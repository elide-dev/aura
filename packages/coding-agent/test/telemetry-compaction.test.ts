import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { emitTelemetryEvent, subscribeTelemetry, type TelemetryEvent } from "../src/telemetry/events";
import { compactionEndToTelemetry, withSnapcompactSavingsTelemetry } from "../src/telemetry/publishers/compaction";
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
