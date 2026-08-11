/**
 * Engine parity for the Elide JS backend.
 *
 * This is the behavior contract milestone 3's real-ABI wiring must keep green by
 * swapping the kernel factory installed in `beforeEach` — one line, plus the
 * counting decorator around it that satisfies the fake's counter surface
 * (`opens`/`closes`/`interrupts`/`resets`/`sessions`), which ~30 assertions here
 * read. Every case drives the production entry point (`executeElideJs`) over the
 * shared eval stack, so what is pinned is the stack's behavior *through* the
 * Elide seam: session reuse, owner-scoped reset forking, disposal through the
 * shared JS context manager, signal-only cancellation, timeout-control
 * filtering, the tool bridge, and errors-as-values.
 *
 * **Two properties of the Task-10 fake shape what can honestly be asserted, and
 * every assertion below is chosen to hold for a real kernel as well.**
 *
 * 1. *The guest shares the host realm.* The fake drives a real `WorkerCore` in
 *    inline mode, so cells execute in THIS process's global scope. Two
 *    consequences, and one rule that follows from them:
 *    - Cell state published to `globalThis` (`var x = 1`, and the
 *      `globalThis.x = x` publish `wrapCode` emits for async-wrapped cells)
 *      outlives a context teardown and is visible to a second live context, so
 *      cases that must observe state NOT crossing a context boundary carry it in
 *      {@link writeState}'s per-runtime bag instead.
 *    - **No cell here may touch a host object.** Reaching a host `Promise`
 *      through `globalThis` would park a cell today and throw on a real kernel,
 *      whose guest has its own realm — the suite would die in setup at the very
 *      swap it exists to survive. Cells that must park do it by awaiting a HOST
 *      TOOL ({@link createParkTool}): tool calls cross the transport in both
 *      engines. Guest-side runtime globals the JS bootstrap installs INSIDE the
 *      guest (`__omp_helpers__`, `__omp_emit_status__`, the prelude aliases) are
 *      fair game — those exist on either engine.
 * 2. *`interrupt()` cannot abort an in-flight inline cell.* The host stack
 *    cancels by force-terminating the worker, so the cancellation case asserts
 *    what the kernel seam RECORDS (a released session, no interrupt ask) rather
 *    than mid-cell abort of a spinning loop — which the inline fake would hang
 *    on. The seam's `interrupt()`/`reset()` asks are exercised directly in the
 *    final block.
 *
 * Idioms mirror `test/eval/kernel-owner-scoping.test.ts` (the Bun-engine twin of
 * cases 1-4). Every real wait is `withTimeout`-bounded so a wedged kernel fails
 * loudly instead of stalling the suite. `src/` imports are relative on purpose:
 * the context-manager singleton these cases share with `executeElideJs` must be
 * the same module instance.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import { Settings } from "../../../src/config/settings";
import { EVAL_TIMEOUT_PAUSE_OP } from "../../../src/eval/bridge-timeout";
import { namespaceSessionId } from "../../../src/eval/elide";
import { executeElideJs } from "../../../src/eval/elide/executor";
import { type ElideJsKernelFactory, setElideJsKernelFactory } from "../../../src/eval/elide/kernel";
import {
	disposeAllVmContexts,
	disposeVmContextsByOwner,
	type JsDisplayOutput,
} from "../../../src/eval/js/context-manager";
import type { JsExecutorOptions, JsResult } from "../../../src/eval/js/executor";
import type { JsStatusEvent } from "../../../src/eval/js/shared/types";
import type { ToolSession } from "../../../src/tools";
import {
	createFakeElideJsKernelFactory,
	type FakeElideJsKernelFactory,
	type FakeElideJsKernelSession,
} from "./fake-kernel";

/** Bounds every real wait so a wedged kernel fails loudly, under Bun's 5s default. */
const WAIT_TIMEOUT_MS = 4_000;

