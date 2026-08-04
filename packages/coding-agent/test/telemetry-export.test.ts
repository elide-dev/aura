import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import {
	createTelemetryExportConfig,
	initTelemetryExport,
	isTelemetryExportEnabled,
	resolveAuraAuthorizedUrl,
	subscribeTelemetry,
} from "@oh-my-pi/pi-coding-agent/telemetry-export";
import { logger } from "@oh-my-pi/pi-utils";
import { metrics, trace } from "@opentelemetry/api";

/**
 * Gating contract for the OTLP export bootstrap. These cases all short-circuit
 * before a provider is registered, so they never mutate the module singleton
 * and are order-independent. The positive export path runs in a subprocess (see
 * the "exports spans" test) so the registered global provider can't leak here.
 */
const OTEL_KEYS = [
	"OTEL_EXPORTER_OTLP_ENDPOINT",
	"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
	"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
	"OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
	"OTEL_EXPORTER_OTLP_PROTOCOL",
	"OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
	"OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
	"OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
	"OTEL_SDK_DISABLED",
	"OTEL_TRACES_EXPORTER",
	"OTEL_LOGS_EXPORTER",
	"OTEL_METRICS_EXPORTER",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
	saved = Object.fromEntries(OTEL_KEYS.map(k => [k, process.env[k]]));
	for (const k of OTEL_KEYS) delete process.env[k];
});

