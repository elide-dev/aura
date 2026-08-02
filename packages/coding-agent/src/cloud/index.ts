/**
 * Public seam for the Aura cloud client.
 *
 * This barrel is deliberately narrow and lazy: it re-exports the error taxonomy and the
 * deployment resolver, both of which are pure, dependency-free and cheap enough to sit on any
 * call graph. Heavier modules — token storage, token management, auth — are added behind it as
 * they land, and must stay behind lazy `import()` at their call sites so importing `src/cloud`
 * never drags them onto the CLI entry graph.
 *
 * Ownership boundary: identity owns CLI scope claims, device flow and JWKS; collab owns
 * server/static-build work; distribution owns signature/rollout/fetch-integrity primitives;
 * telemetry owns its own endpoint/token handoff; credential owns server contracts. None of
 * that surface — `worker-auth`, `AUTH` / `USAGE_INGEST` bindings, remote-session types,
 * provider OAuth — is exported here, and none of it should be re-implemented here.
 */

export {
	type AuraDeployment,
	type AuraDistributionEndpoints,
	type AuraServiceSurface,
	auraDeploymentFor,
	CLOUD_CONSUMER_SETTINGS,
	CLOUD_SWITCH_DEFAULTS,
	type CloudConsumer,
	type CloudSwitches,
	type CloudSwitchPath,
	type CloudSwitchReader,
	type EndpointSource,
	type EnvView,
	type ResolvedEndpoint,
	type ResolvedQaConfiguration,
	type ResolvedQaToken,
	readCloudSwitches,
	resolveAuraDeployment,
	resolveQaConfiguration,
	resolveServiceEndpoint,
} from "./deployment";
export {
	AURA_CLOUD_ERROR_CODES,
	AuraCloudError,
	type AuraCloudErrorCode,
	type AuraCloudErrorJson,
	type AuraCloudErrorOptions,
	type AuraCloudHostClass,
	auraCloudErrorCause,
	classifyHost,
	isAuraCloudError,
} from "./errors";
/**
 * Storage types only. `export type` is erased at build time, so the shapes are importable from
 * the barrel while `token-store.ts` — and with it `bun:sqlite` — stays off the entry graph.
 * Runtime storage symbols (`AuraTokenStore`, the scope list, the lease TTL) are deliberately
 * absent: reach them through `import("./cloud/token-store")` at the call site.
 */
export type {
	AuraAccessToken,
	AuraAccessTokenProvider,
	AuraAccountIdentity,
	AuraAccountNamespace,
	AuraImportReceipt,
	AuraImportReceiptInput,
	AuraLeaseAcquisition,
	AuraRefreshLease,
	AuraRotationResult,
	AuraStoredAccount,
	AuraStoredAuth,
	AuraSurfaceScope,
	AuraSyncConflict,
} from "./token-store";
