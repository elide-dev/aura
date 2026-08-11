/**
 * Test double for the Elide JS kernel seam.
 *
 * It implements {@link ElideJsKernelFactory} by driving the REAL
 * {@link WorkerCore} over an in-memory transport — the same microtask-queue
 * wiring `spawnInlineWorker` uses for the Bun inline fallback
 * (`src/eval/js/context-manager.ts`). Cells therefore execute in a real JS
 * runtime speaking the production worker protocol, so the adapter under test
 * is exercised against real traffic rather than a scripted mock.
 *
 * It is a protocol-level double, not an engine: `interrupt()` records the ask
 * without aborting the in-flight cell (an inline `WorkerCore` run cannot be
 * cancelled from the outside — real interruption arrives with the Tier 2 ABI),
 * and `reset()` discards guest state by rebuilding the core over the same
 * transport.
 */
import { WorkerCore } from "@oh-my-pi/pi-coding-agent/eval/js/worker-core";
import type { Transport, WorkerInbound, WorkerOutbound } from "@oh-my-pi/pi-coding-agent/eval/js/worker-protocol";
import { postmortem } from "@oh-my-pi/pi-utils";
import type {
	ElideJsKernelFactory,
	ElideJsKernelOpenOptions,
	ElideJsKernelSession,
} from "../../../src/eval/elide/kernel";

export interface FakeElideJsKernelSession extends ElideJsKernelSession {
	/** Push a kernel-side fault into this session's `onError` fan-out. */
	fail(error: Error): void;
}

export interface FakeElideJsKernelOptions {
	/** `open()` rejects instead of handing back a session. */
	failOpen?: boolean;
	/** Swallow the `closed` outbound so a graceful close never gets its ack. */
	dropClosed?: boolean;
}

export interface FakeElideJsKernelFactory extends ElideJsKernelFactory {
	/** Every `open()` call in order, including ones `failOpen` rejected. */
	readonly opens: readonly ElideJsKernelOpenOptions[];
	/** Sessions handed out by `open()`, in call order. */
	readonly sessions: readonly FakeElideJsKernelSession[];
	readonly interrupts: number;
	readonly resets: number;
	readonly closes: number;
}

export function createFakeElideJsKernelFactory(options: FakeElideJsKernelOptions = {}): FakeElideJsKernelFactory {
	const opens: ElideJsKernelOpenOptions[] = [];
	const sessions: FakeElideJsKernelSession[] = [];
	let interrupts = 0;
	let resets = 0;
	let closes = 0;

	const openSession = (): FakeElideJsKernelSession => {
		const hostListeners = new Set<(msg: WorkerOutbound) => void>();
		const workerListeners = new Set<(msg: WorkerInbound) => void>();
		const errorListeners = new Set<(error: Error) => void>();
		const transport: Transport = {
			send: msg =>
				queueMicrotask(() => {
					if (options.dropClosed && msg.type === "closed") return;
					for (const listener of [...hostListeners]) listener(msg);
				}),
			onMessage: handler => {
				workerListeners.add(handler);
				return () => workerListeners.delete(handler);
			},
			close: () => {},
		};
		const startCore = (): WorkerCore =>
			new WorkerCore(transport, {
				mode: "inline",
				interceptUnhandledRejections: postmortem.interceptUnhandledRejections,
			});
		let core = startCore();
		return {
			send: msg =>
				queueMicrotask(() => {
					for (const listener of [...workerListeners]) listener(msg);
				}),
			onMessage: handler => {
				hostListeners.add(handler);
				return () => hostListeners.delete(handler);
			},
			onError: handler => {
				errorListeners.add(handler);
				return () => errorListeners.delete(handler);
			},
			async interrupt() {
				interrupts++;
			},
			async reset() {
				resets++;
				core.dispose();
				core = startCore();
			},
			async close() {
				closes++;
				core.dispose();
				hostListeners.clear();
				workerListeners.clear();
				errorListeners.clear();
			},
			fail(error) {
				for (const listener of [...errorListeners]) listener(error);
			},
		};
	};

	return {
		get opens() {
			return opens;
		},
		get sessions() {
			return sessions;
		},
		get interrupts() {
			return interrupts;
		},
		get resets() {
			return resets;
		},
		get closes() {
			return closes;
		},
		async open(opts) {
			opens.push({ cwd: opts.cwd, sessionId: opts.sessionId });
			if (options.failOpen) throw new Error(`fake Elide JS kernel refused to open ${opts.sessionId}`);
			const session = openSession();
			sessions.push(session);
			return session;
		},
	};
}
