/**
 * The real {@link ElideJsKernelFactory}, over the Tier 2 embedded context ABI.
 *
 * The seam it fills is documented in `./kernel.ts` and mapped op by op in
 * `docs/aura/ELIDE_ALIGNMENT.md` ("Wiring checklist"). What this module adds on
 * top of that map is the part the map could not state: **the worker protocol is
 * translated here, on the host, while the cells themselves run in the guest.**
 *
 * - `open()` → one `contextOpen`, `languages = [js, ts]`, `primaryLanguage = js`,
 *   `streamOutput = true`, `workingDir = cwd`, `label = sessionId`. The label is
 *   a label: contexts are never deduplicated, and two opens with byte-identical
 *   options must return two contexts (owner-scoped reset forks under one session
 *   id, so dedup here would merge two sessions' guest state).
 * - `send({type:"run"})` → one `contextCall` carrying `__omp_guest_deliver__(…)`,
 *   drained concurrently by `pumpEmbeddedContextOutput` on the control worker.
 *   The guest's own `text`/`display`/`tool-call`/`result` frames come back
 *   through that drain; see `./guest-bundle.ts` for the framing.
 * - `send({type:"tool-reply"})` **bypasses the queue entirely** and is appended
 *   to the guest's spool file. It cannot ride a `contextCall`: the run it
 *   answers is holding the one execution thread, so a second call would queue
 *   behind the very cell it is meant to unblock.
 * - `interrupt()` / `reset()` / `close()` → the matching control ops, which run
 *   outside the execution FIFO and so reach the runtime mid-eval.
 *
 * **The eval result is a backstop, not the answer.** A healthy cell answers
 * itself, with a `result` frame the guest wrote before the eval settled; this
 * module reads the `EmbeddedEvalResult` only to settle a run the guest could not
 * answer — a guest exit, an interrupt, a blown output budget, or a cell that
 * drained its event loop with the run still open. Every one of those settles the
 * pending run as a *value*; none of them tears the context down.
 */

import { appendFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withTimeout } from "@oh-my-pi/pi-utils";
import {
	decodeEmbeddedResponse,
	type EmbeddedContextInvocation,
	type EmbeddedControlOperation,
	type EmbeddedDecodedResponse,
	type EmbeddedEvalResult,
	type EmbeddedOutputChunk,
	encodeContextCall,
	encodeContextControl,
	encodeOpenRequest,
} from "../../runtime/embedded/codec";
import { resolveEmbeddedRuntimeLibrary } from "../../runtime/embedded/resolve";
import { EmbeddedWorkerHost, pumpEmbeddedContextOutput } from "../../runtime/embedded/worker-core";
import type { RunErrorPayload, SessionSnapshot, WorkerInbound, WorkerOutbound } from "../js/worker-protocol";
import { ELIDE_GUEST_FRAME_PREFIX, type ElideGuestBootstrapOptions, renderElideGuestBootstrap } from "./guest-bundle";
import {
	type ElideJsKernelFactory,
	type ElideJsKernelOpenOptions,
	type ElideJsKernelSession,
	getElideJsKernelFactory,
	setElideJsKernelFactory,
} from "./kernel";

/** Ceiling on one `poll-output` batch. The pump parks; this only bounds a single hop. */
const MAX_POLL_BYTES = 262_144;
/** How long a control op may take before it is treated as a wedged kernel. */
const CONTROL_TIMEOUT_MS = 30_000;
/** `interrupt` asks the runtime to unwind the guest within this window. */
const INTERRUPT_TIMEOUT_MS = 10_000;
const LINE_FEED = 0x0a;

function asError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

/**
 * Reassembles newline-delimited lines from the pump's raw byte chunks.
 *
 * Bytes, not text: a chunk boundary can fall inside a multi-byte rune, so
 * decoding happens only once a complete line is in hand.
 */
class LineReader {
	#buffer = new Uint8Array(0);

