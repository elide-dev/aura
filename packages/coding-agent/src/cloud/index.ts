/**
 * Public seam for the Aura cloud client.
 *
 * This barrel is deliberately narrow and lazy: it re-exports the error taxonomy (cheap,
 * dependency-free) and nothing else. Heavier modules — deployment, token storage, token
 * management, auth — are added behind it as they land, and must stay behind lazy `import()`
 * at their call sites so importing `src/cloud` never drags them onto the CLI entry graph.
 *
 * Ownership boundary: identity owns CLI scope claims, device flow and JWKS; collab owns
 * server/static-build work; distribution owns signature/rollout/fetch-integrity primitives;
 * telemetry owns its own endpoint/token handoff; credential owns server contracts. None of
 * that surface — `worker-auth`, `AUTH` / `USAGE_INGEST` bindings, remote-session types,
 * provider OAuth — is exported here, and none of it should be re-implemented here.
 */

export {
	AURA_CLOUD_ERROR_CODES,
	AuraCloudError,
	type AuraCloudErrorCode,
	type AuraCloudErrorJson,
	type AuraCloudErrorOptions,
	type AuraCloudHostClass,
	classifyHost,
	isAuraCloudError,
} from "./errors";
