import { describe, expect, test } from "bun:test";
import {
	createEmbeddedNativeLibrary,
	type EmbeddedNativeBindings,
	type EmbeddedNativeBuffer,
	type EmbeddedNativeCallResult,
	MAX_EMBEDDED_RESPONSE_BYTES,
} from "../src/runtime/embedded/abi";
import { EMBEDDED_RUNTIME_ABI_VERSION, EMBEDDED_RUNTIME_SCHEMA_SHA256 } from "../src/runtime/embedded/schema";
import { RuntimeRpcError } from "../src/runtime/protocol";

class FakeBuffer implements EmbeddedNativeBuffer {
	readonly byteLength: bigint;
	readonly #source: Uint8Array;
	readonly #events: string[];
	readonly #label: string;

	constructor(source: Uint8Array, events: string[], label: string, byteLength = BigInt(source.byteLength)) {
		this.#source = source;
		this.#events = events;
		this.#label = label;
		this.byteLength = byteLength;
	}

	copy(): Uint8Array {
		this.#events.push(`${this.#label}:copy`);
		return this.#source.slice();
	}

	free(): void {
		this.#events.push(`${this.#label}:free`);
		this.#source.fill(0);
	}
}

class FakeBindings implements EmbeddedNativeBindings {
	readonly events: string[] = [];
	abiVersion = EMBEDDED_RUNTIME_ABI_VERSION;
	schemaHash = EMBEDDED_RUNTIME_SCHEMA_SHA256;
	openCount = 0;
	callCount = 0;
	cancelCount = 0;
	closeRuntimeCount = 0;
	closeLibraryCount = 0;
	onCall: (() => void) | undefined;
	openResult: EmbeddedNativeCallResult & { handle: bigint } = {
		status: 0,
		handle: 41n,
		response: this.buffer("open", [1, 2, 3]),
	};
	callResult: EmbeddedNativeCallResult = { status: 0, response: this.buffer("call", [4, 5, 6]) };
	cancelResult: EmbeddedNativeCallResult = { status: 0, response: this.buffer("cancel", [7, 8]) };
	closeResult: EmbeddedNativeCallResult = { status: 0, response: this.buffer("close", [9]) };

	buffer(label: string, bytes: number[], byteLength?: bigint): EmbeddedNativeBuffer {
		return new FakeBuffer(new Uint8Array(bytes), this.events, label, byteLength);
	}

	open(_request: Uint8Array): EmbeddedNativeCallResult & { handle: bigint } {
		this.openCount += 1;
		this.events.push("native:open");
		return this.openResult;
	}

	call(_handle: bigint, _request: Uint8Array): EmbeddedNativeCallResult {
		this.callCount += 1;
		this.events.push("native:call:start");
		this.onCall?.();
		this.events.push("native:call:return");
		return this.callResult;
	}

	cancel(_handle: bigint, _requestId: bigint): EmbeddedNativeCallResult {
		this.cancelCount += 1;
		this.events.push("native:cancel");
		return this.cancelResult;
	}

	closeRuntime(_handle: bigint): EmbeddedNativeCallResult {
		this.closeRuntimeCount += 1;
		this.events.push("native:close-runtime");
		return this.closeResult;
	}

	closeLibrary(): void {
		this.closeLibraryCount += 1;
		this.events.push("native:dlclose");
	}
}