	push(bytes: Uint8Array): string[] {
		const merged = new Uint8Array(this.#buffer.length + bytes.length);
		merged.set(this.#buffer, 0);
		merged.set(bytes, this.#buffer.length);
		const lines: string[] = [];
		let start = 0;
		for (let index = 0; index < merged.length; index += 1) {
			if (merged[index] !== LINE_FEED) continue;
			lines.push(new TextDecoder().decode(merged.subarray(start, index)));
			start = index + 1;
		}
		this.#buffer = merged.subarray(start);
		return lines;
	}

	/** Whatever arrived without a trailing newline; the reader is empty afterwards. */
	flush(): string | undefined {
		if (this.#buffer.length === 0) return undefined;
		const rest = new TextDecoder().decode(this.#buffer);
		this.#buffer = new Uint8Array(0);
		return rest;
	}
}

function startsWithFramePrefix(line: string): boolean {
	return line.startsWith(ELIDE_GUEST_FRAME_PREFIX);
}

/**
 * One encoded-and-decoded conversation with an open embedded runtime.
 *
 * Split out so the protocol translation below can be driven hermetically: every
 * capnp and worker concern lives on the far side of these two methods, and those
 * are already pinned by the Tier 2 suites.
 */
export interface ElideEmbeddedContextTransport {
	/** Run one control op (open/close/interrupt/reset/poll-output) off the execution FIFO. */
	control(operation: EmbeddedControlOperation): Promise<EmbeddedDecodedResponse>;
	/** Run one eval on the execution FIFO. */
	call(invocation: EmbeddedContextInvocation): Promise<EmbeddedDecodedResponse>;
	/** Release the underlying runtime. */
	dispose(): Promise<void>;
}

/** Drive a real {@link EmbeddedWorkerHost}, minting the request ids both ops correlate on. */
export function createEmbeddedContextTransport(host: EmbeddedWorkerHost): ElideEmbeddedContextTransport {
	let nextRequestId = 0n;
	const requestId = (): bigint => {
		nextRequestId += 1n;
		return nextRequestId;
	};
	return {
		async control(operation) {
			const id = requestId();
			return decodeEmbeddedResponse(await host.contextControl(encodeContextControl(id, operation)), id);
		},
		async call(invocation) {
			const id = requestId();
			const request = encodeContextCall(id, invocation);
			return decodeEmbeddedResponse(await host.contextCall(id, invocation.contextId, request), id);
		},
		dispose: () => host.shutdown(),
	};
}

interface KernelSessionOptions {
	transport: ElideEmbeddedContextTransport;
	contextId: bigint;
	inboxPath: string;
	label: string;
	renderBootstrap(options: ElideGuestBootstrapOptions): Promise<string>;
}

class EmbeddedElideKernelSession implements ElideJsKernelSession {
	readonly #options: KernelSessionOptions;
	readonly #messageListeners = new Set<(msg: WorkerOutbound) => void>();
	readonly #errorListeners = new Set<(error: Error) => void>();
	readonly #stdout = new LineReader();
	readonly #stderr = new LineReader();
	/** Serializes everything that needs the execution thread. `tool-reply` deliberately skips it. */
	#tail: Promise<void> = Promise.resolve();
	#bootstrapped = false;
	#initialized = false;
	#snapshot: SessionSnapshot | undefined;
	/** The run the guest owes a `result` for, if any. */
	#pendingRun: string | undefined;
	#closed = false;

	constructor(options: KernelSessionOptions) {
		this.#options = options;
	}

	send(msg: WorkerInbound): void {
		if (this.#closed) return;
		if (msg.type === "tool-reply") {
			// Straight to the spool: the run this answers owns the execution thread,
			// so anything queued behind it would deadlock against its own reply.
			void this.#spool(msg);
			return;
		}
		const step = (): Promise<void> => this.#process(msg);
		this.#tail = this.#tail.then(step, step);
	}

	onMessage(handler: (msg: WorkerOutbound) => void): () => void {
		this.#messageListeners.add(handler);
		return () => {
			this.#messageListeners.delete(handler);
		};
	}

	onError(handler: (error: Error) => void): () => void {
		this.#errorListeners.add(handler);
		return () => {
			this.#errorListeners.delete(handler);
		};
	}

	/** Rung 1 of the cancellation ladder: the cell unwinds, the context and its state do not. */
	async interrupt(): Promise<void> {
		if (this.#closed) return;
		await this.#control({
			type: "interrupt",
			contextId: this.#options.contextId,
			timeoutMillis: INTERRUPT_TIMEOUT_MS,
		});
	}

	/**
	 * Discard guest state, keep engine warmth — which also discards the guest
	 * kernel, since the bootstrap lived in the state that was just wiped. The next
	 * cell re-evaluates the bundle and replays the last `init`, so a reset is
	 * invisible above this seam apart from the state it was asked to drop.
	 */
	async reset(): Promise<void> {
		if (this.#closed) return;
		await this.#control({ type: "reset", contextId: this.#options.contextId, preserveWarmth: true });
		this.#bootstrapped = false;
		this.#initialized = false;
		this.#pendingRun = undefined;
		// The guest restarts its spool at offset 0, so leaving old replies in place
		// would replay them into the next run.
		await writeFile(this.#options.inboxPath, "").catch(() => undefined);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		try {
			await this.#control({ type: "close", contextId: this.#options.contextId });
		} finally {
			await rm(this.#options.inboxPath, { force: true }).catch(() => undefined);
		}
	}

	#emit(msg: WorkerOutbound): void {
		if (msg.type === "result" && msg.runId === this.#pendingRun) this.#pendingRun = undefined;
		for (const listener of [...this.#messageListeners]) listener(msg);
	}

	#fault(error: Error): void {
		for (const listener of [...this.#errorListeners]) listener(error);
	}

	async #spool(msg: WorkerInbound): Promise<void> {
		try {
			await appendFile(this.#options.inboxPath, `${JSON.stringify(msg)}\n`);
		} catch (error) {
			this.#fault(
				new Error(
					`Runtime JS kernel ${this.#options.label} could not deliver a ${msg.type}: ${asError(error).message}`,
					{
						cause: error,
					},
				),
			);
		}
	}

	async #process(msg: Exclude<WorkerInbound, { type: "tool-reply" }>): Promise<void> {
		if (this.#closed) return;
		try {
			switch (msg.type) {
				case "init":
					this.#snapshot = msg.snapshot;
					await this.#ensureBootstrap();
					await this.#deliver(msg);
					this.#initialized = true;
					return;
				case "run":
					this.#snapshot = msg.snapshot;
					await this.#ensureBootstrap();
					await this.#ensureInitialized();
					this.#pendingRun = msg.runId;
					await this.#deliver(msg);
					return;
				case "close":
					await this.close();
					this.#emit({ type: "closed" });
					return;
			}
		} catch (error) {
			this.#fault(asError(error));
		}
	}

	async #ensureBootstrap(): Promise<void> {
		if (this.#bootstrapped) return;
		const source = await this.#options.renderBootstrap({ inboxPath: this.#options.inboxPath });
		await this.#evaluate(source, "omp-elide-guest-entry.js");
		this.#bootstrapped = true;
	}

	/** Replay the last `init` after a reset. The extra `ready` outbound is inert above this seam. */
	async #ensureInitialized(): Promise<void> {
		if (this.#initialized) return;
		const snapshot = this.#snapshot;
		if (!snapshot) return;
		await this.#deliver({ type: "init", snapshot });
		this.#initialized = true;
	}

	async #deliver(msg: WorkerInbound): Promise<void> {
		// An expression statement, never a declaration: interactive evals share one
		// top-level scope, so a `const` here would collide with the next cell's.
		await this.#evaluate(`globalThis.__omp_guest_deliver__(${JSON.stringify(msg)});`, "omp-elide-inbound.js");
	}

	/**
	 * Run one eval and drain its output concurrently.
	 *
	 * The pump owns its own park bound, gets the RAW eval promise (it projects
	 * that internally, so the rejection stays ours to observe), and gets an
	 * `isEvalSettled` that flips on BOTH arms — a settle flag that ignored the
	 * rejection would leave a failing eval's drain looping at poll cadence.
	 */
	async #evaluate(code: string, sourceName: string): Promise<void> {
		let settled = false;
		const evaluation = this.#options.transport
			.call({
				contextId: this.#options.contextId,
				language: "js",
				source: { type: "content", code },
				sourceName,
				mode: "interactive",
			})
			.then(
				response => {
					settled = true;
					return response;
				},
				error => {
					settled = true;
					throw error;
				},
			);
		const drain = pumpEmbeddedContextOutput({
			poll: waitMillis =>
				this.#options.transport.control({
					type: "poll-output",
					contextId: this.#options.contextId,
					waitMillis,
					maxBytes: MAX_POLL_BYTES,
				}),
			onChunk: chunk => this.#onChunk(chunk),
			isEvalSettled: () => settled,
			evalSettlement: evaluation.then(() => undefined),
		});

		let response: EmbeddedDecodedResponse | undefined;
		let failure: unknown;
		try {
			response = await evaluation;
		} catch (error) {
			failure = error;
		}
		try {
			await drain;
		} catch (error) {
			// A drain that fails has already lost output; say so rather than
			// attributing the loss to the cell.
			this.#fault(
				new Error(`Runtime JS kernel ${this.#options.label} lost its output drain: ${asError(error).message}`, {
					cause: error,
				}),
			);
		}
		this.#flushLines();
		if (failure) throw asError(failure);
		if (response) this.#interpret(response);
	}

	#onChunk(chunk: EmbeddedOutputChunk): void {
		const reader = chunk.stream === "stdout" ? this.#stdout : this.#stderr;
		for (const line of reader.push(chunk.data)) {
			if (chunk.stream === "stdout" && startsWithFramePrefix(line)) {
				this.#onFrame(line.slice(ELIDE_GUEST_FRAME_PREFIX.length));
				continue;
			}
			this.#onRawText(`${line}\n`);
		}
	}

	#flushLines(): void {
		for (const reader of [this.#stdout, this.#stderr]) {
			const rest = reader.flush();
			if (rest === undefined) continue;
			if (reader === this.#stdout && startsWithFramePrefix(rest)) {
				this.#onFrame(rest.slice(ELIDE_GUEST_FRAME_PREFIX.length));
				continue;
			}
			this.#onRawText(rest);
		}
	}

	#onFrame(payload: string): void {
		let parsed: WorkerOutbound;
		try {
			parsed = JSON.parse(payload) as WorkerOutbound;
		} catch (error) {
			this.#fault(
				new Error(
					`Runtime JS kernel ${this.#options.label} emitted an unreadable frame: ${asError(error).message}`,
					{
						cause: error,
					},
				),
			);
			return;
		}
		this.#emit(parsed);
	}

	/**
	 * Output the guest wrote outside the framed channel — a child process, or the
	 * runtime itself. It belongs to whichever cell is running; with no cell in
	 * flight there is nothing to attribute it to and nowhere to render it.
	 */
	#onRawText(chunk: string): void {
		const runId = this.#pendingRun;
		if (!runId) return;
		this.#emit({ type: "text", runId, chunk });
	}

