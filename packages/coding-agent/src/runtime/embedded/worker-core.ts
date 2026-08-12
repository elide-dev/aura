import * as path from "node:path";
import { logger, workerHostEntry } from "@oh-my-pi/pi-utils";
import { formatDisplayPath } from "../../utils/display-path";
import { RuntimeRpcError } from "../protocol";
import { type EmbeddedNativeLibrary, openEmbeddedNativeLibrary } from "./abi";
import {
	decodeEmbeddedResponse,
	type EmbeddedDecodedResponse,
	EmbeddedFailureCode,
	type EmbeddedOutputChunk,
	encodeContextControl,
} from "./codec";
import {
	type ControlWorkerRequest,
	type ControlWorkerResponse,
	EMBEDDED_CONTROL_WORKER_ARG,
	EMBEDDED_DIRECT_CONTROL_WORKER_ARG,
	EMBEDDED_DIRECT_EXECUTION_WORKER_ARG,
	EMBEDDED_EXECUTION_WORKER_ARG,
	type EmbeddedWorkerError,
	type EmbeddedWorkerTransport,
	type ExecutionWorkerRequest,
	type ExecutionWorkerResponse,
} from "./worker-protocol";

const MAX_UINT64 = (1n << 64n) - 1n;

function validRuntimeHandle(handle: bigint): boolean {
	return handle > 0n && handle <= MAX_UINT64;
}

function validateOpenResponse(handle: bigint, bytes: Uint8Array): void {
	const response = decodeEmbeddedResponse(bytes, 0n);
	if (response.type === "failure") {
		throw new RuntimeRpcError("internal", response.message || "Embedded runtime open failed.", {
			failureCode: response.code,
		});
	}
	if (response.type !== "opened") {
		throw new RuntimeRpcError("internal", "Embedded runtime returned an invalid open response.", {
			responseType: response.type,
		});
	}
	if (!validRuntimeHandle(handle)) {
		throw new RuntimeRpcError(
			"internal",
			"Embedded runtime opened response requires a valid nonzero runtime handle.",
			{
				handle: handle.toString(),
			},
		);
	}
}

function resolvedLibraryDisplayPath(libraryPath: string): string {
	return formatDisplayPath(path.resolve(libraryPath));
}

function loadEmbeddedNativeLibrary(
	openLibrary: EmbeddedNativeLibraryFactory,
	libraryPath: string,
): EmbeddedNativeLibrary {
	try {
		return openLibrary(libraryPath);
	} catch (error) {
		if (error instanceof RuntimeRpcError) throw error;
		logger.error("Failed to load embedded runtime library", { error, libraryPath });
		const displayPath = resolvedLibraryDisplayPath(libraryPath);
		throw new RuntimeRpcError(
			"runtime-missing",
			`Failed to load the embedded runtime library at ${displayPath}. Install a compatible Aura runtime or point runtime.embeddedPath or AURA_RUNTIME_EMBEDDED_LIB at a compatible library.`,
			{ path: displayPath },
		);
	}
}

export type EmbeddedNativeLibraryFactory = (path: string) => EmbeddedNativeLibrary;
export type EmbeddedResponseValidator = (bytes: Uint8Array, expectedRequestId: bigint) => void;

export interface EmbeddedWorkerHandle<Request, Response> {
	send(message: Request, transfer?: Bun.Transferable[]): void;
	onMessage(handler: (message: Response) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	onExit(handler: () => void): () => void;
	terminate(): Promise<void>;
}

export interface EmbeddedWorkerFactories {
	createExecutionWorker(): EmbeddedWorkerHandle<ExecutionWorkerRequest, ExecutionWorkerResponse>;
	createControlWorker(): EmbeddedWorkerHandle<ControlWorkerRequest, ControlWorkerResponse>;
}

interface PendingResponse<Response> {
	resolve(response: Response): void;
	reject(error: unknown): void;
}

function serializedError(error: unknown): EmbeddedWorkerError {
	if (error instanceof RuntimeRpcError) {
		return { code: error.code, message: error.message, ...(error.data ? { data: error.data } : {}) };
	}
	logger.error("Embedded runtime worker operation failed", { error });
	return { code: "internal", message: "Embedded runtime worker operation failed." };
}

function restoredError(error: EmbeddedWorkerError): RuntimeRpcError {
	return new RuntimeRpcError(error.code, error.message, error.data);
}

function transferBytes(bytes: Uint8Array): { bytes: Uint8Array; transfer: Bun.Transferable[] } {
	const buffer = bytes.buffer;
	if (buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === buffer.byteLength) {
		return { bytes, transfer: [buffer] };
	}
	const owned = bytes.slice();
	if (!(owned.buffer instanceof ArrayBuffer)) {
		throw new RuntimeRpcError("internal", "Embedded runtime worker could not create a transferable byte buffer.");
	}
	return { bytes: owned, transfer: [owned.buffer] };
}

export class ExecutionWorkerCore {
	readonly #transport: EmbeddedWorkerTransport<ExecutionWorkerRequest, ExecutionWorkerResponse>;
	readonly #openLibrary: EmbeddedNativeLibraryFactory;
	#library: EmbeddedNativeLibrary | undefined;
	#handle: bigint | undefined;
	#tail: Promise<void> = Promise.resolve();

