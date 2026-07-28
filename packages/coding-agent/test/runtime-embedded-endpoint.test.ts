import { describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Message } from "capnp-es";
import {
	type EmbeddedNativeLibrary,
} from "../src/runtime/embedded/abi";
import {
	type EmbeddedExecutionResult,
} from "../src/runtime/embedded/codec";
import { ProtocolVersion } from "../src/runtime/embedded/generated/base";
import {
	EmbeddedCallRequest,
	EmbeddedFailureCode as WireFailureCode,
	EmbeddedResponse,
} from "../src/runtime/embedded/generated/embed";
import { EMBEDDED_RUNTIME_ABI_VERSION, EMBEDDED_RUNTIME_SCHEMA_SHA256 } from "../src/runtime/embedded/schema";
import { ExecutionWorkerCore } from "../src/runtime/embedded/worker-core";
import type {
	EmbeddedWorkerTransport,
	ExecutionWorkerRequest,
	ExecutionWorkerResponse,
} from "../src/runtime/embedded/worker-protocol";
import {
	errorResponse,
	okResponse,
	RuntimeRpcError,
	type RuntimeRpcRequest,
	type RuntimeRpcResponse,
	type RuntimeStatusResult,
	unwrapResponse,
} from "../src/runtime/protocol";
import type { RuntimeEndpoint } from "../src/runtime/service";
import {
	EmbeddedRuntimeEndpoint,
	type EmbeddedRuntimeWorkerHost,
} from "../src/runtime/transport/embedded";
import { SelectedRuntimeEndpoint } from "../src/runtime/transport/selected";

const encoder = new TextEncoder();

function rpcRequest(id: number, method: RuntimeRpcRequest["method"], params: unknown): RuntimeRpcRequest {
	return { jsonrpc: "2.0", id, method, params };
}

function serializeResponse(requestId: bigint, build: (response: EmbeddedResponse) => void): Uint8Array {
	const message = new Message();
	const response = message.initRoot(EmbeddedResponse);
	response.protocolVersion = ProtocolVersion.V2;
	response.requestId = requestId;
	build(response);
	return new Uint8Array(message.toArrayBuffer());
}

function openedResponse(): Uint8Array {
	return serializeResponse(0n, response => {
		response.opened = true;
	});
}

function completedResponse(
	requestId: bigint,
	result: Partial<EmbeddedExecutionResult> = {},
): Uint8Array {
	return serializeResponse(requestId, response => {
		const completed = response._initCompleted();
		completed.exitCode = result.exitCode ?? 0;
		const stdout = encoder.encode(result.stdout ?? "ok");
		completed._initStdout(stdout.byteLength).copyBuffer(stdout);
		const stderr = encoder.encode(result.stderr ?? "");
		completed._initStderr(stderr.byteLength).copyBuffer(stderr);
		completed.killed = result.killed ?? false;
	});
}

function cancelledResponse(requestId: bigint): Uint8Array {
	return serializeResponse(requestId, response => {
		response.cancelled = true;
	});
}

function failureResponse(requestId: bigint, code: WireFailureCode, message: string): Uint8Array {
	return serializeResponse(requestId, response => {
		const failure = response._initFailure();
		failure.code = code;
		failure.message = message;
	});
}

