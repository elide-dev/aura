import type { RuntimeErrorCode } from "../protocol";

export const EMBEDDED_EXECUTION_WORKER_ARG = "__omp_worker_runtime_embed";
export const EMBEDDED_CONTROL_WORKER_ARG = "__omp_worker_runtime_embed_control";

export type ExecutionWorkerRequest =
	| { type: "probe"; id: number }
	| { type: "open"; id: number; libraryPath: string; request: Uint8Array }
	| { type: "call"; id: number; handle: bigint; request: Uint8Array }
	| { type: "close"; id: number; handle: bigint };

export type ControlWorkerRequest =
	| { type: "probe"; id: number }
	| { type: "init"; id: number; libraryPath: string; handle: bigint }
	| { type: "cancel"; id: number; requestId: bigint }
	| { type: "shutdown"; id: number };

export interface EmbeddedWorkerError {
	code: RuntimeErrorCode;
	message: string;
	data?: Record<string, unknown>;
}

export type ExecutionWorkerResponse =
	| { type: "probed"; id: number }
	| { type: "opened"; id: number; libraryPath: string; handle: bigint; response: Uint8Array }
	| { type: "called"; id: number; response: Uint8Array }
	| { type: "closed"; id: number; response: Uint8Array }
	| { type: "error"; id: number; error: EmbeddedWorkerError };

export type ControlWorkerResponse =
	| { type: "probed"; id: number }
	| { type: "initialized"; id: number; libraryPath: string }
	| { type: "cancelled"; id: number; response: Uint8Array }
	| { type: "shutdown-complete"; id: number }
	| { type: "error"; id: number; error: EmbeddedWorkerError };

export interface EmbeddedWorkerTransport<Inbound, Outbound> {
	send(message: Outbound, transfer?: Bun.Transferable[]): void;
	onMessage(handler: (message: Inbound) => void): () => void;
	close(): void;
}
