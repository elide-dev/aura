export { ELIDE_VERSION } from "./dist";
export * from "./protocol";
export { provisionRuntime } from "./provision";
export { managedRuntimeRoot, managedVersionDir, resolveRuntimeBinary } from "./resolve";
export * from "./service";
export { type LocalEndpointOptions, LocalRuntimeEndpoint } from "./transport/local";

import { RuntimeService } from "./service";
import { type LocalEndpointOptions, LocalRuntimeEndpoint } from "./transport/local";

let cached: { key: string; service: RuntimeService } | undefined;

/** Stable cache key over the options that change resolution behaviour. */
function serviceCacheKey(opts?: LocalEndpointOptions): string {
	return JSON.stringify({
		explicitPath: opts?.explicitPath ?? null,
		autoDownload: opts?.autoDownload ?? null,
	});
}

/**
 * Lazily build a service over the local endpoint, memoized on the options that
 * affect binary resolution (`explicitPath`, `autoDownload`). Identical options
 * hand back the cached instance; changed options build a fresh one, so live
 * edits to `runtime.*` settings take effect on the next call. Discarding an
 * instance is free because {@link LocalRuntimeEndpoint} holds no state — it
 * re-resolves the binary on every request.
 *
 * Only `explicitPath`/`autoDownload` participate in the key; callers that vary
 * `env`, `onProgress`, or the test injection hooks must not rely on the cache
 * noticing (construct the service directly instead).
 */
export function getOrCreateRuntimeService(opts?: LocalEndpointOptions): RuntimeService {
	const key = serviceCacheKey(opts);
	if (cached?.key !== key) cached = { key, service: new RuntimeService(new LocalRuntimeEndpoint(opts)) };
	return cached.service;
}

/** Runtime settings as read from `runtime.enabled` / `runtime.autoDownload` / `runtime.path`. */
export interface RuntimeSettingsValues {
	enabled: boolean;
	autoDownload: boolean;
	/** Explicit binary path; empty/whitespace means "discover". An explicit path disables auto-download. */
	path: string;
}

/**
 * Map runtime settings onto endpoint options. Returns `undefined` when the runtime is disabled,
 * which is the signal to expose no service at all.
 */
export function resolveRuntimeEndpointOptions(values: RuntimeSettingsValues): LocalEndpointOptions | undefined {
	if (!values.enabled) return undefined;
	const explicit = values.path.trim();
	return {
		autoDownload: values.autoDownload,
		...(explicit === "" ? {} : { explicitPath: explicit }),
	};
}

/** Drop the memoized service so the next call builds a fresh one. */
export function resetRuntimeServiceForTests(): void {
	cached = undefined;
}
