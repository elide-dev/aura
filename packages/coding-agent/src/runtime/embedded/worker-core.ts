import { logger, workerHostEntry } from "@oh-my-pi/pi-utils";
import { RuntimeRpcError } from "../protocol";
import { openEmbeddedNativeLibrary, type EmbeddedNativeLibrary } from "./abi";
import { decodeEmbeddedResponse } from "./codec";
import {
	EMBEDDED_CONTROL_WORKER_ARG,
	EMBEDDED_EXECUTION_WORKER_ARG,
	type ControlWorkerRequest,
	type ControlWorkerResponse,
	type EmbeddedWorkerError,
	type EmbeddedWorkerTransport,
	type ExecutionWorkerRequest,
	type ExecutionWorkerResponse,
} from "./worker-protocol";

const MAX_UINT64 = (1n << 64n) - 1n;

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
		const library = this.#openLibrary(message.libraryPath);
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
			throw new RuntimeRpcError("internal", "Embedded runtime execution worker cannot open a different loaded library.");
		}
		let openedHandle: bigint | undefined;
		try {
			library ??= this.#openLibrary(message.libraryPath);
			const opened = library.open(message.request);
			openedHandle = opened.handle;
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
			if (library && openedHandle !== undefined) {
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
		if (!response) throw new RuntimeRpcError("internal", "Embedded runtime execution worker close returned no response.");
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
			library = this.#openLibrary(message.libraryPath);
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

export function spawnEmbeddedExecutionWorker(): EmbeddedWorkerHandle<ExecutionWorkerRequest, ExecutionWorkerResponse> {
	const hostEntry = workerHostEntry();
	const worker = hostEntry
		? new Worker(hostEntry, { type: "module", argv: [EMBEDDED_EXECUTION_WORKER_ARG] })
		: new Worker(new URL("./worker-entry.ts", import.meta.url).href, { type: "module" });
	return wrapWorker(worker);
}

export function spawnEmbeddedControlWorker(): EmbeddedWorkerHandle<ControlWorkerRequest, ControlWorkerResponse> {
	const hostEntry = workerHostEntry();
	const worker = hostEntry
		? new Worker(hostEntry, { type: "module", argv: [EMBEDDED_CONTROL_WORKER_ARG] })
		: new Worker(new URL("./control-worker-entry.ts", import.meta.url).href, { type: "module" });
	return wrapWorker(worker);
}

const DEFAULT_WORKER_FACTORIES: EmbeddedWorkerFactories = {
	createExecutionWorker: spawnEmbeddedExecutionWorker,
	createControlWorker: spawnEmbeddedControlWorker,
};

export class EmbeddedWorkerHost {
	readonly #execution: EmbeddedWorkerHandle<ExecutionWorkerRequest, ExecutionWorkerResponse>;
	readonly #control: EmbeddedWorkerHandle<ControlWorkerRequest, ControlWorkerResponse>;
	readonly #executionPending = new Map<number, PendingResponse<ExecutionWorkerResponse>>();
	readonly #controlPending = new Map<number, PendingResponse<ControlWorkerResponse>>();
	readonly #unsubscribers: Array<() => void> = [];
	readonly #lifecycleOperations = new Set<Promise<void>>();
	#nextId = 0;
	#handle: bigint | undefined;
	#loadedLibraryPath: string | undefined;
	#activeRequestId: bigint | undefined;
	#callTail: Promise<void> = Promise.resolve();
	#accepting = true;
	#failure: RuntimeRpcError | undefined;
	#shutdownPromise: Promise<void> | undefined;
	#terminationPromise: Promise<void> | undefined;
	#terminating = false;
	#expectedControlExit = false;

	constructor(factories: EmbeddedWorkerFactories = DEFAULT_WORKER_FACTORIES) {
		this.#execution = factories.createExecutionWorker();
		try {
			this.#control = factories.createControlWorker();
		} catch (error) {
			void this.#execution.terminate();
			throw error;
		}
		this.#unsubscribers.push(
			this.#execution.onMessage(message => this.#settleExecution(message)),
			this.#control.onMessage(message => this.#settleControl(message)),
			this.#execution.onError(error => this.#workerFailed("execution worker failed", error)),
			this.#control.onError(error => this.#workerFailed("control worker failed", error)),
			this.#execution.onExit(() => {
				if (!this.#terminating) this.#workerFailed("execution worker exited");
			}),
			this.#control.onExit(() => {
				if (!this.#terminating && !this.#expectedControlExit) this.#workerFailed("control worker exited");
			}),
		);
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

	async load(
		libraryPath: string,
	): Promise<{ libraryPath: string; abiVersion: number; schemaHash: string }> {
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
				throw new RuntimeRpcError("internal", "Embedded runtime worker host cannot open a different loaded library.");
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
				throw this.#protocolFailure("Embedded runtime execution worker changed the loaded library path during open.");
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
				new RuntimeRpcError("internal", "Embedded runtime worker call request id is outside the supported uint64 range."),
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

	async #cancel(requestId: bigint): Promise<Uint8Array> {
		if (requestId <= 0n || requestId > MAX_UINT64) {
			throw new RuntimeRpcError("internal", "Embedded runtime cancellation request id is outside the supported uint64 range.");
		}
		if (this.#handle === undefined) throw new RuntimeRpcError("internal", "Embedded runtime worker host is not open.");
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
				await this.#cancel(activeRequestId);
			} catch (error) {
				failure = error;
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
		} finally {
			this.#handle = undefined;
			this.#loadedLibraryPath = undefined;
		}
	}

	#sendExecution(
		message: ExecutionWorkerRequest,
		transfer: Bun.Transferable[] = [],
	): Promise<ExecutionWorkerResponse> {
		if (this.#failure) return Promise.reject(this.#hostFailure());
		const pending = Promise.withResolvers<ExecutionWorkerResponse>();
		this.#executionPending.set(message.id, pending);
		try {
			this.#execution.send(message, transfer);
		} catch (error) {
			this.#executionPending.delete(message.id);
			this.#workerFailed("execution worker send failed", error);
			pending.reject(this.#hostFailure());
		}
		return pending.promise;
	}

	#sendControl(message: ControlWorkerRequest, transfer: Bun.Transferable[] = []): Promise<ControlWorkerResponse> {
		if (this.#failure) return Promise.reject(this.#hostFailure());
		const pending = Promise.withResolvers<ControlWorkerResponse>();
		this.#controlPending.set(message.id, pending);
		try {
			this.#control.send(message, transfer);
		} catch (error) {
			this.#controlPending.delete(message.id);
			this.#workerFailed("control worker send failed", error);
			pending.reject(this.#hostFailure());
		}
		return pending.promise;
	}

	#settleExecution(response: ExecutionWorkerResponse): void {
		const pending = this.#executionPending.get(response.id);
		if (!pending) return;
		this.#executionPending.delete(response.id);
		if (response.type === "error") pending.reject(restoredError(response.error));
		else pending.resolve(response);
	}

	#settleControl(response: ControlWorkerResponse): void {
		const pending = this.#controlPending.get(response.id);
		if (!pending) return;
		this.#controlPending.delete(response.id);
		if (response.type === "shutdown-complete") this.#expectedControlExit = true;
		if (response.type === "error") pending.reject(restoredError(response.error));
		else pending.resolve(response);
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
		for (const pending of this.#executionPending.values()) pending.reject(rejection);
		for (const pending of this.#controlPending.values()) pending.reject(rejection);
		this.#executionPending.clear();
		this.#controlPending.clear();
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

	#terminateWorkers(): Promise<void> {
		if (this.#terminationPromise) return this.#terminationPromise;
		this.#terminating = true;
		const rejection =
			this.#failure ?? new RuntimeRpcError("internal", "Embedded runtime worker host terminated during shutdown.");
		for (const pending of this.#executionPending.values()) pending.reject(rejection);
		for (const pending of this.#controlPending.values()) pending.reject(rejection);
		this.#executionPending.clear();
		this.#controlPending.clear();
		for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
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
