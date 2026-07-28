import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { postmortem } from "@oh-my-pi/pi-utils";
import {
	decodeEmbeddedResponse,
	EmbeddedFailureCode,
	encodeOpenRequest,
	encodeRunRequest,
	MAX_EMBEDDED_ARGUMENT_COUNT,
	type EmbeddedDecodedResponse,
	type EmbeddedExecutionResult,
	type EmbeddedRunInvocation,
} from "../embedded/codec";
import { resolveEmbeddedRuntimeLibrary, type ResolvedEmbeddedRuntimeLibrary } from "../embedded/resolve";
import { EMBEDDED_RUNTIME_ABI_VERSION, EMBEDDED_RUNTIME_SCHEMA_SHA256 } from "../embedded/schema";
import { EmbeddedWorkerHost } from "../embedded/worker-core";
import {
	errorResponse,
	okResponse,
	RUNTIME_PROTOCOL_VERSION,
	RuntimeRpcError,
	type RuntimeExecResult,
	type RuntimeRpcRequest,
	type RuntimeRpcResponse,
	type RuntimeStatusResult,
} from "../protocol";
import { isRegularFile, resolveRuntimeBinary, type ResolvedRuntime } from "../resolve";
import type { RuntimeEndpoint } from "../service";

const MAX_NATIVE_REQUEST_ID = (1n << 64n) - 1n;
const CANCELLED_MESSAGE = "Runtime execution was cancelled.";
const MISSING_LIBRARY_GUIDANCE =
	"The embedded runtime library is unavailable. Point runtime.embeddedPath or AURA_RUNTIME_EMBEDDED_LIB at a compatible library.";

const INLINE_SOURCE_NAME: Record<EmbeddedRunInvocation["language"], string> = {
	js: "[eval].js",
	ts: "[eval].ts",
	python: "[eval].py",
};

let nextPostmortemRegistration = 0;

export interface EmbeddedRuntimeWorkerHost {
	probe(): Promise<void>;
	load(libraryPath: string): Promise<{ libraryPath: string; abiVersion: number; schemaHash: string }>;
	open(
		libraryPath: string,
		request: Uint8Array,
	): Promise<{ libraryPath: string; handle: bigint; response: Uint8Array }>;
	call(requestId: bigint, request: Uint8Array): Promise<Uint8Array>;
	cancel(requestId: bigint): Promise<Uint8Array>;
	shutdown(): Promise<void>;
}

export interface EmbeddedEndpointOptions {
	embeddedPath?: string;
	explicitPath?: string;
	env?: NodeJS.ProcessEnv;
	resolveLibrary?: typeof resolveEmbeddedRuntimeLibrary;
	resolveRuntime?: typeof resolveRuntimeBinary;
	createWorkerHost?: () => EmbeddedRuntimeWorkerHost;
	now?: () => number;
}

interface PreparedRun {
	invocation: EmbeddedRunInvocation;
	timeoutMs: number | undefined;
}

interface QueuedRun {
	readonly rpcId: number;
	readonly prepared: PreparedRun;
	readonly signal: AbortSignal | undefined;
	readonly resolve: (response: RuntimeRpcResponse) => void;
	queuedAbort: (() => void) | undefined;
}

type EmbeddedSelection =
	| { kind: "ready"; resolved: ResolvedEmbeddedRuntimeLibrary; status: RuntimeStatusResult }
	| { kind: "missing"; error: RuntimeRpcError; status: RuntimeStatusResult }
	| { kind: "broken"; error: RuntimeRpcError; status: RuntimeStatusResult };

type CallOutcome =
	| { kind: "completed"; result: EmbeddedExecutionResult }
	| { kind: "cancelled" }
	| { kind: "failure"; response: Extract<EmbeddedDecodedResponse, { type: "failure" }> };

type CancelOutcome = { kind: "matched" } | { kind: "late" };