/**
 * Cell source that stores/reads one string of per-context guest state.
 *
 * The carrier is the runtime's own `env` bag, reached through `__omp_helpers__`.
 * Every `JsRuntime` installs its own `__omp_helpers__` and the global-owner
 * stack swaps it back in for each run, so the bag belongs to exactly one
 * context — the property a wipe case has to observe. The prelude's `env` alias
 * is NOT equivalent: the prelude installs once per realm and short-circuits
 * afterwards, so with the inline fake a neighbouring runtime's alias can outlive
 * a context teardown and make a cold context look warm. Under a real Elide
 * kernel every carrier is per-context and this one still is.
 *
 * TODO(m3): once the real kernel gives the guest its own realm, revert this to
 * the plain `var shared = 41` carrier `test/eval/kernel-owner-scoping.test.ts`
 * uses, which then tests strictly more (it observes the whole guest global
 * scope, not one bag inside it).
 */
const STATE_KEY = "PARITY_STATE";

function writeState(value: string): string {
	return `void globalThis.__omp_helpers__.env(${JSON.stringify(STATE_KEY)}, ${JSON.stringify(value)});`;
}

const READ_STATE = `return globalThis.__omp_helpers__.env(${JSON.stringify(STATE_KEY)}) ?? "gone";`;

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

/** A cell parked inside a host tool call, plus the handles to observe and release it. */
interface ParkedCell {
	tool: AgentTool;
	/** Cell source that parks in the tool and finishes once released. */
	code: string;
	/** Resolves with the signal the tool was handed, once the cell is parked in it. */
	entered: Promise<AbortSignal | undefined>;
	release(): void;
}

/**
 * Park a cell mid-run the only way that works on BOTH engines: an outbound tool
 * call the host never answers until the test says so. The guest is blocked in
 * `await tool.parity_park({})` — real traffic over the worker protocol — with no
 * host object in reach and no spinning loop the inline fake could not interrupt.
 */
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
		entered: withTimeout(entered.promise, WAIT_TIMEOUT_MS, "parked cell never reached the tool"),
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
		getSessionId: () => "elide-parity-session",
		getEvalSessionId: () => "elide-parity-eval-session",
		getToolByName: name => registry.get(name),
	};
}

type CellOptions = Partial<Omit<JsExecutorOptions, "cwd" | "session" | "sessionId">>;

/** One cell on one Elide session, bounded so a wedged kernel fails loudly. */
function makeRunner(session: ToolSession, cwd: string, sessionId: string) {
	return (code: string, options: CellOptions = {}): Promise<JsResult> =>
		withTimeout(
			executeElideJs(code, { cwd, sessionId, session, ...options }),
			WAIT_TIMEOUT_MS,
			`elide cell never settled: ${code.slice(0, 48)}`,
		);
}

function statusOutputs(result: JsResult): Extract<JsDisplayOutput, { type: "status" }>[] {
	return result.displayOutputs.filter(
		(output): output is Extract<JsDisplayOutput, { type: "status" }> => output.type === "status",
	);
}

let factory: FakeElideJsKernelFactory;
let restoreFactory: ElideJsKernelFactory | undefined;
/**
 * Index of the kernel session that answered each finished cell, in order. The
 * only way to see which context served a cell when every context shares the
 * host realm — it is what proves owner-scoped forking really routed traffic.
 */
let servedBy: number[];

beforeEach(() => {
	factory = createFakeElideJsKernelFactory();
	servedBy = [];
	// A thin wrapper, so the run-routing probe attaches before the adapter's own
	// subscriber and the fake's counters stay the ones under assertion.
	const tracked: ElideJsKernelFactory = {
		async open(opts) {
			const session = await factory.open(opts);
			// `session` came out of the fake, so it is one of `factory.sessions`;
			// only `open()`'s interface return type hides that.
			const index = factory.sessions.indexOf(session as FakeElideJsKernelSession);
			session.onMessage(msg => {
				if (msg.type === "result") servedBy.push(index);
			});
			return session;
		},
	};
	restoreFactory = setElideJsKernelFactory(tracked);
});

afterEach(async () => {
	await withTimeout(disposeAllVmContexts(), WAIT_TIMEOUT_MS, "VM context disposal never settled");
	setElideJsKernelFactory(restoreFactory);
	restoreFactory = undefined;
});

