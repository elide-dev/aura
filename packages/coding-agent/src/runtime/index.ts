export * from "./dist";
export * from "./embedded/resolve";
export * from "./jvm";
export * from "./protocol";
export * from "./provision";
export * from "./resolve";
export * from "./service";
export * from "./transport/embedded";
export * from "./transport/local";
export * from "./transport/selected";

import { logger } from "@oh-my-pi/pi-utils";
import { type RuntimeAdapter, RuntimeRpcError } from "./protocol";
import { RuntimeService } from "./service";
import { type SelectedEndpointOptions, SelectedRuntimeEndpoint } from "./transport/selected";

interface CachedRuntimeService {
	key: string;
	service: RuntimeService;
}

interface RuntimeServiceScopeState {
	cached: CachedRuntimeService | undefined;
	leases: number;
	retirements: Map<RuntimeService, Promise<void>>;
	accepting: boolean;
}

const DEFAULT_RUNTIME_SERVICE_SCOPE = {};
const runtimeServiceScopes = new WeakMap<object, RuntimeServiceScopeState>();
const liveRuntimeServiceScopes = new Set<object>();

/** Stable cache key over every setting that changes endpoint selection or resolution. */
function serviceCacheKey(options: SelectedEndpointOptions = {}): string {
	return JSON.stringify({
		adapter: options.adapter ?? "process",
		embeddedPath: options.embeddedPath ?? null,
		explicitPath: options.explicitPath ?? null,
		version: options.version ?? null,
		autoDownload: options.autoDownload ?? null,
	});
}

/** Root-owned runtime cache identity and live configuration source shared by its descendants. */
export interface RuntimeServiceScope {
	readSettings(): RuntimeSettingsValues;
}

/**
 * Runtime services are memoized by the options that affect adapter selection or
 * runtime discovery (`adapter`, `embeddedPath`, `explicitPath`, `version`, and
 * `autoDownload`). A changed key publishes the replacement first, then retires
 * the old endpoint without blocking its caller.
 *
 * Callers that vary unkeyed environment, progress, or test-injection options
 * must construct the service directly instead.
 */
export function getOrCreateRuntimeService(
	options: SelectedEndpointOptions = {},
	onCreate?: (service: RuntimeService) => void,
	scope: object = DEFAULT_RUNTIME_SERVICE_SCOPE,
): RuntimeService {
	const state = runtimeServiceScopeState(scope);
	assertRuntimeServiceScopeActive(scope, state);
	const key = serviceCacheKey(options);
	if (state.cached?.key === key) return state.cached.service;
	const retired = state.cached?.service;
	const service = new RuntimeService(new SelectedRuntimeEndpoint(options));
	state.cached = { key, service };
	onCreate?.(service);
	if (retired) void retireRuntimeService(scope, state, retired, "after settings change");
	return service;
}

/**
 * Register one top-level session against a settings scope. The returned release
 * is idempotent and closes that scope only after its final lease is released.
 */
export function acquireRuntimeServiceLease(scope: object = DEFAULT_RUNTIME_SERVICE_SCOPE): () => Promise<void> {
	const state = runtimeServiceScopeState(scope);
	if (!state.accepting) throw new RuntimeRpcError("internal", "Runtime service scope is closed.");
	state.leases += 1;
	let released = false;
	return async () => {
		if (released) return;
		released = true;
		state.leases -= 1;
		if (state.leases !== 0) return;
		state.accepting = false;
		await drainRuntimeServiceScope(scope, state, false);
	};
}

/** Atomically evict and asynchronously retire the service for one settings scope. */
export function disableCachedRuntimeService(scope: object = DEFAULT_RUNTIME_SERVICE_SCOPE): Promise<void> {
	const state = runtimeServiceScopes.get(scope);
	if (state) assertRuntimeServiceScopeActive(scope, state);
	const target = state?.cached?.service;
	if (!state || !target) return Promise.resolve();
	state.cached = undefined;
	return retireRuntimeService(scope, state, target, "after runtime was disabled");
}

/**
 * Atomically evict and then close a cached service. Supplying a retired service
 * closes only that instance and cannot evict a newer replacement.
 */
export async function disposeCachedRuntimeService(
	service?: RuntimeService,
	scope: object = DEFAULT_RUNTIME_SERVICE_SCOPE,
): Promise<void> {
	if (service) {
		for (const candidateScope of liveRuntimeServiceScopes) {
			const state = runtimeServiceScopes.get(candidateScope);
			if (!state) continue;
			const pending = state.retirements.get(service);
			if (pending) {
				await pending;
				return;
			}
			if (state.cached?.service !== service) continue;
			state.cached = undefined;
			await retireRuntimeService(candidateScope, state, service, "during explicit disposal");
			return;
		}
		await service.close();
		return;
	}

	const state = runtimeServiceScopes.get(scope);
	if (!state) return;
	await drainRuntimeServiceScope(scope, state, true);
}

