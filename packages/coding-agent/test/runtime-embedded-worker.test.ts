import { describe, expect, test } from "bun:test";
import type { EmbeddedNativeLibrary } from "../src/runtime/embedded/abi";
import {
	ControlWorkerCore,
	EmbeddedWorkerHost,
	type EmbeddedWorkerFactories,
	type EmbeddedWorkerHandle,
	ExecutionWorkerCore,
} from "../src/runtime/embedded/worker-core";
import type {
	ControlWorkerRequest,
	ControlWorkerResponse,
	EmbeddedWorkerTransport,
	ExecutionWorkerRequest,
	ExecutionWorkerResponse,
} from "../src/runtime/embedded/worker-protocol";
import { EMBEDDED_RUNTIME_ABI_VERSION, EMBEDDED_RUNTIME_SCHEMA_SHA256 } from "../src/runtime/embedded/schema";
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

	constructor(path: string, events: string[]) {
		this.path = path;
		this.events = events;
	}

	open(request: Uint8Array): { handle: bigint; response: Uint8Array } {
		this.events.push(`open:${request[0]}`);
		return { handle: 88n, response: new Uint8Array([11]) };
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

function responseForId<Response extends { id: number }>(responses: SentMessage<Response>[], id: number): SentMessage<Response> {
	const response = responses.find(candidate => candidate.message.id === id);
	if (!response) throw new Error(`missing worker response ${id}`);
	return response;
}

class FakeExecutionWorker implements EmbeddedWorkerHandle<ExecutionWorkerRequest, ExecutionWorkerResponse> {
	readonly sent: SentMessage<ExecutionWorkerRequest>[] = [];
	terminateCount = 0;
	respondToProbe = true;
	respondToOpen = true;
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
						handle: 88n,
						response: new Uint8Array([1]),
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
		queueMicrotask(() => this.emit({ type: "closed", id: message.id, response: new Uint8Array([3]) }));
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
			handle: 88n,
			response: new Uint8Array([1]),
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
			queueMicrotask(() => this.emit({ type: "cancelled", id: message.id, response: new Uint8Array([2]) }));
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
			expect(sent.transfer).toEqual([sent.message.response.buffer]);
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
		expect(cancelled.transfer).toEqual([cancelled.message.response.buffer]);

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
			(entry): entry is SentMessage<Extract<ControlWorkerRequest, { type: "init" }>> => entry.message.type === "init",
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

		const cancel = host.cancel(9007199254740993n);
		expect(await cancel).toEqual(new Uint8Array([2]));
		const sentCancel = control.sent.find(
			(entry): entry is SentMessage<Extract<ControlWorkerRequest, { type: "cancel" }>> =>
				entry.message.type === "cancel",
		);
		expect(sentCancel?.message.requestId).toBe(9007199254740993n);
		await host.shutdown();
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
});