	constructor(
		transport: EmbeddedWorkerTransport<ExecutionWorkerRequest, ExecutionWorkerResponse>,
		openLibrary: EmbeddedNativeLibraryFactory = openEmbeddedNativeLibrary,
	) {
		this.#transport = transport;
		this.#openLibrary = openLibrary;
		transport.onMessage(message => this.#onMessage(message));
	}

	#onMessage(message: ExecutionWorkerRequest): void {
		if (message.type === "probe") {
			this.#transport.send({ type: "probed", id: message.id });
			return;
		}
		const run = (): void => {
			try {
				switch (message.type) {
					case "load":
						this.#load(message);
						break;
					case "open":
						this.#open(message);
						break;
					case "call":
						this.#call(message);
						break;
					case "context-call":
						this.#contextCall(message);
						break;
					case "close":
						this.#close(message);
						break;
					case "unload":
						this.#unload(message);
						break;
				}
			} catch (error) {
				try {
					this.#transport.send({ type: "error", id: message.id, error: serializedError(error) });
				} catch (sendError) {
					logger.error("Failed to publish embedded runtime execution worker error", { error: sendError });
				}
			}
		};
		this.#tail = this.#tail.then(run, run);
	}

	#load(message: Extract<ExecutionWorkerRequest, { type: "load" }>): void {
		if (this.#handle !== undefined) {
			throw new RuntimeRpcError("internal", "Embedded runtime execution worker cannot load over an open runtime.");
		}
		const retained = this.#library;
		if (retained) {
			if (retained.path !== message.libraryPath) {
				throw new RuntimeRpcError("internal", "Embedded runtime execution worker cannot replace a loaded library.");
			}
			this.#transport.send({
				type: "loaded",
				id: message.id,
				libraryPath: retained.path,
				abiVersion: retained.abiVersion,
				schemaHash: retained.schemaHash,
			});
			return;
		}
		const library = loadEmbeddedNativeLibrary(this.#openLibrary, message.libraryPath);
		try {
			this.#transport.send({
				type: "loaded",
				id: message.id,
				libraryPath: library.path,
				abiVersion: library.abiVersion,
				schemaHash: library.schemaHash,
			});
			this.#library = library;
		} catch (error) {
			try {
				library.closeLibrary();
			} catch (closeError) {
				logger.error("Failed to close embedded runtime library after worker load response failure", {
					error: closeError,
				});
			}
			throw error;
		}
	}

	#open(message: Extract<ExecutionWorkerRequest, { type: "open" }>): void {
		if (this.#handle !== undefined) {
			throw new RuntimeRpcError("internal", "Embedded runtime execution worker is already open.");
		}
		let library = this.#library;
		if (library && library.path !== message.libraryPath) {
			throw new RuntimeRpcError(
				"internal",
				"Embedded runtime execution worker cannot open a different loaded library.",
			);
		}
		let openedHandle: bigint | undefined;
		try {
			library ??= loadEmbeddedNativeLibrary(this.#openLibrary, message.libraryPath);
			const opened = library.open(message.request);
			openedHandle = opened.handle;
			validateOpenResponse(opened.handle, opened.response);
			const response = transferBytes(opened.response);
			this.#transport.send(
				{
					type: "opened",
					id: message.id,
					libraryPath: library.path,
					handle: opened.handle,
					response: response.bytes,
				},
				response.transfer,
			);
			this.#library = library;
			this.#handle = opened.handle;
		} catch (error) {
			this.#library = undefined;
			this.#handle = undefined;
			if (library && openedHandle !== undefined && validRuntimeHandle(openedHandle)) {
				try {
					library.closeRuntime(openedHandle);
				} catch (closeRuntimeError) {
					logger.error("Failed to close embedded runtime after worker open response failure", {
						error: closeRuntimeError,
					});
				}
			}
			try {
				library?.closeLibrary();
			} catch (closeError) {
				logger.error("Failed to close embedded runtime library after worker open failure", { error: closeError });
			}
			throw error;
		}
	}

	#call(message: Extract<ExecutionWorkerRequest, { type: "call" }>): void {
		const library = this.#library;
		if (!library || this.#handle === undefined) {
			throw new RuntimeRpcError("internal", "Embedded runtime execution worker is not open.");
		}
		if (message.handle !== this.#handle) {
			throw new RuntimeRpcError("internal", "Embedded runtime execution worker received a stale handle.");
		}
		const response = transferBytes(library.call(message.handle, message.request));
		this.#transport.send({ type: "called", id: message.id, response: response.bytes }, response.transfer);
	}

	#contextCall(message: Extract<ExecutionWorkerRequest, { type: "context-call" }>): void {
		const library = this.#library;
		if (!library || this.#handle === undefined) {
			throw new RuntimeRpcError("internal", "Embedded runtime execution worker is not open.");
		}
		if (message.handle !== this.#handle) {
			throw new RuntimeRpcError("internal", "Embedded runtime execution worker received a stale handle.");
		}
		const response = transferBytes(library.contextCall(message.handle, message.request));
		this.#transport.send({ type: "context-called", id: message.id, response: response.bytes }, response.transfer);
	}

	#close(message: Extract<ExecutionWorkerRequest, { type: "close" }>): void {
		const library = this.#library;
		if (!library || this.#handle === undefined) {
			throw new RuntimeRpcError("internal", "Embedded runtime execution worker is not open.");
		}
		if (message.handle !== this.#handle) {
			throw new RuntimeRpcError("internal", "Embedded runtime execution worker received a stale handle.");
		}
		let response: Uint8Array | undefined;
		let failure: unknown;
		try {
			response = library.closeRuntime(message.handle);
		} catch (error) {
			failure = error;
		}
		try {
			library.closeLibrary();
		} catch (error) {
			failure ??= error;
		}
		this.#library = undefined;
		this.#handle = undefined;
		if (failure !== undefined) throw failure;
		if (!response)
			throw new RuntimeRpcError("internal", "Embedded runtime execution worker close returned no response.");
		const transferable = transferBytes(response);
		this.#transport.send({ type: "closed", id: message.id, response: transferable.bytes }, transferable.transfer);
	}

	#unload(message: Extract<ExecutionWorkerRequest, { type: "unload" }>): void {
		if (this.#handle !== undefined) {
			throw new RuntimeRpcError("internal", "Embedded runtime execution worker cannot unload an open runtime.");
		}
		const library = this.#library;
		this.#library = undefined;
		library?.closeLibrary();
		this.#transport.send({ type: "unloaded", id: message.id });
	}
}