export class EmbeddedRuntimeEndpoint implements RuntimeEndpoint {
	readonly #options: EmbeddedEndpointOptions;
	readonly #queue: QueuedRun[] = [];
	#host: EmbeddedRuntimeWorkerHost | undefined;
	#selection: Promise<EmbeddedSelection> | undefined;
	#opened: Promise<void> | undefined;
	#drain: Promise<void> | undefined;
	#nextNativeRequestId = 0n;
	#poisoned: RuntimeRpcError | undefined;
	#closing = false;
	#closePromise: Promise<void> | undefined;
	#cancelPostmortem: (() => void) | undefined;

	constructor(options: EmbeddedEndpointOptions = {}) {
		this.#options = options;
	}

	async request(request: RuntimeRpcRequest, signal?: AbortSignal): Promise<RuntimeRpcResponse> {
		try {
			if (this.#closing) {
				throw new RuntimeRpcError("internal", "Embedded runtime endpoint is closed.");
			}
			if (request.method === "runtime/status") {
				return okResponse(request.id, await this.#status());
			}
			if (request.method !== "runtime/run") {
				throw new RuntimeRpcError("invalid-params", `Embedded runtime endpoint does not support ${request.method}.`);
			}
			if (signal?.aborted) throw new RuntimeRpcError("cancelled", CANCELLED_MESSAGE);
			const prepared = await this.#prepareRun(request.params);
			if (signal?.aborted) throw new RuntimeRpcError("cancelled", CANCELLED_MESSAGE);
			return await this.#enqueue(request.id, prepared, signal);
		} catch (error) {
			return errorResponse(request.id, runtimeError(error));
		}
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closing = true;
		for (const queued of this.#queue.splice(0)) {
			if (queued.queuedAbort) queued.signal?.removeEventListener("abort", queued.queuedAbort);
			queued.resolve(errorResponse(queued.rpcId, new RuntimeRpcError("internal", "Embedded runtime endpoint is closed.")));
		}
		this.#closePromise = this.#performClose();
		return this.#closePromise;
	}

	async #performClose(): Promise<void> {
		if (this.#selection) await Promise.allSettled([this.#selection]);
		const tasks: Promise<void>[] = [];
		if (this.#host) tasks.push(this.#host.shutdown());
		if (this.#drain) tasks.push(this.#drain);
		const results = await Promise.allSettled(tasks);
		this.#cancelPostmortem?.();
		this.#cancelPostmortem = undefined;
		const failure = results.find(result => result.status === "rejected");
		if (failure?.status === "rejected") throw failure.reason;
	}

	async #status(): Promise<RuntimeStatusResult> {
		const selection = await this.#resolveSelection();
		if (!this.#poisoned) return selection.status;
		return {
			...selection.status,
			available: false,
			guidance: this.#poisoned.message,
		};
	}

	async #resolveSelection(): Promise<EmbeddedSelection> {
		if (this.#selection) return this.#selection;
		this.#selection = this.#loadSelection();
		return this.#selection;
	}

	async #loadSelection(): Promise<EmbeddedSelection> {
		const env = this.#options.env ?? process.env;
		const resolveRuntime = this.#options.resolveRuntime ?? resolveRuntimeBinary;
		const resolvedRuntime: ResolvedRuntime | null = await resolveRuntime({
			explicitPath: this.#options.explicitPath,
			env,
		});
		const resolveLibrary = this.#options.resolveLibrary ?? resolveEmbeddedRuntimeLibrary;
		const resolved = await resolveLibrary({
			embeddedPath: this.#options.embeddedPath,
			env,
			resolvedRuntime,
		});
		if (!resolved) return this.#missingSelection(env);

		let loaded:
			| { libraryPath: string; abiVersion: number; schemaHash: string }
			| undefined;
		try {
			const host = this.#workerHost();
			await host.probe();
			loaded = await host.load(resolved.libraryPath);
			if (loaded.abiVersion !== EMBEDDED_RUNTIME_ABI_VERSION) {
				throw new RuntimeRpcError(
					"internal",
					`Embedded runtime ABI ${loaded.abiVersion} is incompatible; expected ${EMBEDDED_RUNTIME_ABI_VERSION}.`,
				);
			}
			if (loaded.schemaHash !== EMBEDDED_RUNTIME_SCHEMA_SHA256) {
				throw new RuntimeRpcError("internal", "Embedded runtime schema fingerprint is incompatible.", {
					expected: EMBEDDED_RUNTIME_SCHEMA_SHA256,
					actual: loaded.schemaHash,
				});
			}
			const canonical = { libraryPath: loaded.libraryPath, source: resolved.source } satisfies ResolvedEmbeddedRuntimeLibrary;
			return {
				kind: "ready",
				resolved: canonical,
				status: {
					available: true,
					protocolVersion: RUNTIME_PROTOCOL_VERSION,
					embeddedLibraryPath: canonical.libraryPath,
					embeddedLibrarySource: canonical.source,
					embeddedAbiVersion: loaded.abiVersion,
					embeddedSchemaHash: loaded.schemaHash,
				},
			};
		} catch (error) {
			const failure = runtimeError(error);
			this.#poison(failure);
			return {
				kind: "broken",
				error: failure,
				status: {
					available: false,
					protocolVersion: RUNTIME_PROTOCOL_VERSION,
					embeddedLibraryPath: loaded?.libraryPath ?? path.resolve(resolved.libraryPath),
					embeddedLibrarySource: resolved.source,
					...(loaded
						? {
								embeddedAbiVersion: loaded.abiVersion,
								embeddedSchemaHash: loaded.schemaHash,
							}
						: {}),
					guidance: failure.message,
				},
			};
		}
	}

	#missingSelection(env: NodeJS.ProcessEnv): EmbeddedSelection {
		const settingPath = this.#options.embeddedPath?.trim();
		const environmentPath = env.AURA_RUNTIME_EMBEDDED_LIB?.trim();
		const candidatePath = settingPath || environmentPath;
		const source = settingPath ? "setting" : environmentPath ? "env" : undefined;
		const error = new RuntimeRpcError("runtime-missing", MISSING_LIBRARY_GUIDANCE, {
			...(candidatePath ? { path: path.resolve(candidatePath) } : {}),
		});
		return {
			kind: "missing",
			error,
			status: {
				available: false,
				protocolVersion: RUNTIME_PROTOCOL_VERSION,
				...(candidatePath ? { embeddedLibraryPath: path.resolve(candidatePath) } : {}),
				...(source ? { embeddedLibrarySource: source } : {}),
				guidance: MISSING_LIBRARY_GUIDANCE,
			},
		};
	}

	#workerHost(): EmbeddedRuntimeWorkerHost {
		if (this.#host) return this.#host;
		const host = this.#options.createWorkerHost?.() ?? new EmbeddedWorkerHost();
		this.#host = host;
		nextPostmortemRegistration += 1;
		this.#cancelPostmortem = postmortem.register(`embedded-runtime:${nextPostmortemRegistration}`, () => this.close());
		return host;
	}

	async #prepareRun(params: unknown): Promise<PreparedRun> {
		if (params === null || typeof params !== "object" || Array.isArray(params)) {
			throw new RuntimeRpcError("invalid-params", "run params must be an object.");
		}
		const raw = params as Record<string, unknown>;
		const environment = snapshotEnvironment(this.#options.env ?? process.env);
		const code = raw.code;
		const sourcePath = raw.path;
		if (code === undefined && sourcePath === undefined) {
			throw new RuntimeRpcError("invalid-params", "run requires code (inline) or path (existing file).");
		}
		if (code !== undefined && sourcePath !== undefined) {
			throw new RuntimeRpcError("invalid-params", "code and path are mutually exclusive.");
		}
		if (code !== undefined && typeof code !== "string") {
			throw new RuntimeRpcError("invalid-params", "code must be a string.");
		}
		if (sourcePath !== undefined && (typeof sourcePath !== "string" || sourcePath.trim() === "")) {
			throw new RuntimeRpcError("invalid-params", "path must be a non-empty string.");
		}

		const cwdValue = raw.cwd;
		if (cwdValue !== undefined && (typeof cwdValue !== "string" || cwdValue.trim() === "")) {
			throw new RuntimeRpcError("invalid-params", "cwd must be a non-empty string.");
		}
		const cwd = path.resolve(cwdValue === undefined ? process.cwd() : cwdValue);
		let cwdStat: Stats;
		try {
			cwdStat = await fs.stat(cwd);
		} catch {
			throw new RuntimeRpcError("invalid-params", `Runtime working directory does not exist: ${cwd}.`, { cwd });
		}
		if (!cwdStat.isDirectory()) {
			throw new RuntimeRpcError("invalid-params", `Runtime working directory is not a directory: ${cwd}.`, { cwd });
		}

		const language = embeddedLanguage(raw.language, typeof sourcePath === "string" ? sourcePath : undefined);
		let source: EmbeddedRunInvocation["source"];
		if (typeof sourcePath === "string") {
			const absolutePath = path.resolve(cwd, sourcePath);
			if (!(await isRegularFile(absolutePath))) {
				throw new RuntimeRpcError("invalid-params", `Runtime source file does not exist: ${absolutePath}.`, {
					path: absolutePath,
				});
			}
			source = { type: "file", path: absolutePath };
		} else {
			source = { type: "content", code: code as string, name: INLINE_SOURCE_NAME[language] };
		}

		const argsValue = raw.args;
		if (argsValue !== undefined && (!Array.isArray(argsValue) || !argsValue.every(value => typeof value === "string"))) {
			throw new RuntimeRpcError("invalid-params", "args must be an array of strings.");
		}
		if (Array.isArray(argsValue) && argsValue.length > MAX_EMBEDDED_ARGUMENT_COUNT) {
			throw new RuntimeRpcError("invalid-params", "Embedded runtime invocation has too many arguments.", {
				argumentCount: argsValue.length,
			});
		}
		const stdinValue = raw.stdin;
		if (stdinValue !== undefined && typeof stdinValue !== "string") {
			throw new RuntimeRpcError("invalid-params", "stdin must be a string.");
		}
		const timeoutValue = raw.timeoutMs;
		if (
			timeoutValue !== undefined &&
			(typeof timeoutValue !== "number" || !Number.isFinite(timeoutValue) || timeoutValue <= 0)
		) {
			throw new RuntimeRpcError("invalid-params", "timeoutMs must be a positive number of milliseconds.");
		}

		return {
			invocation: {
				source,
				language,
				args: argsValue === undefined ? [] : [...argsValue] as string[],
				cwd,
				environment,
				stdin: encoder.encode(stdinValue === undefined ? "" : stdinValue),
			},
			timeoutMs: timeoutValue as number | undefined,
		};
	}

	#enqueue(rpcId: number, prepared: PreparedRun, signal: AbortSignal | undefined): Promise<RuntimeRpcResponse> {
		if (this.#closing) {
			return Promise.resolve(errorResponse(rpcId, new RuntimeRpcError("internal", "Embedded runtime endpoint is closed.")));
		}
		const pending = Promise.withResolvers<RuntimeRpcResponse>();
		const queued: QueuedRun = { rpcId, prepared, signal, resolve: pending.resolve, queuedAbort: undefined };
		if (signal) {
			queued.queuedAbort = () => {
				const index = this.#queue.indexOf(queued);
				if (index < 0) return;
				this.#queue.splice(index, 1);
				pending.resolve(errorResponse(rpcId, new RuntimeRpcError("cancelled", CANCELLED_MESSAGE)));
			};
			signal.addEventListener("abort", queued.queuedAbort, { once: true });
		}
		this.#queue.push(queued);
		this.#startDrain();
		return pending.promise;
	}

