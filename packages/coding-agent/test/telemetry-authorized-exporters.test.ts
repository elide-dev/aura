import { describe, expect, it } from "bun:test";
import { ExportResultCode } from "@opentelemetry/core";
import { LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
	AuthorizedLogExporter,
	AuthorizedMetricExporter,
	AuthorizedTraceExporter,
	sendAuthorized,
} from "../src/telemetry/authorized-exporters";

type FetchCall = {
	url: string;
	init: { method?: string; headers?: Bun.HeadersInit; body?: Bun.BodyInit; eligibleOrigin?: string };
};

function fakeTransport(status = 200) {
	const calls: FetchCall[] = [];
	return {
		calls,
		transport: {
			authorizedFetch: async (url: string, init: FetchCall["init"]) => {
				calls.push({ url, init });
				return new Response(new Uint8Array(), { status });
			},
		},
	};
}

/** One scripted step per call: a response status/headers, or "throw" for a network rejection. */
type ScriptedStep = { status: number; headers?: Record<string, string> } | "throw";

function scriptedTransport(steps: ScriptedStep[]) {
	const calls: FetchCall[] = [];
	let index = 0;
	return {
		calls,
		transport: {
			authorizedFetch: async (url: string, init: FetchCall["init"]) => {
				calls.push({ url, init });
				const step = steps[Math.min(index, steps.length - 1)];
				index++;
				if (step === "throw") throw new Error("network down");
				return new Response(new Uint8Array(), { status: step.status, headers: step.headers });
			},
		},
	};
}

/** No-op sleep that resolves immediately, recording every requested delay. */
function fakeSleep() {
	const delays: number[] = [];
	return { delays, sleep: async (ms: number) => void delays.push(ms) };
}

// Minimal ReadableLogRecord: drive a real LoggerProvider with a
// SimpleLogRecordProcessor into the exporter instead of hand-building one.
function emitOne(exporter: AuthorizedLogExporter) {
	// This pinned sdk-logs (0.220.0) takes { exporter }, not the exporter directly.
	const provider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter })] });
	provider.getLogger("test").emit({ body: "chat usage", eventName: "aura.usage.tokens" });
	return provider.forceFlush();
}

describe("AuthorizedLogExporter", () => {
	it("POSTs protobuf to the configured url with the eligible origin", async () => {
		const { calls, transport } = fakeTransport();
		const exporter = new AuthorizedLogExporter({ url: "https://telemetry.elide.cloud/v1/logs", transport });
		await emitOne(exporter);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://telemetry.elide.cloud/v1/logs");
		expect(calls[0]?.init.method).toBe("POST");
		expect(new Headers(calls[0]?.init.headers).get("content-type")).toBe("application/x-protobuf");
		expect(calls[0]?.init.eligibleOrigin).toBe("https://telemetry.elide.cloud");
		const body = calls[0]?.init.body as Uint8Array | undefined;
		expect(body?.byteLength).toBeGreaterThan(0);
	});

	it("maps a collector rejection to a FAILED result", async () => {
		const { transport } = fakeTransport(500);
		const results: Array<{ code: number }> = [];
		await sendAuthorized({ url: "https://telemetry.elide.cloud/v1/logs", transport }, new Uint8Array([1]), result =>
			results.push(result),
		);
		expect(results[0]?.code).toBe(ExportResultCode.FAILED);
	});

	it("an empty batch short-circuits SUCCESS without touching the transport", async () => {
		const { calls, transport } = fakeTransport();
		const exporter = new AuthorizedLogExporter({ url: "https://telemetry.elide.cloud/v1/logs", transport });
		const results: Array<{ code: number }> = [];
		exporter.export([], result => results.push(result));
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(results[0]?.code).toBe(ExportResultCode.SUCCESS);
		expect(calls).toHaveLength(0);
	});
});