describe("Elide engine session state", () => {
	it("keeps guest state across two cells on one session", async () => {
		using tempDir = TempDir.createSync("@omp-elide-parity-state-");
		const session = makeSession(tempDir.path());
		const run = makeRunner(session, tempDir.path(), namespaceSessionId(`parity-state:${crypto.randomUUID()}`));

		const first = await run(`var parity = 41; ${writeState("from-cell-1")}`);
		expect(first.exitCode).toBe(0);

		const second = await run(
			`return \`\${parity + 1}|\` + (globalThis.__omp_helpers__.env(${JSON.stringify(STATE_KEY)}) ?? "gone");`,
		);
		expect(second.output.trim()).toBe("42|from-cell-1");
		expect(second.exitCode).toBe(0);

		// One kernel session served both cells: the context was reused, not rebuilt.
		expect(factory.opens).toHaveLength(1);
		expect(factory.closes).toBe(0);
		expect(servedBy).toEqual([0, 0]);
	});

	it("wipes guest state when a cell asks for reset", async () => {
		using tempDir = TempDir.createSync("@omp-elide-parity-reset-");
		const session = makeSession(tempDir.path());
		const run = makeRunner(session, tempDir.path(), namespaceSessionId(`parity-reset:${crypto.randomUUID()}`));

		await run(writeState("from-cell-1"));
		const afterReset = await run(READ_STATE, { reset: true });

		expect(afterReset.output.trim()).toBe("gone");
		expect(afterReset.exitCode).toBe(0);
		// A host-level reset is a cold start: the old kernel session is released
		// and a new one opened. It never travels through the seam's `reset()` ask
		// (see the kernel-seam block for that path).
		expect(factory.opens).toHaveLength(2);
		expect(factory.closes).toBe(1);
		expect(factory.resets).toBe(0);
		expect(servedBy).toEqual([0, 1]);
	});
});

describe("Elide engine owner-scoped reset", () => {
	it("forks a non-exclusive owner's reset onto a private kernel session", async () => {
		using tempDir = TempDir.createSync("@omp-elide-parity-fork-");
		const session = makeSession(tempDir.path());
		const run = makeRunner(session, tempDir.path(), namespaceSessionId(`parity-fork:${crypto.randomUUID()}`));

		await run(writeState("owner-a-state"), { kernelOwnerId: "agent-a" });
		const joined = await run(READ_STATE, { kernelOwnerId: "agent-b" });
		expect(joined.output.trim()).toBe("owner-a-state");
		expect(factory.opens).toHaveLength(1);

		// agent-b resets. It does not own the context exclusively, so
		// `resolveOwnerScopedSessionKey` sends it to `<base>\0fork\0agent-b`:
		// a second kernel session, private and empty, with agent-a's untouched.
		const forked = await run(READ_STATE, { kernelOwnerId: "agent-b", reset: true });
		expect(forked.output.trim()).toBe("gone");
		expect(factory.opens).toHaveLength(2);
		// Nothing was torn down: the fork is additive, so agent-a's context — and
		// therefore its state — survives another owner's reset.
		expect(factory.closes).toBe(0);
		expect(factory.sessions).toHaveLength(2);

		const preserved = await run(READ_STATE, { kernelOwnerId: "agent-a" });
		expect(preserved.output.trim()).toBe("owner-a-state");

		// The fork is sticky: agent-b keeps resolving to it without asking again.
		const sticky = await run(READ_STATE, { kernelOwnerId: "agent-b" });
		expect(sticky.output.trim()).toBe("gone");
		expect(factory.opens).toHaveLength(2);

		// The routing proof: a-define, b-join → session 0; b-reset, b-sticky →
		// session 1; a-after-fork → back to session 0.
		expect(servedBy).toEqual([0, 0, 1, 0, 1]);
		// Both contexts opened under the SAME kernel-facing session id — the fork
		// key is host-side bookkeeping, so a real kernel must not assume its
		// `sessionId` uniquely identifies a context.
		expect(new Set(factory.opens.map(open => open.sessionId)).size).toBe(1);
		expect(factory.opens[0]?.sessionId).toStartWith("js-elide:");
	});
});