	#interpret(response: EmbeddedDecodedResponse): void {
		if (response.type === "failure") {
			throw new Error(
				`Runtime JS kernel ${this.#options.label} refused a cell (${response.code}): ${response.message}`,
			);
		}
		if (response.type !== "eval-result") {
			throw new Error(`Runtime JS kernel ${this.#options.label} returned a ${response.type} for a cell.`);
		}
		const result = response.result;
		const outcome = result.outcome;
		switch (outcome.type) {
			case "ok":
				// A cell that drained the guest event loop without answering left its
				// run open forever; settling it as a value is the only thing that keeps
				// the host from waiting on a reply that can never come.
				this.#settlePendingRun({
					message:
						"The runtime JS cell finished without producing a result. An outstanding tool call was never answered.",
				});
				return;
			case "interrupted":
				this.#settlePendingRun({ message: this.#interruptedMessage() });
				return;
			case "cancelled":
				this.#settlePendingRun({ message: this.#interruptedMessage() });
				return;
			case "output-limit-exceeded":
				this.#settlePendingRun({
					message: "The runtime JS cell exceeded its output budget and was stopped; the context survived.",
				});
				return;
			case "error":
				this.#settleGuestError(result, outcome.error.isExit, outcome.error.isCancelled, outcome.error);
				return;
		}
	}

	#interruptedMessage(): string {
		return "The runtime JS cell was interrupted; the context and its variables survived.";
	}

	#settleGuestError(
		result: EmbeddedEvalResult,
		isExit: boolean,
		isCancelled: boolean,
		error: { typeName: string; message: string; exitStatus: number },
	): void {
		if (isExit) {
			// A guest exit ends the EVAL, not the context: the handoff's survivable
			// exit. State from earlier cells is still there for the next one.
			this.#settlePendingRun({
				name: "ExitError",
				message: `The runtime JS cell called exit(${error.exitStatus}); the cell ended with exit status ${error.exitStatus} and the context kept its variables.`,
			});
			return;
		}
		if (isCancelled) {
			this.#settlePendingRun({ message: this.#interruptedMessage() });
			return;
		}
		// A guest error with a run still open means the failure escaped the guest
		// kernel itself (the cell's own throw is answered by a `result` frame).
		const payload: RunErrorPayload = { name: error.typeName, message: error.message };
		if (this.#pendingRun) {
			this.#settlePendingRun(payload);
			return;
		}
		if (!result.contextAlive) {
			this.#fault(new Error(`Runtime JS kernel ${this.#options.label} was poisoned: ${error.message}`));
			return;
		}
		this.#fault(new Error(`Runtime JS kernel ${this.#options.label} failed: ${error.message}`));
	}

	#settlePendingRun(error: RunErrorPayload): void {
		const runId = this.#pendingRun;
		if (!runId) return;
		this.#emit({ type: "result", runId, ok: false, error });
	}

	async #control(operation: EmbeddedControlOperation): Promise<void> {
		const response = await withTimeout(
			this.#options.transport.control(operation),
			CONTROL_TIMEOUT_MS,
			`Runtime JS kernel ${this.#options.label} never answered a ${operation.type}`,
		);
		if (response.type === "context-ack") return;
		if (response.type === "failure") {
			throw new Error(
				`Runtime JS kernel ${this.#options.label} refused a ${operation.type} (${response.code}): ${response.message}`,
			);
		}
		throw new Error(`Runtime JS kernel ${this.#options.label} answered a ${operation.type} with a ${response.type}.`);
	}
}

