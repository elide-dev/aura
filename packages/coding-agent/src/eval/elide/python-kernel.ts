/**
 * The Python kernel seam for the Elide eval engine, and its embedded
 * implementation over the Tier 2 persistent-context ABI.
 *
 * ## Why this is a separate module from the JS kernel
 *
 * The JS engine drives a *guest kernel* — a bundled guest program that owns the
 * worker protocol, framed stdout, and a file-backed tool-reply spool. Python has
 * no such guest program yet (the tool bridge is a recorded gap, see the header
 * of `./python.ts`), so a Python cell is exactly one `contextCall` in
 * `interactive` mode with its output drained concurrently. That is a strictly
 * smaller contract, and restating it here keeps the JS kernel's protocol
 * translation untouched.
 *
 * TODO(m3-dedup): the transport plumbing, the `pumpEmbeddedContextOutput`
 * settle-on-both-arms pattern, and the survivable-exit interpretation below are
 * deliberate copies of `./kernel-embedded.ts`, which a parallel fix round owns.
 * Fold the two together once that round lands.
 *
 * ## Runtime quirks a caller must know about
 *
 * - **Adopted host thread.** Cells run on a host thread the runtime adopts, not
 *   on CPython's main thread. `threading.active_count()` reports 1 while a cell
 *   is running, the current thread is named `Dummy-N`, and
 *   `threading.main_thread()` does not identify the thread the cell is on. Code
 *   that keys behavior off "am I the main thread" behaves differently here than
 *   under CPython.
 * - **The GIL is on.** Contexts are opened with `allowThreads: true` — load
 *   bearing, because without it `threading` raises at runtime — but threads buy
 *   I/O overlap, not CPU parallelism. A thread pool over CPU-bound work will not
 *   go faster than the serial version.
 */

import { withTimeout } from "@oh-my-pi/pi-utils";
import {
	decodeEmbeddedResponse,
	type EmbeddedControlOperation,
	type EmbeddedDecodedResponse,
	encodeOpenRequest,
} from "../../runtime/embedded/codec";
import { resolveEmbeddedRuntimeLibrary } from "../../runtime/embedded/resolve";
import { EmbeddedWorkerHost, pumpEmbeddedContextOutput } from "../../runtime/embedded/worker-core";
import { createEmbeddedContextTransport, type ElideEmbeddedContextTransport } from "./kernel-embedded";

/** Ceiling on one `poll-output` batch. The pump parks; this only bounds a single hop. */
const MAX_POLL_BYTES = 262_144;
/** How long a control op may take before it is treated as a wedged kernel. */
const CONTROL_TIMEOUT_MS = 30_000;
/** `interrupt` asks the runtime to unwind the guest within this window. */
const INTERRUPT_TIMEOUT_MS = 10_000;

/** How one Python cell ended. Every arm is a VALUE: none of them tears the context down. */
export type ElidePythonRunOutcome =
	| { type: "ok" }
	/** The cell raised. `message` is the guest's own rendering of the failure. */
	| { type: "error"; name: string; message: string }
	/** `sys.exit(status)` — the cell ended, the context and its globals survived. */
	| { type: "exit"; status: number }
	/** Interrupted or cancelled mid-cell; the context and its globals survived. */
	| { type: "interrupted" }
	/** The cell blew its output budget and was stopped. */
	| { type: "output-limit" };

export interface ElidePythonRunOptions {
	/** Raw text the guest wrote, in arrival order. */
	onText(chunk: string): void;
}

/** One persistent Python context. */
export interface ElidePythonKernelSession {
	run(code: string, options: ElidePythonRunOptions): Promise<ElidePythonRunOutcome>;
	/** Drop guest state, keep engine warmth. Globals from earlier cells are gone afterwards. */
	reset(): Promise<void>;
	/** Unwind the running cell without disturbing the context. */
	interrupt(): Promise<void>;
	close(): Promise<void>;
}

export interface ElidePythonKernelOpenOptions {
	cwd: string;
	/** A LABEL, never a dedup key — see `open()` below. */
	sessionId: string;
}

export interface ElidePythonKernelFactory {
	open(options: ElidePythonKernelOpenOptions): Promise<ElidePythonKernelSession>;
}

let factory: ElidePythonKernelFactory | undefined;

/** Read the installed factory, or `undefined` when nothing has claimed the slot. */
export function getElidePythonKernelFactory(): ElidePythonKernelFactory | undefined {
	return factory;
}

/** Install a factory; returns the one it displaced so a test can restore it. */
export function setElidePythonKernelFactory(
	next: ElidePythonKernelFactory | undefined,
): ElidePythonKernelFactory | undefined {
	const previous = factory;
	factory = next;
	return previous;
}

