/**
 * Cell execution on an Elide Python kernel: one persistent context per session
 * key, held for the process lifetime and reused cell to cell.
 *
 * Contexts are keyed by the caller's already-namespaced session key PLUS the
 * kernel owner id. NOTE: this is STRICTER than the framework's owner-fork rule
 * (share until a non-exclusive owner resets, THEN fork, as the JS engine pins):
 * here every distinct owner gets a private context from its first cell, so a
 * sub-agent never sees the session's existing Python globals. Over-isolation,
 * not leakage — recorded as a gap until Python contexts join the shared VM
 * context manager. Contexts are never deduplicated on the runtime's `label`,
 * so two keys always mean two contexts.
 *
 * Nothing releases these contexts in production: the map is cleared only by
 * failed opens and the test-only teardown below, so a long session that mints
 * many owners holds one native context each until the process exits (same
 * recorded gap).
 *
 * Every failure arm here is a VALUE (`exitCode: 1` and the message in the
 * output), never a throw: an eval cell reporting its own error is the contract
 * the eval tool and the model both depend on.
 */
import { DEFAULT_MAX_BYTES, OutputSink } from "../../session/streaming-output";
import type { ToolSession } from "../../tools";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "../../tools/output-meta";
import type { ExecutorBackendResult } from "../backend";
import { type ElidePythonKernelSession, getElidePythonKernelFactory } from "./python-kernel";

export interface ElidePythonExecutorOptions {
	cwd: string;
	/** Already namespaced by the backend. */
	sessionKey: string;
	kernelOwnerId: string | undefined;
	reset: boolean;
	signal?: AbortSignal;
	session: ToolSession;
	onChunk?: (chunk: string) => void;
}

interface HeldContext {
	session: ElidePythonKernelSession;
	ownerId: string | undefined;
}

const contexts = new Map<string, Promise<HeldContext>>();

function contextKey(sessionKey: string, ownerId: string | undefined): string {
	return ownerId ? `${sessionKey}\0${ownerId}` : sessionKey;
}

async function acquire(options: ElidePythonExecutorOptions): Promise<HeldContext> {
	const key = contextKey(options.sessionKey, options.kernelOwnerId);
	let held = contexts.get(key);
	if (!held) {
		const factory = getElidePythonKernelFactory();
		if (!factory) {
			// Reaches the model as a cell failure, so it names "the runtime".
			throw new Error("No runtime Python kernel is installed; cannot run this cell on the runtime engine.");
		}
		held = factory
			.open({ cwd: options.cwd, sessionId: options.sessionKey })
			.then(session => ({ session, ownerId: options.kernelOwnerId }));
		contexts.set(key, held);
		// A failed open must not poison the slot forever.
		held.catch(() => contexts.delete(key));
		return await held;
	}
	const existing = await held;
	if (options.reset) await existing.session.reset();
	return existing;
}

/**
 * Test-only teardown: close every held Python context.
 *
 * Deliberately NOT named `dispose…`: `test/eval/elide/elide-engine-parity.test.ts`
 * forbids an engine-specific disposal entry point, because production disposal
 * must stay a property of the shared context manager rather than something every
 * caller has to learn an engine for. Python contexts do not live in that manager
 * yet (recorded gap: owner-scoped reaping for the Python engine is not wired), so
 * this exists purely so a suite can release native handles it opened.
 */
export async function closeElidePythonContextsForTests(): Promise<void> {
	const held = [...contexts.values()];
	contexts.clear();
	await Promise.all(held.map(entry => entry.then(({ session }) => session.close()).catch(() => undefined)));
}

/**
 * Identifiers that only exist because the eval tool-bridge prelude defines them.
 * The Elide Python engine has no prelude and no bridge (a recorded gap), so a
 * cell using one would fail with a bare `NameError` that names nothing useful.
 * Detected as bare calls — a leading `.` or word character excludes
 * `file.read()` and `my_display(...)`. Known over-refusals beyond a
 * user-defined bare `read(...)` call: the names inside comments or string
 * literals (`# write(x) is unused`, `s = "output(1)"`) and a cell DEFINING
 * one (`def read(path):` — the space before `read` matches). Each is treated as
 * bridge use rather than run here; the cost of a false positive is now a
 * REROUTE to CPython (which serves every one of those cells correctly), not a
 * refusal, so the class is cheaper than it was when the engine was opt-in.
 *
 * This function is the DETECTOR the dispatch layer consults: `resolveBackend`
 * in `tools/eval.ts` calls it before picking a backend and sends a bridge-using
 * cell to the CPython backend. The refusal below is what is left when there is
 * no CPython backend to send it to.
 */