export class ControlWorkerCore {
	readonly #transport: EmbeddedWorkerTransport<ControlWorkerRequest, ControlWorkerResponse>;
	readonly #openLibrary: EmbeddedNativeLibraryFactory;
	readonly #validateResponse: EmbeddedResponseValidator;
	readonly #unsubscribe: () => void;
	#library: EmbeddedNativeLibrary | undefined;
	#handle: bigint | undefined;
	#tail: Promise<void> = Promise.resolve();
	#closed = false;

	constructor(
		transport: EmbeddedWorkerTransport<ControlWorkerRequest, ControlWorkerResponse>,
		openLibrary: EmbeddedNativeLibraryFactory = openEmbeddedNativeLibrary,
		validateResponse: EmbeddedResponseValidator = (bytes, expectedRequestId) => {
			decodeEmbeddedResponse(bytes, expectedRequestId);
		},
	) {
		this.#transport = transport;
		this.#openLibrary = openLibrary;
		this.#validateResponse = validateResponse;
		this.#unsubscribe = transport.onMessage(message => this.#onMessage(message));
	}

	#onMessage(message: ControlWorkerRequest): void {
		if (message.type === "probe") {
			this.#transport.send({ type: "probed", id: message.id });
			return;
		}
		const run = (): void => {
			try {
				if (message.type === "init") this.#init(message);
				else if (message.type === "cancel") this.#cancel(message);
				else if (message.type === "context-control") this.#contextControl(message);
				else this.#shutdown(message);
			} catch (error) {
				this.#transport.send({ type: "error", id: message.id, error: serializedError(error) });
				if (message.type === "shutdown") this.#finishShutdown();
			}
		};
		this.#tail = this.#tail.then(run, run);
	}

	#init(message: Extract<ControlWorkerRequest, { type: "init" }>): void {
		if (this.#closed) throw new RuntimeRpcError("internal", "Embedded runtime control worker is closed.");
		if (this.#library || this.#handle !== undefined) {
			throw new RuntimeRpcError("internal", "Embedded runtime control worker is already initialized.");
		}
		let library: EmbeddedNativeLibrary | undefined;
		try {
			library = loadEmbeddedNativeLibrary(this.#openLibrary, message.libraryPath);
			this.#library = library;
			this.#handle = message.handle;
			this.#transport.send({ type: "initialized", id: message.id, libraryPath: library.path });
		} catch (error) {
			try {
				library?.closeLibrary();
			} catch (closeError) {
				logger.error("Failed to close embedded runtime control library after init failure", { error: closeError });
			}
			throw error;
		}
	}

	#cancel(message: Extract<ControlWorkerRequest, { type: "cancel" }>): void {
		const library = this.#library;
		const handle = this.#handle;
		if (!library || handle === undefined) {
			throw new RuntimeRpcError("internal", "Embedded runtime control worker is not initialized.");
		}
		const bytes = library.cancel(handle, message.requestId);
		this.#validateResponse(bytes, message.requestId);
		const response = transferBytes(bytes);
		this.#transport.send({ type: "cancelled", id: message.id, response: response.bytes }, response.transfer);
	}

	/**
	 * Serves every non-eval context op from the control thread, so it stays concurrent with an eval
	 * occupying the execution thread. The frame is decoded by the host, not here: this worker owns
	 * only the runtime handle and the native call.
	 */
	#contextControl(message: Extract<ControlWorkerRequest, { type: "context-control" }>): void {
		const library = this.#library;
		const handle = this.#handle;
		if (!library || handle === undefined) {
			throw new RuntimeRpcError("internal", "Embedded runtime control worker is not initialized.");
		}
		const response = transferBytes(library.contextControl(handle, message.request));
		this.#transport.send({ type: "context-controlled", id: message.id, response: response.bytes }, response.transfer);
	}

	#shutdown(message: Extract<ControlWorkerRequest, { type: "shutdown" }>): void {
		if (!this.#closed) {
			this.#closed = true;
			this.#library?.closeLibrary();
			this.#library = undefined;
			this.#handle = undefined;
		}
		this.#transport.send({ type: "shutdown-complete", id: message.id });
		this.#finishShutdown();
	}

	#finishShutdown(): void {
		this.#unsubscribe();
		this.#transport.close();
	}
}

function wrapWorker<Request, Response>(worker: Worker): EmbeddedWorkerHandle<Request, Response> {
	return {
		send(message, transfer = []) {
			worker.postMessage(message, transfer);
		},
		onMessage(handler) {
			const listener = (event: MessageEvent): void => handler(event.data as Response);
			worker.addEventListener("message", listener);
			return () => worker.removeEventListener("message", listener);
		},
		onError(handler) {
			const listener = (event: ErrorEvent): void =>
				handler(event.error instanceof Error ? event.error : new Error(event.message));
			worker.addEventListener("error", listener);
			return () => worker.removeEventListener("error", listener);
		},
		onExit(handler) {
			const listener = (): void => handler();
			worker.addEventListener("close", listener);
			return () => worker.removeEventListener("close", listener);
		},
		async terminate() {
			worker.terminate();
		},
	};
}

