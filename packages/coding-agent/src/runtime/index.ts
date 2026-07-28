export { ELIDE_VERSION, MINIMUM_RUNTIME_VERSION } from "./dist";
export {
	embeddedRuntimeLibraryName,
	resolveEmbeddedRuntimeLibrary,
	type ResolvedEmbeddedRuntimeLibrary,
	type ResolveEmbeddedRuntimeLibraryOptions,
} from "./embedded/resolve";
export { deriveJvmMainClass, JVM_BYTECODE_RELEASE } from "./jvm";
export * from "./protocol";
export { provisionRuntime } from "./provision";
export { managedRuntimeRoot, managedVersionDir, resolveRuntimeBinary } from "./resolve";
export * from "./service";
export { type LocalEndpointOptions, LocalRuntimeEndpoint } from "./transport/local";
export * from "./transport/embedded";
export * from "./transport/selected";

import { logger } from "@oh-my-pi/pi-utils";
import type { RuntimeAdapter } from "./protocol";
import { RuntimeService } from "./service";
import { SelectedRuntimeEndpoint, type SelectedEndpointOptions } from "./transport/selected";

interface CachedRuntimeService {
	key: string;
	service: RuntimeService;
}

let cached: CachedRuntimeService | undefined;

/** Stable cache key over every setting that changes endpoint selection or resolution. */
function serviceCacheKey(options: SelectedEndpointOptions = {}): string {
	return JSON.stringify({
		adapter: options.adapter ?? "process",
		embeddedPath: options.embeddedPath ?? null,
		explicitPath: options.explicitPath ?? null,
		autoDownload: options.autoDownload ?? null,
	});
}

/**
 * Lazily build the selected runtime service. A settings change publishes the
 * replacement first, then retires the old endpoint without blocking its caller.
 */
export function getOrCreateRuntimeService(
	options: SelectedEndpointOptions = {},
	onCreate?: (service: RuntimeService) => void,
): RuntimeService {
	const key = serviceCacheKey(options);
	if (cached?.key === key) return cached.service;
	const retired = cached?.service;
	const service = new RuntimeService(new SelectedRuntimeEndpoint(options));
	cached = { key, service };
	onCreate?.(service);
	if (retired) {
		void retired.close().catch(error => {
			logger.warn("Failed to close retired runtime service after settings change", { error: String(error) });
		});
	}
	return service;
}

/**
 * Atomically evict and then close a cached service. Supplying a retired service
 * closes only that instance and cannot evict a newer replacement.
 */
export async function disposeCachedRuntimeService(service?: RuntimeService): Promise<void> {
	const target = service ?? cached?.service;
	if (!target) return;
	if (cached?.service === target) cached = undefined;
	await target.close();
}

/** Runtime settings as read from the `runtime.*` settings group. */
export interface RuntimeSettingsValues {
	enabled: boolean;
	autoDownload: boolean;
	/** Explicit binary path; empty/whitespace means "discover". An explicit path disables auto-download. */
	path: string;
	/** Requested execution adapter. Process remains the default. */
	adapter: RuntimeAdapter;
	/** Explicit embedded runtime library path; empty/whitespace means "discover". */
	embeddedPath: string;
}

/**
 * Map runtime settings onto selected endpoint options. Returns `undefined` when
 * the runtime is disabled, which is the signal to expose no service at all.
 */
export function resolveRuntimeEndpointOptions(values: RuntimeSettingsValues): SelectedEndpointOptions | undefined {
	if (!values.enabled) return undefined;
	const explicit = values.path.trim();
	const embedded = values.embeddedPath.trim();
	return {
		adapter: values.adapter,
		autoDownload: values.autoDownload,
		...(explicit === "" ? {} : { explicitPath: explicit }),
		...(embedded === "" ? {} : { embeddedPath: embedded }),
	};
}

/** Drop the memoized test singleton without waiting for endpoint teardown. */
export function resetRuntimeServiceForTests(): void {
	cached = undefined;
}
