import * as fs from "node:fs";
import {
	CString,
	dlopen,
	ptr,
	read,
	toArrayBuffer,
	type Library,
	type Pointer,
} from "bun:ffi";
import { MAX_RPC_REASSEMBLED_BYTES } from "../../modes/rpc/rpc-frame";
import { RuntimeRpcError } from "../protocol";
import { EMBEDDED_RUNTIME_ABI_VERSION, EMBEDDED_RUNTIME_SCHEMA_SHA256 } from "./schema";

const MAX_UINT64 = (1n << 64n) - 1n;

/** Native response ceiling, shared with the largest logical RPC frame Aura accepts. */
export const MAX_EMBEDDED_RESPONSE_BYTES = MAX_RPC_REASSEMBLED_BYTES;

export interface EmbeddedNativeLibrary {
	readonly path: string;
	readonly abiVersion: number;
	readonly schemaHash: string;
	open(request: Uint8Array): { handle: bigint; response: Uint8Array };
	call(handle: bigint, request: Uint8Array): Uint8Array;
	cancel(handle: bigint, requestId: bigint): Uint8Array;
	closeRuntime(handle: bigint): Uint8Array;
	closeLibrary(): void;
}

/** A native-owned response allocation. Implementations must not copy until `copy` is called. */
export interface EmbeddedNativeBuffer {
	readonly byteLength: bigint;
	copy(): Uint8Array;
	free(): void;
}

export interface EmbeddedNativeCallResult {
	status: number;
	response: EmbeddedNativeBuffer | null;
}

/** Pointer-free seam used by lifecycle tests; raw FFI remains private to this module. */
export interface EmbeddedNativeBindings {
	readonly abiVersion: number;
	readonly schemaHash: string;
	open(request: Uint8Array): EmbeddedNativeCallResult & { handle: bigint };
	call(handle: bigint, request: Uint8Array): EmbeddedNativeCallResult;
	cancel(handle: bigint, requestId: bigint): EmbeddedNativeCallResult;
	closeRuntime(handle: bigint): EmbeddedNativeCallResult;
	closeLibrary(): void;
}

const EMBEDDED_SYMBOLS = {
	elide_embed_abi_version: { args: [], returns: "u32" },
	elide_embed_schema_hash: { args: [], returns: "ptr" },
	elide_embed_runtime_open: { args: ["ptr", "usize", "ptr", "ptr"], returns: "i32" },
	elide_embed_runtime_call: { args: ["u64", "ptr", "usize", "ptr"], returns: "i32" },
	elide_embed_runtime_cancel: { args: ["u64", "u64", "ptr"], returns: "i32" },
	elide_embed_runtime_close: { args: ["u64", "ptr"], returns: "i32" },
	elide_embed_buffer_free: { args: ["ptr"], returns: "void" },
} as const;

type EmbeddedFfiLibrary = Library<typeof EMBEDDED_SYMBOLS>;

const STATUS_NAMES: Record<number, string> = {
	0: "ok",
	1: "invalid argument",
	2: "isolate error",
	3: "unknown runtime",
	4: "internal error",
};

function internalError(message: string, data?: Record<string, unknown>): RuntimeRpcError {
	return new RuntimeRpcError("internal", message, data);
}

function validHandle(handle: bigint): boolean {
	return handle > 0n && handle <= MAX_UINT64;
}

function consumeResponse(operation: string, result: EmbeddedNativeCallResult): Uint8Array {
	const allocation = result.response;
	let response: Uint8Array | undefined;
	let failure: unknown;
	try {
		if (result.status !== 0) {
			throw internalError(
				`Embedded runtime native ${operation} failed with status ${result.status} (${STATUS_NAMES[result.status] ?? "unknown"}).`,
				{ operation, status: result.status },
			);
		}
		if (!allocation) throw internalError(`Embedded runtime native ${operation} returned a null response.`);
		const byteLength = allocation.byteLength;
		if (byteLength < 0n || byteLength > BigInt(MAX_EMBEDDED_RESPONSE_BYTES)) {
			throw internalError(
				`Embedded runtime native ${operation} response exceeds the ${MAX_EMBEDDED_RESPONSE_BYTES}-byte safety limit.`,
				{ operation, byteLength: byteLength.toString(), limit: MAX_EMBEDDED_RESPONSE_BYTES },
			);
		}
		try {
			response = allocation.copy();
		} catch (cause) {
			throw internalError(`Failed to copy embedded runtime native ${operation} response.`, {
				operation,
				cause: cause instanceof Error ? cause.message : String(cause),
			});
		}
		if (response.byteLength !== Number(byteLength)) {
			throw internalError(`Embedded runtime native ${operation} response length changed during copy.`, {
				operation,
				expected: byteLength.toString(),
				actual: response.byteLength,
			});
		}
	} catch (error) {
		failure = error;
	}
	if (allocation) {
		try {
			allocation.free();
		} catch (cause) {
			if (failure === undefined) {
				failure = internalError(`Failed to free embedded runtime native ${operation} response.`, {
					operation,
					cause: cause instanceof Error ? cause.message : String(cause),
				});
			}
		}
	}
	if (failure !== undefined) throw failure;
	if (!response) throw internalError(`Embedded runtime native ${operation} returned no response.`);
	return response;
}