describe("Elide engine disposal", () => {
	it("tears down an elide session through the shared JS disposal path", async () => {
		using tempDir = TempDir.createSync("@omp-elide-parity-dispose-");
		const session = makeSession(tempDir.path());
		const run = makeRunner(session, tempDir.path(), namespaceSessionId(`parity-dispose:${crypto.randomUUID()}`));

		await run(writeState("before-disposal"), { kernelOwnerId: "agent-solo" });
		expect(factory.opens).toHaveLength(1);
		expect(factory.closes).toBe(0);

		// The disposal wiring is engine-agnostic: the same call the JS engine uses
		// reaps an Elide context, with no Elide-aware code in the caller.
		await withTimeout(disposeVmContextsByOwner("agent-solo"), WAIT_TIMEOUT_MS, "owner disposal never settled");
		expect(factory.closes).toBe(1);

		const afterDisposal = await run(READ_STATE, { kernelOwnerId: "agent-solo" });
		expect(afterDisposal.output.trim()).toBe("gone");
		expect(afterDisposal.exitCode).toBe(0);
		expect(factory.opens).toHaveLength(2);
		expect(servedBy).toEqual([0, 1]);
	});

	it("ships no engine-specific disposal entry point", async () => {
		const elideDir = path.join(import.meta.dir, "../../../src/eval/elide");
		// Recursive: a disposer added in a future subdirectory must not slip past.
		const files = readdirSync(elideDir, { recursive: true }).filter(
			(file): file is string => typeof file === "string" && file.endsWith(".ts"),
		);
		expect(files.length).toBeGreaterThan(0);

		const exported = new Map<string, string[]>();
		for (const file of files) {
			const module: Record<string, unknown> = await import(path.join(elideDir, file));
			exported.set(file, Object.keys(module));
		}

		// Disposal must stay a property of the shared context manager. An
		// `eval/elide/disposeVmContextsByOwner` would mean every caller of the
		// disposal path had to learn which engine served a session.
		for (const [file, names] of exported) {
			expect({ file, disposers: names.filter(name => /^dispose/i.test(name) || /ByOwner$/.test(name)) }).toEqual({
				file,
				disposers: [],
			});
		}
		// The scan is only meaningful if it really read the modules' exports.
		expect(exported.get("kernel.ts")).toContain("setElideJsKernelFactory");
		expect(exported.get("executor.ts")).toContain("executeElideJs");
	});
});

describe("Elide engine cancellation", () => {
	it("settles an aborted cell as cancelled and releases the kernel session", async () => {
		using tempDir = TempDir.createSync("@omp-elide-parity-cancel-");
		const park = createParkTool();
		const session = makeSession(tempDir.path(), [park.tool]);
		const run = makeRunner(session, tempDir.path(), namespaceSessionId(`parity-cancel:${crypto.randomUUID()}`));
		const controller = new AbortController();

		const pending = run(park.code, { signal: controller.signal });
		try {
			await park.entered;
			controller.abort();
			const result = await pending;

			expect(result.cancelled).toBe(true);
			expect(result.exitCode).toBeUndefined();
			// The cell was still parked in the tool when the abort landed: it never
			// reached its own return, so this is a real mid-cell cancel.
			expect(result.output).not.toContain("parked-cell-finished");
			// A plain cancel is not a timeout: no force-kill annotation is added.
			expect(result.output).not.toContain("Command timed out");
			// Cancellation force-terminates the worker, and that is what releases
			// the kernel session…
			expect(factory.closes).toBe(1);
			// …never the seam's `interrupt()` ask, which nothing on the host stack
			// calls today. If Tier 2 wires interrupt into cancellation, this line
			// is the tripwire that says the contract moved.
			expect(factory.interrupts).toBe(0);
		} finally {
			park.release();
		}
	});

	it("never derives a self-cancel timer from idleTimeoutMs", async () => {
		using tempDir = TempDir.createSync("@omp-elide-parity-budget-");
		const session = makeSession(tempDir.path());
		const run = makeRunner(session, tempDir.path(), namespaceSessionId(`parity-budget:${crypto.randomUUID()}`));

		// The eval tool drives cancellation with its own watchdog signal and hands
		// the executor only the runtime-work budget. A cell 24x over that budget,
		// with a signal that never aborts, must still finish.
		const result = await run("await new Promise(resolve => setTimeout(resolve, 120)); return 'slow-cell-finished';", {
			idleTimeoutMs: 5,
			signal: new AbortController().signal,
		});

		expect(result.cancelled).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("slow-cell-finished");
		// The session is still warm: nothing killed the worker behind the cell.
		expect(factory.closes).toBe(0);
		expect(factory.opens).toHaveLength(1);
	});
});