function responseError(response: RuntimeRpcResponse): RuntimeRpcResponse & { error: { code: string; message: string } } {
	if (!("error" in response)) throw new Error("expected runtime RPC error response");
	return response;
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

class FakeEmbeddedHost implements EmbeddedRuntimeWorkerHost {
	readonly events: string[] = [];
	readonly callIds: bigint[] = [];
	readonly callRequests: Uint8Array[] = [];
	readonly cancelIds: bigint[] = [];
	readonly #callWaiters: Array<{ count: number; resolve: () => void }> = [];
	loadCount = 0;
	openCount = 0;
	abiVersion = EMBEDDED_RUNTIME_ABI_VERSION;
	schemaHash = EMBEDDED_RUNTIME_SCHEMA_SHA256;
	shutdownCount = 0;
	loadError: unknown;
	openError: unknown;
	callImpl: (requestId: bigint, request: Uint8Array) => Promise<Uint8Array> = async requestId =>
		completedResponse(requestId);
	cancelImpl: (requestId: bigint) => Promise<Uint8Array> = async requestId => cancelledResponse(requestId);

	async probe(): Promise<void> {
		this.events.push("probe");
	}
	async load(libraryPath: string): Promise<{ libraryPath: string; abiVersion: number; schemaHash: string }> {
		this.events.push(`load:${libraryPath}`);
		this.loadCount += 1;
		if (this.loadError !== undefined) throw this.loadError;
		return {
			libraryPath: "/canonical/libelide_embed.so",
			abiVersion: this.abiVersion,
			schemaHash: this.schemaHash,
		};
	}

	async open(
		libraryPath: string,
		_request: Uint8Array,
	): Promise<{ libraryPath: string; handle: bigint; response: Uint8Array }> {
		this.events.push(`open:${libraryPath}`);
		this.openCount += 1;
		if (this.openError !== undefined) throw this.openError;
		return { libraryPath, handle: 41n, response: openedResponse() };
	}

	waitForCalls(count: number): Promise<void> {
		if (this.callIds.length >= count) return Promise.resolve();
		const waiter = Promise.withResolvers<void>();
		this.#callWaiters.push({ count, resolve: waiter.resolve });
		return waiter.promise;
	}

	call(requestId: bigint, request: Uint8Array): Promise<Uint8Array> {
		this.events.push(`call:${requestId}`);
		this.callIds.push(requestId);
		this.callRequests.push(request);
		for (const waiter of this.#callWaiters.splice(0)) {
			if (this.callIds.length >= waiter.count) waiter.resolve();
			else this.#callWaiters.push(waiter);
		}
		return this.callImpl(requestId, request);
	}

	cancel(requestId: bigint): Promise<Uint8Array> {
		this.events.push(`cancel:${requestId}`);
		this.cancelIds.push(requestId);
		return this.cancelImpl(requestId);
	}

	async shutdown(): Promise<void> {
		this.events.push("shutdown");
		this.shutdownCount += 1;
	}
}

function embeddedEndpoint(
	host: FakeEmbeddedHost,
	overrides: Partial<ConstructorParameters<typeof EmbeddedRuntimeEndpoint>[0]> = {},
): EmbeddedRuntimeEndpoint {
	return new EmbeddedRuntimeEndpoint({
		embeddedPath: "/candidate/libelide_embed.so",
		env: { TEST_VALUE: "visible" },
		resolveLibrary: async () => ({ libraryPath: "/candidate/libelide_embed.so", source: "setting" }),
		resolveRuntime: async () => null,
		createWorkerHost: () => host,
		...overrides,
	});
}

class StubEndpoint implements RuntimeEndpoint {
	readonly requests: RuntimeRpcRequest[] = [];
	closeCount = 0;

	constructor(
		readonly label: string,
		readonly statusResult: RuntimeStatusResult,
		readonly runError?: RuntimeRpcError,
		readonly statusError?: RuntimeRpcError,
	) {}

	async request(request: RuntimeRpcRequest): Promise<RuntimeRpcResponse> {
		this.requests.push(request);
		if (request.method === "runtime/status") {
			return this.statusError ? errorResponse(request.id, this.statusError) : okResponse(request.id, this.statusResult);
		}
		if (this.runError) return errorResponse(request.id, this.runError);
		return okResponse(request.id, {
			exitCode: 0,
			stdout: this.label,
			stderr: "",
			durationMs: 1,
			killed: false,
		});
	}

	async close(): Promise<void> {
		this.closeCount += 1;
	}
}

const processStatus: RuntimeStatusResult = {
	available: true,
	version: "1.4.2",
	binaryPath: "/runtime/bin/elide",
	source: "managed",
	protocolVersion: 2,
};

const validEmbeddedStatus: RuntimeStatusResult = {
	available: true,
	protocolVersion: 2,
	embeddedLibraryPath: "/runtime/lib/libelide_embed.so",
	embeddedLibrarySource: "managed",
	embeddedAbiVersion: EMBEDDED_RUNTIME_ABI_VERSION,
	embeddedSchemaHash: EMBEDDED_RUNTIME_SCHEMA_SHA256,
};

const noEmbeddedStatus: RuntimeStatusResult = {
	available: false,
	protocolVersion: 2,
	guidance: "No embedded runtime library was found.",
};

const brokenEmbeddedStatus: RuntimeStatusResult = {
	available: false,
	protocolVersion: 2,
	embeddedLibraryPath: "/runtime/lib/libelide_embed.so",
	embeddedLibrarySource: "managed",
	guidance: "Embedded runtime ABI is incompatible.",
};

async function selectedRun(
	adapter: "process" | "embedded" | "auto",
	processEndpoint: StubEndpoint,
	embedded: StubEndpoint,
	params: unknown,
): Promise<RuntimeRpcResponse> {
	const endpoint = new SelectedRuntimeEndpoint({ adapter, processEndpoint, embeddedEndpoint: embedded });
	return endpoint.request(rpcRequest(17, "runtime/run", params));
}

describe("SelectedRuntimeEndpoint routing", () => {
	test("implements the complete adapter and language routing matrix", async () => {
		const cases: Array<{
			name: string;
			adapter: "process" | "embedded" | "auto";
			embeddedStatus: RuntimeStatusResult;
			params: unknown;
			expected: "process" | "embedded";
		}> = [
			{ name: "process JavaScript", adapter: "process", embeddedStatus: validEmbeddedStatus, params: { code: "1", language: "js" }, expected: "process" },
			{ name: "process JVM", adapter: "process", embeddedStatus: validEmbeddedStatus, params: { code: "class A {}", language: "java" }, expected: "process" },
			{ name: "embedded TypeScript", adapter: "embedded", embeddedStatus: validEmbeddedStatus, params: { code: "1", language: "ts" }, expected: "embedded" },
			{ name: "embedded Python", adapter: "embedded", embeddedStatus: validEmbeddedStatus, params: { code: "print(1)", language: "python" }, expected: "embedded" },
			{ name: "embedded JVM", adapter: "embedded", embeddedStatus: validEmbeddedStatus, params: { code: "fun main() {}", language: "kotlin" }, expected: "process" },
			{ name: "auto without library", adapter: "auto", embeddedStatus: noEmbeddedStatus, params: { code: "1", language: "js" }, expected: "process" },
			{ name: "auto valid library", adapter: "auto", embeddedStatus: validEmbeddedStatus, params: { code: "1", language: "js" }, expected: "embedded" },
			{ name: "auto JVM with valid library", adapter: "auto", embeddedStatus: validEmbeddedStatus, params: { code: "class A {}", language: "java" }, expected: "process" },
			{ name: "embedded inferred Java file", adapter: "embedded", embeddedStatus: validEmbeddedStatus, params: { path: "Main.java" }, expected: "process" },
			{ name: "explicit embedded language overrides JVM-looking path", adapter: "embedded", embeddedStatus: validEmbeddedStatus, params: { path: "Main.java", language: "js" }, expected: "embedded" },
			{ name: "auto inferred Kotlin file", adapter: "auto", embeddedStatus: validEmbeddedStatus, params: { path: "Main.kt" }, expected: "process" },
		];

		for (const item of cases) {
			const processEndpoint = new StubEndpoint("process", processStatus);
			const embedded = new StubEndpoint("embedded", item.embeddedStatus);
			const response = await selectedRun(item.adapter, processEndpoint, embedded, item.params);
			expect(unwrapResponse<{ stdout: string }>(response).stdout, item.name).toBe(item.expected);
		}
	});

	test("explicit embedded and auto broken candidates never fall back for eligible runs", async () => {
		for (const adapter of ["embedded", "auto"] as const) {
			const processEndpoint = new StubEndpoint("process", processStatus);
			const embedded = new StubEndpoint(
				"embedded",
				brokenEmbeddedStatus,
				new RuntimeRpcError("internal", "Embedded runtime ABI is incompatible."),
			);
			const response = await selectedRun(adapter, processEndpoint, embedded, { code: "1", language: "js" });
			expect(responseError(response).error.message).toContain("incompatible");
			expect(processEndpoint.requests).toHaveLength(0);
			expect(embedded.requests.map(request => request.method)).toEqual(
				adapter === "auto" ? ["runtime/status", "runtime/run"] : ["runtime/run"],
			);
		}
	});

	test("routes every non-run method through the process endpoint", async () => {
		const processEndpoint = new StubEndpoint("process", processStatus);
		const embedded = new StubEndpoint("embedded", validEmbeddedStatus);
		const endpoint = new SelectedRuntimeEndpoint({ adapter: "embedded", processEndpoint, embeddedEndpoint: embedded });
		await endpoint.request(rpcRequest(1, "runtime/check", {}));
		await endpoint.request(rpcRequest(2, "runtime/build", {}));
		await endpoint.request(rpcRequest(3, "runtime/advice", {}));
		expect(processEndpoint.requests.map(request => request.method)).toEqual([
			"runtime/check",
			"runtime/build",
			"runtime/advice",
		]);
		expect(embedded.requests).toHaveLength(0);
	});

	test("composes selected status while preserving process binary metadata", async () => {
		const processEndpoint = new StubEndpoint("process", processStatus);
		const embedded = new StubEndpoint("embedded", validEmbeddedStatus);
		const endpoint = new SelectedRuntimeEndpoint({ adapter: "auto", processEndpoint, embeddedEndpoint: embedded });
		const status = unwrapResponse<RuntimeStatusResult>(
			await endpoint.request(rpcRequest(1, "runtime/status", undefined)),
		);
		expect(status).toMatchObject({
			available: true,
			adapter: "auto",
			effectiveAdapter: "embedded",
			version: "1.4.2",
			binaryPath: "/runtime/bin/elide",
			source: "managed",
			embeddedLibraryPath: "/runtime/lib/libelide_embed.so",
			embeddedLibrarySource: "managed",
			embeddedAbiVersion: EMBEDDED_RUNTIME_ABI_VERSION,
			embeddedSchemaHash: EMBEDDED_RUNTIME_SCHEMA_SHA256,
		});
	});

	test("explicit embedded can be available when the process binary is absent", async () => {
		const processEndpoint = new StubEndpoint("process", {
			available: false,
			guidance: "process runtime missing",
			protocolVersion: 2,
		});
		const embedded = new StubEndpoint("embedded", validEmbeddedStatus);
		const endpoint = new SelectedRuntimeEndpoint({ adapter: "embedded", processEndpoint, embeddedEndpoint: embedded });
		const status = unwrapResponse<RuntimeStatusResult>(
			await endpoint.request(rpcRequest(1, "runtime/status", undefined)),
		);
		expect(status.available).toBe(true);
		expect(status.adapter).toBe("embedded");
		expect(status.effectiveAdapter).toBe("embedded");
		expect(status.embeddedLibraryPath).toBe("/runtime/lib/libelide_embed.so");
		expect(status.binaryPath).toBeUndefined();
	});
	test("non-process status survives a failed process probe, while auto without a candidate preserves it", async () => {
		const processFailure = new RuntimeRpcError("internal", "process binary is corrupt");
		for (const adapter of ["embedded", "auto"] as const) {
			const processEndpoint = new StubEndpoint("process", processStatus, undefined, processFailure);
			const embedded = new StubEndpoint("embedded", validEmbeddedStatus);
			const endpoint = new SelectedRuntimeEndpoint({ adapter, processEndpoint, embeddedEndpoint: embedded });
			const status = unwrapResponse<RuntimeStatusResult>(
				await endpoint.request(rpcRequest(1, "runtime/status", undefined)),
			);
			expect(status).toMatchObject({
				available: true,
				adapter,
				effectiveAdapter: "embedded",
				embeddedLibraryPath: "/runtime/lib/libelide_embed.so",
			});
			expect(status.binaryPath).toBeUndefined();
		}

		const processEndpoint = new StubEndpoint("process", processStatus, undefined, processFailure);
		const embedded = new StubEndpoint("embedded", noEmbeddedStatus);
		const endpoint = new SelectedRuntimeEndpoint({ adapter: "auto", processEndpoint, embeddedEndpoint: embedded });
		expect(
			responseError(await endpoint.request(rpcRequest(2, "runtime/status", undefined))).error.message,
		).toContain("corrupt");
	});

});

describe("EmbeddedRuntimeEndpoint lifecycle and validation", () => {
	test("status loads and validates the library without opening the engine; runs lazily open once and reuse", async () => {
		const host = new FakeEmbeddedHost();
		const endpoint = embeddedEndpoint(host);
		const status = unwrapResponse<RuntimeStatusResult>(
			await endpoint.request(rpcRequest(1, "runtime/status", undefined)),
		);
		expect(status).toMatchObject({
			available: true,
			embeddedLibraryPath: "/canonical/libelide_embed.so",
			embeddedAbiVersion: EMBEDDED_RUNTIME_ABI_VERSION,
			embeddedSchemaHash: EMBEDDED_RUNTIME_SCHEMA_SHA256,
		});
		expect(host.loadCount).toBe(1);
		expect(host.openCount).toBe(0);

		await endpoint.request(rpcRequest(50, "runtime/run", { code: "1", language: "js" }));
		await endpoint.request(rpcRequest(2, "runtime/run", { code: "2", language: "ts" }));
		expect(host.loadCount).toBe(1);
		expect(host.openCount).toBe(1);
		expect(host.callIds).toEqual([1n, 2n]);
		await endpoint.close();
	});

	test("reports incompatible ABI metadata, poisons the endpoint, and never opens or retries it", async () => {
		const host = new FakeEmbeddedHost();
		host.abiVersion = EMBEDDED_RUNTIME_ABI_VERSION + 1;
		const endpoint = embeddedEndpoint(host);
		const status = unwrapResponse<RuntimeStatusResult>(
			await endpoint.request(rpcRequest(1, "runtime/status", undefined)),
		);
		expect(status).toMatchObject({
			available: false,
			embeddedAbiVersion: EMBEDDED_RUNTIME_ABI_VERSION + 1,
			embeddedSchemaHash: EMBEDDED_RUNTIME_SCHEMA_SHA256,
		});
		expect(
			responseError(
				await endpoint.request(rpcRequest(2, "runtime/run", { code: "1", language: "js" })),
			).error.code,
		).toBe("internal");
		expect(host.loadCount).toBe(1);
		expect(host.openCount).toBe(0);
		await endpoint.close();
	});

	test("validates all run inputs before entering the worker queue", async () => {
		const invalidCases: Array<{ name: string; params: unknown }> = [
			{ name: "missing source", params: { language: "js" } },
			{ name: "both sources", params: { code: "1", path: "guest.js", language: "js" } },
			{ name: "language", params: { code: "1", language: "ruby" } },
			{ name: "arguments", params: { code: "1", language: "js", args: ["ok", 2] } },
			{ name: "stdin", params: { code: "1", language: "js", stdin: 3 } },
			{ name: "argument count", params: { code: "1", language: "js", args: Array.from({ length: 0x1_0000 }, () => "x") } },
			{ name: "timeout", params: { code: "1", language: "js", timeoutMs: 0 } },
			{ name: "cwd", params: { code: "1", language: "js", cwd: path.join(process.cwd(), "does-not-exist") } },
		];
		for (const item of invalidCases) {
			const host = new FakeEmbeddedHost();
			const endpoint = embeddedEndpoint(host);
			const response = await endpoint.request(rpcRequest(1, "runtime/run", item.params));
			expect(responseError(response).error.code, item.name).toBe("invalid-params");
			expect(host.events, item.name).toEqual([]);
			await endpoint.close();
		}

		const host = new FakeEmbeddedHost();
		const endpoint = embeddedEndpoint(host, { env: { VALID: "yes", INVALID: 4 } as unknown as NodeJS.ProcessEnv });
		const response = await endpoint.request(rpcRequest(1, "runtime/run", { code: "1", language: "js" }));
		expect(responseError(response).error.code).toBe("invalid-params");
		expect(host.events).toEqual([]);
		await endpoint.close();
	});

	test("normalizes invocation paths, snapshots environment, and measures host wall duration", async () => {
		const host = new FakeEmbeddedHost();
		const environment: NodeJS.ProcessEnv = { KEEP: "value", OMIT: undefined, NO_COLOR: "0" };
		const times = [100, 118.6];
		const endpoint = embeddedEndpoint(host, {
			env: environment,
			now: () => times.shift() ?? 118.6,
		});
		const pending = endpoint.request(
			rpcRequest(1, "runtime/run", {
				code: "print('ok')",
				language: "python",
				args: ["a", "b"],
				stdin: "input",
				cwd: ".",
			}),
		);
		environment.KEEP = "changed-after-request";
		const response = await pending;
		const result = unwrapResponse<{ durationMs: number }>(response);
		expect(result.durationMs).toBe(19);
		const call = new Message(host.callRequests[0], false).getRoot(EmbeddedCallRequest);
		expect(call.requestId).toBe(1n);
		expect(call.invocation.meta.engineConfig.directories.workingDir.path.pathString.path).toBe(process.cwd());
		expect(call.invocation.env.size).toBe(2);
		expect(call.invocation.env.vars.get(0).key).toBe("KEEP");
		expect(call.invocation.env.vars.get(0).value).toBe("value");
		expect(call.invocation.env.vars.get(1).key).toBe("NO_COLOR");
		expect(call.invocation.env.vars.get(1).value).toBe("1");
		expect(new TextDecoder().decode(call.stdin.toUint8Array())).toBe("input");
		await endpoint.close();
	});

	test("serializes runs in order and removes an aborted queued request without native entry", async () => {
		const host = new FakeEmbeddedHost();
		const callGates: Array<PromiseWithResolvers<Uint8Array>> = [];
		host.callImpl = async requestId => {
			const gate = Promise.withResolvers<Uint8Array>();
			callGates.push(gate);
			return gate.promise;
		};
		const endpoint = embeddedEndpoint(host);
		const first = endpoint.request(rpcRequest(10, "runtime/run", { code: "1", language: "js" }));
		const queuedAbort = new AbortController();
		const second = endpoint.request(
			rpcRequest(11, "runtime/run", { code: "2", language: "js" }),
			queuedAbort.signal,
		);
		const third = endpoint.request(rpcRequest(12, "runtime/run", { code: "3", language: "js" }));
		await host.waitForCalls(1);
		expect(host.callIds).toEqual([1n]);
		queuedAbort.abort();
		expect(responseError(await second).error.code).toBe("cancelled");
		expect(host.cancelIds).toEqual([]);
		callGates[0]?.resolve(completedResponse(1n, { stdout: "first" }));
		await first;
		await host.waitForCalls(2);
		expect(host.callIds).toEqual([1n, 2n]);
		callGates[1]?.resolve(completedResponse(2n, { stdout: "third" }));
		expect(unwrapResponse<{ stdout: string }>(await third).stdout).toBe("third");
		await endpoint.close();
	});

	test("reserves FIFO position before asynchronous preparation completes", async () => {
		const host = new FakeEmbeddedHost();
		const directory = await fs.stat(process.cwd());
		const firstPreparation = Promise.withResolvers<void>();
		const endpoint = embeddedEndpoint(host, {
			stat: async cwd => {
				if (cwd.endsWith("/slow")) await firstPreparation.promise;
				return directory;
			},
		});
		const first = endpoint.request(rpcRequest(1, "runtime/run", { code: "first", language: "js", cwd: "/slow" }));
		const second = endpoint.request(rpcRequest(2, "runtime/run", { code: "second", language: "js", cwd: "/fast" }));
		await flushMicrotasks();
		await flushMicrotasks();
		expect(host.callIds).toEqual([]);
		firstPreparation.resolve();
		await Promise.all([first, second]);
		expect(host.callIds).toEqual([1n, 2n]);
		const firstCall = new Message(host.callRequests[0], false).getRoot(EmbeddedCallRequest);
		expect(firstCall.invocation.invocation.cli.command.run.sourceCode.code).toBe("first");
		await endpoint.close();
	});

	test("starts timeout accounting only when a request reaches the queue head", async () => {
		vi.useFakeTimers();
		try {
			const host = new FakeEmbeddedHost();
			const callGates: Array<PromiseWithResolvers<Uint8Array>> = [];
			host.callImpl = async requestId => {
				const gate = Promise.withResolvers<Uint8Array>();
				callGates.push(gate);
				return gate.promise;
			};
			host.cancelImpl = async requestId => {
				callGates[1]?.resolve(completedResponse(requestId));
				return cancelledResponse(requestId);
			};
			const endpoint = embeddedEndpoint(host);
			const first = endpoint.request(rpcRequest(1, "runtime/run", { code: "1", language: "js" }));
			const second = endpoint.request(
				rpcRequest(2, "runtime/run", { code: "2", language: "js", timeoutMs: 20 }),
			);
			await host.waitForCalls(1);
			vi.advanceTimersByTime(100);
			expect(host.cancelIds).toEqual([]);
			callGates[0]?.resolve(completedResponse(1n));
			await first;
			await host.waitForCalls(2);
			expect(host.callIds).toEqual([1n, 2n]);
			vi.advanceTimersByTime(19);
			expect(host.cancelIds).toEqual([]);
			vi.advanceTimersByTime(1);
			expect(host.cancelIds).toEqual([2n]);
			expect(unwrapResponse<{ killed: boolean }>(await second).killed).toBe(true);
			await endpoint.close();
		} finally {
			vi.useRealTimers();
		}
	});

	test("preserves a completed result when timeout cancellation loses with request-not-active", async () => {
		vi.useFakeTimers();
		try {
			const host = new FakeEmbeddedHost();
			const callGate = Promise.withResolvers<Uint8Array>();
			const cancelGate = Promise.withResolvers<Uint8Array>();
			let cancelSettled = false;
			let clockReads = 0;
			host.callImpl = () => callGate.promise;
			host.cancelImpl = () => cancelGate.promise;
			const endpoint = embeddedEndpoint(host, {
				now: () => {
					clockReads += 1;
					return clockReads === 1 ? 0 : cancelSettled ? 1_000 : 10;
				},
			});
			const pending = endpoint.request(
				rpcRequest(1, "runtime/run", { code: "1", language: "js", timeoutMs: 10 }),
			);
			await host.waitForCalls(1);
			vi.advanceTimersByTime(10);
			callGate.resolve(completedResponse(1n, { stdout: "won", killed: false }));
			await flushMicrotasks();
			cancelSettled = true;
			cancelGate.resolve(failureResponse(1n, WireFailureCode.REQUEST_NOT_ACTIVE, "request not active"));
			const result = unwrapResponse<{ stdout: string; killed: boolean; durationMs: number }>(await pending);
			expect(result).toMatchObject({ stdout: "won", killed: false, durationMs: 10 });
			await endpoint.close();
		} finally {
			vi.useRealTimers();
		}
	});

	test("timeout cancellation failure poisons and fails the current request even if the call completes", async () => {
		vi.useFakeTimers();
		try {
			const host = new FakeEmbeddedHost();
			const callGate = Promise.withResolvers<Uint8Array>();
			host.callImpl = () => callGate.promise;
			host.cancelImpl = async () => {
				throw new RuntimeRpcError("internal", "control worker died");
			};
			const endpoint = embeddedEndpoint(host);
			const pending = endpoint.request(
				rpcRequest(1, "runtime/run", { code: "1", language: "js", timeoutMs: 10 }),
			);
			await host.waitForCalls(1);
			vi.advanceTimersByTime(10);
			await flushMicrotasks();
			callGate.resolve(completedResponse(1n, { stdout: "must not escape" }));
			expect(responseError(await pending).error.message).toContain("control worker died");
			expect(
				responseError(
					await endpoint.request(rpcRequest(2, "runtime/run", { code: "2", language: "js" })),
				).error.code,
			).toBe("internal");
			expect(host.callIds).toEqual([1n]);
			await endpoint.close();
		} finally {
			vi.useRealTimers();
		}
	});

	test("a cancelled runtime_call response is a poisoning protocol failure", async () => {
		const host = new FakeEmbeddedHost();
		host.callImpl = async requestId => cancelledResponse(requestId);
		const endpoint = embeddedEndpoint(host);
		expect(
			responseError(
				await endpoint.request(rpcRequest(1, "runtime/run", { code: "1", language: "js" })),
			).error.code,
		).toBe("internal");
		expect(
			responseError(
				await endpoint.request(rpcRequest(2, "runtime/run", { code: "2", language: "js" })),
			).error.code,
		).toBe("internal");
		expect(host.callIds).toEqual([1n]);
		await endpoint.close();
	});

	test("external abort cancels an active call, waits for native settlement, and leaves the queue reusable", async () => {
		const host = new FakeEmbeddedHost();
		const firstCall = Promise.withResolvers<Uint8Array>();
		let callCount = 0;
		host.callImpl = async requestId => {
			callCount += 1;
			if (callCount === 1) return firstCall.promise;
			return completedResponse(requestId, { stdout: "reused" });
		};
		const controller = new AbortController();
		const endpoint = embeddedEndpoint(host);
		let settled = false;
		const first = endpoint
			.request(rpcRequest(1, "runtime/run", { code: "1", language: "js" }), controller.signal)
			.finally(() => {
				settled = true;
			});
		await host.waitForCalls(1);
		controller.abort();
		await flushMicrotasks();
		expect(host.cancelIds).toEqual([1n]);
		expect(settled).toBe(false);
		firstCall.resolve(completedResponse(1n, { killed: true }));
		expect(responseError(await first).error.code).toBe("cancelled");
		const second = await endpoint.request(rpcRequest(2, "runtime/run", { code: "2", language: "js" }));
		expect(unwrapResponse<{ stdout: string }>(second).stdout).toBe("reused");
		expect(host.callIds).toEqual([1n, 2n]);
		await endpoint.close();
	});

	test("guest failures do not poison the queue, but uncertain worker failures do and are never retried", async () => {
		const guestHost = new FakeEmbeddedHost();
		let guestCalls = 0;
		guestHost.callImpl = async requestId => {
			guestCalls += 1;
			return completedResponse(requestId, guestCalls === 1
				? { exitCode: 1, stderr: "guest error" }
				: { stdout: "next" });
		};
		const guestEndpoint = embeddedEndpoint(guestHost);
		const failure = unwrapResponse<{ exitCode: number }>(
			await guestEndpoint.request(rpcRequest(1, "runtime/run", { code: "bad", language: "js" })),
		);
		expect(failure.exitCode).toBe(1);
		const next = unwrapResponse<{ stdout: string }>(
			await guestEndpoint.request(rpcRequest(2, "runtime/run", { code: "good", language: "js" })),
		);
		expect(next.stdout).toBe("next");
		await guestEndpoint.close();

		const uncertainHost = new FakeEmbeddedHost();
		uncertainHost.callImpl = async () => {
			throw new RuntimeRpcError("internal", "execution worker died");
		};
		const uncertainEndpoint = embeddedEndpoint(uncertainHost);
		expect(
			responseError(
				await uncertainEndpoint.request(rpcRequest(1, "runtime/run", { code: "1", language: "js" })),
			).error.code,
		).toBe("internal");
		expect(
			responseError(
				await uncertainEndpoint.request(rpcRequest(2, "runtime/run", { code: "2", language: "js" })),
			).error.code,
		).toBe("internal");
		expect(uncertainHost.callIds).toEqual([1n]);
		await uncertainEndpoint.close();
	});

	test("close is idempotent and shuts down a status-only host", async () => {
		const host = new FakeEmbeddedHost();
		const endpoint = embeddedEndpoint(host);
		await endpoint.request(rpcRequest(1, "runtime/status", undefined));
		const first = endpoint.close();
		const second = endpoint.close();
		expect(second).toBe(first);
		await first;
		expect(host.events).toEqual([
			"probe",
			"load:/candidate/libelide_embed.so",
			"shutdown",
		]);
		expect(host.shutdownCount).toBe(1);
	});
});

class CoreTransport implements EmbeddedWorkerTransport<ExecutionWorkerRequest, ExecutionWorkerResponse> {
	readonly sent: ExecutionWorkerResponse[] = [];
	#handler: ((message: ExecutionWorkerRequest) => void) | undefined;

	send(message: ExecutionWorkerResponse): void {
		this.sent.push(message);
	}

	onMessage(handler: (message: ExecutionWorkerRequest) => void): () => void {
		this.#handler = handler;
		return () => {
			if (this.#handler === handler) this.#handler = undefined;
		};
	}

	close(): void {}

	emit(message: ExecutionWorkerRequest): void {
		this.#handler?.(message);
	}
}

class LoadedNativeLibrary implements EmbeddedNativeLibrary {
	readonly path = "/canonical/libelide_embed.so";
	readonly abiVersion = EMBEDDED_RUNTIME_ABI_VERSION;
	readonly schemaHash = EMBEDDED_RUNTIME_SCHEMA_SHA256;
	openCount = 0;
	closeLibraryCount = 0;

	open(_request: Uint8Array): { handle: bigint; response: Uint8Array } {
		this.openCount += 1;
		return { handle: 9n, response: new Uint8Array([1]) };
	}

	call(_handle: bigint, _request: Uint8Array): Uint8Array {
		return new Uint8Array([2]);
	}

	cancel(_handle: bigint, _requestId: bigint): Uint8Array {
		return new Uint8Array([3]);
	}

	closeRuntime(_handle: bigint): Uint8Array {
		return new Uint8Array([4]);
	}

	closeLibrary(): void {
		this.closeLibraryCount += 1;
	}
}

describe("load-only execution worker contract", () => {
	test("validates and retains a library without opening an engine, then reuses it for the same canonical path", async () => {
		const transport = new CoreTransport();
		const library = new LoadedNativeLibrary();
		let factoryCalls = 0;
		new ExecutionWorkerCore(transport, () => {
			factoryCalls += 1;
			return library;
		});

		transport.emit({ type: "load", id: 1, libraryPath: "/candidate/libelide_embed.so" });
		await flushMicrotasks();
		expect(transport.sent[0]).toEqual({
			type: "loaded",
			id: 1,
			libraryPath: "/canonical/libelide_embed.so",
			abiVersion: EMBEDDED_RUNTIME_ABI_VERSION,
			schemaHash: EMBEDDED_RUNTIME_SCHEMA_SHA256,
		});
		expect(library.openCount).toBe(0);
		expect(library.closeLibraryCount).toBe(0);

		transport.emit({
			type: "open",
			id: 2,
			libraryPath: "/canonical/libelide_embed.so",
			request: new Uint8Array([1]),
		});
		await flushMicrotasks();
		expect(factoryCalls).toBe(1);
		expect(library.openCount).toBe(1);
		expect(library.closeLibraryCount).toBe(0);
		expect(transport.sent[1]?.type).toBe("opened");
	});

	test("rejects an open for a different path instead of reloading the retained library", async () => {
		const transport = new CoreTransport();
		const library = new LoadedNativeLibrary();
		let factoryCalls = 0;
		new ExecutionWorkerCore(transport, () => {
			factoryCalls += 1;
			return library;
		});
		transport.emit({ type: "load", id: 1, libraryPath: "/candidate/libelide_embed.so" });
		await flushMicrotasks();
		transport.emit({ type: "open", id: 2, libraryPath: "/different.so", request: new Uint8Array([1]) });
		await flushMicrotasks();
		expect(factoryCalls).toBe(1);
		expect(library.openCount).toBe(0);
		expect(transport.sent[1]?.type).toBe("error");
	});
});
