/**
 * The cheap gate in resolveCloudTelemetryTransport.
 *
 * Every one of these cases must resolve WITHOUT opening the cloud token
 * database or importing the cloud auth graph — that cost belongs only to
 * installs whose telemetry actually goes to the Aura tier. The assertions
 * below are the observable proxy for that: the function returns undefined
 * synchronously enough that no store is ever constructed, and it never throws.
 */
import { describe, expect, it } from "bun:test";
import { resolveCloudTelemetryTransport } from "../src/telemetry/cloud-session";

function fakeSettings(values: Record<string, unknown>) {
	return { get: (key: string) => values[key] } as never;
}

/** Settings that would select the Aura telemetry tier, given a domain. */
const AURA_TIER_ON = {
	"telemetry.enabled": true,
	"cloud.telemetry.enabled": true,
	"cloud.account.enabled": true,
};

describe("resolveCloudTelemetryTransport declines without a cloud session", () => {
	it("returns undefined when telemetry is disabled outright", async () => {
		const transport = await resolveCloudTelemetryTransport(fakeSettings({ "telemetry.enabled": false }), {
			AURA_DOMAIN: "elide.cloud",
		});
		expect(transport).toBeUndefined();
	});

	it("returns undefined when settings are absent", async () => {
		expect(await resolveCloudTelemetryTransport(undefined, { AURA_DOMAIN: "elide.cloud" })).toBeUndefined();
	});

	it("returns undefined with no AURA_DOMAIN — the built-in tier never authenticates", async () => {
		// The default install: no domain configured, so the Aura tier cannot win
		// and telemetry goes to the built-in collector with no credential.
		expect(await resolveCloudTelemetryTransport(fakeSettings(AURA_TIER_ON), {})).toBeUndefined();
	});

	it("returns undefined while cloud.telemetry.enabled is off, even with a domain", async () => {
		// Signing in is not consent to be measured: the switch gates the tier
		// regardless of session state.
		const transport = await resolveCloudTelemetryTransport(
			fakeSettings({ "telemetry.enabled": true, "cloud.telemetry.enabled": false }),
			{ AURA_DOMAIN: "elide.cloud" },
		);
		expect(transport).toBeUndefined();
	});

	it("returns undefined when an env endpoint owns the destination", async () => {
		// Env wins per key and never carries the Aura credential.
		const transport = await resolveCloudTelemetryTransport(fakeSettings(AURA_TIER_ON), {
			AURA_DOMAIN: "elide.cloud",
			OTEL_EXPORTER_OTLP_ENDPOINT: "https://operator.example",
		});
		expect(transport).toBeUndefined();
	});

	it("returns undefined when an explicit telemetry.endpoint outranks the Aura tier", async () => {
		const transport = await resolveCloudTelemetryTransport(
			fakeSettings({ ...AURA_TIER_ON, "telemetry.endpoint": "http://localhost:4318" }),
			{ AURA_DOMAIN: "elide.cloud" },
		);
		expect(transport).toBeUndefined();
	});

	it("never throws on a malformed AURA_DOMAIN", async () => {
		// Telemetry is best-effort: a bad domain degrades to unauthenticated
		// export rather than taking startup down.
		const transport = await resolveCloudTelemetryTransport(fakeSettings(AURA_TIER_ON), {
			AURA_DOMAIN: "not a domain",
		});
		expect(transport).toBeUndefined();
	});
});
