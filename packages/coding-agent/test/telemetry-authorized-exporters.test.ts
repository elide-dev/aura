import { describe, expect, it } from "bun:test";
import { ExportResultCode } from "@opentelemetry/core";
import { LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { AuthorizedLogExporter, sendAuthorized } from "../src/telemetry/authorized-exporters";

function fakeTransport(status = 200) {
	const calls: Array<{
		url: string;
		init: { method?: string; headers?: Bun.HeadersInit; body?: Bun.BodyInit; eligibleOrigin?: string };
	}> = [];
	return {
		calls,
		transport: {
			authorizedFetch: async (url: string, init: (typeof calls)[number]["init"]) => {
				calls.push({ url, init });
				return new Response(new Uint8Array(), { status });
			},
		},
	};
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
		sendAuthorized({ url: "https://telemetry.elide.cloud/v1/logs", transport }, new Uint8Array([1]), result =>
			results.push(result),
		);
		await new Promise(resolve => setTimeout(resolve, 0));
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
