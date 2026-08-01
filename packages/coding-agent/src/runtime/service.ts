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
import { observeRuntimeCall } from "./telemetry";

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

	async #call<T>(method: RuntimeMethod, params: unknown, signal?: AbortSignal, sessionId?: string): Promise<T> {
		return observeRuntimeCall(method, params, signal, sessionId, async () => {
			if (this.#closed) throw new RuntimeRpcError("internal", "Runtime service is closed.");
			return unwrapResponse<T>(await this.endpoint.request(createRequest(method, params), signal));
		});
	}

	run(params: RuntimeRunParams, signal?: AbortSignal, sessionId?: string): Promise<RuntimeRunResult> {
		return this.#call("runtime/run", params, signal, sessionId);
	}
	check(params: RuntimeCheckParams, signal?: AbortSignal, sessionId?: string): Promise<RuntimeExecResult> {
		return this.#call("runtime/check", params, signal, sessionId);
	}
	build(params: RuntimeBuildParams, signal?: AbortSignal, sessionId?: string): Promise<RuntimeExecResult> {
		return this.#call("runtime/build", params, signal, sessionId);
	}
	insights(params: RuntimeInsightsParams, signal?: AbortSignal, sessionId?: string): Promise<RuntimeExecResult> {
		return this.#call("runtime/insights", params, signal, sessionId);
	}
	profile(params: RuntimeProfileParams, signal?: AbortSignal, sessionId?: string): Promise<RuntimeExecResult> {
		return this.#call("runtime/profile", params, signal, sessionId);
	}
	/** One of the six JVM flows; see {@link RuntimeJvmParams.action}. */
	jvm(params: RuntimeJvmParams, signal?: AbortSignal, sessionId?: string): Promise<RuntimeJvmResult> {
		return this.#call("runtime/jvm", params, signal, sessionId);
	}
	/**
	 * Compose the command line for a long-running flow (`debug`, `serve`) without
	 * starting anything. The caller starts the returned descriptor through the
	 * `hub` supervisor and owns its lifecycle; nothing here holds a process.
	 */
	spawn(params: RuntimeSpawnParams, signal?: AbortSignal, sessionId?: string): Promise<RuntimeLaunchDescriptor> {
		return this.#call("runtime/spawn", params, signal, sessionId);
	}
	/**
	 * The runtime's own build/run/test/install guidance for a project directory.
	 * Read-only, and it runs in the real directory — the guidance is derived from
	 * the manifests it finds there.
	 */
	advice(params: RuntimeAdviceParams, signal?: AbortSignal, sessionId?: string): Promise<RuntimeExecResult> {
		return this.#call("runtime/advice", params, signal, sessionId);
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
