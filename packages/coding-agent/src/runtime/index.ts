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

export function resetRuntimeServiceForTests(): void {
	singleton = undefined;
}
