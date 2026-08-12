/**
 * Engine parity, against the REAL Tier 2 kernel.
 *
 * `elide-engine-parity.test.ts` pins the same contract against the inline fake
 * and must keep running in CI with no artifact, so this is a second file rather
 * than a flag on that one. The swap the wiring checklist promised is still one
 * line — {@link installRealFactory} below — plus the counting decorator that
 * gives the real factory the fake's counter surface.
 *
 * Three things are asserted here that the fake could not support, and they are
 * the reason this file exists at all:
 *
 * 1. **A plain `var` carrier.** The fake drives a `WorkerCore` in the host realm,
 *    so a cell's `var` outlives its context and a wiped context looks warm; the
 *    hermetic suite carries state in the runtime's `env` bag to stay honest about
 *    that. A real kernel gives the guest its own realm, so state can be observed
 *    the way `test/eval/kernel-owner-scoping.test.ts` observes it — over the whole
 *    guest global scope. (`TODO(m3)` #1.)
 * 2. **An interrupt against a genuinely in-flight cell.** The fake's `interrupt()`
 *    only records the ask, and an inline `WorkerCore` run cannot be cancelled
 *    from outside — which is why the hermetic suite interrupts *between* cells.
 *    Here a synchronous spinning cell holds the guest thread and is really
 *    unwound. (`TODO(m3)` #2.)
 *
 * 3. **Survivable guest exit.** `exit(3)` ends the EVAL, not the context: the
 *    cell fails as a value naming status 3, and the next cell still sees every
 *    global the exiting one left behind.
 *
 * Worth recording from building the interrupt case: a cell parked in the guest's
 * event loop — awaiting a host tool — is NOT unwound by `interrupt`. The op
 * reaches the runtime, but there is no guest frame to interrupt and the eval runs
 * on. Rung 1 of the cancellation ladder covers running code, not waiting code;
 * the host's own cancel path (terminate the worker, which closes the context) is
 * what covers the rest, and the cancellation case below pins exactly that.
 *
 * Timeouts are generous and explicit: the first cell in the file pays for a
 * `dlopen`, a runtime build, a guest bundle, and a context, and none of that is
 * what any assertion here is about.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import { Settings } from "../../../src/config/settings";
import { EVAL_TIMEOUT_PAUSE_OP } from "../../../src/eval/bridge-timeout";
import { namespaceSessionId } from "../../../src/eval/elide";
import { executeElideJs } from "../../../src/eval/elide/executor";
import {
	type ElideJsKernelFactory,
	type ElideJsKernelOpenOptions,
	type ElideJsKernelSession,
	setElideJsKernelFactory,
} from "../../../src/eval/elide/kernel";
import {
	createElideEmbeddedKernelFactory,
	type ElideEmbeddedKernelFactory,
} from "../../../src/eval/elide/kernel-embedded";
import type { JsDisplayOutput } from "../../../src/eval/js/context-manager";
import { disposeAllVmContexts, disposeVmContextsByOwner } from "../../../src/eval/js/context-manager";
import type { JsExecutorOptions, JsResult } from "../../../src/eval/js/executor";
import type { JsStatusEvent } from "../../../src/eval/js/shared/types";
import type { ToolSession } from "../../../src/tools";

const embeddedPath = Bun.env.AURA_RUNTIME_EMBEDDED_LIB;
/** Every cell pays real engine costs; a wedged kernel still fails loudly, just later. */
const CELL_TIMEOUT_MS = 60_000;
const CASE_TIMEOUT_MS = 180_000;

interface CountingFactory extends ElideJsKernelFactory {
	readonly opens: readonly ElideJsKernelOpenOptions[];
	readonly sessions: readonly ElideJsKernelSession[];
	readonly interrupts: number;
	readonly resets: number;
	readonly closes: number;
}

/**
 * The fake's counter surface over a real factory, so the assertions the hermetic
 * suite makes about session reuse, forking, and disposal read the same here.
 */
