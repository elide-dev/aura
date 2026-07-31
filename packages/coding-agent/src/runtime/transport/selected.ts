import {
	errorResponse,
	okResponse,
	RUNTIME_PROTOCOL_VERSION,
	type RuntimeAdapter,
	RuntimeRpcError,
	type RuntimeRpcRequest,
	type RuntimeRpcResponse,
	type RuntimeRunParams,
	type RuntimeStatusResult,
	resolveRunTarget,
	toRuntimeRpcError,
} from "../protocol";
import type { RuntimeEndpoint } from "../service";
import { BunRuntimeEndpoint } from "./bun";
import { EmbeddedRuntimeEndpoint, isEmbeddedRunRequest } from "./embedded";
import { type LocalEndpointOptions, LocalRuntimeEndpoint } from "./local";

export interface SelectedEndpointOptions extends LocalEndpointOptions {
	adapter?: RuntimeAdapter;
	embeddedPath?: string;
	processEndpoint?: RuntimeEndpoint;
	embeddedEndpoint?: RuntimeEndpoint;
	bunEndpoint?: RuntimeEndpoint;
}

interface AutoRunPreflight {
	readonly request: RuntimeRpcRequest;
	readonly ready: Promise<unknown>;
}

interface QueuedAutoRun {
	readonly preflight: AutoRunPreflight;
	readonly signal: AbortSignal | undefined;
	readonly resolve: (response: RuntimeRpcResponse) => void;
	queuedAbort: (() => void) | undefined;
}

export class SelectedRuntimeEndpoint implements RuntimeEndpoint {
	readonly #adapter: RuntimeAdapter;
	readonly #process: RuntimeEndpoint;
	readonly #embedded: RuntimeEndpoint;
	readonly #bun: RuntimeEndpoint;
	readonly #autoQueue: QueuedAutoRun[] = [];
	#autoDrain: Promise<void> | undefined;
	#closing = false;
	#closePromise: Promise<void> | undefined;

	constructor(options: SelectedEndpointOptions = {}) {
		this.#adapter = options.adapter ?? "process";
		this.#process = options.processEndpoint ?? new LocalRuntimeEndpoint(options);
		this.#embedded =
			options.embeddedEndpoint ??
			new EmbeddedRuntimeEndpoint({
				embeddedPath: options.embeddedPath,
				explicitPath: options.explicitPath,
				env: options.env,
				resolveRuntime: options.resolve,
			});
		this.#bun = options.bunEndpoint ?? new BunRuntimeEndpoint({ env: options.env });
	}