describe("Elide engine status routing", () => {
	it("routes timeout-control status to onStatus and keeps it out of displayOutputs", async () => {
		using tempDir = TempDir.createSync("@omp-elide-parity-status-");
		const session = makeSession(tempDir.path());
		const run = makeRunner(session, tempDir.path(), namespaceSessionId(`parity-status:${crypto.randomUUID()}`));
		const seen: JsStatusEvent[] = [];

		const result = await run(
			`globalThis.__omp_emit_status__(${JSON.stringify(EVAL_TIMEOUT_PAUSE_OP)}, { deferExternalAbort: true });
			phase("parity-visible");
			return "statuses-emitted";`,
			{ onStatus: event => seen.push(event) },
		);

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("statuses-emitted");
		// The watchdog sees everything, in order…
		expect(seen.map(event => event.op)).toEqual([EVAL_TIMEOUT_PAUSE_OP, "phase"]);
		expect(seen[0]?.deferExternalAbort).toBe(true);
		// …while the cell's rendered/persisted output carries only the real status.
		// The filter is precise: it drops the control event, not statuses at large.
		expect(statusOutputs(result).map(output => output.event.op)).toEqual(["phase"]);
		expect(statusOutputs(result)[0]?.event.title).toBe("parity-visible");
	});
});

describe("Elide engine tool bridge", () => {
	it("round-trips a guest tool call through callSessionTool", async () => {
		using tempDir = TempDir.createSync("@omp-elide-parity-tool-");
		const calls: { toolCallId: string; args: unknown; signal?: AbortSignal }[] = [];
		const echo = createTool("parity_echo", async (toolCallId, args, signal) => {
			calls.push({ toolCallId, args, signal });
			const value = (args as { value?: unknown }).value;
			return { content: [{ type: "text", text: `echo:${String(value)}` }] } as AgentToolResult;
		});
		const session = makeSession(tempDir.path(), [echo]);
		const run = makeRunner(session, tempDir.path(), namespaceSessionId(`parity-tool:${crypto.randomUUID()}`));
		const outerSignal = new AbortController().signal;

		const result = await run("const reply = await tool.parity_echo({ value: 'ping' }); return reply;", {
			signal: outerSignal,
		});

		// The reply came back to the guest, which returned it as the cell value.
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("echo:ping");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.toolCallId).toMatch(/^js-parity_echo-/);
		// Args crossed intact, with the bridge's intent stamp applied.
		expect(calls[0]?.args).toEqual({ value: "ping", [INTENT_FIELD]: "js prelude" });
		// Tools run host-side, in-process: the tool is handed a real AbortSignal
		// object, minted per call — not the executor's own signal, and not a
		// serialized stand-in (an AbortSignal cannot survive structured cloning).
		expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
		expect(calls[0]?.signal).not.toBe(outerSignal);
		expect(calls[0]?.signal?.aborted).toBe(false);
	});

	it("hands the tool the raw live signal the host cancels", async () => {
		using tempDir = TempDir.createSync("@omp-elide-parity-tool-signal-");
		const park = createParkTool();
		const session = makeSession(tempDir.path(), [park.tool]);
		const run = makeRunner(session, tempDir.path(), namespaceSessionId(`parity-tool-signal:${crypto.randomUUID()}`));
		const controller = new AbortController();

		const pending = run(park.code, { signal: controller.signal });
		try {
			const signal = await park.entered;
			expect(signal).toBeInstanceOf(AbortSignal);
			expect(signal?.aborted).toBe(false);

			const aborted = Promise.withResolvers<unknown>();
			signal?.addEventListener("abort", () => aborted.resolve(signal.reason), { once: true });
			controller.abort("parity-cancel");

			// Identity, proven by liveness: the object the tool is holding is the
			// one the host aborts, carrying the host's own reason. A copy could
			// not fire, and a snapshot could not carry the reason.
			const reason = await withTimeout(aborted.promise, WAIT_TIMEOUT_MS, "tool signal never aborted");
			expect(signal?.aborted).toBe(true);
			expect((reason as Error).message).toBe("parity-cancel");

			const result = await pending;
			expect(result.cancelled).toBe(true);
			expect(result.exitCode).toBeUndefined();
		} finally {
			park.release();
		}
	});
});