export interface ElideEmbeddedKernelFactoryOptions {
	/** Native library to open. Ignored when {@link createTransport} is supplied. */
	libraryPath?: string;
	/** Test seam: supply the context transport instead of opening a native runtime. */
	createTransport?(): Promise<ElideEmbeddedContextTransport>;
	/** Directory for the per-context inbound spools; defaults to the system temp dir. */
	spoolDirectory?: string;
	/** Test seam: the bootstrap source a fresh context evaluates. */
	renderBootstrap?(options: ElideGuestBootstrapOptions): Promise<string>;
}

export interface ElideEmbeddedKernelFactory extends ElideJsKernelFactory {
	/** Release the native runtime, if one was ever opened. */
	dispose(): Promise<void>;
}

/**
 * A factory over one embedded runtime handle, opened lazily.
 *
 * Lazy on purpose: installing this must not cost a `dlopen`, two worker threads,
 * and a runtime build for a session that never runs a JS cell. The first
 * `open()` pays for all of it; every later one is a `contextOpen`.
 */
export function createElideEmbeddedKernelFactory(
	options: ElideEmbeddedKernelFactoryOptions,
): ElideEmbeddedKernelFactory {
	const spoolDirectory = options.spoolDirectory ?? os.tmpdir();
	const renderBootstrap = options.renderBootstrap ?? renderElideGuestBootstrap;
	let transportPromise: Promise<ElideEmbeddedContextTransport> | undefined;

	const openTransport = (): Promise<ElideEmbeddedContextTransport> => {
		transportPromise ??= (async () => {
			if (options.createTransport) return await options.createTransport();
			const libraryPath = options.libraryPath;
			if (!libraryPath) throw new Error("No embedded runtime library was resolved for the runtime JS kernel.");
			const host = new EmbeddedWorkerHost();
			const opened = await host.open(libraryPath, encodeOpenRequest({ languages: ["js", "ts"] }));
			const response = decodeEmbeddedResponse(opened.response, 0n);
			if (response.type !== "opened") {
				await host.shutdown().catch(() => undefined);
				throw new Error(`The embedded runtime answered a ${response.type} when opening the runtime JS kernel.`);
			}
			return createEmbeddedContextTransport(host);
		})();
		return transportPromise;
	};

	return {
		async open(opts: ElideJsKernelOpenOptions): Promise<ElideJsKernelSession> {
			const transport = await openTransport();
			const response = await transport.control({
				type: "open",
				spec: {
					languages: ["js", "ts"],
					primaryLanguage: "js",
					streamOutput: true,
					workingDir: opts.cwd,
					// A LABEL. The runtime never deduplicates on it, and neither may we:
					// an owner-scoped fork opens a second context under this same id.
					label: opts.sessionId,
				},
			});
			if (response.type !== "context-opened") {
				const detail = response.type === "failure" ? `${response.code}: ${response.message}` : response.type;
				throw new Error(`The embedded runtime refused a JS context (${detail}).`);
			}
			return new EmbeddedElideKernelSession({
				transport,
				contextId: response.contextId,
				inboxPath: path.join(spoolDirectory, `omp-elide-inbox-${response.contextId}-${crypto.randomUUID()}.jsonl`),
				label: opts.sessionId,
				renderBootstrap,
			});
		},
		async dispose(): Promise<void> {
			const pending = transportPromise;
			transportPromise = undefined;
			if (!pending) return;
			await pending.then(transport => transport.dispose()).catch(() => undefined);
		},
	};
}