/** Re-enters the CLI host under `hostArg` when one is active, else loads `entry` under `directArg`. */
function spawnEmbeddedWorker<Req, Res>(hostArg: string, directArg: string, entry: URL): EmbeddedWorkerHandle<Req, Res> {
	const hostEntry = workerHostEntry();
	const worker = hostEntry
		? new Worker(hostEntry, { type: "module", argv: [hostArg] })
		: new Worker(entry.href, { type: "module", argv: [directArg] });
	return wrapWorker(worker);
}

export function spawnEmbeddedExecutionWorker(): EmbeddedWorkerHandle<ExecutionWorkerRequest, ExecutionWorkerResponse> {
	const entry = new URL("./worker-entry.ts", import.meta.url);
	return spawnEmbeddedWorker(EMBEDDED_EXECUTION_WORKER_ARG, EMBEDDED_DIRECT_EXECUTION_WORKER_ARG, entry);
}

export function spawnEmbeddedControlWorker(): EmbeddedWorkerHandle<ControlWorkerRequest, ControlWorkerResponse> {
	const entry = new URL("./control-worker-entry.ts", import.meta.url);
	return spawnEmbeddedWorker(EMBEDDED_CONTROL_WORKER_ARG, EMBEDDED_DIRECT_CONTROL_WORKER_ARG, entry);
}

export type EmbeddedCancellationOutcome = { kind: "matched" } | { kind: "late" };

/**
 * Cancel across the dispatch window where the execution Worker has accepted a
 * call but the native runtime has not registered it yet.
 */
export async function cancelEmbeddedRequestUntilSettled(
	requestId: bigint,
	cancel: () => Promise<Uint8Array>,
	isCallSettled: () => boolean,
	callSettlement: Promise<void>,
): Promise<EmbeddedCancellationOutcome> {
	while (true) {
		if (isCallSettled()) return { kind: "late" };
		const response = decodeEmbeddedResponse(await cancel(), requestId);
		if (response.type === "cancelled") return { kind: "matched" };
		if (response.type === "failure" && response.code === EmbeddedFailureCode.REQUEST_NOT_ACTIVE) {
			if (isCallSettled()) return { kind: "late" };
			await Promise.race([callSettlement, yieldCancellationRetry()]);
			continue;
		}
		if (response.type === "failure") {
			throw new RuntimeRpcError("internal", response.message || "Embedded runtime cancellation failed.", {
				failureCode: response.code,
			});
		}
		throw new RuntimeRpcError("internal", "Embedded runtime returned an invalid cancellation response.", {
			responseType: response.type,
		});
	}
}

function yieldCancellationRetry(): Promise<void> {
	const yielded = Promise.withResolvers<void>();
	setTimeout(yielded.resolve, 1);
	return yielded.promise;
}

export interface EmbeddedOutputDrain {
	/** Highest chunk sequence observed; 0 when the eval never streamed anything. */
	seq: bigint;
	/** True when the runtime marked the eval's output finished — the authoritative drain signal. */
	complete: boolean;
	/** True when the registry retired the context under the pump; not an error. */
	closed: boolean;
}

export interface EmbeddedOutputPumpOptions {
	/** Sends one already-encoded `poll-output` frame and decodes its response. */
	poll(): Promise<EmbeddedDecodedResponse>;
	onChunk(chunk: EmbeddedOutputChunk): void;
	isEvalSettled(): boolean;
	evalSettlement: Promise<void>;
}

/**
 * Drain a streaming context's output from the control thread while its eval holds the execution
 * thread — the same cross-thread shape `cancelEmbeddedRequestUntilSettled` uses, and a requirement
 * rather than a preference.
 *
 * The runtime imposes **no wall-clock deadline** on a streaming write. A guest parked on a full
 * pipe wakes on exactly three things: this drain, a control op that discards the eval or retires
 * the context, or an interrupt. The output budget is deliberately not a wakeup. A host that never
 * polls therefore stalls its own eval — recoverably, but it does stall.
 *
 * `EmbeddedOutputBatch.complete` is the drain signal; `EmbeddedEvalResult.outputSeq` is not — it
 * reads 0 unless the host polled mid-eval, and even then it trails the true high-water mark.
 *
 * `complete` is only trustworthy once this eval has demonstrably begun. A poll that reaches the
 * control thread before the execution thread enters the eval answers `complete: true` with no
 * chunks — the pipe is describing the *previous* eval, and a pump that believed it would return
 * instantly and drop the whole stream. So an empty `complete` is honoured only after a chunk has
 * arrived or the eval has settled. When the eval settles without `complete` ever being raised, one
 * trailing poll catches a late batch and the drain then ends.
 */
export async function pumpEmbeddedContextOutput(options: EmbeddedOutputPumpOptions): Promise<EmbeddedOutputDrain> {
	let seq = 0n;
	let observedOutput = false;
	let drainedAfterSettlement = false;
	while (true) {
		const response = await options.poll();
		if (response.type === "failure") {
			// `pollOutput` on a closed registry answers `closed` while eval and describe answer
			// `unknownContext` for the same situation; both mean the same thing to a drain.
			if (response.code === EmbeddedFailureCode.CLOSED || response.code === EmbeddedFailureCode.UNKNOWN_CONTEXT) {
				return { seq, complete: false, closed: true };
			}
			throw new RuntimeRpcError("internal", response.message || "Embedded runtime output poll failed.", {
				failureCode: response.code,
			});
		}
		if (response.type !== "output-batch") {
			throw new RuntimeRpcError("internal", "Embedded runtime returned an invalid output poll response.", {
				responseType: response.type,
			});
		}
		for (const chunk of response.chunks) {
			if (chunk.seq <= seq) {
				throw new RuntimeRpcError("internal", "Embedded runtime output chunk sequence moved backwards.", {
					previous: seq.toString(),
					received: chunk.seq.toString(),
				});
			}
			seq = chunk.seq;
			observedOutput = true;
			options.onChunk(chunk);
		}
		if (response.complete && (observedOutput || options.isEvalSettled())) {
			return { seq: response.seq > seq ? response.seq : seq, complete: true, closed: false };
		}
		if (response.chunks.length > 0) {
			drainedAfterSettlement = false;
			continue;
		}
		if (!options.isEvalSettled()) {
			await Promise.race([options.evalSettlement, yieldCancellationRetry()]);
			continue;
		}
		if (drainedAfterSettlement) return { seq, complete: false, closed: false };
		drainedAfterSettlement = true;
	}
}