	#startDrain(): void {
		if (this.#drain) return;
		const settled = Promise.withResolvers<void>();
		this.#drain = settled.promise;
		void this.#drainQueue().then(settled.resolve, settled.reject).finally(() => {
			if (this.#drain === settled.promise) this.#drain = undefined;
			if (this.#queue.length > 0 && !this.#closing) this.#startDrain();
		});
	}

	async #drainQueue(): Promise<void> {
		while (!this.#closing) {
			const queued = this.#queue.shift();
			if (!queued) return;
			if (queued.queuedAbort) queued.signal?.removeEventListener("abort", queued.queuedAbort);
			queued.queuedAbort = undefined;
			if (queued.signal?.aborted) {
				queued.resolve(errorResponse(queued.rpcId, new RuntimeRpcError("cancelled", CANCELLED_MESSAGE)));
				continue;
			}
			try {
				queued.resolve(okResponse(queued.rpcId, await this.#execute(queued.prepared, queued.signal)));
			} catch (error) {
				queued.resolve(errorResponse(queued.rpcId, runtimeError(error)));
			}
		}
	}

	async #execute(prepared: PreparedRun, signal: AbortSignal | undefined): Promise<RuntimeExecResult> {
		if (this.#poisoned) throw this.#poisoned;
		const selection = await this.#resolveSelection();
		if (selection.kind !== "ready") throw selection.error;
		await this.#ensureOpen(selection);
		if (signal?.aborted) throw new RuntimeRpcError("cancelled", CANCELLED_MESSAGE);
		if (this.#poisoned) throw this.#poisoned;

		const requestId = this.#nextRequestId();
		const request = encodeRunRequest(requestId, prepared.invocation);
		const host = this.#workerHost();
		let externalAbort = false;
		let timeoutFired = false;
		let cancelPromise: Promise<CancelOutcome> | undefined;
		const requestCancel = (): void => {
			cancelPromise ??= this.#cancel(requestId);
		};
		const onAbort = (): void => {
			externalAbort = true;
			requestCancel();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
		const startedAt = this.#options.now?.() ?? performance.now();
		const call = host.call(requestId, request);
		let timer: NodeJS.Timeout | undefined;
		if (prepared.timeoutMs !== undefined) {
			timer = setTimeout(() => {
				timeoutFired = true;
				requestCancel();
			}, prepared.timeoutMs);
		}

		let finishedAt = startedAt;
		let callOutcome: CallOutcome;
		try {
			callOutcome = decodeCallOutcome(await call, requestId);
		} catch (error) {
			const failure = runtimeError(error);
			this.#poison(failure);
			callOutcome = {
				kind: "failure",
				response: {
					type: "failure",
					requestId,
					code: EmbeddedFailureCode.INTERNAL,
					message: failure.message,
				},
			};
		} finally {
			finishedAt = this.#options.now?.() ?? performance.now();
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}

		let cancelOutcome: CancelOutcome | undefined;
		if (cancelPromise) {
			try {
				cancelOutcome = await cancelPromise;
			} catch (error) {
				this.#poison(runtimeError(error));
			}
		}
		if (externalAbort) throw new RuntimeRpcError("cancelled", CANCELLED_MESSAGE);
		if (callOutcome.kind === "failure") {
			const failure = new RuntimeRpcError("internal", callOutcome.response.message || "Embedded runtime call failed.", {
				failureCode: callOutcome.response.code,
			});
			this.#poison(failure);
			throw failure;
		}

		const durationMs = Math.round(Math.max(0, finishedAt - startedAt));
		if (callOutcome.kind === "cancelled") {
			return { exitCode: 1, stdout: "", stderr: "", durationMs, killed: timeoutFired };
		}
		return {
			...callOutcome.result,
			durationMs,
			killed: timeoutFired && cancelOutcome?.kind === "matched" ? true : callOutcome.result.killed,
		};
	}

	async #ensureOpen(selection: Extract<EmbeddedSelection, { kind: "ready" }>): Promise<void> {
		if (this.#opened) return this.#opened;
		this.#opened = (async () => {
			try {
				const opened = await this.#workerHost().open(
					selection.resolved.libraryPath,
					encodeOpenRequest({ languages: ["js", "ts", "python"] }),
				);
				if (opened.libraryPath !== selection.resolved.libraryPath) {
					throw new RuntimeRpcError("internal", "Embedded runtime changed library identity while opening.");
				}
				const response = decodeEmbeddedResponse(opened.response, 0n);
				if (response.type !== "opened") {
					throw new RuntimeRpcError("internal", "Embedded runtime returned an invalid open response.");
				}
			} catch (error) {
				const failure = runtimeError(error);
				this.#poison(failure);
				throw failure;
			}
		})();
		return this.#opened;
	}