function asError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

class EmbeddedElidePythonSession implements ElidePythonKernelSession {
	readonly #transport: ElideEmbeddedContextTransport;
	readonly #contextId: bigint;
	readonly #label: string;
	/** Serializes everything that needs the single execution thread. */
	#tail: Promise<unknown> = Promise.resolve();
	#closed = false;

	constructor(transport: ElideEmbeddedContextTransport, contextId: bigint, label: string) {
		this.#transport = transport;
		this.#contextId = contextId;
		this.#label = label;
	}

	run(code: string, options: ElidePythonRunOptions): Promise<ElidePythonRunOutcome> {
		const step = (): Promise<ElidePythonRunOutcome> => this.#run(code, options);
		const next = this.#tail.then(step, step);
		this.#tail = next.catch(() => undefined);
		return next;
	}

	async #run(code: string, options: ElidePythonRunOptions): Promise<ElidePythonRunOutcome> {
		if (this.#closed) throw new Error(`Runtime Python kernel ${this.#label} is closed.`);
		const decoder = new TextDecoder();
		let settled = false;
		const evaluation = this.#transport
			.call({
				contextId: this.#contextId,
				language: "python",
				source: { type: "content", code },
				sourceName: `py-cell-${crypto.randomUUID()}.py`,
				mode: "interactive",
			})
			.then(
				response => {
					settled = true;
					return response;
				},
				error => {
					// Both arms flip the flag: a settle flag that ignored the rejection
					// would leave a failing eval's drain looping at poll cadence.
					settled = true;
					throw error;
				},
			);
		// The pump owns its own park bound; never pass `waitMillis` from here.
		const drain = pumpEmbeddedContextOutput({
			poll: waitMillis =>
				this.#transport.control({
					type: "poll-output",
					contextId: this.#contextId,
					waitMillis,
					maxBytes: MAX_POLL_BYTES,
				}),
			onChunk: chunk => options.onText(decoder.decode(chunk.data, { stream: true })),
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
			options.onText(`\n[the runtime Python kernel lost its output drain: ${asError(error).message}]\n`);
		}
		const tail = decoder.decode();
		if (tail) options.onText(tail);
		if (failure) throw asError(failure);
		if (!response) throw new Error(`Runtime Python kernel ${this.#label} returned no response for a cell.`);
		return this.#interpret(response);
	}

	#interpret(response: EmbeddedDecodedResponse): ElidePythonRunOutcome {
		if (response.type === "failure") {
			throw new Error(`Runtime Python kernel ${this.#label} refused a cell (${response.code}): ${response.message}`);
		}
		if (response.type !== "eval-result") {
			throw new Error(`Runtime Python kernel ${this.#label} returned a ${response.type} for a cell.`);
		}
		const outcome = response.result.outcome;
		switch (outcome.type) {
			case "ok":
				return { type: "ok" };
			case "interrupted":
			case "cancelled":
				return { type: "interrupted" };
			case "output-limit-exceeded":
				return { type: "output-limit" };
			case "error": {
				const error = outcome.error;
				// A guest exit ends the CELL, not the context: globals from earlier
				// cells are still there for the next one.
				if (error.isExit) return { type: "exit", status: error.exitStatus };
				if (error.isCancelled) return { type: "interrupted" };
				return { type: "error", name: error.typeName, message: error.message };
			}
		}
	}

	async interrupt(): Promise<void> {
		if (this.#closed) return;
		await this.#control({ type: "interrupt", contextId: this.#contextId, timeoutMillis: INTERRUPT_TIMEOUT_MS });
	}

	async reset(): Promise<void> {
		if (this.#closed) return;
		await this.#control({ type: "reset", contextId: this.#contextId, preserveWarmth: true });
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#control({ type: "close", contextId: this.#contextId });
	}

	async #control(operation: EmbeddedControlOperation): Promise<void> {
		const response = await withTimeout(
			this.#transport.control(operation),
			CONTROL_TIMEOUT_MS,
			`Runtime Python kernel ${this.#label} never answered a ${operation.type}`,
		);
		if (response.type === "context-ack") return;
		if (response.type === "failure") {
			throw new Error(
				`Runtime Python kernel ${this.#label} refused a ${operation.type} (${response.code}): ${response.message}`,
			);
		}
		throw new Error(`Runtime Python kernel ${this.#label} answered a ${operation.type} with a ${response.type}.`);
	}
}

export interface ElideEmbeddedPythonFactoryOptions {
	/** Native library to open. Ignored when {@link createTransport} is supplied. */
	libraryPath?: string;
	/** Test seam: supply the context transport instead of opening a native runtime. */
	createTransport?(): Promise<ElideEmbeddedContextTransport>;
}

