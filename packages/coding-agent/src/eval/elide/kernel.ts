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
 *
 * Filling the slot is scoped end to end in `docs/aura/ELIDE_ALIGNMENT.md`, under
 * **"Wiring checklist (when Tier 2 lands)"**: the ≤ 4 files that change, the map
 * from each method here to its embedded-ABI op, what must NOT change, and the
 * known gaps. Read it before writing the real factory.
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
	/**
	 * Diagnostic LABEL for the context, not an identity. Two live contexts can
	 * legitimately carry the same value — see {@link ElideJsKernelFactory.open}.
	 */
	sessionId: string;
}

export interface ElideJsKernelFactory {
	/**
	 * Open a context. **Every call must return a fresh, isolated context**, even
	 * when two calls arrive with byte-identical options.
	 *
	 * `sessionId` is a label, NOT a dedup key. Owner-scoped reset forks a second
	 * context under the *same* kernel-facing session id — the fork key is
	 * host-side bookkeeping in `resolveOwnerScopedSessionKey` and never reaches
	 * this method (`./worker.ts` passes only `{cwd, sessionId}`). A kernel that
	 * keyed contexts by `sessionId` would hand a subagent's forked context back to
	 * its parent, silently merging two sessions' guest state. The parity suite's
	 * fork-privacy case pins this loudly:
	 * `test/eval/elide/elide-engine-parity.test.ts:299` asserts both opens of a
	 * fork share one `sessionId`, while the state assertions around it require the
	 * two contexts to stay private.
	 */
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