	async request(request: RuntimeRpcRequest, signal?: AbortSignal): Promise<RuntimeRpcResponse> {
		if (this.#closing) {
			return errorResponse(request.id, new RuntimeRpcError("internal", "Runtime endpoint is closed."));
		}
		if (request.method === "runtime/status") return this.#statusResponse(request);
		if (request.method === "runtime/run") {
			try {
				const target = resolveRunTarget(request.params as RuntimeRunParams);
				if (target.engine === "bun") return this.#bun.request(request, signal);
			} catch (error) {
				return errorResponse(request.id, toRuntimeRpcError(error));
			}
		}
		if (!isEmbeddedRunRequest(request) || this.#adapter === "process") {
			return this.#process.request(request, signal);
		}
		if (this.#adapter === "embedded") return this.#embedded.request(request, signal);
		return this.#enqueueAuto(request, signal);
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closing = true;
		for (const queued of this.#autoQueue.splice(0)) {
			if (queued.queuedAbort) queued.signal?.removeEventListener("abort", queued.queuedAbort);
			queued.resolve(
				errorResponse(queued.preflight.request.id, new RuntimeRpcError("internal", "Runtime endpoint is closed.")),
			);
		}
		this.#closePromise = this.#closeEndpoints();
		return this.#closePromise;
	}

	async #closeEndpoints(): Promise<void> {
		if (this.#autoDrain) await Promise.allSettled([this.#autoDrain]);
		const endpoints = [...new Set([this.#process, this.#embedded, this.#bun])];
		const results = await Promise.allSettled(endpoints.map(endpoint => endpoint.close?.() ?? Promise.resolve()));
		const failure = results.find(result => result.status === "rejected");
		if (failure?.status === "rejected") throw failure.reason;
	}

	#enqueueAuto(request: RuntimeRpcRequest, signal: AbortSignal | undefined): Promise<RuntimeRpcResponse> {
		const preflight: AutoRunPreflight =
			this.#embedded instanceof EmbeddedRuntimeEndpoint
				? this.#embedded.preflightRunRequest(request)
				: { request: snapshotRunRequest(request), ready: Promise.resolve() };
		// Preflight starts before FIFO dispatch. Observe it immediately so a later
		// invalid item cannot become an unhandled rejection while a slow head
		// blocks the drain, or after abort/close removes it from the queue.
		void preflight.ready.catch(() => undefined);
		const pending = Promise.withResolvers<RuntimeRpcResponse>();
		const queued: QueuedAutoRun = {
			preflight,
			signal,
			resolve: pending.resolve,
			queuedAbort: undefined,
		};
		if (signal) {
			queued.queuedAbort = () => {
				const index = this.#autoQueue.indexOf(queued);
				if (index < 0) return;
				this.#autoQueue.splice(index, 1);
				pending.resolve(
					errorResponse(
						preflight.request.id,
						new RuntimeRpcError("cancelled", "Runtime execution was cancelled."),
					),
				);
			};
			signal.addEventListener("abort", queued.queuedAbort, { once: true });
		}
		this.#autoQueue.push(queued);
		this.#startAutoDrain();
		return pending.promise;
	}

	#startAutoDrain(): void {
		if (this.#autoDrain) return;
		const settled = Promise.withResolvers<void>();
		this.#autoDrain = settled.promise;
		void this.#drainAutoQueue()
			.then(settled.resolve, settled.reject)
			.finally(() => {
				if (this.#autoDrain === settled.promise) this.#autoDrain = undefined;
				if (this.#autoQueue.length > 0 && !this.#closing) this.#startAutoDrain();
			});
	}

	async #drainAutoQueue(): Promise<void> {
		while (!this.#closing) {
			const queued = this.#autoQueue.shift();
			if (!queued) return;
			if (queued.queuedAbort) queued.signal?.removeEventListener("abort", queued.queuedAbort);
			queued.queuedAbort = undefined;
			if (queued.signal?.aborted) {
				queued.resolve(
					errorResponse(
						queued.preflight.request.id,
						new RuntimeRpcError("cancelled", "Runtime execution was cancelled."),
					),
				);
				continue;
			}
			try {
				await queued.preflight.ready;
			} catch (error) {
				queued.resolve(errorResponse(queued.preflight.request.id, toRuntimeRpcError(error)));
				continue;
			}
			if (queued.signal?.aborted) {
				queued.resolve(
					errorResponse(
						queued.preflight.request.id,
						new RuntimeRpcError("cancelled", "Runtime execution was cancelled."),
					),
				);
				continue;
			}
			if (this.#closing) {
				queued.resolve(
					errorResponse(
						queued.preflight.request.id,
						new RuntimeRpcError("internal", "Runtime endpoint is closed."),
					),
				);
				continue;
			}
			let embeddedStatus: RuntimeStatusResult;
			try {
				embeddedStatus = await this.#endpointStatus(this.#embedded, queued.preflight.request.id);
			} catch (error) {
				queued.resolve(errorResponse(queued.preflight.request.id, toRuntimeRpcError(error)));
				continue;
			}
			if (this.#closing) {
				queued.resolve(
					errorResponse(
						queued.preflight.request.id,
						new RuntimeRpcError("internal", "Runtime endpoint is closed."),
					),
				);
				continue;
			}
			const endpoint =
				embeddedStatus.available || embeddedStatus.embeddedLibraryPath !== undefined
					? this.#embedded
					: this.#process;
			void (async () => {
				const response = await endpoint.request(queued.preflight.request, queued.signal);
				if (endpoint === this.#embedded && isUnsupportedEmbeddedLanguage(response)) {
					return this.#process.request(queued.preflight.request, queued.signal);
				}
				return response;
			})().then(queued.resolve, error => {
				queued.resolve(errorResponse(queued.preflight.request.id, toRuntimeRpcError(error)));
			});
		}
	}

	async #statusResponse(request: RuntimeRpcRequest): Promise<RuntimeRpcResponse> {
		try {
			const processStatusPromise = this.#endpointStatus(this.#process, request.id);
			if (this.#adapter === "process") {
				const processStatus = await processStatusPromise;
				return okResponse(request.id, {
					...processStatus,
					adapter: "process",
					effectiveAdapter: "process",
				});
			}

			const [processResult, embeddedResult] = await Promise.allSettled([
				processStatusPromise,
				this.#endpointStatus(this.#embedded, request.id),
			]);
			if (embeddedResult.status === "rejected") throw embeddedResult.reason;
			const embeddedStatus = embeddedResult.value;
			const candidate = embeddedStatus.available || embeddedStatus.embeddedLibraryPath !== undefined;
			if (this.#adapter === "auto" && !candidate) {
				if (processResult.status === "rejected") throw processResult.reason;
				return okResponse(request.id, {
					...processResult.value,
					adapter: "auto",
					effectiveAdapter: "process",
				});
			}

			const processMetadata =
				processResult.status === "fulfilled"
					? {
							...(processResult.value.version === undefined ? {} : { version: processResult.value.version }),
							...(processResult.value.binaryPath === undefined
								? {}
								: { binaryPath: processResult.value.binaryPath }),
							...(processResult.value.source === undefined ? {} : { source: processResult.value.source }),
						}
					: {};
			return okResponse(request.id, {
				...embeddedStatus,
				...processMetadata,
				available: embeddedStatus.available,
				guidance: embeddedStatus.guidance,
				protocolVersion: RUNTIME_PROTOCOL_VERSION,
				adapter: this.#adapter,
				effectiveAdapter: "embedded",
			});
		} catch (error) {
			return errorResponse(request.id, toRuntimeRpcError(error));
		}
	}

	async #endpointStatus(endpoint: RuntimeEndpoint, id: number): Promise<RuntimeStatusResult> {
		const response = await endpoint.request({ jsonrpc: "2.0", id, method: "runtime/status", params: undefined });
		if ("error" in response) {
			throw new RuntimeRpcError(response.error.code, response.error.message, response.error.data);
		}
		return response.result as RuntimeStatusResult;
	}
}

function isUnsupportedEmbeddedLanguage(response: RuntimeRpcResponse): boolean {
	if (!("error" in response)) return false;
	const data = response.error.data;
	return (
		data !== null &&
		typeof data === "object" &&
		!Array.isArray(data) &&
		(data as Record<string, unknown>).failureCode === "unsupported-language"
	);
}
function snapshotRunRequest(request: RuntimeRpcRequest): RuntimeRpcRequest {
	const params = request.params;
	if (params === null || typeof params !== "object") return request;
	if (Array.isArray(params)) return { ...request, params: [...params] };
	const raw = params as Record<string, unknown>;
	const args = raw.args;
	const stdin = raw.stdin;
	return {
		...request,
		params: {
			code: raw.code,
			path: raw.path,
			language: raw.language,
			args: Array.isArray(args) ? [...args] : args,
			stdin: stdin instanceof Uint8Array ? new Uint8Array(stdin) : stdin,
			timeoutMs: raw.timeoutMs,
			cwd: raw.cwd === undefined ? process.cwd() : raw.cwd,
		},
	};
}
