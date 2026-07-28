import * as path from "node:path";
import {
	errorResponse,
	okResponse,
	RUNTIME_PROTOCOL_VERSION,
	type RuntimeAdapter,
	RuntimeRpcError,
	type RuntimeRpcRequest,
	type RuntimeRpcResponse,
	type RuntimeStatusResult,
} from "../protocol";
import type { RuntimeEndpoint } from "../service";
import { EmbeddedRuntimeEndpoint } from "./embedded";
import { type LocalEndpointOptions, LocalRuntimeEndpoint } from "./local";

export interface SelectedEndpointOptions extends LocalEndpointOptions {
	adapter?: RuntimeAdapter;
	embeddedPath?: string;
	processEndpoint?: RuntimeEndpoint;
	embeddedEndpoint?: RuntimeEndpoint;
}

export class SelectedRuntimeEndpoint implements RuntimeEndpoint {
	readonly #adapter: RuntimeAdapter;
	readonly #process: RuntimeEndpoint;
	readonly #embedded: RuntimeEndpoint;
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
	}

	async request(request: RuntimeRpcRequest, signal?: AbortSignal): Promise<RuntimeRpcResponse> {
		if (this.#closing) {
			return errorResponse(request.id, new RuntimeRpcError("internal", "Runtime endpoint is closed."));
		}
		if (request.method === "runtime/status") return this.#statusResponse(request);
		if (request.method !== "runtime/run" || this.#adapter === "process" || isJvmRun(request.params)) {
			return this.#process.request(request, signal);
		}
		if (this.#adapter === "embedded") return this.#embedded.request(request, signal);
		try {
			const embeddedStatus = await this.#endpointStatus(this.#embedded, request.id);
			return embeddedStatus.available || embeddedStatus.embeddedLibraryPath !== undefined
				? this.#embedded.request(request, signal)
				: this.#process.request(request, signal);
		} catch (error) {
			return errorResponse(request.id, runtimeError(error));
		}
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closing = true;
		this.#closePromise = this.#closeEndpoints();
		return this.#closePromise;
	}

	async #closeEndpoints(): Promise<void> {
		const endpoints = this.#process === this.#embedded ? [this.#process] : [this.#process, this.#embedded];
		const results = await Promise.allSettled(
			endpoints.map(endpoint => endpoint.close?.() ?? Promise.resolve()),
		);
		const failure = results.find(result => result.status === "rejected");
		if (failure?.status === "rejected") throw failure.reason;
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
			return errorResponse(request.id, runtimeError(error));
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

function isJvmRun(params: unknown): boolean {
	if (params === null || typeof params !== "object" || Array.isArray(params)) return false;
	const raw = params as Record<string, unknown>;
	if (raw.language === "java" || raw.language === "kotlin") return true;
	if (raw.language !== undefined) return false;
	if (typeof raw.path !== "string") return false;
	const extension = path.extname(raw.path).toLowerCase();
	return extension === ".java" || extension === ".kt" || extension === ".kts";
}

function runtimeError(error: unknown): RuntimeRpcError {
	if (error instanceof RuntimeRpcError) return error;
	return new RuntimeRpcError("internal", error instanceof Error ? error.message : String(error));
}
