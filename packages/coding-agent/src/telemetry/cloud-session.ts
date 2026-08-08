/**
 * Resolves the cloud transport the Aura telemetry tier authenticates with.
 *
 * This is the handoff `InitTelemetryOptions.cloud` documents: when a signed-in
 * cloud session exists, telemetry exports go through the authorized exporters
 * (fresh bearer per export via `TokenManager.authorizedFetch`) instead of the
 * stock unauthenticated ones. The cloud relay accepts anonymous OTLP either
 * way; the bearer is what lets it attribute usage to an account.
 *
 * Three properties are load-bearing:
 *
 *  - **The pure gate runs first.** `resolveAuraAuthorizedUrl` already encodes
 *    the full destination precedence (env wins, an explicit `telemetry.endpoint`
 *    outranks the Aura tier, the built-in tier never authenticates, and
 *    `cloud.telemetry.enabled` gates the tier). If no signal would use the Aura
 *    tier there is nothing to authenticate, and we must not open the token
 *    database — startup cost is paid only by installs that will actually use it.
 *  - **Cloud auth stays off the CLI entry graph.** `token-store` and `auth` are
 *    reached through lazy `import()`, per the ownership note in `src/cloud/index.ts`.
 *  - **Never throws.** Telemetry is best-effort; a missing database, an invalid
 *    `AURA_DOMAIN`, or a locked store degrades to unauthenticated export, never
 *    to a failed startup.
 *
 * Returns `undefined` when no session is available — which today is always,
 * since nothing in the CLI creates one yet. The moment an Elide Cloud login
 * lands, authenticated export starts working with no change here.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type { AuraTelemetryTransport } from "./authorized-exporters";
import { resolveAuraAuthorizedUrl, type TelemetrySignal } from "./init";

const SIGNALS: readonly TelemetrySignal[] = ["trace", "log", "metric"];

export async function resolveCloudTelemetryTransport(
	settings: Pick<Settings, "get"> | undefined,
	processEnv: Record<string, string | undefined> = process.env,
): Promise<AuraTelemetryTransport | undefined> {
	// Pure and cheap: no I/O, no database, no import of the cloud auth graph.
	const usesAuraTier = SIGNALS.some(signal => resolveAuraAuthorizedUrl(signal, settings, processEnv) !== undefined);
	if (!usesAuraTier || !settings) return undefined;

	try {
		const { auraDeploymentFor, readCloudSwitches, resolveAuraDeployment } = await import("../cloud/deployment");
		const deployment = resolveAuraDeployment({ env: processEnv });
		// `account` is the consumer that owns the auth origin; its own switch
		// gates it, so disabling cloud account access also disables this.
		const authOrigin = auraDeploymentFor("account", deployment, readCloudSwitches(settings)).authOrigin?.url;
		if (!authOrigin) return undefined;

		const [{ AuraTokenStore }, { AuraAuthClient }] = await Promise.all([
			import("../cloud/token-store"),
			import("../cloud/auth"),
		]);
		const client = new AuraAuthClient({ authOrigin, store: await AuraTokenStore.open() });
		// Signed out: hand back nothing rather than a manager that would fail on
		// every export. The stock exporters then carry telemetry unauthenticated.
		if (!client.status().signedIn) return undefined;
		return client.manager;
	} catch (error) {
		logger.warn("telemetry: no cloud session available; exporting unauthenticated", {
			error: String(error),
		});
		return undefined;
	}
}
