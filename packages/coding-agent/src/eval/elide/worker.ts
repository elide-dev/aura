/**
 * Presents an {@link ElideJsKernelSession} as the `WorkerHandle` the JS eval
 * context manager drives, so an Elide kernel plugs into the existing eval
 * stack as one more worker mode rather than a parallel engine.
 *
 * Adapter contracts:
 * - **Errors are values.** `send` never throws; a kernel that cannot open or
 *   cannot accept a message faults through the `onError` fan-out.
 * - **Graceful close is acknowledged.** `close()` resolves `true` only after
 *   the kernel answers `{type:"close"}` with a `{type:"closed"}` outbound,
 *   and `false` when that ack does not arrive in the grace period.
 * - **`terminate()` is unconditional and idempotent** and never rejects. It
 *   resolves only once the kernel session was released, including one that is
 *   still opening — callers read a resolved `terminate()` as "the worker is
 *   gone" — bounded by the grace period so a hung open cannot wedge exit.
 * - **No execution-budget timer.** The close grace period below is the only
 *   timer in this module, and it bounds teardown handshakes only; cell
 *   cancellation belongs to the caller's `AbortSignal`, never to a wall clock
 *   down here.
 */
import { withTimeout } from "@oh-my-pi/pi-utils";
import type { WorkerHandle } from "../js/context-manager";
import type { WorkerInbound, WorkerOutbound } from "../js/worker-protocol";
import type { ElideJsKernelFactory, ElideJsKernelSession } from "./kernel";

export interface SpawnElideWorkerOptions {
	cwd: string;
	sessionId: string;
	/** Tag used in fault messages; defaults to the session id. */
	label?: string;
}

/**
 * Grace period for the teardown handshakes, mirroring the JS context manager's:
 * how long `close()` waits for its `{type:"closed"}` ack, and how long
 * `terminate()` waits for an open that is still in flight.
 */
const ELIDE_WORKER_CLOSE_TIMEOUT_MS = 1_000;
let elideWorkerCloseTimeoutMs: number = ELIDE_WORKER_CLOSE_TIMEOUT_MS;

/**
 * Test-only seam mirroring `setWorkerCloseTimeoutMsForTests` in the JS context
 * manager: override the teardown grace period (ms) and return the previous
 * value so callers can restore it. Never call this outside tests.
 */
export function setElideWorkerCloseTimeoutMsForTests(ms: number): number {
	const previous = elideWorkerCloseTimeoutMs;
	elideWorkerCloseTimeoutMs = ms;
	return previous;
}

function asError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

/**
 * Open a kernel session through {@link factory} and drive it as a worker.
 * The handle is live immediately: the session opens in the background, and
 * traffic sent meanwhile is queued until it lands.
 */