describe("Elide engine errors as values", () => {
	it("returns a throwing cell as exitCode 1 without throwing out of the executor", async () => {
		using tempDir = TempDir.createSync("@omp-elide-parity-error-");
		const session = makeSession(tempDir.path());
		const run = makeRunner(session, tempDir.path(), namespaceSessionId(`parity-error:${crypto.randomUUID()}`));

		const settled = await run("throw new Error('parity-boom');").then(
			result => ({ status: "resolved" as const, result }),
			(error: unknown) => ({ status: "rejected" as const, error }),
		);

		expect(settled.status).toBe("resolved");
		const result = settled.status === "resolved" ? settled.result : undefined;
		expect(result?.exitCode).toBe(1);
		expect(result?.cancelled).toBe(false);
		expect(result?.output).toContain("parity-boom");

		// A failed cell is a value, not a fatality: the context stays warm and the
		// next cell runs on the same kernel session.
		const next = await run("return 'still-alive';");
		expect(next.output.trim()).toBe("still-alive");
		expect(next.exitCode).toBe(0);
		expect(factory.opens).toHaveLength(1);
		expect(factory.closes).toBe(0);
		expect(servedBy).toEqual([0, 0]);
	});
});

/**
 * The two lifecycle asks the seam adds on top of the worker protocol. Nothing on
 * the host stack calls them today (the cases above pin that: reset cold-starts,
 * cancel terminates), so they are exercised here directly — against the contract
 * `ElideJsKernelSession` documents, which the Tier 2 kernel has to honor.
 */
describe("Elide kernel seam asks", () => {
	// TODO(m3): a real kernel can abort an in-flight cell, so re-point this at a
	// cell actually running (park it with `createParkTool`, interrupt, assert the
	// cell settles and the context survives) instead of interrupting between
	// cells. The fake cannot: its `interrupt()` only records the ask.
	it("records an interrupt without disturbing the context", async () => {
		using tempDir = TempDir.createSync("@omp-elide-parity-interrupt-");
		const session = makeSession(tempDir.path());
		const run = makeRunner(session, tempDir.path(), namespaceSessionId(`parity-interrupt:${crypto.randomUUID()}`));

		await run(writeState("across-interrupt"));
		const kernelSession = factory.sessions[0];
		expect(kernelSession).toBeDefined();

		await withTimeout(kernelSession?.interrupt() ?? Promise.resolve(), WAIT_TIMEOUT_MS, "interrupt never settled");
		expect(factory.interrupts).toBe(1);

		// "Abort the current cell; the context and its state survive."
		const after = await run(READ_STATE);
		expect(after.output.trim()).toBe("across-interrupt");
		expect(factory.opens).toHaveLength(1);
		expect(factory.closes).toBe(0);
	});

	it("discards guest state on a kernel reset while the session stays warm", async () => {
		using tempDir = TempDir.createSync("@omp-elide-parity-kernel-reset-");
		const session = makeSession(tempDir.path());
		const run = makeRunner(session, tempDir.path(), namespaceSessionId(`parity-kernel-reset:${crypto.randomUUID()}`));

		await run(writeState("before-kernel-reset"));
		const kernelSession = factory.sessions[0];
		expect(kernelSession).toBeDefined();

		await withTimeout(kernelSession?.reset() ?? Promise.resolve(), WAIT_TIMEOUT_MS, "kernel reset never settled");
		expect(factory.resets).toBe(1);

		// "Discard user state, keeping engine warmth": the host session is the
		// same one — no reopen, no close — but the guest starts clean.
		const after = await run(READ_STATE);
		expect(after.output.trim()).toBe("gone");
		expect(factory.opens).toHaveLength(1);
		expect(factory.closes).toBe(0);
		expect(servedBy).toEqual([0, 0]);
	});
});
