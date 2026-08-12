import { beforeEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import { withTimeout } from "@oh-my-pi/pi-utils";
import { consumeWorkerInbox, installWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import { Message } from "capnp-es";
import type { EmbeddedNativeLibrary } from "../src/runtime/embedded/abi";
import { decodeEmbeddedResponse, MAX_EMBEDDED_POLL_WAIT_MILLIS } from "../src/runtime/embedded/codec";
import { ProtocolVersion } from "../src/runtime/embedded/generated/base";
import {
	EmbeddedControl,
	EmbeddedControl_Op_Which,
	EmbeddedResponse,
	EmbeddedFailureCode as WireFailureCode,
} from "../src/runtime/embedded/generated/embed";
import { EMBEDDED_RUNTIME_ABI_VERSION, EMBEDDED_RUNTIME_SCHEMA_SHA256 } from "../src/runtime/embedded/schema";
import {
	ControlWorkerCore,
	DEFAULT_EMBEDDED_POLL_WAIT_MILLIS,
	type EmbeddedWorkerFactories,
	type EmbeddedWorkerHandle,
	EmbeddedWorkerHost,
	ExecutionWorkerCore,
	pumpEmbeddedContextOutput,
	spawnEmbeddedControlWorker,
	spawnEmbeddedExecutionWorker,
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

	contextCall(handle: bigint, request: Uint8Array): Uint8Array {
		this.events.push(`context-call:${handle}:${request[0]}`);
		return new Uint8Array([100, request[0] ?? 0]);
	}

	contextControl(handle: bigint, request: Uint8Array): Uint8Array {
		this.events.push(`context-control:${handle}:${request[0]}`);
		return new Uint8Array([200, request[0] ?? 0]);
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

function contextAckResponse(requestId: bigint): Uint8Array {
	return serializeResponse(response => {
		response.contextAck = true;
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
	respondToClose = true;
	closeResponse = closedResponse();
	openHandle = 88n;
	openResponse = openedResponse();
	failSend: ((message: ExecutionWorkerRequest) => boolean) | undefined;
	readonly #events: string[];
	readonly #messageHandlers = new Set<(message: ExecutionWorkerResponse) => void>();
	readonly #errorHandlers = new Set<(error: Error) => void>();
	readonly #exitHandlers = new Set<() => void>();

	constructor(events: string[]) {
		this.#events = events;
	}

	send(message: ExecutionWorkerRequest, transfer: Bun.Transferable[] = []): void {
		if (this.failSend?.(message)) throw new Error("synthetic worker send failure");
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
		if (message.type === "context-call") {
			this.#events.push("execution:context-call");
			return;
		}
		this.#events.push("execution:close-runtime");
		if (this.respondToClose) {
			queueMicrotask(() => this.emit({ type: "closed", id: message.id, response: this.closeResponse }));
		}
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

	releaseClose(): void {
		const request = this.sent.findLast(
			(candidate): candidate is SentMessage<Extract<ExecutionWorkerRequest, { type: "close" }>> =>
				candidate.message.type === "close",
		);
		if (!request) throw new Error("missing execution close");
		this.emit({ type: "closed", id: request.message.id, response: this.closeResponse });
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

	releaseLatestContextCall(response: Uint8Array): number {
		const request = this.sent.findLast(
			(candidate): candidate is SentMessage<Extract<ExecutionWorkerRequest, { type: "context-call" }>> =>
				candidate.message.type === "context-call",
		);
		if (!request) throw new Error("missing execution context call");
		this.#events.push("execution:context-call-response");
		this.emit({ type: "context-called", id: request.message.id, response });
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
	respondToShutdown = true;
	exitBeforeShutdownAck = false;
	cancelResponses: Uint8Array[] = [];
	contextControlResponses: Uint8Array[] = [];
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
		if (message.type === "context-control") {
			this.#events.push("control:context-control");
			const response = this.contextControlResponses.shift();
			if (response !== undefined) {
				queueMicrotask(() => this.emit({ type: "context-controlled", id: message.id, response }));
			}
			return;
		}
		this.#events.push("control:shutdown");
		if (this.exitBeforeShutdownAck) queueMicrotask(() => this.die());
		else if (this.respondToShutdown) queueMicrotask(() => this.emit({ type: "shutdown-complete", id: message.id }));
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

	releaseLatestContextControl(response: Uint8Array): number {
		const request = this.sent.findLast(
			(candidate): candidate is SentMessage<Extract<ControlWorkerRequest, { type: "context-control" }>> =>
				candidate.message.type === "context-control",
		);
		if (!request) throw new Error("missing control context-control");
		this.emit({ type: "context-controlled", id: request.message.id, response });
		return request.message.id;
	}

	releaseShutdown(): void {
		const request = this.sent.findLast(
			(candidate): candidate is SentMessage<Extract<ControlWorkerRequest, { type: "shutdown" }>> =>
				candidate.message.type === "shutdown",
		);
		if (!request) throw new Error("missing control shutdown");
		this.emit({ type: "shutdown-complete", id: request.message.id });
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

/** The id of the last request of `type` the host handed to a fake worker. */
function lastRequestId<Request extends { type: string; id: number }>(
	sent: SentMessage<Request>[],
	type: Request["type"],
): number {
	const request = sent.findLast(candidate => candidate.message.type === type);
	if (!request) throw new Error(`missing worker request ${type}`);
	return request.message.id;
}

/** Bounded: yields the rejection reason, and fails loudly if `promise` resolves or stalls. */
async function rejectionOf(promise: Promise<unknown>, label: string): Promise<unknown> {
	return await withTimeout(
		promise.then(
			() => {
				throw new Error(`${label} resolved instead of rejecting`);
			},
			(error: unknown) => error,
		),
		5_000,
		`${label} never settled`,
	);
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

	test("restores a worker error response into its own pending request on either channel", async () => {
		const { host, execution, control } = createHostHarness();
		await host.open("/runtime.so", new Uint8Array([1]));

		const call = host.call(41n, new Uint8Array([4]));
		await flushWorkerQueue();
		execution.emit({
			type: "error",
			id: lastRequestId(execution.sent, "call"),
			error: { code: "invalid-params", message: "guest rejected the call", data: { reason: "fixture" } },
		});
		const callFailure = await rejectionOf(call, "execution call");
		expect(callFailure).toBeInstanceOf(RuntimeRpcError);
		expect(callFailure).toMatchObject({
			code: "invalid-params",
			message: "guest rejected the call",
			data: { reason: "fixture" },
		});

		// Emitted ahead of the fake's queued `cancelled` acknowledgement, so the error
		// settles the request and the acknowledgement behind it is discarded as stale.
		const cancel = host.cancel(42n);
		control.emit({
			type: "error",
			id: lastRequestId(control.sent, "cancel"),
			error: { code: "runtime-missing", message: "control library vanished", data: { path: "/gone.so" } },
		});
		const cancelFailure = await rejectionOf(cancel, "control cancel");
		expect(cancelFailure).toBeInstanceOf(RuntimeRpcError);
		expect(cancelFailure).toMatchObject({
			code: "runtime-missing",
			message: "control library vanished",
			data: { path: "/gone.so" },
		});

		// A per-request error is not a host fault, so the host still shuts down cleanly.
		await withTimeout(host.shutdown(), 5_000, "shutdown after restored worker errors stalled");
	});

	test("one worker's fault rejects the pending requests on both channels", async () => {
		const { host, execution, control } = createHostHarness();
		await host.open("/runtime.so", new Uint8Array([1]));
		const call = host.call(51n, new Uint8Array([5]));
		await flushWorkerQueue();
		// The fake acknowledges a cancel on a queued microtask, so this is still pending
		// on the control channel when the execution worker dies later in this same turn.
		const cancel = host.cancel(52n);
		expect(control.sent.some(entry => entry.message.type === "cancel")).toBe(true);
		execution.die();

		for (const [pending, label] of [
			[call, "execution call"],
			[cancel, "control cancel"],
		] as const) {
			const failure = await rejectionOf(pending, label);
			expect(failure).toBeInstanceOf(RuntimeRpcError);
			if (!(failure instanceof RuntimeRpcError)) throw new Error("expected RuntimeRpcError");
			expect(failure.code).toBe("internal");
			expect(failure.message).toContain("execution worker exited");
		}
		expect(execution.terminateCount).toBe(1);
		expect(control.terminateCount).toBe(1);
	});

	test("a throwing worker send faults the host and rejects the request it was carrying", async () => {
		const { host, execution, control } = createHostHarness();
		await host.open("/runtime.so", new Uint8Array([1]));
		execution.failSend = message => message.type === "call";

		const failure = await rejectionOf(host.call(71n, new Uint8Array([7])), "execution call");
		expect(failure).toBeInstanceOf(RuntimeRpcError);
		if (!(failure instanceof RuntimeRpcError)) throw new Error("expected RuntimeRpcError");
		expect(failure.code).toBe("internal");
		expect(failure.message).toContain("worker host failed");
		expect(String(failure.data?.cause)).toContain("execution worker send failed");

		// The failed send is a host fault: later work is refused and both workers are gone.
		await expectInternalRejection(host.call(72n, new Uint8Array([8])), "worker host failed");
		await flushWorkerQueue();
		expect(execution.terminateCount).toBe(1);
		expect(control.terminateCount).toBe(1);
	});

	test("mints request ids from one counter shared by both worker channels", async () => {
		const { host, execution, control } = createHostHarness();
		await host.probe();
		await host.open("/runtime.so", new Uint8Array([1]));
		const call = host.call(61n, new Uint8Array([6]));
		await flushWorkerQueue();
		execution.releaseLatestCall(new Uint8Array([6]));
		await withTimeout(call, 5_000, "call stalled");
		await withTimeout(host.cancel(62n), 5_000, "cancel stalled");
		await withTimeout(host.shutdown(), 5_000, "shutdown stalled");

		// Every id the host mints is sent, so the two workers' ids must interleave into
		// one unbroken 1..n run; a per-channel counter would hand out duplicates instead.
		const ids = [...execution.sent, ...control.sent].map(entry => entry.message.id).sort((a, b) => a - b);
		expect(execution.sent.length).toBeGreaterThan(0);
		expect(control.sent.length).toBeGreaterThan(0);
		expect(ids).toEqual(Array.from({ length: ids.length }, (_, index) => index + 1));
	});

	test("an acknowledged control worker exit never faults the in-flight runtime close", async () => {
		const { host, execution, control, events } = createHostHarness();
		await host.open("/runtime.so", new Uint8Array([1]));
		control.respondToShutdown = false;
		execution.respondToClose = false;
		events.length = 0;

		const shutdown = host.shutdown();
		await flushWorkerQueue();
		control.releaseShutdown();
		await flushWorkerQueue();
		// The runtime close is in flight on the execution channel and the control worker
		// has acknowledged shutdown, so its exit here is expected rather than a crash.
		expect(events).toEqual(["control:shutdown", "execution:close-runtime"]);
		control.die();
		await flushWorkerQueue();
		execution.releaseClose();

		await withTimeout(shutdown, 5_000, "shutdown after an expected control exit stalled");
		expect(events).toEqual([
			"control:shutdown",
			"execution:close-runtime",
			"execution:terminate",
			"control:terminate",
		]);
		expect(execution.terminateCount).toBe(1);
		expect(control.terminateCount).toBe(1);
	});
});

/** Every member `EmbeddedWorkerHandle` declares; both spawn helpers must expose exactly these. */
const EMBEDDED_WORKER_HANDLE_MEMBERS = [
	"send",
	"onMessage",
	"onError",
	"onExit",
	"terminate",
] as const satisfies readonly (keyof EmbeddedWorkerHandle<never, never>)[];

// Compile-time companion to the runtime assertion below: a member added to
// `EmbeddedWorkerHandle` without being listed above fails `check:ts` here rather
// than silently escaping a member set the test still believes is exhaustive.
type AssertNever<T extends never> = T;
type UnlistedHandleMember = Exclude<
	keyof EmbeddedWorkerHandle<never, never>,
	(typeof EMBEDDED_WORKER_HANDLE_MEMBERS)[number]
>;
export type EmbeddedWorkerHandleMembersAreExhaustive = AssertNever<UnlistedHandleMember>;

function expectEmbeddedWorkerHandleShape(handle: object): void {
	expect(Object.keys(handle).sort()).toEqual([...EMBEDDED_WORKER_HANDLE_MEMBERS].sort());
	for (const value of Object.values(handle)) expect(typeof value).toBe("function");
}

async function askSpawnedWorker<Request, Response>(
	handle: EmbeddedWorkerHandle<Request, Response>,
	request: Request,
	label: string,
): Promise<Response> {
	const answered = Promise.withResolvers<Response>();
	const unsubscribe = handle.onMessage(message => answered.resolve(message));
	try {
		handle.send(request);
		return await withTimeout(answered.promise, 5_000, `${label} never answered`);
	} finally {
		unsubscribe();
	}
}

describe("embedded worker spawn helpers", () => {
	// Spawns real Workers: the spawn helpers own the `new Worker` call itself, so
	// no injection seam reaches the argv/entry pairing a shared helper could swap.
	test("both spawn helpers expose the exact handle member set and reach their own worker entry", async () => {
		// Only `terminate` is needed here, so both handle types fit structurally and
		// a spawn that throws still leaves its predecessor terminable.
		const spawned: Pick<EmbeddedWorkerHandle<never, never>, "terminate">[] = [];
		try {
			const execution = spawnEmbeddedExecutionWorker();
			spawned.push(execution);
			const control = spawnEmbeddedControlWorker();
			spawned.push(control);

			expectEmbeddedWorkerHandleShape(execution);
			expectEmbeddedWorkerHandleShape(control);

			// Each round-trip uses a request only its own core answers this way, so a
			// swapped entry URL or argv reaches the other protocol and fails here.
			// `probe` cannot do this job: both cores answer it identically.
			expect(await askSpawnedWorker(execution, { type: "unload", id: 1 }, "embedded execution worker")).toEqual({
				type: "unloaded",
				id: 1,
			});
			expect(await askSpawnedWorker(control, { type: "shutdown", id: 2 }, "embedded control worker")).toEqual({
				type: "shutdown-complete",
				id: 2,
			});
		} finally {
			await withTimeout(
				Promise.all(spawned.map(handle => handle.terminate())),
				5_000,
				"embedded worker termination stalled",
			);
		}
		// The 20s bound leaves headroom over the 5s round-trip bound above so a
		// cross-wired entry reports which worker went silent rather than tripping
		// bun's bare "test timed out".
	}, 20_000);
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

describe("embedded Tier 2 worker routing", () => {
	test("execution worker serves a context call from the native context entry point", async () => {
		const transport = new MemoryTransport<ExecutionWorkerRequest, ExecutionWorkerResponse>();
		const events: string[] = [];
		new ExecutionWorkerCore(transport, path => new FakeNativeLibrary(path, events));

		transport.emit({ type: "open", id: 1, libraryPath: "/runtime.so", request: new Uint8Array([10]) });
		transport.emit({ type: "context-call", id: 2, handle: 88n, request: new Uint8Array([42]) });
		await flushWorkerQueue();

		expect(events).toEqual(["open:10", "context-call:88:42"]);
		const response = responseForId(transport.sent, 2).message;
		expect(response.type).toBe("context-called");
		if (!("response" in response)) throw new Error("context call response carried no bytes");
		expect(Array.from(response.response)).toEqual([100, 42]);
		expect(responseForId(transport.sent, 2).transfer).toEqual([ownedTransferBuffer(response.response)]);
	});

	test("execution worker refuses a context call before open and on a stale handle", async () => {
		const transport = new MemoryTransport<ExecutionWorkerRequest, ExecutionWorkerResponse>();
		const events: string[] = [];
		new ExecutionWorkerCore(transport, path => new FakeNativeLibrary(path, events));

		transport.emit({ type: "context-call", id: 1, handle: 88n, request: new Uint8Array([1]) });
		await flushWorkerQueue();
		expect(responseForId(transport.sent, 1).message).toMatchObject({ type: "error" });

		transport.emit({ type: "open", id: 2, libraryPath: "/runtime.so", request: new Uint8Array([10]) });
		transport.emit({ type: "context-call", id: 3, handle: 99n, request: new Uint8Array([1]) });
		await flushWorkerQueue();
		const stale = responseForId(transport.sent, 3).message;
		expect(stale.type).toBe("error");
		if (stale.type !== "error") throw new Error("expected a worker error");
		expect(stale.error.message).toContain("stale handle");
		expect(events).toEqual(["open:10"]);
	});

	test("control worker serves a context control frame while holding the runtime handle", async () => {
		const transport = new MemoryTransport<ControlWorkerRequest, ControlWorkerResponse>();
		const events: string[] = [];
		new ControlWorkerCore(transport, path => new FakeNativeLibrary(path, events));

		transport.emit({ type: "init", id: 1, libraryPath: "/runtime.so", handle: 88n });
		transport.emit({ type: "context-control", id: 2, request: new Uint8Array([7]) });
		await flushWorkerQueue();

		expect(events).toEqual(["context-control:88:7"]);
		const response = responseForId(transport.sent, 2).message;
		expect(response.type).toBe("context-controlled");
		if (!("response" in response)) throw new Error("context control response carried no bytes");
		expect(Array.from(response.response)).toEqual([200, 7]);
	});

	test("control worker refuses a context control before init and after shutdown", async () => {
		const transport = new MemoryTransport<ControlWorkerRequest, ControlWorkerResponse>();
		const events: string[] = [];
		new ControlWorkerCore(transport, path => new FakeNativeLibrary(path, events));

		transport.emit({ type: "context-control", id: 1, request: new Uint8Array([7]) });
		await flushWorkerQueue();
		expect(responseForId(transport.sent, 1).message).toMatchObject({ type: "error" });

		transport.emit({ type: "init", id: 2, libraryPath: "/runtime.so", handle: 88n });
		transport.emit({ type: "shutdown", id: 3 });
		transport.emit({ type: "context-control", id: 4, request: new Uint8Array([7]) });
		await flushWorkerQueue();
		// Shutdown drops the handle first, so a frame queued behind it is refused rather than run.
		expect(responseForId(transport.sent, 4).message).toMatchObject({
			type: "error",
			error: { code: "internal", message: "Embedded runtime control worker is not initialized." },
		});
		expect(events).toEqual(["dlclose"]);
	});

	test("host answers a context control while a context eval is still in flight", async () => {
		const { host, execution, control } = createHostHarness();
		await host.open("/real/libelide_embed.so", new Uint8Array([1]));

		const eval1 = host.contextCall(1n, 4n, new Uint8Array([2]));
		await flushWorkerQueue();
		let settled = false;
		void eval1.finally(() => {
			settled = true;
		});

		const controlled = host.contextControl(new Uint8Array([3]));
		await flushWorkerQueue();
		control.releaseLatestContextControl(new Uint8Array([9]));
		expect(Array.from(await controlled)).toEqual([9]);
		expect(settled).toBe(false);

		execution.releaseLatestContextCall(new Uint8Array([5]));
		expect(Array.from(await eval1)).toEqual([5]);
	});

	test("host serializes context evals behind an in-flight one-shot call", async () => {
		const { host, execution, events } = createHostHarness();
		await host.open("/real/libelide_embed.so", new Uint8Array([1]));

		const oneShot = host.call(1n, new Uint8Array([2]));
		const contextEval = host.contextCall(2n, 4n, new Uint8Array([3]));
		await flushWorkerQueue();
		expect(events.filter(entry => entry.startsWith("execution:"))).toEqual(["execution:open", "execution:call"]);

		execution.releaseLatestCall(new Uint8Array([8]));
		await oneShot;
		await flushWorkerQueue();
		execution.releaseLatestContextCall(new Uint8Array([9]));
		expect(Array.from(await contextEval)).toEqual([9]);
	});

	test("host discards an in-flight context eval before it waits on shutdown", async () => {
		const { host, execution, control } = createHostHarness();
		await host.open("/real/libelide_embed.so", new Uint8Array([1]));

		const contextEval = host.contextCall(1n, 4n, new Uint8Array([2]));
		await flushWorkerQueue();
		const shutdown = host.shutdown();
		await flushWorkerQueue();

		const discard = control.sent.findLast(entry => entry.message.type === "context-control");
		if (!discard) throw new Error("shutdown did not discard the in-flight context eval");
		const request = discard.message;
		if (request.type !== "context-control") throw new Error("expected a context-control request");
		const decoded = new Message(request.request, false).getRoot(EmbeddedControl);
		expect(decoded.contextId).toBe(4n);
		expect(decoded.op.which()).toBe(EmbeddedControl_Op_Which.CANCEL);

		control.releaseLatestContextControl(contextAckResponse(decoded.requestId));
		await flushWorkerQueue();
		execution.releaseLatestContextCall(new Uint8Array([5]));
		await contextEval;
		await shutdown;
	});
});

describe("embedded context output pump", () => {
	function batch(chunks: Array<[stream: 0 | 1, text: string, seq: bigint]>, seq: bigint, complete: boolean) {
		const message = new Message();
		const response = message.initRoot(EmbeddedResponse);
		response.protocolVersion = ProtocolVersion.V2;
		response.requestId = 1n;
		const outputBatch = response._initOutputBatch();
		const wireChunks = outputBatch._initChunks(chunks.length);
		for (let index = 0; index < chunks.length; index += 1) {
			const entry = chunks[index];
			if (!entry) continue;
			const chunk = wireChunks.get(index);
			chunk.stream = entry[0];
			const bytes = new TextEncoder().encode(entry[1]);
			chunk._initData(bytes.byteLength).copyBuffer(bytes);
			chunk.seq = entry[2];
		}
		outputBatch.seq = seq;
		outputBatch.complete = complete;
		return decodeEmbeddedResponse(new Uint8Array(message.toArrayBuffer()), 1n);
	}

	function failure(code: WireFailureCode, requestId = 1n) {
		const message = new Message();
		const response = message.initRoot(EmbeddedResponse);
		response.protocolVersion = ProtocolVersion.V2;
		response.requestId = requestId;
		const detail = response._initFailure();
		detail.code = code;
		detail.message = "poll refused";
		return decodeEmbeddedResponse(new Uint8Array(message.toArrayBuffer()), requestId);
	}

	function collector() {
		const chunks: string[] = [];
		return {
			chunks,
			onChunk(chunk: { stream: "stdout" | "stderr"; data: Uint8Array }): void {
				chunks.push(`${chunk.stream}:${new TextDecoder().decode(chunk.data)}`);
			},
		};
	}

	test("drains chunks in sequence order and stops on the completion flag", async () => {
		const responses = [
			batch([[0, "one", 1n]], 1n, false),
			batch(
				[
					[0, "two", 2n],
					[1, "err", 3n],
				],
				3n,
				false,
			),
			batch([], 3n, true),
		];
		const sink = collector();
		const drain = await pumpEmbeddedContextOutput({
			poll: async () => responses.shift() ?? batch([], 3n, true),
			waitMillis: 0,
			onChunk: sink.onChunk,
			isEvalSettled: () => false,
			evalSettlement: new Promise<void>(() => {}),
		});

		expect(sink.chunks).toEqual(["stdout:one", "stdout:two", "stderr:err"]);
		expect(drain).toEqual({ seq: 3n, complete: true, closed: false });
	});

	test("parks each poll on the pump's own bound, and lets a caller override it", async () => {
		const bounds: number[] = [];
		const responses = [batch([[0, "one", 1n]], 1n, false), batch([], 1n, true)];
		const drain = await pumpEmbeddedContextOutput({
			poll: async waitMillis => {
				bounds.push(waitMillis);
				return responses.shift() ?? batch([], 1n, true);
			},
			onChunk: () => {},
			isEvalSettled: () => false,
			evalSettlement: new Promise<void>(() => {}),
		});
		// The wire default is 0 — an unparked poll, which would spin the control thread across the
		// worker boundary for the whole eval. The pump supplies a real bound instead.
		expect(bounds).toEqual([DEFAULT_EMBEDDED_POLL_WAIT_MILLIS, DEFAULT_EMBEDDED_POLL_WAIT_MILLIS]);
		expect(drain.complete).toBe(true);

		const overridden: number[] = [];
		await pumpEmbeddedContextOutput({
			poll: async waitMillis => {
				overridden.push(waitMillis);
				return batch([], 0n, true);
			},
			onChunk: () => {},
			isEvalSettled: () => true,
			evalSettlement: Promise.resolve(),
			waitMillis: 90_000,
		});
		// A caller-supplied bound wins, still clamped to the runtime's one-second cap.
		expect(overridden).toEqual([MAX_EMBEDDED_POLL_WAIT_MILLIS]);
	});

	test("finishes the drain when the eval rejects mid-stream instead of throwing out of the pump", async () => {
		const evalFailure = new Error("guest eval failed");
		const evaluation = Promise.reject<void>(evalFailure);
		let settled = false;
		void evaluation.catch(() => {
			settled = true;
		});
		const responses = [
			batch([[0, "before", 1n]], 1n, false),
			batch([[0, "after", 2n]], 2n, false),
			batch([], 2n, true),
		];
		const sink = collector();

		const drain = await pumpEmbeddedContextOutput({
			poll: async () => responses.shift() ?? batch([], 2n, true),
			onChunk: sink.onChunk,
			isEvalSettled: () => settled,
			evalSettlement: evaluation,
			waitMillis: 0,
		});

		expect(sink.chunks).toEqual(["stdout:before", "stdout:after"]);
		expect(drain).toEqual({ seq: 2n, complete: true, closed: false });
		// The rejection stays the caller's to observe on its own reference.
		await expect(evaluation).rejects.toBe(evalFailure);
	});

	test("ignores a completion flag that arrives before the eval produced anything", async () => {
		// A poll that beats the execution thread into the eval describes the *previous* eval and answers
		// complete with no chunks. Believing it drops the entire stream.
		const responses = [
			batch([], 0n, true),
			batch([], 0n, true),
			batch([[0, "late", 1n]], 1n, false),
			batch([], 1n, true),
		];
		const sink = collector();
		const drain = await pumpEmbeddedContextOutput({
			poll: async () => responses.shift() ?? batch([], 1n, true),
			onChunk: sink.onChunk,
			isEvalSettled: () => false,
			evalSettlement: new Promise<void>(() => {}),
		});

		expect(sink.chunks).toEqual(["stdout:late"]);
		expect(drain).toEqual({ seq: 1n, complete: true, closed: false });
	});

	test("accepts an empty completion once the eval settled, so a silent eval still terminates", async () => {
		const drain = await pumpEmbeddedContextOutput({
			poll: async () => batch([], 0n, true),
			onChunk: () => {
				throw new Error("a silent eval must not deliver chunks");
			},
			isEvalSettled: () => true,
			evalSettlement: Promise.resolve(),
		});
		expect(drain).toEqual({ seq: 0n, complete: true, closed: false });
	});

	test("rejects a batch whose sequence numbers move backwards", async () => {
		const responses = [batch([[0, "one", 2n]], 2n, false), batch([[0, "stale", 1n]], 2n, false)];
		await expectInternalRejection(
			pumpEmbeddedContextOutput({
				poll: async () => responses.shift() ?? batch([], 2n, true),
				onChunk: () => {},
				isEvalSettled: () => false,
				evalSettlement: new Promise<void>(() => {}),
			}),
			"sequence",
		);
	});

	test("stops without a completion flag once the eval settled and the pipe ran dry", async () => {
		let polls = 0;
		const drain = await pumpEmbeddedContextOutput({
			poll: async () => {
				polls += 1;
				return batch([], 0n, false);
			},
			onChunk: () => {},
			isEvalSettled: () => true,
			evalSettlement: Promise.resolve(),
		});

		// One trailing poll after settlement catches a late batch; a second empty one ends the drain.
		expect(polls).toBe(2);
		expect(drain).toEqual({ seq: 0n, complete: false, closed: false });
	});

	test("treats a closed registry and an unknown context as a terminated drain, not a fault", async () => {
		for (const code of [WireFailureCode.CLOSED, WireFailureCode.UNKNOWN_CONTEXT]) {
			const drain = await pumpEmbeddedContextOutput({
				poll: async () => failure(code),
				onChunk: () => {},
				isEvalSettled: () => false,
				evalSettlement: new Promise<void>(() => {}),
			});
			expect(drain).toEqual({ seq: 0n, complete: false, closed: true });
		}
	});

	test("raises any other poll failure so a streaming host never silently loses output", async () => {
		await expectInternalRejection(
			pumpEmbeddedContextOutput({
				poll: async () => failure(WireFailureCode.CONTEXT_POISONED),
				onChunk: () => {},
				isEvalSettled: () => false,
				evalSettlement: new Promise<void>(() => {}),
			}),
			"poll refused",
		);
	});
});