export function spawnElideWorker(factory: ElideJsKernelFactory, opts: SpawnElideWorkerOptions): WorkerHandle {
	const label = opts.label ?? opts.sessionId;
	const messageListeners = new Set<(msg: WorkerOutbound) => void>();
	const errorListeners = new Set<(error: Error) => void>();
	// Traffic that arrived before anyone subscribed. Held only until the first
	// subscriber attaches — the same startup window the inline Bun worker has —
	// after which an unheard message is dropped rather than accumulated.
	let bufferedMessages: WorkerOutbound[] | undefined = [];
	let bufferedErrors: Error[] | undefined = [];
	// Inbound traffic sent while `factory.open` is still in flight.
	const queuedInbound: WorkerInbound[] = [];
	const subscriptions: (() => void)[] = [];
	let session: ElideJsKernelSession | undefined;
	let openFailed = false;
	let disposed = false;
	let disposal: Promise<void> | undefined;

	const emitMessage = (msg: WorkerOutbound): void => {
		if (disposed) return;
		if (bufferedMessages) {
			bufferedMessages.push(msg);
			return;
		}
		for (const listener of [...messageListeners]) listener(msg);
	};

	const emitError = (error: Error): void => {
		if (disposed) return;
		if (bufferedErrors) {
			bufferedErrors.push(error);
			return;
		}
		for (const listener of [...errorListeners]) listener(error);
	};

	const deliver = (target: ElideJsKernelSession, msg: WorkerInbound): void => {
		try {
			target.send(msg);
		} catch (error) {
			emitError(
				new Error(`Elide JS kernel ${label} rejected a ${msg.type} message: ${asError(error).message}`, {
					cause: error,
				}),
			);
		}
	};

	/** The open handshake, kept so teardown can wait for a session that lands late. */
	const opening: Promise<void> = (async () => {
		let opened: ElideJsKernelSession;
		try {
			opened = await factory.open({ cwd: opts.cwd, sessionId: opts.sessionId });
		} catch (error) {
			openFailed = true;
			queuedInbound.length = 0;
			emitError(new Error(`Elide JS kernel ${label} failed to open: ${asError(error).message}`, { cause: error }));
			return;
		}
		if (disposed) {
			// terminate() ran while the open was in flight. Nothing will ever drive
			// this session, so release it the moment it exists.
			try {
				await opened.close();
			} catch {
				// Best effort: teardown never rejects.
			}
			return;
		}
		session = opened;
		subscriptions.push(opened.onMessage(emitMessage), opened.onError(emitError));
		for (const msg of queuedInbound.splice(0)) deliver(opened, msg);
	})();

	const disposeOnce = async (): Promise<void> => {
		disposed = true;
		for (const unsubscribe of subscriptions.splice(0)) {
			try {
				unsubscribe();
			} catch {
				// Best effort: teardown never rejects.
			}
		}
		messageListeners.clear();
		errorListeners.clear();
		bufferedMessages = undefined;
		bufferedErrors = undefined;
		queuedInbound.length = 0;
		const opened = session;
		session = undefined;
		if (opened) {
			try {
				await opened.close();
			} catch {
				// Best effort: teardown never rejects.
			}
			return;
		}
		// The open was still in flight. Its chain releases the session the moment
		// it lands (the `disposed` branch above), and callers read a resolved
		// terminate() as "the worker is gone" — `disposeAll` on the process-exit
		// path would otherwise return while an Elide context is still under
		// construction and leak it. So wait for that chain, bounded by the close
		// grace period: this bounds a teardown handshake, not cell execution, and
		// a kernel whose open never settles must not wedge process exit. Giving up
		// on the wait does not abandon the session — the chain still closes it.
		await withTimeout(
			opening,
			elideWorkerCloseTimeoutMs,
			`Elide JS kernel ${label} was still opening at teardown`,
		).catch(() => {});
	};

	/**
	 * Teardown shared by the acked close and by `terminate()`. Idempotent: every
	 * call after the first awaits the same teardown instead of racing past it.
	 */
	const dispose = (): Promise<void> => {
		disposal ??= disposeOnce();
		return disposal;
	};

	const send = (msg: WorkerInbound): void => {
		if (disposed || openFailed) return;
		if (!session) {
			queuedInbound.push(msg);
			return;
		}
		deliver(session, msg);
	};

	const onMessage = (handler: (msg: WorkerOutbound) => void): (() => void) => {
		messageListeners.add(handler);
		const pending = bufferedMessages;
		bufferedMessages = undefined;
		if (pending?.length) {
			queueMicrotask(() => {
				for (const msg of pending) handler(msg);
			});
		}
		return () => {
			messageListeners.delete(handler);
		};
	};

	const onError = (handler: (error: Error) => void): (() => void) => {
		errorListeners.add(handler);
		const pending = bufferedErrors;
		bufferedErrors = undefined;
		if (pending?.length) {
			queueMicrotask(() => {
				for (const error of pending) handler(error);
			});
		}
		return () => {
			errorListeners.delete(handler);
		};
	};

	const gracefulClose = async (): Promise<boolean> => {
		const { promise: closed, resolve } = Promise.withResolvers<boolean>();
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;
		let unsubscribe = (): void => {};
		const finish = (value: boolean): void => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			unsubscribe();
			resolve(value);
		};
		unsubscribe = onMessage(msg => {
			if (msg.type === "closed") finish(true);
		});
		send({ type: "close" });
		timeout = setTimeout(() => finish(false), elideWorkerCloseTimeoutMs);
		const acked = await closed;
		// Only an acked close releases the session — a timed-out one leaves the
		// kernel alive for the caller's terminate().
		if (acked) await dispose();
		return acked;
	};

	return {
		mode: "elide",
		send,
		onMessage,
		onError,
		close: () => {
			// A kernel that never opened, or one already torn down, has nothing to
			// close gracefully; say so instead of burning the grace period.
			if (disposed || openFailed) return Promise.resolve(false);
			return gracefulClose();
		},
		terminate: dispose,
	};
}
