import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { resolveTelemetryEnv } from "../src/telemetry/init";

function fakeSettings(values: Record<string, unknown>) {
	return { get: (path: string) => values[path] } as never;
}

describe("settings-driven telemetry activation", () => {
	it("maps telemetry.* settings to OTEL env fallbacks", () => {
		const env = resolveTelemetryEnv(
			fakeSettings({
				"telemetry.enabled": true,
				"telemetry.endpoint": "http://localhost:4318",
				"telemetry.headers": { "x-api-key": "k" },
				"telemetry.signals": ["metrics", "logs"],
			}),
			{}, // current process.env view
		);
		expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://localhost:4318");
		expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBe("x-api-key=k");
		expect(env.OTEL_TRACES_EXPORTER).toBe("none"); // traces not in signals list
		expect(env.OTEL_LOGS_EXPORTER).toBeUndefined();
		expect(env.OTEL_METRICS_EXPORTER).toBeUndefined();
	});

	it("env always wins and disabled settings contribute nothing", () => {
		const withEnv = resolveTelemetryEnv(
			fakeSettings({ "telemetry.enabled": true, "telemetry.endpoint": "http://settings:4318" }),
			{ OTEL_EXPORTER_OTLP_ENDPOINT: "http://env:4318" },
		);
		expect(withEnv.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://env:4318");

		const disabled = resolveTelemetryEnv(
			fakeSettings({ "telemetry.enabled": false, "telemetry.endpoint": "http://settings:4318" }),
			{},
		);
		expect(disabled.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
	});

	it("passes env through untouched when no settings instance is supplied", () => {
		const env = resolveTelemetryEnv(undefined, { OTEL_EXPORTER_OTLP_ENDPOINT: "http://env:4318" });
		expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://env:4318");
		expect(env.OTEL_TRACES_EXPORTER).toBeUndefined();
	});

	it("leaves headers alone when the settings record is empty and env has its own", () => {
		const env = resolveTelemetryEnv(fakeSettings({ "telemetry.enabled": true, "telemetry.headers": {} }), {
			OTEL_EXPORTER_OTLP_HEADERS: "a=b",
		});
		expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBe("a=b");
	});

	it("keeps a per-signal env exporter selection over the settings signals list", () => {
		const env = resolveTelemetryEnv(fakeSettings({ "telemetry.enabled": true, "telemetry.signals": [] }), {
			OTEL_TRACES_EXPORTER: "otlp",
		});
		expect(env.OTEL_TRACES_EXPORTER).toBe("otlp");
		expect(env.OTEL_LOGS_EXPORTER).toBe("none");
		expect(env.OTEL_METRICS_EXPORTER).toBe("none");
	});
});

describe("settings-driven telemetry end-to-end", () => {
	it("activates a provider and exports when only settings supply the endpoint", async () => {
		// Subprocess for the same reason as the env probes in
		// telemetry-export.test.ts: initTelemetryExport() registers process-global
		// providers. This is the regression guard for the coordinated edit — if
		// registerProviders stops threading its options through, the settings path
		// silently registers nothing and this probe exits non-zero.
		const probe = fileURLToPath(new URL("./otel-settings-probe.ts", import.meta.url));
		const proc = Bun.spawn(["bun", probe], { stdout: "pipe", stderr: "pipe" });
		const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
		expect(stdout).toContain("PROBE: RECEIVED");
		expect(code).toBe(0);
	}, 20_000);
});
