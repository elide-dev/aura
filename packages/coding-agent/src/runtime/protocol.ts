/**
 * Aura runtime capability protocol — a small JSON-RPC 2.0 contract between
 * the RuntimeService (what tools see) and a RuntimeEndpoint (how dispatch
 * happens). The wire shape is the seam: today's endpoint shells the runtime
 * CLI per call; a stdio broker daemon or an in-process endpoint are drop-ins.
 */

/**
 * Version of this contract, surfaced by `runtime/status` (and printed by
 * `aura runtime status`). Informational today — there is no negotiation and no
 * v1 endpoint left in the tree — but it is the honest answer to "what shape is
 * this seam?", which is what a future stdio-broker or in-process endpoint needs.
 *
 * v2 = the shared-workdir generation: one temp directory per request-handler
 * flow with a bound runner, so a single request can be several invocations
 * (compile → run). The multi-invocation methods ride this version.
 */
export const RUNTIME_PROTOCOL_VERSION = 2 as const;

export type RuntimeMethod =
	| "runtime/run"
	| "runtime/check"
	| "runtime/build"
	| "runtime/insights"
	| "runtime/profile"
	| "runtime/status";

export type RuntimeLanguage = "js" | "ts" | "python";

export interface RuntimeRunParams {
	/** Inline source; mutually exclusive with `path`. Written to a temp file (stdin source mode is unsupported by the runtime). */
	code?: string;
	/** Existing file to run; preserves project cwd/imports. */
	path?: string;
	/** Language for inline code (default "ts"); inferred from the extension in path mode. */
	language?: RuntimeLanguage;
	args?: string[];
	stdin?: string;
	timeoutMs?: number;
	cwd?: string;
}

export interface RuntimeInsightsParams extends RuntimeRunParams {
	/** Inline insight instrumentation script (JS). */
	insight?: string;
	/** Existing insight script path. */
	insightPath?: string;
}

export interface RuntimeProfileParams extends RuntimeRunParams {
	mode: "cputracing" | "cpusampling";
}

export interface RuntimeBuildParams {
	/** ':'-prefixed build targets with scoped options, passed through verbatim. */
	targets?: string[];
	cwd?: string;
	timeoutMs?: number;
}

/** v1: check = validation build (resolve + compile, no artifacts requested). */
export type RuntimeCheckParams = RuntimeBuildParams;

export interface RuntimeExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
	killed: boolean;
}

export type RuntimeSource = "flag" | "env" | "managed" | "path";

export interface RuntimeStatusResult {
	available: boolean;
	version?: string;
	binaryPath?: string;
	source?: RuntimeSource;
	guidance?: string;
	protocolVersion: number;
}

export type RuntimeErrorCode =
	| "runtime-missing"
	| "download-failed"
	| "timeout"
	| "invalid-params"
	| "cancelled"
	| "internal";

export class RuntimeRpcError extends Error {
	constructor(
		readonly code: RuntimeErrorCode,
		message: string,
		readonly data?: Record<string, unknown>,
	) {
		super(message);
		this.name = "RuntimeRpcError";
	}
}

export interface RuntimeRpcRequest {
	jsonrpc: "2.0";
	id: number;
	method: RuntimeMethod;
	params: unknown;
}

export type RuntimeRpcResponse =
	| { jsonrpc: "2.0"; id: number; result: unknown }
	| { jsonrpc: "2.0"; id: number; error: { code: RuntimeErrorCode; message: string; data?: Record<string, unknown> } };

let nextRequestId = 1;

export function createRequest(method: RuntimeMethod, params: unknown): RuntimeRpcRequest {
	return { jsonrpc: "2.0", id: nextRequestId++, method, params };
}

export function okResponse(id: number, result: unknown): RuntimeRpcResponse {
	return { jsonrpc: "2.0", id, result };
}

export function errorResponse(id: number, err: RuntimeRpcError): RuntimeRpcResponse {
	return { jsonrpc: "2.0", id, error: { code: err.code, message: err.message, data: err.data } };
}

export function unwrapResponse<T>(res: RuntimeRpcResponse): T {
	if ("error" in res) {
		throw new RuntimeRpcError(res.error.code, res.error.message, res.error.data);
	}
	return res.result as T;
}