const BRIDGE_NAMES = ["read", "write", "display", "output", "env", "completion", "agent", "parallel", "pipeline"];
const BRIDGE_CALL = new RegExp(String.raw`(^|[^\w.])(${BRIDGE_NAMES.join("|")})\s*\(`, "m");

export function findEvalToolBridgeUse(code: string): string | undefined {
	return BRIDGE_CALL.exec(code)?.[2];
}

/**
 * The terminal bridge-gap failure. Reached only when the dispatch layer had no
 * CPython backend to reroute the cell to, so it may NOT tell the user to switch
 * `eval.pyEngine` to `cpython`: on a host that lands here, the cpython engine
 * has no kernel either and the switch would fail the same cell differently.
 */
const TOOL_BRIDGE_GAP =
	"The runtime Python engine has no eval tool bridge yet, so %s() is not defined in this context, " +
	"and no CPython kernel is installed to run this cell instead. " +
	"Install the python kernel to run cells that call eval tool helpers.";

function toResult(summary: Awaited<ReturnType<OutputSink["dump"]>>, exitCode: number | undefined, cancelled: boolean) {
	return {
		output: summary.output,
		exitCode,
		cancelled,
		truncated: summary.truncated,
		artifactId: summary.artifactId,
		totalLines: summary.totalLines,
		totalBytes: summary.totalBytes,
		outputLines: summary.outputLines,
		outputBytes: summary.outputBytes,
		displayOutputs: [],
	} satisfies ExecutorBackendResult;
}

export async function executeElidePython(
	code: string,
	options: ElidePythonExecutorOptions,
): Promise<ExecutorBackendResult> {
	const outputSink = new OutputSink({
		spillThreshold: DEFAULT_MAX_BYTES,
		headBytes: resolveOutputSinkHeadBytes(options.session.settings),
		maxColumns: resolveOutputMaxColumns(options.session.settings),
		onChunk: chunk => options.onChunk?.(chunk),
	});
	try {
		const bridgeName = findEvalToolBridgeUse(code);
		if (bridgeName) {
			outputSink.push(TOOL_BRIDGE_GAP.replace("%s", bridgeName));
			return toResult(await outputSink.dump(), 1, false);
		}

		const held = await acquire(options);
		const abort = options.signal;
		const onAbort = (): void => void held.session.interrupt().catch(() => undefined);
		abort?.addEventListener("abort", onAbort, { once: true });
		let outcome: Awaited<ReturnType<ElidePythonKernelSession["run"]>>;
		try {
			outcome = await held.session.run(code, { onText: chunk => outputSink.push(chunk) });
		} finally {
			abort?.removeEventListener("abort", onAbort);
		}

		switch (outcome.type) {
			case "ok":
				return toResult(await outputSink.dump(), 0, false);
			case "exit":
				// Survivable: the cell ended, the context and its globals did not.
				outputSink.push(
					`\nThe runtime Python cell called sys.exit(${outcome.status}); the cell ended with exit status ${outcome.status} and the context kept its variables.\n`,
				);
				return toResult(await outputSink.dump(), outcome.status, false);
			case "interrupted":
				outputSink.push("\nThe runtime Python cell was interrupted; the context and its variables survived.\n");
				return toResult(await outputSink.dump(), undefined, true);
			case "output-limit":
				outputSink.push(
					"\nThe runtime Python cell exceeded its output budget and was stopped; the context survived.\n",
				);
				return toResult(await outputSink.dump(), 1, false);
			case "error":
				outputSink.push(`\n${outcome.name}: ${outcome.message}\n`);
				return toResult(await outputSink.dump(), 1, false);
		}
	} catch (error) {
		// Errors as values, always: a kernel that could not be opened or that
		// refused the cell is still a failed CELL, not a failed tool call.
		outputSink.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
		return toResult(await outputSink.dump(), 1, false);
	} finally {
		await outputSink.dispose();
	}
}