function countingFactory(inner: ElideJsKernelFactory): CountingFactory {
	const opens: ElideJsKernelOpenOptions[] = [];
	const sessions: ElideJsKernelSession[] = [];
	let interrupts = 0;
	let resets = 0;
	let closes = 0;
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
		async open(options) {
			opens.push({ cwd: options.cwd, sessionId: options.sessionId });
			const session = await inner.open(options);
			const counted: ElideJsKernelSession = {
				send: msg => session.send(msg),
				onMessage: handler => session.onMessage(handler),
				onError: handler => session.onError(handler),
				async interrupt() {
					interrupts += 1;
					await session.interrupt();
				},
				async reset() {
					resets += 1;
					await session.reset();
				},
				async close() {
					closes += 1;
					await session.close();
				},
			};
			sessions.push(counted);
			return counted;
		},
	};
}

let embedded: ElideEmbeddedKernelFactory | undefined;
let factory: CountingFactory;
let restoreFactory: ElideJsKernelFactory | undefined;

/** The one line the wiring checklist budgeted for: the real factory, installed. */
function installRealFactory(): void {
	embedded = createElideEmbeddedKernelFactory({ libraryPath: embeddedPath ?? "" });
	factory = countingFactory(embedded);
	restoreFactory = setElideJsKernelFactory(factory);
}

function createTool(
	name: string,
	execute: (toolCallId: string, args: unknown, signal?: AbortSignal) => Promise<AgentToolResult>,
): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({}),
		concurrency: "parallel",
		execute,
	} as unknown as AgentTool;
}

interface ParkedCell {
	tool: AgentTool;
	code: string;
	entered: Promise<AbortSignal | undefined>;
	release(): void;
}

/** Park a cell mid-run in a host tool the test answers on demand. */
function createParkTool(): ParkedCell {
	const entered = Promise.withResolvers<AbortSignal | undefined>();
	const release = Promise.withResolvers<void>();
	return {
		tool: createTool("parity_park", async (_toolCallId, _args, signal) => {
			entered.resolve(signal);
			await release.promise;
			return { content: [{ type: "text", text: "parked-tool-returned" }] } as AgentToolResult;
		}),
		code: "await tool.parity_park({}); return 'parked-cell-finished';",
		entered: withTimeout(entered.promise, CELL_TIMEOUT_MS, "parked cell never reached the tool"),
		release: () => release.resolve(),
	};
}

function makeSession(cwd: string, tools: AgentTool[] = []): ToolSession {
	const registry = new Map(tools.map(tool => [tool.name, tool]));
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
			"task.enableLsp": false,
		}),
		taskDepth: 0,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getActiveModelString: () => "p/active",
		getModelString: () => "p/fallback",
		getArtifactsDir: () => null,
		getSessionId: () => "elide-parity-real-session",
		getEvalSessionId: () => "elide-parity-real-eval-session",
		getToolByName: name => registry.get(name),
	};
}

type CellOptions = Partial<Omit<JsExecutorOptions, "cwd" | "session" | "sessionId">>;

function makeRunner(session: ToolSession, cwd: string, sessionId: string) {
	return (code: string, options: CellOptions = {}): Promise<JsResult> =>
		withTimeout(
			executeElideJs(code, { cwd, sessionId, session, ...options }),
			CELL_TIMEOUT_MS,
			`elide cell never settled: ${code.slice(0, 48)}`,
		);
}

function statusOutputs(result: JsResult): Extract<JsDisplayOutput, { type: "status" }>[] {
	return result.displayOutputs.filter(
		(output): output is Extract<JsDisplayOutput, { type: "status" }> => output.type === "status",
	);
}

/**
 * The `TODO(m3)` #1 carrier: a plain `var` on the guest global scope, exactly as
 * `test/eval/kernel-owner-scoping.test.ts` observes state on the Bun engine. It
 * tests strictly more than the hermetic suite's per-runtime bag, because a
 * context that was wiped cannot fake it.
 */
const READ_STATE = "return typeof shared === 'undefined' ? 'gone' : shared;";

function writeState(value: string): string {
	return `var shared = ${JSON.stringify(value)};`;
}