class FfiEmbeddedNativeBuffer implements EmbeddedNativeBuffer {
	readonly #buffer: Pointer;
	readonly #freeBuffer: (buffer: Pointer) => void;
	#freed = false;

	constructor(buffer: Pointer, freeBuffer: (buffer: Pointer) => void) {
		this.#buffer = buffer;
		this.#freeBuffer = freeBuffer;
	}

	get byteLength(): bigint {
		this.#assertLive();
		return read.u64(this.#buffer, 8);
	}

	copy(): Uint8Array {
		this.#assertLive();
		const byteLength = this.byteLength;
		if (byteLength < 0n || byteLength > BigInt(MAX_EMBEDDED_RESPONSE_BYTES)) {
			throw internalError("Embedded runtime native response length is outside the supported range.", {
				byteLength: byteLength.toString(),
				limit: MAX_EMBEDDED_RESPONSE_BYTES,
			});
		}
		if (byteLength === 0n) return new Uint8Array();
		const address = read.ptr(this.#buffer, 0);
		if (address === 0) throw internalError("Embedded runtime native response has a null data pointer.");
		const borrowed = new Uint8Array(toArrayBuffer(address as Pointer, 0, Number(byteLength)));
		return borrowed.slice();
	}

	free(): void {
		if (this.#freed) return;
		this.#freed = true;
		this.#freeBuffer(this.#buffer);
	}

	#assertLive(): void {
		if (this.#freed) throw internalError("Embedded runtime native response was accessed after free.");
	}
}

class FfiEmbeddedNativeBindings implements EmbeddedNativeBindings {
	readonly #library: EmbeddedFfiLibrary;
	readonly abiVersion: number;
	readonly schemaHash: string;
	#closed = false;

	constructor(library: EmbeddedFfiLibrary) {
		this.#library = library;
		this.abiVersion = library.symbols.elide_embed_abi_version();
		const schemaPointer = library.symbols.elide_embed_schema_hash();
		if (!schemaPointer) throw internalError("Embedded runtime native schema hash pointer is null.");
		this.schemaHash = new CString(schemaPointer).toString();
	}

	open(request: Uint8Array): EmbeddedNativeCallResult & { handle: bigint } {
		this.#assertLive();
		const runtime = new BigUint64Array(1);
		const response = new BigUint64Array(1);
		const status = this.#library.symbols.elide_embed_runtime_open(
			ptr(request),
			request.byteLength,
			ptr(runtime),
			ptr(response),
		);
		return { status, handle: runtime[0] ?? 0n, response: this.#takeResponse(response) };
	}

	call(handle: bigint, request: Uint8Array): EmbeddedNativeCallResult {
		this.#assertLive();
		const response = new BigUint64Array(1);
		const status = this.#library.symbols.elide_embed_runtime_call(
			handle,
			ptr(request),
			request.byteLength,
			ptr(response),
		);
		return { status, response: this.#takeResponse(response) };
	}

	cancel(handle: bigint, requestId: bigint): EmbeddedNativeCallResult {
		this.#assertLive();
		const response = new BigUint64Array(1);
		const status = this.#library.symbols.elide_embed_runtime_cancel(handle, requestId, ptr(response));
		return { status, response: this.#takeResponse(response) };
	}

	closeRuntime(handle: bigint): EmbeddedNativeCallResult {
		this.#assertLive();
		const response = new BigUint64Array(1);
		const status = this.#library.symbols.elide_embed_runtime_close(handle, ptr(response));
		return { status, response: this.#takeResponse(response) };
	}

	closeLibrary(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#library.close();
	}

	#takeResponse(slot: BigUint64Array): EmbeddedNativeBuffer | null {
		const address = read.ptr(ptr(slot));
		if (address === 0) return null;
		return new FfiEmbeddedNativeBuffer(address as Pointer, buffer => {
			this.#library.symbols.elide_embed_buffer_free(buffer);
		});
	}

	#assertLive(): void {
		if (this.#closed) throw internalError("Embedded runtime native library is closed.");
	}
}

class OwnedEmbeddedNativeLibrary implements EmbeddedNativeLibrary {
	readonly path: string;
	readonly abiVersion: number;
	readonly schemaHash: string;
	readonly #bindings: EmbeddedNativeBindings;
	readonly #runtimes = new Set<bigint>();
	readonly #closedOutcomes = new Map<bigint, { response: Uint8Array } | { error: unknown }>();
	#inFlight = 0;
	#closeRequested = false;
	#closed = false;

	constructor(path: string, bindings: EmbeddedNativeBindings) {
		this.path = path;
		this.abiVersion = bindings.abiVersion;
		this.schemaHash = bindings.schemaHash;
		this.#bindings = bindings;
	}

	open(request: Uint8Array): { handle: bigint; response: Uint8Array } {
		return this.#operation(false, () => {
			const result = this.#bindings.open(request);
			try {
				const response = consumeResponse("open", result);
				if (!validHandle(result.handle)) {
					throw internalError("Embedded runtime native open returned an invalid runtime handle.", {
						handle: result.handle.toString(),
					});
				}
				this.#runtimes.add(result.handle);
				return { handle: result.handle, response };
			} catch (error) {
				if (result.status === 0 && validHandle(result.handle)) this.#discardRuntime(result.handle);
				throw error;
			}
		});
	}

	call(handle: bigint, request: Uint8Array): Uint8Array {
		this.#assertHandle(handle);
		return this.#operation(false, () => consumeResponse("call", this.#bindings.call(handle, request)));
	}

	cancel(handle: bigint, requestId: bigint): Uint8Array {
		this.#assertHandle(handle);
		if (!validHandle(requestId)) {
			throw internalError("Embedded runtime cancellation request id is outside the supported uint64 range.", {
				requestId: requestId.toString(),
			});
		}
		return this.#operation(false, () => consumeResponse("cancel", this.#bindings.cancel(handle, requestId)));
	}

	closeRuntime(handle: bigint): Uint8Array {
		this.#assertHandle(handle);
		const previous = this.#closedOutcomes.get(handle);
		if (previous) {
			if ("error" in previous) throw previous.error;
			return previous.response.slice();
		}
		return this.#operation(true, () => {
			const result = this.#bindings.closeRuntime(handle);
			if (result.status === 0) this.#runtimes.delete(handle);
			try {
				const response = consumeResponse("close", result);
				this.#closedOutcomes.set(handle, { response });
				return response;
			} catch (error) {
				if (result.status === 0) this.#closedOutcomes.set(handle, { error });
				throw error;
			}
		});
	}