/**
 * The install site — **process-wide, once, never cleared**, and reached lazily
 * from the Elide backend's `isAvailable()`.
 *
 * `docs/aura/ELIDE_ALIGNMENT.md` parked this as an open design call with three
 * candidates; this is the third, "a process-lifetime install site instead of a
 * per-scope hook". The obvious candidate, `getOrCreateRuntimeService`, is keyed
 * per `RuntimeServiceScope` while the slot it would fill is a module-level
 * binding, so a per-scope hook would let the second session's factory serve the
 * first session's evals, and any one scope's retirement would empty the slot
 * under a healthy sibling. Nothing here is per-scope, nothing retires, and the
 * memoized attempt means N sessions asking cost one resolve.
 *
 * A factory already in the slot always wins — that is what keeps a test's fake
 * from being replaced by a real kernel that happens to be resolvable on the
 * machine running the suite.
 */
let installation: Promise<boolean> | undefined;

export interface EnsureElideJsKernelOptions {
	/** `runtime.embeddedPath`; a nonblank value is binding. */
	embeddedPath?: string;
}

/**
 * Install the embedded kernel factory if one is resolvable, and report whether a
 * factory is installed. Idempotent: the first call decides for the process.
 */
export function ensureElideJsKernelFactory(options: EnsureElideJsKernelOptions = {}): Promise<boolean> {
	installation ??= (async () => {
		if (getElideJsKernelFactory() !== undefined) return true;
		const resolved = await resolveEmbeddedRuntimeLibrary({ embeddedPath: options.embeddedPath });
		if (!resolved) return false;
		// Re-checked after the await: an installer that raced us — in practice a
		// test's fake — owns the slot, and clobbering it is exactly the "last
		// install wins" failure this site exists to avoid.
		if (getElideJsKernelFactory() !== undefined) return true;
		setElideJsKernelFactory(createElideEmbeddedKernelFactory({ libraryPath: resolved.libraryPath }));
		return true;
	})();
	return installation;
}

/** Test-only: forget the memoized install attempt. Never call this outside tests. */
export function resetElideJsKernelInstallForTests(): void {
	installation = undefined;
}