describe.skipIf(!embeddedPath).serial("Elide engine parity (real embedded kernel)", () => {
	beforeAll(() => {
		installRealFactory();
	}, CASE_TIMEOUT_MS);

	afterEach(async () => {
		await withTimeout(disposeAllVmContexts(), CELL_TIMEOUT_MS, "VM context disposal never settled");
	}, CASE_TIMEOUT_MS);

	afterAll(async () => {
		setElideJsKernelFactory(restoreFactory);
		restoreFactory = undefined;
		await embedded?.dispose();
		embedded = undefined;
	}, CASE_TIMEOUT_MS);

	it(
		"keeps guest state across two cells on one session",
		async () => {
			using tempDir = TempDir.createSync("@omp-elide-real-state-");
			const session = makeSession(tempDir.path());
			const run = makeRunner(session, tempDir.path(), namespaceSessionId(`real-state:${crypto.randomUUID()}`));
			const before = factory.opens.length;

			const first = await run(`${writeState("from-cell-1")} console.log('stored');`);
			expect(first.exitCode).toBe(0);
			expect(first.output).toContain("stored");

			const second = await run(READ_STATE);
			expect(second.exitCode).toBe(0);
			expect(second.output.trim()).toBe("from-cell-1");
			// One context served both cells: it was reused, not rebuilt.
			expect(factory.opens.length - before).toBe(1);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"wipes guest state when a cell asks for reset",
		async () => {
			using tempDir = TempDir.createSync("@omp-elide-real-reset-");
			const session = makeSession(tempDir.path());
			const run = makeRunner(session, tempDir.path(), namespaceSessionId(`real-reset:${crypto.randomUUID()}`));
			const opensBefore = factory.opens.length;
			const resetsBefore = factory.resets;

			await run(writeState("from-cell-1"));
			const afterReset = await run(READ_STATE, { reset: true });

			expect(afterReset.exitCode).toBe(0);
			expect(afterReset.output.trim()).toBe("gone");
			// A host-level reset is a cold start: a second context, never the seam's
			// own `reset()` ask.
			expect(factory.opens.length - opensBefore).toBe(2);
			expect(factory.resets).toBe(resetsBefore);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"forks a non-exclusive owner's reset onto a private context",
		async () => {
			using tempDir = TempDir.createSync("@omp-elide-real-fork-");
			const session = makeSession(tempDir.path());
			const run = makeRunner(session, tempDir.path(), namespaceSessionId(`real-fork:${crypto.randomUUID()}`));
			const before = factory.opens.length;

			await run(writeState("owner-a-state"), { kernelOwnerId: "agent-a" });
			const joined = await run(READ_STATE, { kernelOwnerId: "agent-b" });
			expect(joined.output.trim()).toBe("owner-a-state");

			const forked = await run(READ_STATE, { kernelOwnerId: "agent-b", reset: true });
			expect(forked.output.trim()).toBe("gone");
			const preserved = await run(READ_STATE, { kernelOwnerId: "agent-a" });
			expect(preserved.output.trim()).toBe("owner-a-state");
			const sticky = await run(READ_STATE, { kernelOwnerId: "agent-b" });
			expect(sticky.output.trim()).toBe("gone");

			const opened = factory.opens.slice(before);
			expect(opened).toHaveLength(2);
			// Both contexts opened under ONE kernel-facing session id: the fork key is
			// host-side bookkeeping, so a kernel that deduplicated on `sessionId` would
			// have handed agent-b's forked context back to agent-a.
			expect(new Set(opened.map(open => open.sessionId)).size).toBe(1);
			expect(opened[0]?.sessionId).toStartWith("js-elide:");
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"tears down a session through the shared JS disposal path",
		async () => {
			using tempDir = TempDir.createSync("@omp-elide-real-dispose-");
			const session = makeSession(tempDir.path());
			const run = makeRunner(session, tempDir.path(), namespaceSessionId(`real-dispose:${crypto.randomUUID()}`));
			const closesBefore = factory.closes;

			await run(writeState("before-disposal"), { kernelOwnerId: "agent-solo" });
			// Engine-agnostic: the same call the Bun engine uses reaps an Elide context.
			await withTimeout(disposeVmContextsByOwner("agent-solo"), CELL_TIMEOUT_MS, "owner disposal never settled");
			expect(factory.closes - closesBefore).toBe(1);

			const afterDisposal = await run(READ_STATE, { kernelOwnerId: "agent-solo" });
			expect(afterDisposal.exitCode).toBe(0);
			expect(afterDisposal.output.trim()).toBe("gone");
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"settles an aborted cell as cancelled and releases the kernel session",
		async () => {
			using tempDir = TempDir.createSync("@omp-elide-real-cancel-");
			const park = createParkTool();
			const session = makeSession(tempDir.path(), [park.tool]);
			const run = makeRunner(session, tempDir.path(), namespaceSessionId(`real-cancel:${crypto.randomUUID()}`));
			const controller = new AbortController();
			const closesBefore = factory.closes;
			const interruptsBefore = factory.interrupts;

			const pending = run(park.code, { signal: controller.signal });
			try {
				await park.entered;
				controller.abort();
				const result = await pending;

				expect(result.cancelled).toBe(true);
				expect(result.exitCode).toBeUndefined();
				expect(result.output).not.toContain("parked-cell-finished");
				expect(result.output).not.toContain("Command timed out");
				// Cancellation force-terminates the worker, and that is what releases
				// the context — never the seam's `interrupt()` ask, which nothing on the
				// host stack calls today.
				expect(factory.closes - closesBefore).toBe(1);
				expect(factory.interrupts).toBe(interruptsBefore);
			} finally {
				park.release();
			}
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"never derives a self-cancel timer from idleTimeoutMs",
		async () => {
			using tempDir = TempDir.createSync("@omp-elide-real-budget-");
			const session = makeSession(tempDir.path());
			const run = makeRunner(session, tempDir.path(), namespaceSessionId(`real-budget:${crypto.randomUUID()}`));
			const closesBefore = factory.closes;

			const result = await run(
				"await new Promise(resolve => setTimeout(resolve, 120)); return 'slow-cell-finished';",
				{
					idleTimeoutMs: 5,
					signal: new AbortController().signal,
				},
			);

			expect(result.cancelled).toBe(false);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("slow-cell-finished");
			expect(factory.closes).toBe(closesBefore);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"routes timeout-control status to onStatus and keeps it out of displayOutputs",
		async () => {
			using tempDir = TempDir.createSync("@omp-elide-real-status-");
			const session = makeSession(tempDir.path());
			const run = makeRunner(session, tempDir.path(), namespaceSessionId(`real-status:${crypto.randomUUID()}`));
			const seen: JsStatusEvent[] = [];

			const result = await run(
				`globalThis.__omp_emit_status__(${JSON.stringify(EVAL_TIMEOUT_PAUSE_OP)}, { deferExternalAbort: true });
				phase("parity-visible");
				return "statuses-emitted";`,
				{ onStatus: event => seen.push(event) },
			);

			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("statuses-emitted");
			expect(seen.map(event => event.op)).toEqual([EVAL_TIMEOUT_PAUSE_OP, "phase"]);
			expect(seen[0]?.deferExternalAbort).toBe(true);
			expect(statusOutputs(result).map(output => output.event.op)).toEqual(["phase"]);
			expect(statusOutputs(result)[0]?.event.title).toBe("parity-visible");
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"round-trips a guest tool call through callSessionTool",
		async () => {
			using tempDir = TempDir.createSync("@omp-elide-real-tool-");
			const calls: { toolCallId: string; args: unknown; signal?: AbortSignal }[] = [];
			const echo = createTool("parity_echo", async (toolCallId, args, signal) => {
				calls.push({ toolCallId, args, signal });
				const value = (args as { value?: unknown }).value;
				return { content: [{ type: "text", text: `echo:${String(value)}` }] } as AgentToolResult;
			});
			const session = makeSession(tempDir.path(), [echo]);
			const run = makeRunner(session, tempDir.path(), namespaceSessionId(`real-tool:${crypto.randomUUID()}`));
			const outerSignal = new AbortController().signal;

			const result = await run("const reply = await tool.parity_echo({ value: 'ping' }); return reply;", {
				signal: outerSignal,
			});

			expect(result.exitCode).toBe(0);
			expect(result.output.trim()).toBe("echo:ping");
			expect(calls).toHaveLength(1);
			expect(calls[0]?.toolCallId).toMatch(/^js-parity_echo-/);
			expect(calls[0]?.args).toEqual({ value: "ping", [INTENT_FIELD]: "js prelude" });
			// Tools run host-side: a real AbortSignal object, minted per call.
			expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
			expect(calls[0]?.signal).not.toBe(outerSignal);
			expect(calls[0]?.signal?.aborted).toBe(false);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"returns a throwing cell as exitCode 1 without throwing out of the executor",
		async () => {
			using tempDir = TempDir.createSync("@omp-elide-real-error-");
			const session = makeSession(tempDir.path());
			const run = makeRunner(session, tempDir.path(), namespaceSessionId(`real-error:${crypto.randomUUID()}`));
			const before = factory.opens.length;

			const settled = await run("throw new Error('parity-boom');").then(
				result => ({ status: "resolved" as const, result }),
				(error: unknown) => ({ status: "rejected" as const, error }),
			);

			expect(settled.status).toBe("resolved");
			const result = settled.status === "resolved" ? settled.result : undefined;
			expect(result?.exitCode).toBe(1);
			expect(result?.cancelled).toBe(false);
			expect(result?.output).toContain("parity-boom");

			// A failed cell is a value, not a fatality: the context stays warm.
			const next = await run("return 'still-alive';");
			expect(next.output.trim()).toBe("still-alive");
			expect(next.exitCode).toBe(0);
			expect(factory.opens.length - before).toBe(1);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"survives a guest exit: the cell ends with its status, the context keeps its variables",
		async () => {
			using tempDir = TempDir.createSync("@omp-elide-real-exit-");
			const session = makeSession(tempDir.path());
			const run = makeRunner(session, tempDir.path(), namespaceSessionId(`real-exit:${crypto.randomUUID()}`));
			const before = factory.opens.length;

			await run(writeState("kept-across-exit"));
			const exited = await run("console.log('exiting'); process.exit(3);");

			// Errors as values: the EVAL ended, the executor did not throw.
			expect(exited.cancelled).toBe(false);
			expect(exited.exitCode).toBe(1);
			expect(exited.output).toContain("exit status 3");

			const after = await run(READ_STATE);
			expect(after.exitCode).toBe(0);
			expect(after.output.trim()).toBe("kept-across-exit");
			// One context throughout: the exit never cost a rebuild.
			expect(factory.opens.length - before).toBe(1);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"interrupts a cell that is genuinely in flight and keeps the context",
		async () => {
			using tempDir = TempDir.createSync("@omp-elide-real-interrupt-");
			const session = makeSession(tempDir.path());
			const run = makeRunner(session, tempDir.path(), namespaceSessionId(`real-interrupt:${crypto.randomUUID()}`));
			const before = factory.opens.length;

			await run(writeState("across-interrupt"));
			const kernelSession = factory.sessions[factory.sessions.length - 1];
			expect(kernelSession).toBeDefined();

			// A cell the fake could never be asked to interrupt: synchronous, spinning,
			// and holding the guest thread. Native execution has no test-only "entered
			// guest" hook, so a short real delay is the idiom here.
			const pending = run("while (true) {}");
			await Bun.sleep(500);
			await withTimeout(kernelSession?.interrupt() ?? Promise.resolve(), CELL_TIMEOUT_MS, "interrupt never settled");

			// The cell settles as a VALUE — the executor never throws — and it settles
			// because of the interrupt, not because a wall clock ran out.
			const result = await pending;
			expect(result.exitCode === 1 || result.cancelled).toBe(true);
			expect(result.output).toContain("interrupted");

			// "Abort the current cell; the context and its state survive."
			const after = await run(READ_STATE);
			expect(after.exitCode).toBe(0);
			expect(after.output.trim()).toBe("across-interrupt");
			expect(factory.opens.length - before).toBe(1);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"discards guest state on a kernel reset while the session stays warm",
		async () => {
			using tempDir = TempDir.createSync("@omp-elide-real-kernel-reset-");
			const session = makeSession(tempDir.path());
			const run = makeRunner(
				session,
				tempDir.path(),
				namespaceSessionId(`real-kernel-reset:${crypto.randomUUID()}`),
			);
			const opensBefore = factory.opens.length;
			const closesBefore = factory.closes;

			await run(writeState("before-kernel-reset"));
			const kernelSession = factory.sessions[factory.sessions.length - 1];
			expect(kernelSession).toBeDefined();

			await withTimeout(kernelSession?.reset() ?? Promise.resolve(), CELL_TIMEOUT_MS, "kernel reset never settled");

			// "Discard user state, keeping engine warmth": same host session, no
			// reopen and no close, but the guest starts clean.
			const after = await run(READ_STATE);
			expect(after.exitCode).toBe(0);
			expect(after.output.trim()).toBe("gone");
			expect(factory.opens.length).toBe(opensBefore + 1);
			expect(factory.closes).toBe(closesBefore);
		},
		CASE_TIMEOUT_MS,
	);
});