afterEach(() => {
	for (const k of OTEL_KEYS) {
		const v = saved[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

describe("initTelemetryExport gating", () => {
	it("stays disabled when no OTLP endpoint is configured", async () => {
		await initTelemetryExport();
		expect(isTelemetryExportEnabled()).toBe(false);
	});

	it("stays disabled when OTEL_SDK_DISABLED=true even with an endpoint", async () => {
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
		process.env.OTEL_SDK_DISABLED = "true";
		await initTelemetryExport();
		expect(isTelemetryExportEnabled()).toBe(false);
	});

	it("stays disabled under OTEL_SDK_DISABLED even with the built-in destination available", async () => {
		// The kill switch outranks every tier, including the built-in Aura
		// fallback a settings instance would otherwise activate on its own.
		process.env.OTEL_SDK_DISABLED = "true";
		await initTelemetryExport({ settings: { get: (key: string) => key === "telemetry.enabled" } as never });
		expect(isTelemetryExportEnabled()).toBe(false);
	});

	it("stays disabled when OTEL_TRACES_EXPORTER=none and only the traces endpoint is set", async () => {
		process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://localhost:4318";
		process.env.OTEL_TRACES_EXPORTER = "none";
		await initTelemetryExport();
		expect(isTelemetryExportEnabled()).toBe(false);
	});

	it("declines unsupported OTLP protocols instead of misrouting spans", async () => {
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4317";
		process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";
		await initTelemetryExport();
		expect(isTelemetryExportEnabled()).toBe(false);

		process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = "http/json";
		await initTelemetryExport();
		expect(isTelemetryExportEnabled()).toBe(false);
	});

	it("honors the kill-switches case-insensitively per the OTEL env contract", async () => {
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
		process.env.OTEL_SDK_DISABLED = "TRUE";
		await initTelemetryExport();
		expect(isTelemetryExportEnabled()).toBe(false);

		delete process.env.OTEL_SDK_DISABLED;
		process.env.OTEL_TRACES_EXPORTER = "otlp,None";
		process.env.OTEL_LOGS_EXPORTER = "none";
		process.env.OTEL_METRICS_EXPORTER = "none";
		await initTelemetryExport();
		expect(isTelemetryExportEnabled()).toBe(false);
	});

	it("stays disabled when every signal exporter is set to none", async () => {
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
		process.env.OTEL_TRACES_EXPORTER = "none";
		process.env.OTEL_LOGS_EXPORTER = "none";
		process.env.OTEL_METRICS_EXPORTER = "none";
		await initTelemetryExport();
		expect(isTelemetryExportEnabled()).toBe(false);
	});
});

describe("initTelemetryExport signals export path", () => {
	it("registers a provider and exports spans to an OTLP/proto receiver", async () => {
		// Run in a subprocess: initTelemetryExport() registers a process-global
		// provider, so exercising the positive path in-process would leak that
		// singleton into every later test. The probe stands up its own loopback
		// receiver and exits 0 only when a protobuf trace export actually lands.
		const probe = fileURLToPath(new URL("./otel-export-probe.ts", import.meta.url));
		const proc = Bun.spawn([process.execPath, probe], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		expect(await proc.exited).toBe(0);
	}, 20_000);

	it("exports log records and metrics to OTLP/proto receivers", async () => {
		// Same subprocess isolation as the trace probe: the logs/metrics probe
		// drives the bridged logger, the agent telemetry metric hooks, and one of
		// every telemetry-bus event, then asserts protobuf POSTs landed at both
		// /v1/logs and /v1/metrics with the expected resource attributes, metric
		// data points, and log event names. Assertion failures land on stderr, so
		// it is folded into the diagnostic below rather than discarded.
		const probe = fileURLToPath(new URL("./otel-signals-probe.ts", import.meta.url));
		const proc = Bun.spawn(["bun", probe], { stdout: "pipe", stderr: "pipe" });
		const [code, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const output = `${stdout}\n${stderr}`;
		expect(output).toContain("PROBE: SIGNALS OK");
		expect(output).toContain("PROBE: RECEIVED");
		expect(code).toBe(0);
	}, 20_000);

	it("merges OTEL_RESOURCE_ATTRIBUTES into the exported resource", async () => {
		// Regression for #7134: the resource only carried service.name, so
		// OTEL_RESOURCE_ATTRIBUTES entries never reached the collector. The probe
		// asserts the merged attributes land and that OTEL_SERVICE_NAME wins
		// service.name over an OTEL_RESOURCE_ATTRIBUTES entry.
		const probe = fileURLToPath(new URL("./otel-resource-probe.ts", import.meta.url));
		const proc = Bun.spawn(["bun", probe], { stdout: "pipe", stderr: "pipe" });
		const [code, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect(`${stdout}\n${stderr}`).not.toContain("PROBE: FAIL");
		expect(code).toBe(0);
	}, 20_000);
});

/**
 * Registration error boundary.
 *
 * A malformed endpoint makes the OTLP exporter constructor throw, and telemetry
 * must never be able to take the CLI down at startup. These cases run in-process
 * on purpose: the contract under test is precisely that a failed registration
 * leaves *nothing* behind, so there is no global singleton to leak — and an
 * out-of-process probe could not prove the absence.
 */
describe("initTelemetryExport registration failures", () => {
	const MALFORMED = "http://local host:4318";

	function fakeSettings(values: Record<string, unknown>) {
		return { get: (key: string) => values[key] } as never;
	}

	/** Every observable trace of a registration, from the outside. */
	function assertNothingRegistered(): void {
		expect(isTelemetryExportEnabled()).toBe(false);
		// The gate the CLI reads: no export config means no agent-loop hooks.
		expect(createTelemetryExportConfig(undefined)).toBeUndefined();
		// A live NodeTracerProvider would hand back a recording span; the noop
		// provider's span carries the all-zero span context.
		const span = trace.getTracer("aura-teardown-probe").startSpan("probe");
		const recording = span.isRecording();
		span.end();
		expect(recording).toBe(false);
		// A live MeterProvider's counter is a real instrument, not the noop one.
		expect(metrics.getMeterProvider().constructor.name).not.toBe("MeterProvider");
		// The logger bridge must be off the log-sink list: while it is registered,
		// every error-level record publishes an `error.reported` bus event.
		const seen: string[] = [];
		const unsubscribe = subscribeTelemetry(event => seen.push(event.type));
		try {
			logger.error("telemetry teardown probe", { code: "teardown_probe" });
		} finally {
			unsubscribe();
		}
		expect(seen).toEqual([]);
	}

	afterEach(() => {
		// Belt and braces: any test here that unexpectedly DID register must not
		// poison the rest of the suite.
		assertNothingRegistered();
	});

	it("logs and disables instead of throwing when the settings endpoint is malformed", async () => {
		const warnings: string[] = [];
		const unsink = logger.registerLogSink(event => {
			if (event.level === "warn") warnings.push(event.message);
		});
		try {
			await initTelemetryExport({
				settings: fakeSettings({ "telemetry.enabled": true, "telemetry.endpoint": MALFORMED }),
			});
		} finally {
			unsink();
		}
		expect(warnings.some(w => w.includes("OTLP provider registration failed"))).toBe(true);
		assertNothingRegistered();
	});

	it("tears down already-registered signals when a later signal's exporter throws", async () => {
		// Traces get a valid endpoint through the environment (env wins per key, so
		// the settings base is not consulted for that signal); metrics fall through
		// to the malformed settings base and blow up in the exporter constructor —
		// after the tracer provider has already been registered globally. Logs are
		// switched off so the failure lands squarely between two registrations.
		process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://127.0.0.1:4318/v1/traces";
		process.env.OTEL_LOGS_EXPORTER = "none";
		await initTelemetryExport({
			settings: fakeSettings({ "telemetry.enabled": true, "telemetry.endpoint": MALFORMED }),
		});
		assertNothingRegistered();
	});

	it("does not memoize the failure, so a corrected configuration can retry", async () => {
		// The first attempt must not leave a resolved initPromise behind: if it
		// did, the second call would short-circuit and never reach the exporter,
		// and no second warning would be logged.
		const settings = fakeSettings({ "telemetry.enabled": true, "telemetry.endpoint": MALFORMED });
		const warnings: string[] = [];
		const unsink = logger.registerLogSink(event => {
			if (event.level === "warn" && event.message.includes("OTLP provider registration failed")) {
				warnings.push(event.message);
			}
		});
		try {
			await initTelemetryExport({ settings });
			await initTelemetryExport({ settings });
		} finally {
			unsink();
		}
		expect(warnings).toHaveLength(2);
	});
});

describe("resolveAuraAuthorizedUrl", () => {
	const settings = {
		get: (key: string) =>
			(({ "telemetry.enabled": true, "cloud.telemetry.enabled": true }) as Record<string, unknown>)[key],
	} as never;

	it("returns the signal URL when the Aura tier wins the destination", () => {
		const url = resolveAuraAuthorizedUrl("log", settings, { AURA_DOMAIN: "elide.cloud" });
		expect(url).toBe("https://telemetry.elide.cloud/v1/logs");
	});

	it("returns undefined when env owns the endpoint (credential never follows env)", () => {
		const url = resolveAuraAuthorizedUrl("log", settings, {
			AURA_DOMAIN: "elide.cloud",
			OTEL_EXPORTER_OTLP_ENDPOINT: "https://operator.example",
		});
		expect(url).toBeUndefined();
	});

	it("returns undefined when an explicit telemetry.endpoint outranks the Aura tier", () => {
		const withEndpoint = {
			get: (key: string) =>
				(
					({
						"telemetry.enabled": true,
						"cloud.telemetry.enabled": true,
						"telemetry.endpoint": "https://collector.example",
					}) as Record<string, unknown>
				)[key],
		} as never;
		expect(resolveAuraAuthorizedUrl("log", withEndpoint, { AURA_DOMAIN: "elide.cloud" })).toBeUndefined();
	});

	it("returns undefined for the built-in tier (no AURA_DOMAIN)", () => {
		expect(resolveAuraAuthorizedUrl("log", settings, {})).toBeUndefined();
	});
});
