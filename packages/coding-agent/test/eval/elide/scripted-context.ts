/**
 * A scripted stand-in for one open embedded runtime.
 *
 * It implements {@link ElideEmbeddedContextTransport} — the seam the real kernel
 * factory takes its transport from — so the host-side protocol translation can be
 * driven with no native library, no worker threads, and no artifact. Everything
 * below that seam (capnp encoding, the two worker threads, the FIFO) is already
 * pinned by the Tier 2 suites; what these doubles exist to exercise is the part
 * that is new: framing, run settlement, and the ordering rules between an eval
 * and the control ops that must reach the runtime while it runs.
 *
 * The output side behaves like the runtime's: chunks accumulate on the context
 * and a `poll-output` drains whatever has landed, reporting `complete` only once
 * the eval that produced it has finished.
 */

import { ELIDE_GUEST_FRAME_PREFIX } from "@oh-my-pi/pi-coding-agent/eval/elide/guest-bundle";
import type {
	ElideEmbeddedContextTransport,
	ElideEmbeddedKernelFactoryOptions,
} from "@oh-my-pi/pi-coding-agent/eval/elide/kernel-embedded";
import type { WorkerOutbound } from "@oh-my-pi/pi-coding-agent/eval/js/worker-protocol";
import type {
	EmbeddedContextSpecInput,
	EmbeddedControlOperation,
	EmbeddedDecodedResponse,
	EmbeddedEvalResult,
	EmbeddedOutputChunk,
} from "@oh-my-pi/pi-coding-agent/runtime/embedded/codec";

const encoder = new TextEncoder();

/** One guest protocol frame as the guest would write it: sentinel, JSON, newline. */
export function frame(msg: WorkerOutbound): string {
	return `${ELIDE_GUEST_FRAME_PREFIX}${JSON.stringify(msg)}\n`;
}

export function okResult(overrides: Partial<EmbeddedEvalResult> = {}): EmbeddedEvalResult {
	return {
		outcome: { type: "ok" },
		exitCode: 0,
		stdout: "",
		stderr: "",
		outputSeq: 0n,
		durationNanos: 0n,
		contextAlive: true,
		...overrides,
	};
}

export class ScriptedContext {
	readonly id: bigint;
	readonly spec: EmbeddedContextSpecInput;
	closed = false;
	resets = 0;
	interrupts = 0;
	#seq = 0n;
	#pending: EmbeddedOutputChunk[] = [];
	#evalActive = false;

	constructor(id: bigint, spec: EmbeddedContextSpecInput) {
		this.id = id;
		this.spec = spec;
	}

	/** Queue guest output. Text is encoded whole; use {@link writeBytes} to split a rune. */
	write(text: string, stream: "stdout" | "stderr" = "stdout"): void {
		this.writeBytes(encoder.encode(text), stream);
	}

	writeBytes(data: Uint8Array, stream: "stdout" | "stderr" = "stdout"): void {
		this.#seq += 1n;
		this.#pending.push({ stream, data, seq: this.#seq });
	}

	beginEval(): void {
		this.#evalActive = true;
	}

	endEval(): void {
		this.#evalActive = false;
	}

	drain(): { chunks: EmbeddedOutputChunk[]; seq: bigint; complete: boolean } {
		const chunks = this.#pending;
		this.#pending = [];
		return { chunks, seq: this.#seq, complete: !this.#evalActive };
	}
}

/** Answers one eval. Write the guest's frames onto `context` before resolving. */
export type ScriptedEval = (code: string, context: ScriptedContext) => Promise<EmbeddedDecodedResponse>;

export interface ScriptedTransport extends ElideEmbeddedContextTransport {
	/** Every context spec `open` was asked for, in order. */
	readonly opens: EmbeddedContextSpecInput[];
	/** Every eval source, in order. */
	readonly evals: string[];
	/** Every control op except `poll-output`, which is noise at this altitude. */
	readonly controls: EmbeddedControlOperation[];
	readonly contexts: ReadonlyMap<bigint, ScriptedContext>;
	/** Replace the eval handler; the default answers `ok` with no output. */
	script(handler: ScriptedEval): void;
}

export function createScriptedTransport(): ScriptedTransport {
	const opens: EmbeddedContextSpecInput[] = [];
	const evals: string[] = [];
	const controls: EmbeddedControlOperation[] = [];
	const contexts = new Map<bigint, ScriptedContext>();
	let nextContextId = 0n;
	let handler: ScriptedEval = async () => ({ type: "eval-result", requestId: 0n, result: okResult() });

	const require = (contextId: bigint): ScriptedContext => {
		const context = contexts.get(contextId);
		if (!context) throw new Error(`scripted transport has no context ${contextId}`);
		return context;
	};

	return {
		opens,
		evals,
		controls,
		contexts,
		script(next) {
			handler = next;
		},
		async control(operation) {
			if (operation.type !== "poll-output") controls.push(operation);
			switch (operation.type) {
				case "open": {
					opens.push(operation.spec);
					nextContextId += 1n;
					// Never deduplicated: a byte-identical spec still gets a fresh id.
					contexts.set(nextContextId, new ScriptedContext(nextContextId, operation.spec));
					return {
						type: "context-opened",
						requestId: 0n,
						contextId: nextContextId,
						languages: [...operation.spec.languages],
						capabilities: {
							streaming: true,
							hostCalls: false,
							reset: true,
							interrupt: true,
							mainScriptMode: true,
							captureResultValue: false,
							threadedContexts: true,
							maxContexts: 64,
							maxOutputBytes: 66_060_288n,
						},
					};
				}
				case "poll-output": {
					const drained = require(operation.contextId).drain();
					return { type: "output-batch", requestId: 0n, ...drained };
				}
				case "close":
					require(operation.contextId).closed = true;
					return { type: "context-ack", requestId: 0n };
				case "reset":
					require(operation.contextId).resets += 1;
					return { type: "context-ack", requestId: 0n };
				case "interrupt":
					require(operation.contextId).interrupts += 1;
					return { type: "context-ack", requestId: 0n };
				default:
					return { type: "context-ack", requestId: 0n };
			}
		},
		async call(invocation) {
			const code = invocation.source.type === "content" ? invocation.source.code : invocation.source.path;
			evals.push(code);
			const context = require(invocation.contextId);
			context.beginEval();
			try {
				return await handler(code, context);
			} finally {
				context.endEval();
			}
		},
		async dispose() {},
	};
}

/** Factory options wired to a scripted transport and an inert bootstrap. */
export function scriptedFactoryOptions(
	transport: ScriptedTransport,
	spoolDirectory: string,
	bootstrapSource = "/* scripted bootstrap */",
): ElideEmbeddedKernelFactoryOptions {
	return {
		createTransport: async () => transport,
		spoolDirectory,
		renderBootstrap: async () => bootstrapSource,
	};
}
