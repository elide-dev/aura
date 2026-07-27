export { ELIDE_VERSION } from "./dist";
export * from "./protocol";
export { provisionRuntime } from "./provision";
export { managedRuntimeRoot, managedVersionDir, resolveRuntimeBinary } from "./resolve";
export * from "./service";
export { type LocalEndpointOptions, LocalRuntimeEndpoint } from "./transport/local";

import { RuntimeService } from "./service";
import { type LocalEndpointOptions, LocalRuntimeEndpoint } from "./transport/local";

let singleton: RuntimeService | undefined;

/** Process-wide lazy service over the local endpoint. Options apply on first call only. */
export function getOrCreateRuntimeService(opts?: LocalEndpointOptions): RuntimeService {
	singleton ??= new RuntimeService(new LocalRuntimeEndpoint(opts));
	return singleton;
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

export function resetRuntimeServiceForTests(): void {
	singleton = undefined;
}