const DEFAULT_WORKER_FACTORIES: EmbeddedWorkerFactories = {
	createExecutionWorker: spawnEmbeddedExecutionWorker,
	createControlWorker: spawnEmbeddedControlWorker,
};

/** The one response shape both worker protocols share; a channel settles it as a rejection. */
type WorkerErrorResponse = { id: number; type: "error"; error: EmbeddedWorkerError };

function isWorkerErrorResponse(response: { id: number; type: string }): response is WorkerErrorResponse {
	return response.type === "error";
}

interface WorkerChannelHandlers<Response> {
	/** Runs for a response that matched a pending request, just before that request settles. */
	settled?(response: Response): void;
	/** The worker raised an error event. */
	failed(error: Error): void;
	/** The worker exited, expectedly or not — the owner decides which. */
	exited(): void;
}

/**
 * One worker handle plus the requests awaiting its responses.
 *
 * Its owner mints the request ids — they stay unique across every channel the owner holds
 * — and keeps all failure policy: a channel decides nothing, it only routes a response back
 * to the request that asked for it and hands every worker event to the owner's handlers.
 */
class WorkerRequestChannel<Request extends { id: number }, Response extends { id: number; type: string }> {
	readonly #worker: EmbeddedWorkerHandle<Request, Response>;
	readonly #pending = new Map<number, PendingResponse<Response>>();
	readonly #unsubscribers: Array<() => void> = [];

	constructor(worker: EmbeddedWorkerHandle<Request, Response>) {
		this.#worker = worker;
	}

	/** Subscribes to every event this worker raises. Call once, before the first send. */
	listen(handlers: WorkerChannelHandlers<Response>): void {
		this.#unsubscribers.push(
			this.#worker.onMessage(response => this.#settle(response, handlers)),
			this.#worker.onError(error => handlers.failed(error)),
			this.#worker.onExit(() => handlers.exited()),
		);
	}

	/** Records `message` as pending and hands it to the worker; a throwing send leaves nothing pending. */
	send(message: Request, transfer: Bun.Transferable[] = []): Promise<Response> {
		const pending = Promise.withResolvers<Response>();
		this.#pending.set(message.id, pending);
		try {
			this.#worker.send(message, transfer);
		} catch (error) {
			this.#pending.delete(message.id);
			throw error;
		}
		return pending.promise;
	}

	/** Rejects every pending request; responses arriving afterwards find nothing to settle. */
	failAll(error: unknown): void {
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
	}

	/** Drops every subscription `listen` installed. */
	dispose(): void {
		for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
	}

	terminate(): Promise<void> {
		return this.#worker.terminate();
	}

	#settle(response: Response, handlers: WorkerChannelHandlers<Response>): void {
		const pending = this.#pending.get(response.id);
		if (!pending) return;
		this.#pending.delete(response.id);
		handlers.settled?.(response);
		if (isWorkerErrorResponse(response)) pending.reject(restoredError(response.error));
		else pending.resolve(response);
	}
}

export class EmbeddedWorkerHost {
	readonly #execution: WorkerRequestChannel<ExecutionWorkerRequest, ExecutionWorkerResponse>;
	readonly #control: WorkerRequestChannel<ControlWorkerRequest, ControlWorkerResponse>;
	readonly #lifecycleOperations = new Set<Promise<void>>();
	#nextId = 0;
	#nextHostControlRequestId = 0n;
	#handle: bigint | undefined;
	#loadedLibraryPath: string | undefined;
	#activeRequestId: bigint | undefined;
	#activeContextEval: { requestId: bigint; contextId: bigint } | undefined;
	#callTail: Promise<void> = Promise.resolve();
	#accepting = true;
	#failure: RuntimeRpcError | undefined;
	#shutdownPromise: Promise<void> | undefined;
	#terminationPromise: Promise<void> | undefined;
	#terminating = false;
	#expectedControlExit = false;