function expectInternalError(action: () => unknown, message: string): void {
	let thrown: unknown;
	try {
		action();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(RuntimeRpcError);
	if (!(thrown instanceof RuntimeRpcError)) throw new Error("expected RuntimeRpcError");
	expect(thrown.code).toBe("internal");
	expect(thrown.message).toContain(message);
}

describe("embedded native ABI ownership", () => {
	test("rejects ABI and schema mismatches before a runtime can open", () => {
		for (const mismatch of ["abi", "schema"] as const) {
			const bindings = new FakeBindings();
			if (mismatch === "abi") bindings.abiVersion += 1;
			else bindings.schemaHash = "wrong-schema";

			expectInternalError(() => createEmbeddedNativeLibrary("/canonical/libelide_embed.so", bindings), "mismatch");
			expect(bindings.openCount).toBe(0);
			expect(bindings.closeLibraryCount).toBe(1);
		}
	});

	test("copies every successful response before freeing native storage", () => {
		const bindings = new FakeBindings();
		const library = createEmbeddedNativeLibrary("/canonical/libelide_embed.so", bindings);

		const opened = library.open(new Uint8Array([99]));
		const called = library.call(opened.handle, new Uint8Array([98]));
		const cancelled = library.cancel(opened.handle, 7n);
		const closed = library.closeRuntime(opened.handle);

		expect(opened.response).toEqual(new Uint8Array([1, 2, 3]));
		expect(called).toEqual(new Uint8Array([4, 5, 6]));
		expect(cancelled).toEqual(new Uint8Array([7, 8]));
		expect(closed).toEqual(new Uint8Array([9]));
		expect(bindings.events).toEqual([
			"native:open",
			"open:copy",
			"open:free",
			"native:call:start",
			"native:call:return",
			"call:copy",
			"call:free",
			"native:cancel",
			"cancel:copy",
			"cancel:free",
			"native:close-runtime",
			"close:copy",
			"close:free",
		]);
	});

	test("frees failed and oversized responses without copying or retrying", () => {
		const bindings = new FakeBindings();
		bindings.callResult = { status: 2, response: bindings.buffer("failed", [1]) };
		const library = createEmbeddedNativeLibrary("/canonical/libelide_embed.so", bindings);
		const { handle } = library.open(new Uint8Array([1]));

		expectInternalError(() => library.call(handle, new Uint8Array([2])), "status 2");
		expect(bindings.callCount).toBe(1);
		expect(bindings.events).toContain("failed:free");
		expect(bindings.events).not.toContain("failed:copy");

		bindings.callResult = {
			status: 0,
			response: bindings.buffer("oversized", [], BigInt(MAX_EMBEDDED_RESPONSE_BYTES) + 1n),
		};
		expectInternalError(() => library.call(handle, new Uint8Array([3])), "safety limit");
		expect(bindings.events).toContain("oversized:free");
		expect(bindings.events).not.toContain("oversized:copy");
	});

	test("treats status-zero close as terminal even when its response is malformed", () => {
		const bindings = new FakeBindings();
		bindings.closeResult = {
			status: 0,
			response: bindings.buffer("malformed-close", [], BigInt(MAX_EMBEDDED_RESPONSE_BYTES) + 1n),
		};
		const library = createEmbeddedNativeLibrary("/canonical/libelide_embed.so", bindings);
		const { handle } = library.open(new Uint8Array([1]));

		expectInternalError(() => library.closeRuntime(handle), "safety limit");
		expectInternalError(() => library.closeRuntime(handle), "safety limit");
		library.closeLibrary();

		expect(bindings.closeRuntimeCount).toBe(1);
		expect(bindings.events).toContain("malformed-close:free");
		expect(bindings.closeLibraryCount).toBe(1);
	});

	test("defers dlclose until an in-flight call and its runtime are closed", () => {
		const bindings = new FakeBindings();
		const library = createEmbeddedNativeLibrary("/canonical/libelide_embed.so", bindings);
		const { handle } = library.open(new Uint8Array([1]));
		bindings.onCall = () => library.closeLibrary();

		library.call(handle, new Uint8Array([2]));
		expect(bindings.closeLibraryCount).toBe(0);
		const firstClose = library.closeRuntime(handle);
		const repeatedClose = library.closeRuntime(handle);
		library.closeLibrary();

		expect(firstClose).toEqual(new Uint8Array([9]));
		expect(repeatedClose).toEqual(new Uint8Array([9]));
		expect(bindings.closeRuntimeCount).toBe(1);
		expect(bindings.closeLibraryCount).toBe(1);
		expect(bindings.events.indexOf("native:dlclose")).toBeGreaterThan(bindings.events.indexOf("close:free"));
	});
});
