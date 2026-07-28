import { describe, expect, it } from "bun:test";
import { emptyAgentRunCoverage, emptyAgentRunSummary } from "@oh-my-pi/pi-agent-core";
import {
	AggregationTemporality,
	InMemoryMetricExporter,
	MeterProvider,
	PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { emitTelemetryEvent } from "../src/telemetry/events";
import { errorEventFromLog } from "../src/telemetry/init";
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
				// Present in the fixture on purpose: the assertions below prove the
				// default path drops it rather than that it was never there.
				email: "a@example.com",
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
		// Identity is opt-in: by default only a digest of the account key ships.
		expect(utilization?.dataPoints[0]?.attributes["aura.account.key"]).toBeUndefined();
		expect(utilization?.dataPoints[0]?.attributes["aura.account.email"]).toBeUndefined();
		expect(utilization?.dataPoints[0]?.attributes["aura.account.hash"]).toMatch(/^[0-9a-f]{12}$/);

		unregister();
		await provider.shutdown();
	});

	it("exports account email and key only when identity export is opted in", async () => {
		const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
		const provider = new MeterProvider({
			readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
		});
		const recorder = new AuraMetricRecorder(provider.getMeter("test"), { includeAccountIdentity: true });
		const unregister = registerOtlpSink({ recorder, emitLog: () => {} });

		emitTelemetryEvent({
			type: "usage_limit.snapshot",
			entry: {
				recordedAt: Date.now(),
				provider: "anthropic",
				accountKey: "acct-1",
				email: "a@example.com",
				limitId: "five_hour",
				label: "5 hour",
				windowLabel: "5h",
				usedFraction: 0.42,
			},
		});

		const metrics = await collect(exporter, provider);
		const attributes = metrics.find(m => m.descriptor.name === "aura.usage_limit.utilization")?.dataPoints[0]
			?.attributes;
		expect(attributes?.["aura.account.key"]).toBe("acct-1");
		expect(attributes?.["aura.account.email"]).toBe("a@example.com");
		expect(attributes?.["aura.account.hash"]).toBeUndefined();

		unregister();
		await provider.shutdown();
	});

	it("counts error.reported with phase attribute", async () => {
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

		emitTelemetryEvent({ type: "error.reported", phase: "session", errorType: "log_error", message: "boom" });

		const metrics = await collect(exporter, provider);
		const errors = metrics.find(m => m.descriptor.name === "aura.agent.errors");
		expect(errors).toBeDefined();
		expect(errors?.dataPoints[0]?.attributes["aura.error.phase"]).toBe("session");
		expect(errors?.dataPoints[0]?.attributes["error.type"]).toBe("log_error");
		// The logger sink already forwarded the log line; the event exists for counting.
		expect(logs).toHaveLength(0);

		unregister();
		await provider.shutdown();
	});

	it("stamps run-summary error types with chat/tool phase", async () => {
		const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
		const provider = new MeterProvider({
			readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
		});
		const recorder = new AuraMetricRecorder(provider.getMeter("test"));
		const unregister = registerOtlpSink({ recorder, emitLog: () => {} });

		emitTelemetryEvent({
			type: "turn.completed",
			sessionId: "s1",
			summary: {
				...emptyAgentRunSummary(),
				stepCount: 1,
				errors: { total: 3, byType: { tool_timeout: 1, error: 1, TypeError: 1 } },
			},
			coverage: emptyAgentRunCoverage(),
		});

		const metrics = await collect(exporter, provider);
		const errors = metrics.find(m => m.descriptor.name === "aura.agent.errors");
		const phases = errors?.dataPoints.map(p => [p.attributes["error.type"], p.attributes["aura.error.phase"]]);
		expect(phases).toContainEqual(["tool_timeout", "tool"]);
		expect(phases).toContainEqual(["error", "chat"]);
		// Thrown tool errors surface as JS class names; those attribute to the tool phase.
		expect(phases).toContainEqual(["TypeError", "tool"]);

		unregister();
		await provider.shutdown();
	});

	it("derives session-phase error events from error-level log records only", () => {
		expect(errorEventFromLog({ level: "warn", message: "careful", context: undefined, timestamp: new Date() })).toBe(
			undefined,
		);
		expect(errorEventFromLog({ level: "error", message: "boom", context: undefined, timestamp: new Date() })).toEqual(
			{
				type: "error.reported",
				phase: "session",
				errorType: "log_error",
				message: "boom",
			},
		);
		// A caller-supplied `code` is the error taxonomy; anything else falls back.
		expect(
			errorEventFromLog({ level: "error", message: "boom", context: { code: "acp_failed" }, timestamp: new Date() }),
		).toMatchObject({ errorType: "acp_failed" });
		expect(
			errorEventFromLog({ level: "error", message: "boom", context: { code: 42 }, timestamp: new Date() }),
		).toMatchObject({ errorType: "log_error" });
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