describe("sendAuthorized retry/backoff/timeout", () => {
	it("retries a 503 once and succeeds, backing off between attempts", async () => {
		const { calls, transport } = scriptedTransport([{ status: 503 }, { status: 200 }]);
		const { delays, sleep } = fakeSleep();
		const results: Array<{ code: number }> = [];
		await sendAuthorized(
			{ url: "https://telemetry.elide.cloud/v1/logs", transport, sleep },
			new Uint8Array([1]),
			result => results.push(result),
		);
		expect(calls).toHaveLength(2);
		expect(delays).toHaveLength(1);
		expect(delays[0]).toBeGreaterThan(0);
		expect(results[0]?.code).toBe(ExportResultCode.SUCCESS);
	});

	it("retries a network rejection and succeeds", async () => {
		const { calls, transport } = scriptedTransport(["throw", { status: 200 }]);
		const { sleep } = fakeSleep();
		const results: Array<{ code: number }> = [];
		await sendAuthorized(
			{ url: "https://telemetry.elide.cloud/v1/logs", transport, sleep },
			new Uint8Array([1]),
			result => results.push(result),
		);
		expect(calls).toHaveLength(2);
		expect(results[0]?.code).toBe(ExportResultCode.SUCCESS);
	});

	it("exhausts retries on persistent 503s and reports FAILED", async () => {
		const { calls, transport } = scriptedTransport([
			{ status: 503 },
			{ status: 503 },
			{ status: 503 },
			{ status: 503 },
		]);
		const { sleep } = fakeSleep();
		const results: Array<{ code: number; error?: Error }> = [];
		await sendAuthorized(
			{ url: "https://telemetry.elide.cloud/v1/logs", transport, sleep },
			new Uint8Array([1]),
			result => results.push(result),
		);
		// 3 attempts total: the initial send plus 2 retries — no more calls after that.
		expect(calls).toHaveLength(3);
		expect(results).toHaveLength(1);
		expect(results[0]?.code).toBe(ExportResultCode.FAILED);
		expect(results[0]?.error?.message).toContain("503");
	});

	it("fails immediately on a non-retryable 400, without retrying", async () => {
		const { calls, transport } = scriptedTransport([{ status: 400 }, { status: 200 }]);
		const { sleep } = fakeSleep();
		const results: Array<{ code: number }> = [];
		await sendAuthorized(
			{ url: "https://telemetry.elide.cloud/v1/logs", transport, sleep },
			new Uint8Array([1]),
			result => results.push(result),
		);
		expect(calls).toHaveLength(1);
		expect(results[0]?.code).toBe(ExportResultCode.FAILED);
	});

	it("honors Retry-After over the computed backoff", async () => {
		const { transport } = scriptedTransport([{ status: 429, headers: { "retry-after": "7" } }, { status: 200 }]);
		const { delays, sleep } = fakeSleep();
		const results: Array<{ code: number }> = [];
		await sendAuthorized(
			{ url: "https://telemetry.elide.cloud/v1/logs", transport, sleep },
			new Uint8Array([1]),
			result => results.push(result),
		);
		expect(delays[0]).toBe(7000);
		expect(results[0]?.code).toBe(ExportResultCode.SUCCESS);
	});

	it("bounds each attempt with an AbortSignal timeout", async () => {
		let sawSignal: AbortSignal | undefined;
		const transport = {
			authorizedFetch: async (_url: string, init: { signal?: AbortSignal }) => {
				sawSignal = init.signal;
				return new Response(new Uint8Array(), { status: 200 });
			},
		};
		const results: Array<{ code: number }> = [];
		await sendAuthorized({ url: "https://telemetry.elide.cloud/v1/logs", transport }, new Uint8Array([1]), result =>
			results.push(result),
		);
		expect(sawSignal).toBeInstanceOf(AbortSignal);
		expect(sawSignal?.aborted).toBe(false);
	});
});

describe("AuthorizedTraceExporter", () => {
	it("POSTs protobuf spans through the shared send, happy path", async () => {
		const { calls, transport } = fakeTransport();
		const exporter = new AuthorizedTraceExporter({ url: "https://telemetry.elide.cloud/v1/traces", transport });
		const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
		provider.getTracer("test").startSpan("probe").end();
		await provider.forceFlush();

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://telemetry.elide.cloud/v1/traces");
		expect(calls[0]?.init.method).toBe("POST");
		expect(new Headers(calls[0]?.init.headers).get("content-type")).toBe("application/x-protobuf");
		expect(calls[0]?.init.eligibleOrigin).toBe("https://telemetry.elide.cloud");
		const body = calls[0]?.init.body as Uint8Array | undefined;
		expect(body?.byteLength).toBeGreaterThan(0);
	});
});

describe("AuthorizedMetricExporter", () => {
	it("POSTs protobuf metrics through the shared send, happy path", async () => {
		const { calls, transport } = fakeTransport();
		const exporter = new AuthorizedMetricExporter({ url: "https://telemetry.elide.cloud/v1/metrics", transport });
		const provider = new MeterProvider({
			readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
		});
		provider.getMeter("test").createCounter("probe.count").add(1);
		await provider.forceFlush();

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://telemetry.elide.cloud/v1/metrics");
		expect(calls[0]?.init.method).toBe("POST");
		expect(new Headers(calls[0]?.init.headers).get("content-type")).toBe("application/x-protobuf");
		expect(calls[0]?.init.eligibleOrigin).toBe("https://telemetry.elide.cloud");
		const body = calls[0]?.init.body as Uint8Array | undefined;
		expect(body?.byteLength).toBeGreaterThan(0);

		await provider.shutdown();
	});
});
