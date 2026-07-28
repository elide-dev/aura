import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { logger } from "@oh-my-pi/pi-utils";
import { resolveExporterConfig, resolveTelemetryEnv } from "../src/telemetry/init";

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

	it("warns once about unrecognized telemetry.signals members", () => {
		// A typo reads as a deliberate omission and silently switches the signal
		// off, so the misspelling has to be named rather than absorbed.
		const warnings: { message: string; context: Record<string, unknown> | undefined }[] = [];
		const unsink = logger.registerLogSink(event => {
			if (event.level === "warn") warnings.push({ message: event.message, context: event.context });
		});
		let env: Record<string, string | undefined>;
		try {
			env = resolveTelemetryEnv(
				fakeSettings({ "telemetry.enabled": true, "telemetry.signals": ["trace", "logs", "metric"] }),
				{},
			);
		} finally {
			unsink();
		}
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toContain("telemetry.signals has unrecognized entries");
		expect(warnings[0]?.context?.unknown).toBe("trace,metric");
		// The warning is advisory: the misspelled signals still resolve to "off",
		// which is what the list literally asked for.
		expect(env.OTEL_TRACES_EXPORTER).toBe("none");
		expect(env.OTEL_METRICS_EXPORTER).toBe("none");
		expect(env.OTEL_LOGS_EXPORTER).toBeUndefined();
	});

	it("stays silent when every telemetry.signals member is recognized", () => {
		const warnings: string[] = [];
		const unsink = logger.registerLogSink(event => {
			if (event.level === "warn") warnings.push(event.message);
		});
		try {
			resolveTelemetryEnv(fakeSettings({ "telemetry.enabled": true, "telemetry.signals": ["traces", "logs"] }), {});
		} finally {
			unsink();
		}
		expect(warnings).toEqual([]);
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

describe("settings-driven OTLP exporter config", () => {
	const configured = fakeSettings({
		"telemetry.enabled": true,
		"telemetry.endpoint": "http://localhost:4318",
		"telemetry.headers": { "x-api-key": "k" },
	});

	it("appends the per-signal OTLP path to the settings base endpoint", () => {
		expect(resolveExporterConfig("trace", configured, {}).url).toBe("http://localhost:4318/v1/traces");
		expect(resolveExporterConfig("log", configured, {}).url).toBe("http://localhost:4318/v1/logs");
		expect(resolveExporterConfig("metric", configured, {}).url).toBe("http://localhost:4318/v1/metrics");
	});

	it("trims trailing slashes on the base endpoint instead of doubling the join", () => {
		const settings = fakeSettings({ "telemetry.enabled": true, "telemetry.endpoint": "http://localhost:4318///" });
		expect(resolveExporterConfig("trace", settings, {}).url).toBe("http://localhost:4318/v1/traces");
	});

	it("passes settings headers as a record, unserialized", () => {
		expect(resolveExporterConfig("trace", configured, {}).headers).toEqual({ "x-api-key": "k" });
	});

	it("defers to the exporters' own env handling when env owns the key", () => {
		// Generic env endpoint: no url passed, so the exporter reads env itself.
		const genericEndpoint = resolveExporterConfig("trace", configured, {
			OTEL_EXPORTER_OTLP_ENDPOINT: "http://env:4318",
		});
		expect(genericEndpoint.url).toBeUndefined();
		expect(genericEndpoint.headers).toEqual({ "x-api-key": "k" }); // headers key still settings-owned

		// Signal-specific env endpoint governs that signal only.
		expect(
			resolveExporterConfig("trace", configured, { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://env:4318/v1/traces" })
				.url,
		).toBeUndefined();
		expect(
			resolveExporterConfig("log", configured, { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://env:4318/v1/traces" })
				.url,
		).toBe("http://localhost:4318/v1/logs");

		// Headers, generic and signal-specific.
		expect(resolveExporterConfig("trace", configured, { OTEL_EXPORTER_OTLP_HEADERS: "a=b" }).headers).toBeUndefined();
		expect(
			resolveExporterConfig("trace", configured, { OTEL_EXPORTER_OTLP_TRACES_HEADERS: "a=b" }).headers,
		).toBeUndefined();
	});

	it("contributes nothing when telemetry is disabled or unconfigured", () => {
		expect(resolveExporterConfig("trace", undefined, {})).toEqual({});
		expect(
			resolveExporterConfig(
				"trace",
				fakeSettings({ "telemetry.enabled": false, "telemetry.endpoint": "http://s:4318" }),
				{},
			),
		).toEqual({});
		expect(
			resolveExporterConfig("trace", fakeSettings({ "telemetry.enabled": true, "telemetry.headers": {} }), {}),
		).toEqual({});
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
