import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { logger } from "@oh-my-pi/pi-utils";
import {
	BUILTIN_TELEMETRY_ENDPOINT,
	BUILTIN_TELEMETRY_HEADERS,
	resolveExporterConfig,
	resolveTelemetryEnv,
} from "../src/telemetry/init";

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

	it("contributes nothing with no settings instance or with telemetry switched off", () => {
		expect(resolveExporterConfig("trace", undefined, {})).toEqual({});
		expect(
			resolveExporterConfig(
				"trace",
				fakeSettings({ "telemetry.enabled": false, "telemetry.endpoint": "http://s:4318" }),
				{},
			),
		).toEqual({});
		// `telemetry.enabled: false` also switches the built-in destination off:
		// the master switch gates every settings-side tier, not just the endpoint.
		expect(resolveExporterConfig("trace", fakeSettings({ "telemetry.enabled": false }), {})).toEqual({});
	});

	it("holds headers back when the user configured headers but no destination", () => {
		// Headers with nothing to attach them to is an incomplete configuration,
		// not a request to send the user's credential to the built-in stack. The
		// built-in tier declines rather than pairing a foreign header with it.
		expect(
			resolveExporterConfig(
				"trace",
				fakeSettings({ "telemetry.enabled": true, "telemetry.headers": { "x-api-key": "k" } }),
				{},
			),
		).toEqual({});
	});
});

/**
 * Destination tiers below the OTEL env vars.
 *
 * Order under test, highest first: `OTEL_EXPORTER_OTLP_*` → explicit
 * `telemetry.endpoint` → Aura (`AURA_TELEMETRY_URL`/`AURA_DOMAIN`, gated by
 * `cloud.telemetry.enabled`) → the built-in team Grafana Cloud stack.
 *
 * Endpoint and headers of a fallback tier are atomic: the built-in credential
 * must never ride along with any endpoint other than the built-in one.
 */
describe("telemetry destination fallback tiers", () => {
	const AURA_URL = "https://telemetry.aura.example/otlp";

	it("falls back to the built-in Grafana destination when nothing is configured", () => {
		const settings = fakeSettings({ "telemetry.enabled": true });
		expect(resolveExporterConfig("trace", settings, {}).url).toBe(`${BUILTIN_TELEMETRY_ENDPOINT}/v1/traces`);
		expect(resolveExporterConfig("log", settings, {}).url).toBe(`${BUILTIN_TELEMETRY_ENDPOINT}/v1/logs`);
		expect(resolveExporterConfig("metric", settings, {}).url).toBe(`${BUILTIN_TELEMETRY_ENDPOINT}/v1/metrics`);
		// The credential travels with it, or the endpoint is useless.
		const headers = resolveExporterConfig("trace", settings, {}).headers;
		expect(headers?.Authorization).toBe(BUILTIN_TELEMETRY_HEADERS.Authorization);
		expect(headers?.Authorization?.startsWith("Basic ")).toBe(true);
		// And the gating view activates the signals, exactly as a settings endpoint would.
		expect(resolveTelemetryEnv(settings, {}).OTEL_EXPORTER_OTLP_ENDPOINT).toBe(BUILTIN_TELEMETRY_ENDPOINT);
	});

	it("keeps an explicit telemetry.endpoint above the built-in destination", () => {
		const settings = fakeSettings({ "telemetry.enabled": true, "telemetry.endpoint": "http://otel.internal:4318" });
		const config = resolveExporterConfig("trace", settings, {});
		expect(config.url).toBe("http://otel.internal:4318/v1/traces");
		expect(config.headers).toBeUndefined();
		expect(resolveTelemetryEnv(settings, {}).OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://otel.internal:4318");
	});

	it("keeps OTEL env above both, and never lends it the built-in credential", () => {
		const settings = fakeSettings({ "telemetry.enabled": true });
		const generic = resolveExporterConfig("trace", settings, { OTEL_EXPORTER_OTLP_ENDPOINT: "http://env:4318" });
		expect(generic.url).toBeUndefined(); // exporter reads env itself
		expect(generic.headers).toBeUndefined();

		const perSignal = resolveExporterConfig("trace", settings, {
			OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://env:4318/v1/traces",
		});
		expect(perSignal.url).toBeUndefined();
		expect(perSignal.headers).toBeUndefined();
		// The env view reports the env endpoint, not the built-in one.
		expect(
			resolveTelemetryEnv(settings, { OTEL_EXPORTER_OTLP_ENDPOINT: "http://env:4318" }).OTEL_EXPORTER_OTLP_ENDPOINT,
		).toBe("http://env:4318");
	});

	it("cuts over to the Aura tier over the built-in destination", () => {
		// The whole point of the built-in being the LOWEST tier: the day the Aura
		// relay is configured, it takes over with no further edit.
		const settings = fakeSettings({ "telemetry.enabled": true, "cloud.telemetry.enabled": true });
		expect(resolveExporterConfig("trace", settings, { AURA_TELEMETRY_URL: AURA_URL }).url).toBe(
			`${AURA_URL}/v1/traces`,
		);
		expect(resolveTelemetryEnv(settings, { AURA_TELEMETRY_URL: AURA_URL }).OTEL_EXPORTER_OTLP_ENDPOINT).toBe(AURA_URL);
		// Domain derivation is an Aura tier too.
		expect(resolveExporterConfig("trace", settings, { AURA_DOMAIN: "aura.example" }).url).toBe(
			"https://telemetry.aura.example/v1/traces",
		);
	});

	it("never sends the built-in credential to an Aura endpoint", () => {
		const settings = fakeSettings({ "telemetry.enabled": true, "cloud.telemetry.enabled": true });
		for (const env of [{ AURA_TELEMETRY_URL: AURA_URL }, { AURA_DOMAIN: "aura.example" }]) {
			const config = resolveExporterConfig("trace", settings, env);
			expect(config.url).not.toBe(`${BUILTIN_TELEMETRY_ENDPOINT}/v1/traces`);
			expect(config.headers ?? {}).not.toHaveProperty("Authorization");
			expect(JSON.stringify(config)).not.toContain(BUILTIN_TELEMETRY_HEADERS.Authorization);
		}
	});

	it("keeps the built-in destination while cloud.telemetry.enabled is off", () => {
		// Today's default. The Aura endpoint is present in env but the switch is
		// off, so the Aura tier is absent and the built-in applies.
		const settings = fakeSettings({ "telemetry.enabled": true });
		const config = resolveExporterConfig("trace", settings, { AURA_TELEMETRY_URL: AURA_URL });
		expect(config.url).toBe(`${BUILTIN_TELEMETRY_ENDPOINT}/v1/traces`);
		expect(config.headers?.Authorization).toBe(BUILTIN_TELEMETRY_HEADERS.Authorization);
	});

	it("keeps the built-in destination when an Aura variable is malformed", () => {
		// Telemetry must never take startup down, and a rejected Aura tier is not
		// a licence to invent one — the next tier down applies.
		const settings = fakeSettings({ "telemetry.enabled": true, "cloud.telemetry.enabled": true });
		const config = resolveExporterConfig("trace", settings, { AURA_TELEMETRY_URL: "not a url" });
		expect(config.url).toBe(`${BUILTIN_TELEMETRY_ENDPOINT}/v1/traces`);
	});

	it("keeps explicit user headers with an explicit user endpoint only", () => {
		const settings = fakeSettings({
			"telemetry.enabled": true,
			"telemetry.endpoint": "http://otel.internal:4318",
			"telemetry.headers": { "x-api-key": "k" },
		});
		expect(resolveExporterConfig("trace", settings, {}).headers).toEqual({ "x-api-key": "k" });
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
