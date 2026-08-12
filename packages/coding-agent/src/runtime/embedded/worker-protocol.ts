import type { RuntimeErrorCode } from "../protocol";

export const EMBEDDED_EXECUTION_WORKER_ARG = "__omp_worker_runtime_embed";
export const EMBEDDED_CONTROL_WORKER_ARG = "__omp_worker_runtime_embed_control";
export const EMBEDDED_DIRECT_EXECUTION_WORKER_ARG = "__omp_worker_runtime_embed_direct";
export const EMBEDDED_DIRECT_CONTROL_WORKER_ARG = "__omp_worker_runtime_embed_control_direct";

/**
 * Requests served on the execution worker thread, which owns the native runtime handle.
 *
 * `context-call` joins `call` here because an eval occupies the thread for its whole duration.
 * Every non-eval context op rides `ControlWorkerRequest` instead, which is what makes control
 * operations concurrent with an in-flight eval — and, for a streaming context, what keeps a parked
 * guest write wakeable at all: the runtime imposes no wall-clock deadline on it.
 */
export type ExecutionWorkerRequest =
	| { type: "probe"; id: number }
	| { type: "load"; id: number; libraryPath: string }
	| { type: "open"; id: number; libraryPath: string; request: Uint8Array }
	| { type: "call"; id: number; handle: bigint; request: Uint8Array }
	| { type: "context-call"; id: number; handle: bigint; request: Uint8Array }
	| { type: "close"; id: number; handle: bigint }
	| { type: "unload"; id: number };

/**
 * Requests served on the control worker thread.
 *
 * `context-control` carries an already-encoded `EmbeddedControl` frame, so context
 * open/close/interrupt/cancel/reset/poll-output/describe all arrive through this one op.
 */
export type ControlWorkerRequest =
	| { type: "probe"; id: number }
	| { type: "init"; id: number; libraryPath: string; handle: bigint }
	| { type: "cancel"; id: number; requestId: bigint }
	| { type: "context-control"; id: number; request: Uint8Array }
	| { type: "shutdown"; id: number };

export interface EmbeddedWorkerError {
	code: RuntimeErrorCode;
	message: string;
	data?: Record<string, unknown>;
}

export type ExecutionWorkerResponse =
	| { type: "probed"; id: number }
	| { type: "loaded"; id: number; libraryPath: string; abiVersion: number; schemaHash: string }
	| { type: "opened"; id: number; libraryPath: string; handle: bigint; response: Uint8Array }
	| { type: "called"; id: number; response: Uint8Array }
	| { type: "context-called"; id: number; response: Uint8Array }
	| { type: "closed"; id: number; response: Uint8Array }
	| { type: "unloaded"; id: number }
	| { type: "error"; id: number; error: EmbeddedWorkerError };

export type ControlWorkerResponse =
	| { type: "probed"; id: number }
	| { type: "initialized"; id: number; libraryPath: string }
	| { type: "cancelled"; id: number; response: Uint8Array }
	| { type: "context-controlled"; id: number; response: Uint8Array }
	| { type: "shutdown-complete"; id: number }
	| { type: "error"; id: number; error: EmbeddedWorkerError };

export interface EmbeddedWorkerTransport<Inbound, Outbound> {
	send(message: Outbound, transfer?: Bun.Transferable[]): void;
	onMessage(handler: (message: Inbound) => void): () => void;
	close(): void;
}