export interface ElideEmbeddedPythonKernelFactory extends ElidePythonKernelFactory {
	/** Release the native runtime, if one was ever opened. */
	dispose(): Promise<void>;
}

/**
 * A factory over one embedded runtime handle, opened lazily — the first
 * `open()` pays for the `dlopen` and the runtime build, every later one is a
 * `contextOpen`.
 */
export function createElideEmbeddedPythonKernelFactory(
	options: ElideEmbeddedPythonFactoryOptions,
): ElideEmbeddedPythonKernelFactory {
	let transportPromise: Promise<ElideEmbeddedContextTransport> | undefined;

	const openTransport = (): Promise<ElideEmbeddedContextTransport> => {
		transportPromise ??= (async () => {
			if (options.createTransport) return await options.createTransport();
			const libraryPath = options.libraryPath;
			if (!libraryPath) throw new Error("No embedded runtime library was resolved for the runtime Python kernel.");
			const host = new EmbeddedWorkerHost();
			const opened = await host.open(libraryPath, encodeOpenRequest({ languages: ["python"] }));
			const response = decodeEmbeddedResponse(opened.response, 0n);
			if (response.type !== "opened") {
				await host.shutdown().catch(() => undefined);
				throw new Error(`The embedded runtime answered a ${response.type} when opening the runtime Python kernel.`);
			}
			return createEmbeddedContextTransport(host);
		})();
		return transportPromise;
	};

	return {
		async open(opts: ElidePythonKernelOpenOptions): Promise<ElidePythonKernelSession> {
			const transport = await openTransport();
			const response = await transport.control({
				type: "open",
				spec: {
					// Python-only, and threaded. `allowThreads` is load-bearing: without
					// it `threading` raises at runtime inside the guest. It is also the
					// only shape that may carry the flag — the codec rejects JS/TS +
					// allowThreads host-side at encode.
					languages: ["python"],
					primaryLanguage: "python",
					allowThreads: true,
					streamOutput: true,
					workingDir: opts.cwd,
					// A LABEL. The runtime never deduplicates on it, and neither may we:
					// an owner-scoped fork opens a second context under this same id.
					label: opts.sessionId,
				},
			});
			if (response.type !== "context-opened") {
				const detail = response.type === "failure" ? `${response.code}: ${response.message}` : response.type;
				throw new Error(`The embedded runtime refused a Python context (${detail}).`);
			}
			return new EmbeddedElidePythonSession(transport, response.contextId, opts.sessionId);
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
 * The install site — process-wide, once, never cleared — for the same reasons
 * `ensureElideJsKernelFactory` documents: the slot is a module-level binding, so
 * filling it from a per-scope hook would let one session's factory serve
 * another's cells. A factory already in the slot always wins, which keeps a
 * test's fake from being replaced by a real kernel that happens to resolve on
 * the machine running the suite.
 */
let installation: Promise<boolean> | undefined;

export interface EnsureElidePythonKernelOptions {
	/** `runtime.embeddedPath`; a nonblank value is binding. */
	embeddedPath?: string;
}

/** Install the embedded Python factory if one is resolvable, and report whether a factory is installed. */
export function ensureElidePythonKernelFactory(options: EnsureElidePythonKernelOptions = {}): Promise<boolean> {
	installation ??= (async () => {
		if (getElidePythonKernelFactory() !== undefined) return true;
		const resolved = await resolveEmbeddedRuntimeLibrary({ embeddedPath: options.embeddedPath });
		if (!resolved) return false;
		// Re-checked after the await: an installer that raced us — in practice a
		// test's fake — owns the slot, and clobbering it is exactly the "last
		// install wins" failure this site exists to avoid.
		if (getElidePythonKernelFactory() !== undefined) return true;
		setElidePythonKernelFactory(createElideEmbeddedPythonKernelFactory({ libraryPath: resolved.libraryPath }));
		return true;
	})();
	const attempt = installation;
	const forgetFailure = (installed: boolean): boolean => {
		// Only success is permanent: a runtime installed on demand mid-session
		// must be picked up by the next resolve. Guarded on identity so a later
		// attempt's memo is never dropped by an earlier one settling late.
		if (!installed && installation === attempt) installation = undefined;
		return installed;
	};
	return attempt.then(forgetFailure, error => {
		if (installation === attempt) installation = undefined;
		throw error;
	});
}

/** Test-only: forget the memoized install attempt. Never call this outside tests. */
export function resetElidePythonKernelInstallForTests(): void {
	installation = undefined;
}
