import { describe, expect, it } from "bun:test";
import {
	AggregationTemporality,
	InMemoryMetricExporter,
	MeterProvider,
	PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { emitTelemetryEvent } from "../src/telemetry/events";
import { AuraMetricRecorder } from "../src/telemetry/metrics";
import { registerOtlpSink } from "../src/telemetry/sink-otlp";

async function collect(exporter: InMemoryMetricExporter, provider: MeterProvider) {
	await provider.forceFlush();
	return exporter.getMetrics().flatMap(rm => rm.scopeMetrics.flatMap(sm => sm.metrics));
}

describe("otlp sink", () => {
	it("maps session.ended and compaction.completed events to aura.* instruments", async () => {
		const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
		const provider = new MeterProvider({
			readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
		});
		const recorder = new AuraMetricRecorder(provider.getMeter("test"));
		const logs: Array<{ eventName: string }> = [];
		const unregister = registerOtlpSink({
			recorder,
			emitLog: (_level, _body, _attrs, eventName) => logs.push({ eventName }),
		});

		emitTelemetryEvent({
			type: "session.ended",
			sessionId: "s1",
			mode: "print",
			durationMs: 120_000,
			activeMs: 30_000,
			turns: 4,
			tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
			estimatedCostUsd: 0.02,
			endReason: "exit",
		});
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

		const metrics = await collect(exporter, provider);
		const names = metrics.map(m => m.descriptor.name);
		expect(names).toContain("aura.session.duration");
		expect(names).toContain("aura.session.turns");
		expect(names).toContain("aura.compaction.count");
		expect(names).toContain("aura.compaction.tokens_saved");
		expect(names).toContain("aura.compaction.effectiveness");
		expect(logs.map(l => l.eventName)).toContain("aura.session.ended");
		expect(logs.map(l => l.eventName)).toContain("aura.compaction.completed");

		const effectiveness = metrics.find(m => m.descriptor.name === "aura.compaction.effectiveness");
		// 1 - 20000/100000 = 0.8
		expect((effectiveness?.dataPoints[0]?.value as { sum?: number })?.sum).toBeCloseTo(0.8);

		unregister();
		await provider.shutdown();
	});

	it("records usage-limit utilization and snapcompact savings", async () => {
		const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
		const provider = new MeterProvider({
			readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
		});
		const recorder = new AuraMetricRecorder(provider.getMeter("test"));
		const unregister = registerOtlpSink({ recorder, emitLog: () => {} });

		emitTelemetryEvent({
			type: "compaction.savings",
			provider: "anthropic",
			model: "claude-haiku-4-5",
			savedTokens: 4_200,
		});
		emitTelemetryEvent({
			type: "usage_limit.snapshot",
			entry: {
				recordedAt: Date.now(),
				provider: "anthropic",
				accountKey: "acct-1",
				limitId: "five_hour",
				label: "5 hour",
				windowLabel: "5h",
				usedFraction: 0.42,
			},
		});

		const metrics = await collect(exporter, provider);
		const names = metrics.map(m => m.descriptor.name);
		expect(names).toContain("aura.snapcompact.tokens_saved");
		expect(names).toContain("aura.usage_limit.utilization");
		const utilization = metrics.find(m => m.descriptor.name === "aura.usage_limit.utilization");
		expect(utilization?.dataPoints[0]?.value).toBeCloseTo(0.42);
		expect(utilization?.dataPoints[0]?.attributes["aura.usage_limit.id"]).toBe("five_hour");

		unregister();
		await provider.shutdown();
	});

	it("never lets sink failures reach the publisher", () => {
		const unregister = registerOtlpSink({
			emitLog: () => {
				throw new Error("boom");
			},
		});
		expect(() =>
			emitTelemetryEvent({ type: "session.started", sessionId: "s1", mode: "tui", resumed: false }),
		).not.toThrow();
		unregister();
	});
});