	constructor(factories: EmbeddedWorkerFactories = DEFAULT_WORKER_FACTORIES) {
		this.#execution = new WorkerRequestChannel(factories.createExecutionWorker());
		try {
			this.#control = new WorkerRequestChannel(factories.createControlWorker());
		} catch (error) {
			void this.#execution.terminate();
			throw error;
		}
		this.#execution.listen({
			failed: error => this.#workerFailed("execution worker failed", error),
			exited: () => {
				if (!this.#terminating) this.#workerFailed("execution worker exited");
			},
		});
		this.#control.listen({
			// An acknowledged shutdown makes the control worker's exit expected, not a crash.
			settled: response => {
				if (response.type === "shutdown-complete") this.#expectedControlExit = true;
			},
			failed: error => this.#workerFailed("control worker failed", error),
			exited: () => {
				if (!this.#terminating && !this.#expectedControlExit) this.#workerFailed("control worker exited");
			},
		});
	}

	async probe(): Promise<void> {
		this.#assertAccepting();
		const finish = this.#beginLifecycleOperation();
		try {
			const executionId = this.#requestId();
			const controlId = this.#requestId();
			const [execution, control] = await Promise.all([
				this.#sendExecution({ type: "probe", id: executionId }),
				this.#sendControl({ type: "probe", id: controlId }),
			]);
			if (execution.type !== "probed" || control.type !== "probed") {
				throw this.#protocolFailure("Embedded runtime workers returned invalid probe responses.");
			}
		} finally {
			finish();
		}
	}

	async load(libraryPath: string): Promise<{ libraryPath: string; abiVersion: number; schemaHash: string }> {
		this.#assertAccepting();
		const finish = this.#beginLifecycleOperation();
		try {
			if (this.#handle !== undefined) {
				throw new RuntimeRpcError("internal", "Embedded runtime worker host is already open.");
			}
			if (this.#loadedLibraryPath !== undefined && this.#loadedLibraryPath !== libraryPath) {
				throw new RuntimeRpcError("internal", "Embedded runtime worker host cannot replace a loaded library.");
			}
			const id = this.#requestId();
			const response = await this.#sendExecution({ type: "load", id, libraryPath });
			if (response.type !== "loaded") {
				throw this.#protocolFailure("Embedded runtime execution worker returned an invalid load response.");
			}
			this.#loadedLibraryPath = response.libraryPath;
			return {
				libraryPath: response.libraryPath,
				abiVersion: response.abiVersion,
				schemaHash: response.schemaHash,
			};
		} finally {
			finish();
		}
	}

	async open(
		libraryPath: string,
		request: Uint8Array,
	): Promise<{ libraryPath: string; handle: bigint; response: Uint8Array }> {
		this.#assertAccepting();
		const finish = this.#beginLifecycleOperation();
		try {
			if (this.#handle !== undefined) {
				throw new RuntimeRpcError("internal", "Embedded runtime worker host is already open.");
			}
			if (this.#loadedLibraryPath !== undefined && this.#loadedLibraryPath !== libraryPath) {
				throw new RuntimeRpcError(
					"internal",
					"Embedded runtime worker host cannot open a different loaded library.",
				);
			}
			const transferred = transferBytes(request);
			const id = this.#requestId();
			const response = await this.#sendExecution(
				{ type: "open", id, libraryPath, request: transferred.bytes },
				transferred.transfer,
			);
			if (response.type !== "opened") {
				throw this.#protocolFailure("Embedded runtime execution worker returned an invalid open response.");
			}
			if (this.#loadedLibraryPath !== undefined && response.libraryPath !== this.#loadedLibraryPath) {
				throw this.#protocolFailure(
					"Embedded runtime execution worker changed the loaded library path during open.",
				);
			}
			try {
				validateOpenResponse(response.handle, response.response);
			} catch (error) {
				if (validRuntimeHandle(response.handle)) {
					this.#loadedLibraryPath = response.libraryPath;
					this.#handle = response.handle;
					try {
						await this.#closeExecutionRuntime();
					} catch (closeError) {
						logger.error("Failed to close embedded runtime after invalid worker open response", {
							error: closeError,
						});
					}
				}
				throw error;
			}
			this.#loadedLibraryPath = response.libraryPath;
			this.#handle = response.handle;
			try {
				const initId = this.#requestId();
				const initialized = await this.#sendControl({
					type: "init",
					id: initId,
					libraryPath: response.libraryPath,
					handle: response.handle,
				});
				if (initialized.type !== "initialized" || initialized.libraryPath !== response.libraryPath) {
					throw new RuntimeRpcError(
						"internal",
						"Embedded runtime workers did not load the same canonical library path.",
					);
				}
			} catch (error) {
				try {
					await this.#closeExecutionRuntime();
				} catch (closeError) {
					logger.error("Failed to close embedded runtime after control worker initialization failure", {
						error: closeError,
					});
				}
				this.#workerFailed("worker initialization failed", error);
				throw error;
			}
			return { libraryPath: response.libraryPath, handle: response.handle, response: response.response };
		} finally {
			finish();
		}
	}

	call(requestId: bigint, request: Uint8Array): Promise<Uint8Array> {
		try {
			this.#assertAccepting();
		} catch (error) {
			return Promise.reject(error);
		}
		if (requestId <= 0n || requestId > MAX_UINT64) {
			return Promise.reject(
				new RuntimeRpcError(
					"internal",
					"Embedded runtime worker call request id is outside the supported uint64 range.",
				),
			);
		}
		const run = (): Promise<Uint8Array> => this.#executeCall(requestId, request);
		const result = this.#callTail.then(run, run);
		this.#callTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	/**
	 * Evaluate into an open context. Shares the execution worker with `call`, so evals are FIFO
	 * across the whole host; `contextId` is retained so shutdown can discard an eval that would
	 * otherwise never settle — a streaming eval has no wall-clock deadline anywhere.
	 */
	contextCall(requestId: bigint, contextId: bigint, request: Uint8Array): Promise<Uint8Array> {
		try {
			this.#assertAccepting();
		} catch (error) {
			return Promise.reject(error);
		}
		if (requestId <= 0n || requestId > MAX_UINT64) {
			return Promise.reject(
				new RuntimeRpcError(
					"internal",
					"Embedded runtime worker context call request id is outside the supported uint64 range.",
				),
			);
		}
		const run = (): Promise<Uint8Array> => this.#executeContextCall(requestId, contextId, request);
		const result = this.#callTail.then(run, run);
		this.#callTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	/**
	 * Run one already-encoded `EmbeddedControl` frame on the control worker.
	 *
	 * Deliberately outside the execution FIFO: interrupt, cancel, reset, and the output poll must
	 * reach the runtime while an eval holds the execution thread, or a parked guest write has
	 * nothing left to wake it.
	 */
	contextControl(request: Uint8Array): Promise<Uint8Array> {
		try {
			this.#assertAccepting();
		} catch (error) {
			return Promise.reject(error);
		}
		return this.#contextControl(request);
	}

	cancel(requestId: bigint): Promise<Uint8Array> {
		try {
			this.#assertAccepting();
		} catch (error) {
			return Promise.reject(error);
		}
		return this.#cancel(requestId);
	}

	shutdown(): Promise<void> {
		if (this.#shutdownPromise) return this.#shutdownPromise;
		this.#accepting = false;
		const shutdown = Promise.withResolvers<void>();
		this.#shutdownPromise = shutdown.promise;
		void this.#performShutdown().then(shutdown.resolve, shutdown.reject);
		return shutdown.promise;
	}

	async #executeCall(requestId: bigint, request: Uint8Array): Promise<Uint8Array> {
		this.#assertAccepting();
		const handle = this.#handle;
		if (handle === undefined) throw new RuntimeRpcError("internal", "Embedded runtime worker host is not open.");
		const transferred = transferBytes(request);
		this.#activeRequestId = requestId;
		try {
			const id = this.#requestId();
			const response = await this.#sendExecution(
				{ type: "call", id, handle, request: transferred.bytes },
				transferred.transfer,
			);
			if (response.type !== "called") {
				throw this.#protocolFailure("Embedded runtime execution worker returned an invalid call response.");
			}
			return response.response;
		} finally {
			if (this.#activeRequestId === requestId) this.#activeRequestId = undefined;
		}
	}

	async #executeContextCall(requestId: bigint, contextId: bigint, request: Uint8Array): Promise<Uint8Array> {
		this.#assertAccepting();
		const handle = this.#handle;
		if (handle === undefined) throw new RuntimeRpcError("internal", "Embedded runtime worker host is not open.");
		const transferred = transferBytes(request);
		this.#activeContextEval = { requestId, contextId };
		try {
			const id = this.#requestId();
			const response = await this.#sendExecution(
				{ type: "context-call", id, handle, request: transferred.bytes },
				transferred.transfer,
			);
			if (response.type !== "context-called") {
				throw this.#protocolFailure("Embedded runtime execution worker returned an invalid context call response.");
			}
			return response.response;
		} finally {
			if (this.#activeContextEval?.requestId === requestId) this.#activeContextEval = undefined;
		}
	}

	async #contextControl(request: Uint8Array): Promise<Uint8Array> {
		if (this.#handle === undefined) {
			throw new RuntimeRpcError("internal", "Embedded runtime worker host is not open.");
		}
		const transferred = transferBytes(request);
		const id = this.#requestId();
		const response = await this.#sendControl(
			{ type: "context-control", id, request: transferred.bytes },
			transferred.transfer,
		);
		if (response.type !== "context-controlled") {
			throw this.#protocolFailure("Embedded runtime control worker returned an invalid context control response.");
		}
		return response.response;
	}

	/**
	 * Discard an eval that shutdown would otherwise wait on forever.
	 *
	 * `cancel` on a context discards the in-flight eval and rebuilds the context from the same warm
	 * runtime; it is one of the three things that can wake a parked guest write, and the only one
	 * available to a host that is tearing down.
	 */
	async #discardActiveContextEval(): Promise<void> {
		const active = this.#activeContextEval;
		if (!active) return;
		const requestId = this.#nextControlRequestId();
		const response = decodeEmbeddedResponse(
			await this.#contextControl(encodeContextControl(requestId, { type: "cancel", contextId: active.contextId })),
			requestId,
		);
		if (response.type === "context-ack") return;
		if (response.type === "failure") {
			// A context that is already gone needs no discard; anything else is a real fault.
			if (
				response.code === EmbeddedFailureCode.UNKNOWN_CONTEXT ||
				response.code === EmbeddedFailureCode.CLOSED ||
				response.code === EmbeddedFailureCode.UNSUPPORTED_OPERATION
			) {
				return;
			}
			throw new RuntimeRpcError("internal", response.message || "Embedded runtime context discard failed.", {
				failureCode: response.code,
			});
		}
		throw this.#protocolFailure("Embedded runtime returned an invalid context discard response.");
	}

	async #cancel(requestId: bigint): Promise<Uint8Array> {
		if (requestId <= 0n || requestId > MAX_UINT64) {
			throw new RuntimeRpcError(
				"internal",
				"Embedded runtime cancellation request id is outside the supported uint64 range.",
			);
		}
		if (this.#handle === undefined)
			throw new RuntimeRpcError("internal", "Embedded runtime worker host is not open.");
		const id = this.#requestId();
		const response = await this.#sendControl({ type: "cancel", id, requestId });
		if (response.type !== "cancelled") {
			throw this.#protocolFailure("Embedded runtime control worker returned an invalid cancellation response.");
		}
		return response.response;
	}

	async #performShutdown(): Promise<void> {
		let failure: unknown;
		const activeRequestId = this.#activeRequestId;
		if (activeRequestId !== undefined && !this.#failure) {
			try {
				await cancelEmbeddedRequestUntilSettled(
					activeRequestId,
					() => this.#cancel(activeRequestId),
					() => this.#activeRequestId !== activeRequestId,
					this.#callTail,
				);
			} catch (error) {
				failure = error;
				this.#workerFailed("shutdown cancellation failed", error);
			}
		}
		if (this.#activeContextEval && !this.#failure) {
			try {
				await this.#discardActiveContextEval();
			} catch (error) {
				failure ??= error;
				this.#workerFailed("shutdown context discard failed", error);
			}
		}
		await Promise.allSettled(this.#lifecycleOperations);
		await this.#callTail;
		if (!this.#failure) {
			try {
				const id = this.#requestId();
				const response = await this.#sendControl({ type: "shutdown", id });
				if (response.type !== "shutdown-complete") {
					throw this.#protocolFailure("Embedded runtime control worker returned an invalid shutdown response.");
				}
			} catch (error) {
				failure ??= error;
			}
			try {
				await this.#closeExecutionRuntime();
			} catch (error) {
				failure ??= error;
			}
		}
		await this.#terminateWorkers();
		if (failure !== undefined) throw failure;
	}

	async #closeExecutionRuntime(): Promise<void> {
		const handle = this.#handle;
		if (handle === undefined) {
			if (this.#loadedLibraryPath === undefined) return;
			const id = this.#requestId();
			try {
				const response = await this.#sendExecution({ type: "unload", id });
				if (response.type !== "unloaded") {
					throw this.#protocolFailure("Embedded runtime execution worker returned an invalid unload response.");
				}
			} finally {
				this.#loadedLibraryPath = undefined;
			}
			return;
		}
		const id = this.#requestId();
		try {
			const response = await this.#sendExecution({ type: "close", id, handle });
			if (response.type !== "closed") {
				throw this.#protocolFailure("Embedded runtime execution worker returned an invalid close response.");
			}
			const decoded = decodeEmbeddedResponse(response.response, 0n);
			if (decoded.type === "failure") {
				throw new RuntimeRpcError("internal", decoded.message || "Embedded runtime close failed.", {
					failureCode: decoded.code,
				});
			}
			if (decoded.type !== "closed") {
				throw this.#protocolFailure("Embedded runtime returned an invalid close response.");
			}
		} finally {
			this.#handle = undefined;
			this.#loadedLibraryPath = undefined;
		}
	}

	#sendExecution(
		message: ExecutionWorkerRequest,
		transfer: Bun.Transferable[] = [],
	): Promise<ExecutionWorkerResponse> {
		return this.#send(this.#execution, "execution worker", message, transfer);
	}

	#sendControl(message: ControlWorkerRequest, transfer: Bun.Transferable[] = []): Promise<ControlWorkerResponse> {
		return this.#send(this.#control, "control worker", message, transfer);
	}

	/** Refuses new work once the host has failed, and treats a throwing send as a worker fault. */
	#send<Request extends { id: number }, Response extends { id: number; type: string }>(
		channel: WorkerRequestChannel<Request, Response>,
		label: string,
		message: Request,
		transfer: Bun.Transferable[],
	): Promise<Response> {
		if (this.#failure) return Promise.reject(this.#hostFailure());
		try {
			return channel.send(message, transfer);
		} catch (error) {
			this.#workerFailed(`${label} send failed`, error);
			return Promise.reject(this.#hostFailure());
		}
	}

	#workerFailed(message: string, cause?: unknown): void {
		if (this.#failure || this.#terminating) return;
		this.#failure = new RuntimeRpcError("internal", `Embedded runtime ${message}.`, {
			...(cause === undefined ? {} : { cause: cause instanceof Error ? cause.message : String(cause) }),
		});
		this.#accepting = false;
		this.#handle = undefined;
		this.#loadedLibraryPath = undefined;
		const rejection = this.#failure;
		this.#execution.failAll(rejection);
		this.#control.failAll(rejection);
		void this.#terminateWorkers();
	}

	#protocolFailure(message: string): RuntimeRpcError {
		const error = new RuntimeRpcError("internal", message);
		this.#workerFailed("worker protocol failed", error);
		return error;
	}

	#beginLifecycleOperation(): () => void {
		const completion = Promise.withResolvers<void>();
		this.#lifecycleOperations.add(completion.promise);
		let finished = false;
		return () => {
			if (finished) return;
			finished = true;
			this.#lifecycleOperations.delete(completion.promise);
			completion.resolve();
		};
	}

	#assertAccepting(): void {
		if (this.#failure) throw this.#hostFailure();
		if (!this.#accepting) throw new RuntimeRpcError("internal", "Embedded runtime worker host is shutting down.");
	}

	#hostFailure(): RuntimeRpcError {
		return new RuntimeRpcError("internal", "Embedded runtime worker host failed.", {
			cause: this.#failure?.message ?? "unknown worker failure",
		});
	}

	#requestId(): number {
		if (this.#nextId >= Number.MAX_SAFE_INTEGER) {
			throw this.#protocolFailure("Embedded runtime worker request id space is exhausted.");
		}
		this.#nextId += 1;
		return this.#nextId;
	}

	/** Ids for control frames the host mints itself; responses still correlate by worker request id. */
	#nextControlRequestId(): bigint {
		if (this.#nextHostControlRequestId >= MAX_UINT64) {
			throw this.#protocolFailure("Embedded runtime host control request id space is exhausted.");
		}
		this.#nextHostControlRequestId += 1n;
		return this.#nextHostControlRequestId;
	}

	#terminateWorkers(): Promise<void> {
		if (this.#terminationPromise) return this.#terminationPromise;
		this.#terminating = true;
		const rejection =
			this.#failure ?? new RuntimeRpcError("internal", "Embedded runtime worker host terminated during shutdown.");
		this.#execution.failAll(rejection);
		this.#control.failAll(rejection);
		this.#execution.dispose();
		this.#control.dispose();
		const terminated = Promise.withResolvers<void>();
		this.#terminationPromise = terminated.promise;
		void (async () => {
			try {
				await this.#execution.terminate();
				await this.#control.terminate();
				terminated.resolve();
			} catch (error) {
				terminated.reject(error);
			}
		})();
		return terminated.promise;
	}
}

/** Distribution smoke probe: both worker module graphs must answer without loading a native library. */
export async function smokeTestEmbeddedWorkers(): Promise<void> {
	const host = new EmbeddedWorkerHost();
	try {
		await host.probe();
	} finally {
		await host.shutdown();
	}
}