	closeLibrary(): void {
		if (this.#closed || this.#closeRequested) return;
		this.#closeRequested = true;
		this.#tryClose();
	}

	#operation<T>(allowDuringClose: boolean, action: () => T): T {
		if (this.#closed || (this.#closeRequested && !allowDuringClose)) {
			throw internalError("Embedded runtime native library is closing.");
		}
		this.#inFlight += 1;
		try {
			return action();
		} finally {
			this.#inFlight -= 1;
			this.#tryClose();
		}
	}

	#tryClose(): void {
		if (!this.#closeRequested || this.#closed || this.#inFlight !== 0 || this.#runtimes.size !== 0) return;
		this.#closed = true;
		this.#bindings.closeLibrary();
	}

	#discardRuntime(handle: bigint): void {
		try {
			const result = this.#bindings.closeRuntime(handle);
			if (result.response) result.response.free();
		} catch {
			// Preserve the malformed open failure; this path is best-effort native cleanup only.
		}
	}

	#assertHandle(handle: bigint): void {
		if (!validHandle(handle)) {
			throw internalError("Embedded runtime handle is outside the supported uint64 range.", {
				handle: handle.toString(),
			});
		}
	}
}

/** Build the ownership/state layer around pointer-free bindings. */
export function createEmbeddedNativeLibrary(path: string, bindings: EmbeddedNativeBindings): EmbeddedNativeLibrary {
	try {
		if (bindings.abiVersion !== EMBEDDED_RUNTIME_ABI_VERSION) {
			throw internalError(
				`Embedded runtime ABI mismatch: library reports ${bindings.abiVersion}, Aura requires ${EMBEDDED_RUNTIME_ABI_VERSION}.`,
				{ actual: bindings.abiVersion, expected: EMBEDDED_RUNTIME_ABI_VERSION },
			);
		}
		if (bindings.schemaHash !== EMBEDDED_RUNTIME_SCHEMA_SHA256) {
			throw internalError("Embedded runtime schema mismatch: the native library and Aura use different protocols.", {
				actual: bindings.schemaHash,
				expected: EMBEDDED_RUNTIME_SCHEMA_SHA256,
			});
		}
		return new OwnedEmbeddedNativeLibrary(path, bindings);
	} catch (error) {
		try {
			bindings.closeLibrary();
		} catch {
			// Preserve the compatibility failure that prevented the library from becoming usable.
		}
		throw error;
	}
}

/** Realpath and load the embedded runtime façade with its exact seven-symbol ABI. */
export function openEmbeddedNativeLibrary(path: string): EmbeddedNativeLibrary {
	const canonicalPath = fs.realpathSync(path);
	const library = dlopen(canonicalPath, EMBEDDED_SYMBOLS);
	let bindings: FfiEmbeddedNativeBindings;
	try {
		bindings = new FfiEmbeddedNativeBindings(library);
	} catch (error) {
		library.close();
		throw error;
	}
	return createEmbeddedNativeLibrary(canonicalPath, bindings);
}