	async #cancel(requestId: bigint): Promise<CancelOutcome> {
		const response = decodeEmbeddedResponse(await this.#workerHost().cancel(requestId), requestId);
		if (response.type === "cancelled") return { kind: "matched" };
		if (response.type === "failure" && response.code === EmbeddedFailureCode.REQUEST_NOT_ACTIVE) {
			return { kind: "late" };
		}
		throw new RuntimeRpcError("internal", "Embedded runtime returned an invalid cancellation response.", {
			responseType: response.type,
		});
	}

	#nextRequestId(): bigint {
		if (this.#nextNativeRequestId >= MAX_NATIVE_REQUEST_ID) {
			const failure = new RuntimeRpcError("internal", "Embedded runtime native request id space is exhausted.");
			this.#poison(failure);
			throw failure;
		}
		this.#nextNativeRequestId += 1n;
		return this.#nextNativeRequestId;
	}

	#poison(error: RuntimeRpcError): void {
		this.#poisoned ??= new RuntimeRpcError("internal", error.message, error.data);
	}
}

const encoder = new TextEncoder();

function embeddedLanguage(value: unknown, sourcePath: string | undefined): EmbeddedRunInvocation["language"] {
	if (value !== undefined) {
		if (value === "js" || value === "ts" || value === "python") return value;
		throw new RuntimeRpcError("invalid-params", "Embedded run language must be js, ts, or python.");
	}
	if (!sourcePath) return "ts";
	const extension = path.extname(sourcePath).toLowerCase();
	if (extension === ".py") return "python";
	if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return "js";
	return "ts";
}

