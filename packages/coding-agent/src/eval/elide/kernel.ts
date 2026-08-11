/**
 * The Elide JS kernel seam.
 *
 * An {@link ElideJsKernelSession} is everything the eval stack needs from an
 * Elide-hosted JavaScript context: the EXISTING worker protocol
 * (`WorkerInbound`/`WorkerOutbound` from `../js/worker-protocol`) plus the
 * three lifecycle asks a warm kernel adds — interrupt the current cell, reset
 * guest state, close the context. No new protocol: an Elide kernel is another
 * transport for the conversation the Bun worker already has, which is what
 * lets `spawnElideWorker` (`./worker.ts`) present one as a `WorkerHandle`.
 *
 * The factory slot below is EMPTY in production this milestone. The scaffold
 * lands the seam, its adapter, and the tests; the real Tier 2 embedded ABI
 * fills the slot later. `getElideJsKernelFactory() === undefined` is therefore
 * the correct production state, and it is what keeps the Elide eval backend's
 * `isAvailable()` false until the ABI exists.
 */
import type { WorkerInbound, WorkerOutbound } from "../js/worker-protocol";

export interface ElideJsKernelSession {
	send(msg: WorkerInbound): void;
	onMessage(h: (msg: WorkerOutbound) => void): () => void;
	onError(h: (e: Error) => void): () => void;
	/** Abort the current cell; the context and its state survive. */
	interrupt(): Promise<void>;
	/** Discard user state, keeping engine warmth. */
	reset(): Promise<void>;
	close(): Promise<void>;
}

export interface ElideJsKernelOpenOptions {
	cwd: string;
	sessionId: string;
}

export interface ElideJsKernelFactory {
	open(opts: ElideJsKernelOpenOptions): Promise<ElideJsKernelSession>;
}

let kernelFactory: ElideJsKernelFactory | undefined;

/**
 * Install (or clear) the process-wide kernel factory. Returns the previous
 * value so callers — today only tests — can restore it.
 */
export function setElideJsKernelFactory(f: ElideJsKernelFactory | undefined): ElideJsKernelFactory | undefined {
	const previous = kernelFactory;
	kernelFactory = f;
	return previous;
}

/** The installed kernel factory, or `undefined` when no Elide kernel exists. */
export function getElideJsKernelFactory(): ElideJsKernelFactory | undefined {
	return kernelFactory;
}