function assertRuntimeServiceScopeActive(scope: object, state: RuntimeServiceScopeState): void {
	if (!state.accepting || (scope !== DEFAULT_RUNTIME_SERVICE_SCOPE && state.leases === 0)) {
		throw new RuntimeRpcError("internal", "Runtime service scope is closed.");
	}
}

function runtimeServiceScopeState(scope: object): RuntimeServiceScopeState {
	const existing = runtimeServiceScopes.get(scope);
	if (existing) return existing;
	const created: RuntimeServiceScopeState = {
		cached: undefined,
		leases: 0,
		retirements: new Map(),
		accepting: true,
	};
	runtimeServiceScopes.set(scope, created);
	liveRuntimeServiceScopes.add(scope);
	return created;
}

function forgetRuntimeServiceScope(scope: object, state: RuntimeServiceScopeState): void {
	if (state.cached || state.leases !== 0 || state.retirements.size !== 0) return;
	if (runtimeServiceScopes.get(scope) !== state) return;
	if (state.accepting) runtimeServiceScopes.delete(scope);
	liveRuntimeServiceScopes.delete(scope);
}

function retireRuntimeService(
	scope: object,
	state: RuntimeServiceScopeState,
	service: RuntimeService,
	context: string,
): Promise<void> {
	const existing = state.retirements.get(service);
	if (existing) return existing;
	const closing = service.close();
	state.retirements.set(service, closing);
	void closing.catch(error => {
		logger.warn(`Failed to close retired runtime service ${context}`, { error: String(error) });
	});
	void closing
		.finally(() => {
			if (state.retirements.get(service) === closing) state.retirements.delete(service);
			forgetRuntimeServiceScope(scope, state);
		})
		.catch(() => undefined);
	return closing;
}

async function drainRuntimeServiceScope(scope: object, state: RuntimeServiceScopeState, force: boolean): Promise<void> {
	const failures: unknown[] = [];
	while (force || state.leases === 0) {
		const current = state.cached?.service;
		state.cached = undefined;
		if (current) retireRuntimeService(scope, state, current, "during scope disposal");
		const pending = [...state.retirements.values()];
		if (pending.length === 0) break;
		const results = await Promise.allSettled(pending);
		for (const result of results) {
			if (result.status === "rejected") failures.push(result.reason);
		}
		if (!force && state.leases !== 0) break;
	}
	forgetRuntimeServiceScope(scope, state);
	if (failures.length !== 0) throw new AggregateError(failures, "Failed to close runtime service scope.");
}

/** Runtime settings as read from the `runtime.*` settings group. */
export interface RuntimeSettingsValues {
	enabled: boolean;
	autoDownload: boolean;
	/** Explicit binary path; empty/whitespace means "discover". An explicit path disables auto-download. */
	path: string;
	/**
	 * Managed-install version to select; empty/whitespace means the pinned
	 * default. An off-pin version is never downloaded (no published checksum) —
	 * it selects an install the user placed themselves.
	 */
	version: string;
	/** Requested execution adapter. Process remains the default. */
	adapter: RuntimeAdapter;
	/** Explicit embedded runtime library path; empty/whitespace means "discover". */
	embeddedPath: string;
}

export function runtimeAdapterFromEnvironment(
	configured: RuntimeAdapter,
	env: Readonly<Record<string, string | undefined>> = process.env,
): RuntimeAdapter {
	const value = env.AURA_RUNTIME_ADAPTER?.trim();
	if (!value) return configured;
	if (value === "process" || value === "embedded" || value === "auto") return value;
	throw new RuntimeRpcError(
		"invalid-params",
		`AURA_RUNTIME_ADAPTER must be process, embedded, or auto; received ${JSON.stringify(value)}.`,
	);
}

/**
 * Map runtime settings onto selected endpoint options. Returns `undefined` when
 * the runtime is disabled, which is the signal to expose no service at all.
 */
export function resolveRuntimeEndpointOptions(values: RuntimeSettingsValues): SelectedEndpointOptions | undefined {
	if (!values.enabled) return undefined;
	const explicit = values.path.trim();
	const version = values.version.trim();
	const embedded = values.embeddedPath.trim();
	return {
		adapter: values.adapter,
		autoDownload: values.autoDownload,
		...(explicit === "" ? {} : { explicitPath: explicit }),
		...(version === "" ? {} : { version }),
		...(embedded === "" ? {} : { embeddedPath: embedded }),
	};
}

/** Drop every memoized test scope and begin all endpoint teardown without waiting. */
export function resetRuntimeServiceForTests(): void {
	for (const scope of liveRuntimeServiceScopes) {
		const state = runtimeServiceScopes.get(scope);
		if (!state) continue;
		const service = state.cached?.service;
		state.cached = undefined;
		if (service) void retireRuntimeService(scope, state, service, "during test reset");
		runtimeServiceScopes.delete(scope);
	}
	liveRuntimeServiceScopes.clear();
	runtimeServiceScopes.delete(DEFAULT_RUNTIME_SERVICE_SCOPE);
}
