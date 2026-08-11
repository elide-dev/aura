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
	 * Both halves matter: the session must ask for the `runtime` engine, and a
	 * kernel must actually exist to serve it. The factory slot is empty in
	 * production this milestone, so this is `false` for every real session today
	 * and the eval tool falls back to Bun with a notice.
	 */
	async isAvailable(session: ToolSession): Promise<boolean> {
		return resolveJsEvalEngine(session) === "elide" && getElideJsKernelFactory() !== undefined;
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
