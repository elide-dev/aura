import {
	createRequest,
	type RuntimeAdviceParams,
	type RuntimeBuildParams,
	type RuntimeCheckParams,
	type RuntimeExecResult,
	type RuntimeInsightsParams,
	type RuntimeJvmParams,
	type RuntimeJvmResult,
	type RuntimeLaunchDescriptor,
	type RuntimeMethod,
	type RuntimeProfileParams,
	RuntimeRpcError,
	type RuntimeRpcRequest,
	type RuntimeRpcResponse,
	type RuntimeRunParams,
	type RuntimeRunResult,
	type RuntimeSpawnParams,
	type RuntimeStatusResult,
	unwrapResponse,
} from "./protocol";

export interface RuntimeEndpoint {
	request(req: RuntimeRpcRequest, signal?: AbortSignal): Promise<RuntimeRpcResponse>;
	close?(): Promise<void>;
}

/**
 * The only runtime surface tools see. Speaks the protocol to an endpoint and
 * never knows whether dispatch is per-call subprocess, broker, or in-process.
 */
export class RuntimeService {
	#closed = false;
	#closePromise: Promise<void> | undefined;

	constructor(private readonly endpoint: RuntimeEndpoint) {}

	async #call<T>(method: RuntimeMethod, params: unknown, signal?: AbortSignal): Promise<T> {
		if (this.#closed) throw new RuntimeRpcError("internal", "Runtime service is closed.");
		return unwrapResponse<T>(await this.endpoint.request(createRequest(method, params), signal));
	}

	run(params: RuntimeRunParams, signal?: AbortSignal): Promise<RuntimeRunResult> {
		return this.#call("runtime/run", params, signal);
	}
	check(params: RuntimeCheckParams, signal?: AbortSignal): Promise<RuntimeExecResult> {
		return this.#call("runtime/check", params, signal);
	}
	build(params: RuntimeBuildParams, signal?: AbortSignal): Promise<RuntimeExecResult> {
		return this.#call("runtime/build", params, signal);
	}
	insights(params: RuntimeInsightsParams, signal?: AbortSignal): Promise<RuntimeExecResult> {
		return this.#call("runtime/insights", params, signal);
	}
	profile(params: RuntimeProfileParams, signal?: AbortSignal): Promise<RuntimeExecResult> {
		return this.#call("runtime/profile", params, signal);
	}
	/** One of the six JVM flows; see {@link RuntimeJvmParams.action}. */
	jvm(params: RuntimeJvmParams, signal?: AbortSignal): Promise<RuntimeJvmResult> {
		return this.#call("runtime/jvm", params, signal);
	}
	/**
	 * Compose the command line for a long-running flow (`debug`, `serve`) without
	 * starting anything. The caller starts the returned descriptor through the
	 * `hub` supervisor and owns its lifecycle; nothing here holds a process.
	 */
	spawn(params: RuntimeSpawnParams, signal?: AbortSignal): Promise<RuntimeLaunchDescriptor> {
		return this.#call("runtime/spawn", params, signal);
	}
	/**
	 * The runtime's own build/run/test/install guidance for a project directory.
	 * Read-only, and it runs in the real directory — the guidance is derived from
	 * the manifests it finds there.
	 */
	advice(params: RuntimeAdviceParams, signal?: AbortSignal): Promise<RuntimeExecResult> {
		return this.#call("runtime/advice", params, signal);
	}
	status(): Promise<RuntimeStatusResult> {
		return this.#call("runtime/status", undefined);
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closed = true;
		this.#closePromise = Promise.try(() => this.endpoint.close?.()).then(() => undefined);
		return this.#closePromise;
	}
}
