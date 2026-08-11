import { beforeEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import { consumeWorkerInbox, installWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import { Message } from "capnp-es";
import type { EmbeddedNativeLibrary } from "../src/runtime/embedded/abi";
import { ProtocolVersion } from "../src/runtime/embedded/generated/base";
import { EmbeddedResponse, EmbeddedFailureCode as WireFailureCode } from "../src/runtime/embedded/generated/embed";
import { EMBEDDED_RUNTIME_ABI_VERSION, EMBEDDED_RUNTIME_SCHEMA_SHA256 } from "../src/runtime/embedded/schema";
import {
	ControlWorkerCore,
	type EmbeddedWorkerFactories,
	type EmbeddedWorkerHandle,
	EmbeddedWorkerHost,
	ExecutionWorkerCore,
} from "../src/runtime/embedded/worker-core";
import type {
	ControlWorkerRequest,
	ControlWorkerResponse,
	EmbeddedWorkerTransport,
	ExecutionWorkerRequest,
	ExecutionWorkerResponse,
} from "../src/runtime/embedded/worker-protocol";
import { createParentPortWorkerTransport } from "../src/runtime/embedded/worker-transport";
import { RuntimeRpcError } from "../src/runtime/protocol";

interface SentMessage<Message> {
	message: Message;
	transfer: Bun.Transferable[];
}

class MemoryTransport<Inbound, Outbound> implements EmbeddedWorkerTransport<Inbound, Outbound> {
	readonly sent: SentMessage<Outbound>[] = [];
	closeCount = 0;
	failSend: ((message: Outbound) => boolean) | undefined;
	#handler: ((message: Inbound) => void) | undefined;

	send(message: Outbound, transfer: Bun.Transferable[] = []): void {
		if (this.failSend?.(message)) throw new Error("synthetic worker transport failure");
		this.sent.push({ message, transfer });
	}

	onMessage(handler: (message: Inbound) => void): () => void {
		this.#handler = handler;
		return () => {
			if (this.#handler === handler) this.#handler = undefined;
		};
	}

	close(): void {
		this.closeCount += 1;
	}

	emit(message: Inbound): void {
		this.#handler?.(message);
	}
}

class FakeNativeLibrary implements EmbeddedNativeLibrary {
	readonly path: string;
	readonly abiVersion = EMBEDDED_RUNTIME_ABI_VERSION;
	readonly schemaHash = EMBEDDED_RUNTIME_SCHEMA_SHA256;
	readonly events: string[];
	closeLibraryCount = 0;
	closeRuntimeFailure: Error | undefined;
	openHandle = 88n;
	openResponse = openedResponse();

	constructor(path: string, events: string[]) {
		this.path = path;
		this.events = events;
	}

	open(request: Uint8Array): { handle: bigint; response: Uint8Array } {
		this.events.push(`open:${request[0]}`);
		return { handle: this.openHandle, response: this.openResponse.slice() };
	}

	call(handle: bigint, request: Uint8Array): Uint8Array {
		this.events.push(`call:${handle}:${request[0]}`);
		return new Uint8Array([request[0] ?? 0]);
	}

	cancel(handle: bigint, requestId: bigint): Uint8Array {
		this.events.push(`cancel:${handle}:${requestId}`);
		return new Uint8Array([12]);
	}

	closeRuntime(handle: bigint): Uint8Array {
		this.events.push(`close:${handle}`);
		if (this.closeRuntimeFailure) throw this.closeRuntimeFailure;
		return new Uint8Array([13]);
	}

	closeLibrary(): void {
		this.closeLibraryCount += 1;
		this.events.push("dlclose");
	}
}

async function flushWorkerQueue(): Promise<void> {
	for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

function responseForId<Response extends { id: number }>(
	responses: SentMessage<Response>[],
	id: number,
): SentMessage<Response> {
	const response = responses.find(candidate => candidate.message.id === id);
	if (!response) throw new Error(`missing worker response ${id}`);
	return response;
}

function serializeResponse(build: (response: EmbeddedResponse) => void, requestId = 0n): Uint8Array {
	const message = new Message();
	const response = message.initRoot(EmbeddedResponse);
	response.protocolVersion = ProtocolVersion.V2;
	response.requestId = requestId;
	build(response);
	return new Uint8Array(message.toArrayBuffer());
}

function openedResponse(): Uint8Array {
	return serializeResponse(response => {
		response.opened = true;
	});
}

function openFailureResponse(message: string): Uint8Array {
	return serializeResponse(response => {
		const failure = response._initFailure();
		failure.code = WireFailureCode.UNSUPPORTED_LANGUAGE;
		failure.message = message;
	});
}

function cancelledResponse(requestId: bigint): Uint8Array {
	return serializeResponse(response => {
		response.cancelled = true;
	}, requestId);
}

function requestNotActiveResponse(requestId: bigint): Uint8Array {
	return serializeResponse(response => {
		const failure = response._initFailure();
		failure.code = WireFailureCode.REQUEST_NOT_ACTIVE;
		failure.message = "request is not active yet";
	}, requestId);
}

function closedResponse(): Uint8Array {
	return serializeResponse(response => {
		response.closed = true;
	});
}

function closeFailureResponse(message: string): Uint8Array {
	return serializeResponse(response => {
		const failure = response._initFailure();
		failure.code = WireFailureCode.INTERNAL;
		failure.message = message;
	});
}

class FakeExecutionWorker implements EmbeddedWorkerHandle<ExecutionWorkerRequest, ExecutionWorkerResponse> {
	readonly sent: SentMessage<ExecutionWorkerRequest>[] = [];
	terminateCount = 0;
	respondToProbe = true;
	respondToOpen = true;
	closeResponse = closedResponse();
	openHandle = 88n;
	openResponse = openedResponse();
	readonly #events: string[];
	readonly #messageHandlers = new Set<(message: ExecutionWorkerResponse) => void>();
	readonly #errorHandlers = new Set<(error: Error) => void>();
	readonly #exitHandlers = new Set<() => void>();

	constructor(events: string[]) {
		this.#events = events;
	}

	send(message: ExecutionWorkerRequest, transfer: Bun.Transferable[] = []): void {
		this.sent.push({ message, transfer });
		if (message.type === "probe") {
			if (this.respondToProbe) queueMicrotask(() => this.emit({ type: "probed", id: message.id }));
			return;
		}
		if (message.type === "open") {
			this.#events.push("execution:open");
			if (this.respondToOpen) {
				queueMicrotask(() =>
					this.emit({
						type: "opened",
						id: message.id,
						libraryPath: "/real/libelide_embed.so",
						handle: this.openHandle,
						response: this.openResponse.slice(),
					}),
				);
			}
			return;
		}
		if (message.type === "call") {
			this.#events.push("execution:call");
			return;
		}
		this.#events.push("execution:close-runtime");
		queueMicrotask(() => this.emit({ type: "closed", id: message.id, response: this.closeResponse }));
	}

	onMessage(handler: (message: ExecutionWorkerResponse) => void): () => void {
		this.#messageHandlers.add(handler);
		return () => this.#messageHandlers.delete(handler);
	}

	onError(handler: (error: Error) => void): () => void {
		this.#errorHandlers.add(handler);
		return () => this.#errorHandlers.delete(handler);
	}

	onExit(handler: () => void): () => void {
		this.#exitHandlers.add(handler);
		return () => this.#exitHandlers.delete(handler);
	}

	async terminate(): Promise<void> {
		this.terminateCount += 1;
		this.#events.push("execution:terminate");
	}

	emit(message: ExecutionWorkerResponse): void {
		for (const handler of this.#messageHandlers) handler(message);
	}

	releaseProbe(): void {
		const request = this.sent.findLast(
			(candidate): candidate is SentMessage<Extract<ExecutionWorkerRequest, { type: "probe" }>> =>
				candidate.message.type === "probe",
		);
		if (!request) throw new Error("missing execution probe");
		this.emit({ type: "probed", id: request.message.id });
	}

	releaseOpen(): void {
		const request = this.sent.findLast(
			(candidate): candidate is SentMessage<Extract<ExecutionWorkerRequest, { type: "open" }>> =>
				candidate.message.type === "open",
		);
		if (!request) throw new Error("missing execution open");
		this.emit({
			type: "opened",
			id: request.message.id,
			libraryPath: "/real/libelide_embed.so",
			handle: this.openHandle,
			response: this.openResponse.slice(),
		});
	}

	releaseLatestCall(response: Uint8Array): number {
		const request = this.sent.findLast(
			(candidate): candidate is SentMessage<Extract<ExecutionWorkerRequest, { type: "call" }>> =>
				candidate.message.type === "call",
		);
		if (!request) throw new Error("missing execution call");
		this.#events.push("execution:call-response");
		this.emit({ type: "called", id: request.message.id, response });
		return request.message.id;
	}

	die(): void {
		for (const handler of this.#exitHandlers) handler();
	}
}

class FakeControlWorker implements EmbeddedWorkerHandle<ControlWorkerRequest, ControlWorkerResponse> {
	readonly sent: SentMessage<ControlWorkerRequest>[] = [];
	terminateCount = 0;
	respondToProbe = true;
	exitBeforeShutdownAck = false;
	cancelResponses: Uint8Array[] = [];
	onCancel: ((attempt: number) => void) | undefined;
	#cancelAttempts = 0;
	readonly #events: string[];
	readonly #messageHandlers = new Set<(message: ControlWorkerResponse) => void>();
	readonly #errorHandlers = new Set<(error: Error) => void>();
	readonly #exitHandlers = new Set<() => void>();

	constructor(events: string[]) {
		this.#events = events;
	}

	send(message: ControlWorkerRequest, transfer: Bun.Transferable[] = []): void {
		this.sent.push({ message, transfer });
		if (message.type === "probe") {
			if (this.respondToProbe) queueMicrotask(() => this.emit({ type: "probed", id: message.id }));
			return;
		}
		if (message.type === "init") {
			this.#events.push(`control:init:${message.handle}`);
			queueMicrotask(() =>
				this.emit({ type: "initialized", id: message.id, libraryPath: "/real/libelide_embed.so" }),
			);
			return;
		}
		if (message.type === "cancel") {
			this.#events.push(`control:cancel:${message.requestId}`);
			this.#cancelAttempts += 1;
			const response = this.cancelResponses.shift() ?? cancelledResponse(message.requestId);
			queueMicrotask(() => {
				this.emit({ type: "cancelled", id: message.id, response });
				this.onCancel?.(this.#cancelAttempts);
			});
			return;
		}
		this.#events.push("control:shutdown");
		if (this.exitBeforeShutdownAck) queueMicrotask(() => this.die());
		else queueMicrotask(() => this.emit({ type: "shutdown-complete", id: message.id }));
	}

	onMessage(handler: (message: ControlWorkerResponse) => void): () => void {
		this.#messageHandlers.add(handler);
		return () => this.#messageHandlers.delete(handler);
	}

	onError(handler: (error: Error) => void): () => void {
		this.#errorHandlers.add(handler);
		return () => this.#errorHandlers.delete(handler);
	}

	onExit(handler: () => void): () => void {
		this.#exitHandlers.add(handler);
		return () => this.#exitHandlers.delete(handler);
	}

	async terminate(): Promise<void> {
		this.terminateCount += 1;
		this.#events.push("control:terminate");
	}

	emit(message: ControlWorkerResponse): void {
		for (const handler of this.#messageHandlers) handler(message);
	}

	releaseProbe(): void {
		const request = this.sent.findLast(
			(candidate): candidate is SentMessage<Extract<ControlWorkerRequest, { type: "probe" }>> =>
				candidate.message.type === "probe",
		);
		if (!request) throw new Error("missing control probe");
		this.emit({ type: "probed", id: request.message.id });
	}

	die(): void {
		for (const handler of this.#exitHandlers) handler();
	}
}

interface HostHarness {
	host: EmbeddedWorkerHost;
	execution: FakeExecutionWorker;
	control: FakeControlWorker;
	events: string[];
}

function createHostHarness(): HostHarness {
	const events: string[] = [];
	const execution = new FakeExecutionWorker(events);
	const control = new FakeControlWorker(events);
	const factories: EmbeddedWorkerFactories = {
		createExecutionWorker: () => execution,
		createControlWorker: () => control,
	};
	return { host: new EmbeddedWorkerHost(factories), execution, control, events };
}

function ownedTransferBuffer(bytes: Uint8Array): ArrayBuffer {
	const buffer = bytes.buffer;
	if (!(buffer instanceof ArrayBuffer)) throw new Error("worker response did not own a transferable ArrayBuffer");
	if (bytes.byteOffset !== 0 || bytes.byteLength !== buffer.byteLength) {
		throw new Error("worker response did not own its complete transferable ArrayBuffer");
	}
	return buffer;
}

async function expectInternalRejection(promise: Promise<unknown>, message: string): Promise<void> {
	let thrown: unknown;
	try {
		await promise;
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(RuntimeRpcError);
	if (!(thrown instanceof RuntimeRpcError)) throw new Error("expected RuntimeRpcError");
	expect(thrown.code).toBe("internal");
	expect(thrown.message).toContain(message);
}

describe("embedded worker cores", () => {
	test("execution probe avoids library loading and native operations stay serialized", async () => {
		const transport = new MemoryTransport<ExecutionWorkerRequest, ExecutionWorkerResponse>();
		const events: string[] = [];
		let factoryCalls = 0;
		const core = new ExecutionWorkerCore(transport, path => {
			factoryCalls += 1;
			return new FakeNativeLibrary(path, events);
		});

		transport.emit({ type: "probe", id: 1 });
		expect(responseForId(transport.sent, 1).message.type).toBe("probed");
		expect(factoryCalls).toBe(0);
		transport.emit({ type: "open", id: 2, libraryPath: "/runtime.so", request: new Uint8Array([10]) });
		transport.emit({ type: "call", id: 3, handle: 88n, request: new Uint8Array([20]) });
		transport.emit({ type: "call", id: 4, handle: 88n, request: new Uint8Array([30]) });
		transport.emit({ type: "close", id: 5, handle: 88n });
		await flushWorkerQueue();

		expect(events).toEqual(["open:10", "call:88:20", "call:88:30", "close:88", "dlclose"]);
		expect(transport.sent.map(entry => entry.message.id)).toEqual([1, 2, 3, 4, 5]);
		for (const id of [2, 3, 4, 5]) {
			const sent = responseForId(transport.sent, id);
			if (!("response" in sent.message)) throw new Error(`response ${id} did not contain bytes`);
			expect(sent.transfer).toEqual([ownedTransferBuffer(sent.message.response)]);
		}
		void core;
	});

	test("execution open closes the native runtime when publishing its response fails", async () => {
		const transport = new MemoryTransport<ExecutionWorkerRequest, ExecutionWorkerResponse>();
		transport.failSend = message => message.type === "opened";
		const events: string[] = [];
		new ExecutionWorkerCore(transport, path => new FakeNativeLibrary(path, events));

		transport.emit({ type: "open", id: 1, libraryPath: "/runtime.so", request: new Uint8Array([10]) });
		await flushWorkerQueue();

		expect(events).toEqual(["open:10", "close:88", "dlclose"]);
		expect(transport.sent.map(entry => entry.message.type)).toEqual(["error"]);
	});

	test("execution open maps a serialized failure exactly and closes its valid native handle", async () => {
		const transport = new MemoryTransport<ExecutionWorkerRequest, ExecutionWorkerResponse>();
		const events: string[] = [];
		const library = new FakeNativeLibrary("/runtime.so", events);
		library.openResponse = openFailureResponse("configured languages are unavailable");
		new ExecutionWorkerCore(transport, () => library);

		transport.emit({ type: "open", id: 1, libraryPath: "/runtime.so", request: new Uint8Array([10]) });
		await flushWorkerQueue();

		expect(events).toEqual(["open:10", "close:88", "dlclose"]);
		expect(responseForId(transport.sent, 1).message).toEqual({
			type: "error",
			id: 1,
			error: {
				code: "internal",
				message: "configured languages are unavailable",
				data: { failureCode: "unsupported-language" },
			},
		});
	});

	test("converts unknown library load and open failures into stable safe guidance", async () => {
		const libraryPath = "/deploy/runtime\ncandidate\u001b[31m.so";
		const safePath = "/deploy/runtime\\ncandidate.so";
		const message =
			`Failed to load the embedded runtime library at ${safePath}. ` +
			"Install a compatible Aura runtime or point runtime.embeddedPath or AURA_RUNTIME_EMBEDDED_LIB at a compatible library.";
		for (const operation of ["load", "open"] as const) {
			for (const rawDetail of [
				"realpath failed: secret canonicalization detail",
				"dlopen failed: secret linker detail",
				"missing symbol: secret ABI detail",
			]) {
				const transport = new MemoryTransport<ExecutionWorkerRequest, ExecutionWorkerResponse>();
				new ExecutionWorkerCore(transport, () => {
					throw new Error(rawDetail);
				});

				if (operation === "load") {
					transport.emit({ type: "load", id: 1, libraryPath });
				} else {
					transport.emit({ type: "open", id: 1, libraryPath, request: new Uint8Array([1]) });
				}
				await flushWorkerQueue();

				const response = responseForId(transport.sent, 1).message;
				expect(response).toEqual({
					type: "error",
					id: 1,
					error: { code: "runtime-missing", message, data: { path: safePath } },
				});
				expect(JSON.stringify(response)).not.toContain(rawDetail);
			}
		}
	});

	test("home-shortens the resolved candidate path in user-visible loader guidance", async () => {
		const libraryPath = `${os.homedir()}/private/runtime/libelide_embed.so`;
		const transport = new MemoryTransport<ExecutionWorkerRequest, ExecutionWorkerResponse>();
		new ExecutionWorkerCore(transport, () => {
			throw new Error("private linker detail");
		});

		transport.emit({ type: "load", id: 1, libraryPath });
		await flushWorkerQueue();

		const response = responseForId(transport.sent, 1).message;
		expect(response.type).toBe("error");
		if (response.type !== "error") throw new Error("expected worker error");
		expect(response.error.message).toContain("~/private/runtime/libelide_embed.so");
		expect(response.error.message).not.toContain(os.homedir());
		expect(response.error.data?.path).toBe("~/private/runtime/libelide_embed.so");
	});

	test("preserves a specific RuntimeRpcError from library setup unchanged", async () => {
		const transport = new MemoryTransport<ExecutionWorkerRequest, ExecutionWorkerResponse>();
		const failure = new RuntimeRpcError("invalid-params", "specific setup rejection", {
			reason: "fixture",
		});
		new ExecutionWorkerCore(transport, () => {
			throw failure;
		});

		transport.emit({ type: "load", id: 1, libraryPath: "/runtime.so" });
		await flushWorkerQueue();

		expect(responseForId(transport.sent, 1).message).toEqual({
			type: "error",
			id: 1,
			error: { code: "invalid-params", message: "specific setup rejection", data: { reason: "fixture" } },
		});
	});

	test("execution close requests library cleanup when a terminal close response is malformed", async () => {
		const transport = new MemoryTransport<ExecutionWorkerRequest, ExecutionWorkerResponse>();
		const events: string[] = [];
		const library = new FakeNativeLibrary("/runtime.so", events);
		library.closeRuntimeFailure = new RuntimeRpcError("internal", "malformed terminal close response");
		new ExecutionWorkerCore(transport, () => library);

		transport.emit({ type: "open", id: 1, libraryPath: "/runtime.so", request: new Uint8Array([10]) });
		await flushWorkerQueue();
		events.length = 0;
		transport.emit({ type: "close", id: 2, handle: 88n });
		await flushWorkerQueue();

		expect(events).toEqual(["close:88", "dlclose"]);
		expect(responseForId(transport.sent, 2).message.type).toBe("error");
	});

	test("control worker validates cancellation responses and remains responsive until shutdown", async () => {
		const transport = new MemoryTransport<ControlWorkerRequest, ControlWorkerResponse>();
		const events: string[] = [];
		let factoryCalls = 0;
		const validated: Array<{ bytes: Uint8Array; requestId: bigint }> = [];
		const core = new ControlWorkerCore(
			transport,
			path => {
				factoryCalls += 1;
				return new FakeNativeLibrary(path, events);
			},
			(bytes, requestId) => validated.push({ bytes: bytes.slice(), requestId }),
		);

		transport.emit({ type: "probe", id: 1 });
		expect(factoryCalls).toBe(0);
		transport.emit({ type: "init", id: 2, libraryPath: "/runtime.so", handle: 88n });
		transport.emit({ type: "cancel", id: 3, requestId: 1234567890123456789n });
		await flushWorkerQueue();

		expect(events).toEqual(["cancel:88:1234567890123456789"]);
		expect(validated).toEqual([{ bytes: new Uint8Array([12]), requestId: 1234567890123456789n }]);
		const cancelled = responseForId(transport.sent, 3);
		if (!("response" in cancelled.message)) throw new Error("cancel response did not contain bytes");
		expect(cancelled.transfer).toEqual([ownedTransferBuffer(cancelled.message.response)]);

		transport.emit({ type: "shutdown", id: 4 });
		await flushWorkerQueue();
		expect(events).toEqual(["cancel:88:1234567890123456789", "dlclose"]);
		expect(responseForId(transport.sent, 4).message.type).toBe("shutdown-complete");
		expect(transport.closeCount).toBe(1);
		void core;
	});
});

describe("embedded dual-worker host", () => {
	test("probes both complete worker graphs without loading a library", async () => {
		const { host, execution, control } = createHostHarness();
		await host.probe();
		expect(execution.sent.map(entry => entry.message.type)).toEqual(["probe"]);
		expect(control.sent.map(entry => entry.message.type)).toEqual(["probe"]);
		await host.shutdown();
	});

	test("transfers request buffers and preserves bigint handles and request ids", async () => {
		const { host, execution, control } = createHostHarness();
		const openRequest = new Uint8Array([1, 2]);
		const opened = await host.open("/configured/runtime.so", openRequest);
		expect(opened.handle).toBe(88n);
		expect(opened.libraryPath).toBe("/real/libelide_embed.so");
		const sentOpen = execution.sent.find(
			(entry): entry is SentMessage<Extract<ExecutionWorkerRequest, { type: "open" }>> =>
				entry.message.type === "open",
		);
		expect(sentOpen?.transfer).toEqual([openRequest.buffer]);
		const sentInit = control.sent.find(
			(entry): entry is SentMessage<Extract<ControlWorkerRequest, { type: "init" }>> =>
				entry.message.type === "init",
		);
		expect(sentInit?.message.handle).toBe(88n);

		const callRequest = new Uint8Array([3, 4]);
		const call = host.call(9007199254740993n, callRequest);
		await flushWorkerQueue();
		const sentCall = execution.sent.find(
			(entry): entry is SentMessage<Extract<ExecutionWorkerRequest, { type: "call" }>> =>
				entry.message.type === "call",
		);
		expect(sentCall?.message.handle).toBe(88n);
		expect(sentCall?.transfer).toEqual([callRequest.buffer]);
		execution.releaseLatestCall(new Uint8Array([5]));
		expect(await call).toEqual(new Uint8Array([5]));

		const cancelled = await host.cancel(9007199254740993n);
		expect(cancelled).toEqual(cancelledResponse(9007199254740993n));
		const sentCancel = control.sent.find(
			(entry): entry is SentMessage<Extract<ControlWorkerRequest, { type: "cancel" }>> =>
				entry.message.type === "cancel",
		);
		expect(sentCancel?.message.requestId).toBe(9007199254740993n);
		await host.shutdown();
	});

	test("decodes a zero-handle serialized open failure before control initialization", async () => {
		const { host, execution, control } = createHostHarness();
		execution.openHandle = 0n;
		execution.openResponse = openFailureResponse("configured languages are unavailable");

		await expect(host.open("/runtime.so", new Uint8Array([1]))).rejects.toMatchObject({
			code: "internal",
			message: "configured languages are unavailable",
			data: { failureCode: "unsupported-language" },
		});
		expect(control.sent.some(entry => entry.message.type === "init")).toBe(false);
		expect(execution.sent.some(entry => entry.message.type === "close")).toBe(false);
	});

	test("rejects an opened response with a zero handle before control initialization", async () => {
		const { host, execution, control } = createHostHarness();
		execution.openHandle = 0n;
		execution.openResponse = openedResponse();

		await expect(host.open("/runtime.so", new Uint8Array([1]))).rejects.toMatchObject({
			code: "internal",
			message: "Embedded runtime opened response requires a valid nonzero runtime handle.",
			data: { handle: "0" },
		});
		expect(control.sent.some(entry => entry.message.type === "init")).toBe(false);
		expect(execution.sent.some(entry => entry.message.type === "close")).toBe(false);
	});

	test("ignores stale responses instead of settling a later request", async () => {
		const { host, execution } = createHostHarness();
		await host.open("/runtime.so", new Uint8Array([1]));
		const first = host.call(1n, new Uint8Array([1]));
		await flushWorkerQueue();
		const firstId = execution.releaseLatestCall(new Uint8Array([10]));
		expect(await first).toEqual(new Uint8Array([10]));

		let secondSettled = false;
		const second = host.call(2n, new Uint8Array([2])).then(response => {
			secondSettled = true;
			return response;
		});
		await flushWorkerQueue();
		execution.emit({ type: "called", id: firstId, response: new Uint8Array([99]) });
		await flushWorkerQueue();
		expect(secondSettled).toBe(false);
		execution.releaseLatestCall(new Uint8Array([20]));
		expect(await second).toEqual(new Uint8Array([20]));
		await host.shutdown();
	});

	test("rejects all pending work on worker death and never retries guest code", async () => {
		const { host, execution } = createHostHarness();
		await host.open("/runtime.so", new Uint8Array([1]));
		const call = host.call(77n, new Uint8Array([7]));
		await flushWorkerQueue();
		const callCount = execution.sent.filter(entry => entry.message.type === "call").length;
		execution.die();

		await expectInternalRejection(call, "execution worker exited");
		await expectInternalRejection(host.call(78n, new Uint8Array([8])), "worker host failed");
		expect(execution.sent.filter(entry => entry.message.type === "call").length).toBe(callCount);
	});

	test("shutdown drains in-flight probe and open before closing the opened runtime", async () => {
		const { host, execution, control } = createHostHarness();
		execution.respondToProbe = false;
		execution.respondToOpen = false;
		control.respondToProbe = false;
		let probeSettled = false;
		let openSettled = false;
		let shutdownSettled = false;
		const probe = host.probe().then(() => {
			probeSettled = true;
		});
		const open = host.open("/runtime.so", new Uint8Array([1])).then(() => {
			openSettled = true;
		});
		const shutdown = host.shutdown().then(() => {
			shutdownSettled = true;
		});

		await flushWorkerQueue();
		expect(probeSettled).toBe(false);
		expect(openSettled).toBe(false);
		expect(shutdownSettled).toBe(false);
		expect(execution.terminateCount).toBe(0);
		execution.releaseProbe();
		control.releaseProbe();
		execution.releaseOpen();
		await Promise.all([probe, open, shutdown]);

		expect(execution.sent.some(entry => entry.message.type === "close")).toBe(true);
		expect(execution.terminateCount).toBe(1);
		expect(control.terminateCount).toBe(1);
	});

	test("control exit before its shutdown acknowledgement rejects shutdown", async () => {
		const { host, control, execution } = createHostHarness();
		await host.open("/runtime.so", new Uint8Array([1]));
		control.exitBeforeShutdownAck = true;
		let settled = false;
		let shutdownError: unknown;
		void host.shutdown().then(
			() => {
				settled = true;
			},
			error => {
				settled = true;
				shutdownError = error;
			},
		);
		await flushWorkerQueue();

		expect(settled).toBe(true);
		expect(shutdownError).toBeInstanceOf(RuntimeRpcError);
		if (!(shutdownError instanceof RuntimeRpcError)) throw new Error("expected RuntimeRpcError");
		expect(shutdownError.message).toContain("control worker exited");
		expect(execution.terminateCount).toBe(1);
		expect(control.terminateCount).toBe(1);
	});

	test("shutdown cancels active work, drains it, closes control then runtime, and is idempotent", async () => {
		const { host, execution, control, events } = createHostHarness();
		await host.open("/runtime.so", new Uint8Array([1]));
		events.length = 0;
		const call = host.call(55n, new Uint8Array([5]));
		await flushWorkerQueue();
		const shutdown = host.shutdown();
		await flushWorkerQueue();
		expect(events).toEqual(["execution:call", "control:cancel:55"]);
		expect(execution.sent.some(entry => entry.message.type === "close")).toBe(false);
		await expectInternalRejection(host.call(56n, new Uint8Array([6])), "shutting down");

		execution.releaseLatestCall(new Uint8Array([5]));
		expect(await call).toEqual(new Uint8Array([5]));
		await shutdown;
		expect(events).toEqual([
			"execution:call",
			"control:cancel:55",
			"execution:call-response",
			"control:shutdown",
			"execution:close-runtime",
			"execution:terminate",
			"control:terminate",
		]);
		expect(execution.terminateCount).toBe(1);
		expect(control.terminateCount).toBe(1);

		await host.shutdown();
		expect(execution.terminateCount).toBe(1);
		expect(control.terminateCount).toBe(1);
	});

	test("shutdown retries dispatch-window cancellation until the native call settles", async () => {
		const { host, execution, control, events } = createHostHarness();
		await host.open("/runtime.so", new Uint8Array([1]));
		events.length = 0;
		control.cancelResponses.push(requestNotActiveResponse(77n), cancelledResponse(77n));
		control.onCancel = attempt => {
			if (attempt === 2) execution.releaseLatestCall(cancelledResponse(77n));
		};

		const call = host.call(77n, new Uint8Array([7]));
		void call.catch(() => undefined);
		await flushWorkerQueue();
		await host.shutdown();
		await call;

		expect(events).toEqual([
			"execution:call",
			"control:cancel:77",
			"control:cancel:77",
			"execution:call-response",
			"control:shutdown",
			"execution:close-runtime",
			"execution:terminate",
			"control:terminate",
		]);
		expect(execution.terminateCount).toBe(1);
		expect(control.terminateCount).toBe(1);
	});

	test("shutdown rejects a serialized native close failure after terminating both workers", async () => {
		const { host, execution, control } = createHostHarness();
		await host.open("/runtime.so", new Uint8Array([1]));
		execution.closeResponse = closeFailureResponse("native runtime close failed");

		await expect(host.shutdown()).rejects.toMatchObject({
			code: "internal",
			message: "native runtime close failed",
			data: { failureCode: "internal" },
		});
		expect(execution.terminateCount).toBe(1);
		expect(control.terminateCount).toBe(1);
	});
});

interface PostedMessage {
	message: unknown;
	transfer: readonly unknown[] | undefined;
}

class FakePort {
	readonly posted: PostedMessage[] = [];
	closeCount = 0;
	readonly #listeners = new Set<(message: unknown) => void>();

	get listenerCount(): number {
		return this.#listeners.size;
	}

	postMessage(message: unknown, transfer?: readonly unknown[]): void {
		this.posted.push({ message, transfer });
	}

	on(event: "message", listener: (message: unknown) => void): void {
		if (event !== "message") throw new Error(`unexpected port event ${event}`);
		this.#listeners.add(listener);
	}

	off(event: "message", listener: (message: unknown) => void): void {
		if (event !== "message") throw new Error(`unexpected port event ${event}`);
		this.#listeners.delete(listener);
	}

	close(): void {
		this.closeCount += 1;
	}

	emit(message: unknown): void {
		for (const listener of [...this.#listeners]) listener(message);
	}
}

describe("createParentPortWorkerTransport", () => {
	// `installWorkerInbox` stashes a process-wide pending inbox; drop any leftover
	// so the direct-listener cases below never inherit another test's inbox.
	beforeEach(() => {
		consumeWorkerInbox();
	});

	test("replays host-buffered inbox messages to the first subscriber before new port messages", () => {
		const port = new FakePort();
		installWorkerInbox(port);
		port.emit({ type: "probe", id: 1 });
		port.emit({ type: "load", id: 2, libraryPath: "/runtime.so" });
		const transport = createParentPortWorkerTransport<ExecutionWorkerRequest, ExecutionWorkerResponse>(
			port,
			"embedded-runtime-execution-worker",
		);

		const received: ExecutionWorkerRequest[] = [];
		transport.onMessage(message => received.push(message));
		expect(received).toEqual([
			{ type: "probe", id: 1 },
			{ type: "load", id: 2, libraryPath: "/runtime.so" },
		]);

		port.emit({ type: "unload", id: 3 });
		expect(received).toEqual([
			{ type: "probe", id: 1 },
			{ type: "load", id: 2, libraryPath: "/runtime.so" },
			{ type: "unload", id: 3 },
		]);
		// The inbox listener is the only one: binding must not double-subscribe.
		expect(port.listenerCount).toBe(1);
	});

	test("delivers port messages through its own listener when no inbox was installed", () => {
		const port = new FakePort();
		const transport = createParentPortWorkerTransport<ControlWorkerRequest, ControlWorkerResponse>(
			port,
			"embedded-runtime-control-worker",
		);

		const received: ControlWorkerRequest[] = [];
		transport.onMessage(message => received.push(message));
		expect(port.listenerCount).toBe(1);
		port.emit({ type: "probe", id: 1 });
		port.emit({ type: "shutdown", id: 2 });
		expect(received).toEqual([
			{ type: "probe", id: 1 },
			{ type: "shutdown", id: 2 },
		]);
	});

	test("unsubscribing stops delivery on both the inbox and direct listener paths", () => {
		const inboxPort = new FakePort();
		installWorkerInbox(inboxPort);
		const inboxTransport = createParentPortWorkerTransport<ExecutionWorkerRequest, ExecutionWorkerResponse>(
			inboxPort,
			"embedded-runtime-execution-worker",
		);
		const fromInbox: ExecutionWorkerRequest[] = [];
		const unsubscribeInbox = inboxTransport.onMessage(message => fromInbox.push(message));
		inboxPort.emit({ type: "probe", id: 1 });
		unsubscribeInbox();
		inboxPort.emit({ type: "probe", id: 2 });
		expect(fromInbox).toEqual([{ type: "probe", id: 1 }]);

		const directPort = new FakePort();
		const directTransport = createParentPortWorkerTransport<ExecutionWorkerRequest, ExecutionWorkerResponse>(
			directPort,
			"embedded-runtime-execution-worker",
		);
		const fromPort: ExecutionWorkerRequest[] = [];
		const unsubscribeDirect = directTransport.onMessage(message => fromPort.push(message));
		directPort.emit({ type: "probe", id: 1 });
		unsubscribeDirect();
		expect(directPort.listenerCount).toBe(0);
		directPort.emit({ type: "probe", id: 2 });
		expect(fromPort).toEqual([{ type: "probe", id: 1 }]);
	});

	test("forwards the transfer list verbatim and defaults to an empty list", () => {
		const port = new FakePort();
		const transport = createParentPortWorkerTransport<ExecutionWorkerRequest, ExecutionWorkerResponse>(
			port,
			"embedded-runtime-execution-worker",
		);
		const response = new Uint8Array([7, 8]);
		const transfer: Bun.Transferable[] = [ownedTransferBuffer(response)];

		transport.send({ type: "called", id: 1, response }, transfer);
		transport.send({ type: "probed", id: 2 });

		expect(port.posted.map(entry => entry.message)).toEqual([
			{ type: "called", id: 1, response },
			{ type: "probed", id: 2 },
		]);
		expect(port.posted[0]?.transfer).toBe(transfer);
		expect(port.posted[1]?.transfer).toEqual([]);

		// Sends are inbox-independent: an inbox-bound transport posts identically.
		const inboxPort = new FakePort();
		installWorkerInbox(inboxPort);
		createParentPortWorkerTransport<ExecutionWorkerRequest, ExecutionWorkerResponse>(
			inboxPort,
			"embedded-runtime-execution-worker",
		).send({ type: "called", id: 3, response }, transfer);
		expect(inboxPort.posted).toEqual([{ message: { type: "called", id: 3, response }, transfer }]);
		expect(inboxPort.posted[0]?.transfer).toBe(transfer);
	});

	test("closes the underlying port and rejects a missing parent port with its worker label", () => {
		const port = new FakePort();
		const transport = createParentPortWorkerTransport<ControlWorkerRequest, ControlWorkerResponse>(
			port,
			"embedded-runtime-control-worker",
		);

		transport.close();
		expect(port.closeCount).toBe(1);
		expect(() =>
			createParentPortWorkerTransport<ControlWorkerRequest, ControlWorkerResponse>(
				null,
				"embedded-runtime-control-worker",
			),
		).toThrow("embedded-runtime-control-worker: missing parentPort");
	});
});
