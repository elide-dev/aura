/**
 * The Elide Python eval backend: an ENGINE for `language: "python"`, not a new
 * language.
 *
 * `id` is `"python"`, so the tool schema, the description, the details payload,
 * and every renderer keep saying `python` whichever engine ran the cell. Only
 * `label` distinguishes it, and it says "the runtime", not the product, because
 * it is displayed.
 *
 * The `"python-elide:"` session prefix is load-bearing: contexts are held by
 * session key alone, so a key shared with the CPython backend would let one
 * engine's state answer the other's cells.
 *
 * Reached only through the eval tool's lazy `import()`, so a session pinned to
 * `cpython` never loads the executor or the kernel seam at all.
 *
 * ## Recorded gaps (deliberately not built)
 *
 * - **No eval tool bridge.** `read()`, `write()`, `agent()` and the rest of the
 *   prelude need a Python-side guest shim over the host spool; there is none.
 *   Since this engine is the DEFAULT, `resolveBackend` reroutes a cell that
 *   calls one to the CPython backend with a notice rather than failing it — at
 *   the cost of that cell running in the CPython kernel's separate session
 *   state, which the notice says out loud. Only a host with no CPython kernel
 *   at all reaches this engine's own bridge-gap error value.
 * - **No mainScript mode**, so no file/args/stdin carriers; no rich display
 *   outputs; no captured result value. Cells communicate through stdout.
 *
 * ## Runtime quirks
 *
 * - **Adopted host thread.** Cells run on a thread the runtime adopts, so
 *   `threading.active_count()` reads 1 inside a cell, the current thread is
 *   named `Dummy-N`, and `threading.main_thread()` does not identify it. Code
 *   that branches on "am I the main thread" behaves differently than on CPython.
 * - **The GIL is on.** Contexts open with `allowThreads: true` — load-bearing,
 *   since `threading` otherwise raises — but threads give I/O overlap, not CPU
 *   parallelism.
 */
import type { ToolSession } from "../../tools";
import type { ExecutorBackend, ExecutorBackendExecOptions, ExecutorBackendResult } from "../backend";
import { namespaceSessionId as sharedNamespace } from "../backend-helpers";
import { executeElidePython } from "./python-executor";
import { getElidePythonKernelFactory } from "./python-kernel";
import { resolvePyEvalEngine } from "./settings";

const ELIDE_PYTHON_SESSION_PREFIX = "python-elide:";

export function namespaceSessionId(sessionId: string): string {
	return sharedNamespace(sessionId, ELIDE_PYTHON_SESSION_PREFIX);
}

export default {
	id: "python",
	label: "Python (Runtime)",
	highlightLang: "python",

	/**
	 * Both halves matter: the session must ask for the `elide` engine, and a
	 * kernel must actually exist to serve it. The install is checked before the
	 * ensure so an already-installed factory costs nothing, and imported lazily so
	 * a CPython session never loads the embedded transport.
	 */
	async isAvailable(session: ToolSession): Promise<boolean> {
		if (resolvePyEvalEngine(session) !== "elide") return false;
		if (getElidePythonKernelFactory() !== undefined) return true;
		const { ensureElidePythonKernelFactory } = await import("./python-kernel");
		await ensureElidePythonKernelFactory({ embeddedPath: session.settings.get("runtime.embeddedPath") ?? undefined });
		return getElidePythonKernelFactory() !== undefined;
	},

	async execute(code: string, opts: ExecutorBackendExecOptions): Promise<ExecutorBackendResult> {
		return await executeElidePython(code, {
			cwd: opts.cwd,
			sessionKey: namespaceSessionId(opts.sessionId),
			kernelOwnerId: opts.kernelOwnerId,
			reset: opts.reset,
			signal: opts.signal,
			session: opts.session,
			onChunk: opts.onChunk,
		});
	},
} satisfies ExecutorBackend;
