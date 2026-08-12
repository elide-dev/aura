/**
 * The Elide eval backend: an ENGINE for `language: "js"`, not a new language.
 *
 * `id` is `"js"`, so the tool schema, the description, the details payload, and
 * every renderer keep saying "js" whichever engine ran the cell. Only `label`
 * distinguishes it, for UI that names the runtime — and it says "the runtime",
 * not the product, because it is displayed.
 *
 * The `"js-elide:"` session prefix is load-bearing rather than cosmetic. The JS
 * context manager reuses a live context by session key ALONE — it has no notion
 * of which engine built it — so a key shared with the Bun backend would let a
 * Bun-served context answer Elide cells (and the reverse) with no error
 * anywhere. Namespacing the key separates the two engines' contexts by
 * construction.
 *
 * This module is reached only through the eval tool's lazy `import()` and is
 * deliberately absent from the `../index.ts` barrel, so a default session never
 * loads the Elide executor, adapter, or kernel seam at all.
 */
import type { ToolSession } from "../../tools";
import {
	type ExecutorBackend,
	type ExecutorBackendExecOptions,
	type ExecutorBackendResult,
	resolveEvalUrlRoots,
} from "../backend";
import { namespaceSessionId as sharedNamespace, toExecutorBackendResult } from "../backend-helpers";
import { executeElideJs } from "./executor";
import { getElideJsKernelFactory } from "./kernel";
import { resolveJsEvalEngine } from "./settings";

const ELIDE_JS_SESSION_PREFIX = "js-elide:";

export function namespaceSessionId(sessionId: string): string {
	return sharedNamespace(sessionId, ELIDE_JS_SESSION_PREFIX);
}

export default {
	id: "js",
	label: "JavaScript (Runtime)",
	highlightLang: "javascript",

	/**
	 * Both halves matter: the session must ask for the `elide` engine, and a
	 * kernel must actually exist to serve it.
	 *
	 * **This is the install site**, and it is a deliberate answer to the design
	 * call `docs/aura/ELIDE_ALIGNMENT.md` parked: the factory slot is
	 * process-wide, so it is filled from a process-lifetime path rather than from
	 * a per-scope hook that would let one session's factory serve another's evals
	 * and one scope's retirement empty the slot under a healthy sibling. The
	 * install is memoized, idempotent, and never cleared —
	 * `ensureElideJsKernelFactory` is a no-op once anything holds the slot, which
	 * is what keeps a test's fake from being replaced by a real kernel that
	 * happens to be resolvable on the machine running the suite.
	 *
	 * Checked before the ensure so an already-installed factory costs nothing,
	 * and imported lazily so a Bun session never loads the embedded transport.
	 */
	async isAvailable(session: ToolSession): Promise<boolean> {
		if (resolveJsEvalEngine(session) !== "elide") return false;
		if (getElideJsKernelFactory() !== undefined) return true;
		const { ensureElideJsKernelFactory } = await import("./kernel-embedded");
		await ensureElideJsKernelFactory({ embeddedPath: session.settings.get("runtime.embeddedPath") ?? undefined });
		return getElideJsKernelFactory() !== undefined;
	},

	async execute(code: string, opts: ExecutorBackendExecOptions): Promise<ExecutorBackendResult> {
		const result = await executeElideJs(code, {
			cwd: opts.cwd,
			idleTimeoutMs: opts.idleTimeoutMs,
			signal: opts.signal,
			sessionId: namespaceSessionId(opts.sessionId),
			kernelOwnerId: opts.kernelOwnerId,
			sessionFile: opts.sessionFile,
			reset: opts.reset,
			onChunk: opts.onChunk,
			onStatus: opts.onStatus,
			session: opts.session,
			localRoots: resolveEvalUrlRoots(opts.session),
		});
		return toExecutorBackendResult(result);
	},
} satisfies ExecutorBackend;