function snapshotEnvironment(environment: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
	const snapshot: Record<string, string> = {};
	for (const [key, value] of Object.entries(environment)) {
		if (value === undefined) continue;
		if (typeof value !== "string") {
			throw new RuntimeRpcError("invalid-params", `Runtime environment value for ${key} must be a string.`);
		}
		if (key.length === 0 || key.includes("=") || key.includes("\0") || value.includes("\0")) {
			throw new RuntimeRpcError("invalid-params", `Runtime environment entry ${key || "<empty>"} is invalid.`);
		}
		snapshot[key] = value;
	}
	snapshot.NO_COLOR = "1";
	return snapshot;
}

function decodeCallOutcome(bytes: Uint8Array, requestId: bigint): CallOutcome {
	const response = decodeEmbeddedResponse(bytes, requestId);
	if (response.type === "completed") return { kind: "completed", result: response.result };
	if (response.type === "cancelled") return { kind: "cancelled" };
	if (response.type === "failure") return { kind: "failure", response };
	throw new RuntimeRpcError("internal", `Embedded runtime returned ${response.type} for a call.`);
}

function runtimeError(error: unknown): RuntimeRpcError {
	if (error instanceof RuntimeRpcError) return error;
	return new RuntimeRpcError("internal", error instanceof Error ? error.message : String(error));
}
