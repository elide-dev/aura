import {
	createRequest,
	type RuntimeBuildParams,
	type RuntimeCheckParams,
	type RuntimeExecResult,
	type RuntimeInsightsParams,
	type RuntimeMethod,
	type RuntimeProfileParams,
	type RuntimeRpcRequest,
	type RuntimeRpcResponse,
	type RuntimeRunParams,
	type RuntimeStatusResult,
	unwrapResponse,
} from "./protocol";

export interface RuntimeEndpoint {
	request(req: RuntimeRpcRequest, signal?: AbortSignal): Promise<RuntimeRpcResponse>;
}

/**
 * The only runtime surface tools see. Speaks the protocol to an endpoint and
 * never knows whether dispatch is per-call subprocess, broker, or in-process.
 */
export class RuntimeService {
	constructor(private readonly endpoint: RuntimeEndpoint) {}

	private async call<T>(method: RuntimeMethod, params: unknown, signal?: AbortSignal): Promise<T> {
		return unwrapResponse<T>(await this.endpoint.request(createRequest(method, params), signal));
	}

	run(params: RuntimeRunParams, signal?: AbortSignal): Promise<RuntimeExecResult> {
		return this.call("runtime/run", params, signal);
	}
	check(params: RuntimeCheckParams, signal?: AbortSignal): Promise<RuntimeExecResult> {
		return this.call("runtime/check", params, signal);
	}
	build(params: RuntimeBuildParams, signal?: AbortSignal): Promise<RuntimeExecResult> {
		return this.call("runtime/build", params, signal);
	}
	insights(params: RuntimeInsightsParams, signal?: AbortSignal): Promise<RuntimeExecResult> {
		return this.call("runtime/insights", params, signal);
	}
	profile(params: RuntimeProfileParams, signal?: AbortSignal): Promise<RuntimeExecResult> {
		return this.call("runtime/profile", params, signal);
	}
	status(): Promise<RuntimeStatusResult> {
		return this.call("runtime/status", undefined);
	}
}
