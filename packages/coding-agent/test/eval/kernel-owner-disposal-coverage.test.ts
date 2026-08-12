/**
 * Pins the kernel-owner disposal fan-out that session teardown relies on.
 *
 * Every retained eval backend (Python, Ruby, Julia, JS) is reaped by owner id,
 * never by a global sweep, and the two teardown paths — a live session's
 * `EvalRunner.disposeKernels()` and `createAgentSession`'s startup-failure
 * cleanup — must cover the same disposer set. These are regression gates, not
 * new behavior: anything that removes a backend from either fan-out, swaps an
 * owner-scoped disposer for a global one, or lets one backend's failure
 * suppress the others has to break a test here first.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import * as juliaExecutor from "../../src/eval/jl/executor";
import * as jsContextManager from "../../src/eval/js/context-manager";
import { executeJs } from "../../src/eval/js/executor";
import * as pythonExecutor from "../../src/eval/py/executor";
import * as rubyExecutor from "../../src/eval/rb/executor";
import { EvalRunner, type EvalRunnerHost } from "../../src/session/eval-runner";
import type { ToolSession } from "../../src/tools";

/** Bounds every awaited disposal so a hung disposer fails loudly instead of stalling the suite. */
const DISPOSE_TIMEOUT_MS = 10_000;
/** Bounds a real JS cell (worker cold start included). */
const CELL_TIMEOUT_MS = 20_000;

/**
 * The owner-scoped disposers `EvalRunner.disposeKernels()` fans out to. Shared
 * with the startup-failure pin below so both teardown paths are checked against
 * one list — adding a backend to one path without the other fails here.
 */
const EVAL_RUNNER_DISPOSERS = [
	"disposeKernelSessionsByOwner",
	"disposeRubyKernelSessionsByOwner",
	"disposeJuliaKernelSessionsByOwner",
	"disposeVmContextsByOwner",
] as const;
type DisposerName = (typeof EVAL_RUNNER_DISPOSERS)[number];

function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
			"task.enableLsp": true,
		}),
		taskDepth: 0,
		enableLsp: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getActiveModelString: () => "p/active",
		getModelString: () => "p/fallback",
		getArtifactsDir: () => null,
		getSessionId: () => "test-session",
		getEvalSessionId: () => "test-eval-session",
	};
}

/**
 * A runner whose host is inert: `disposeKernels()` only consults the (empty)
 * active-execution set before fanning out, so nothing here is exercised.
 */
function makeEvalRunner(kernelOwnerId: string): EvalRunner {
	const host: EvalRunnerHost = {
		agent: {} as EvalRunnerHost["agent"],
		sessionManager: {
			getCwd: () => "/dev/null",
			getSessionFile: () => null,
		} as unknown as EvalRunnerHost["sessionManager"],
		settings: Settings.isolated(),
		extensionRunner: () => undefined,
		isStreaming: () => false,
		appendSessionMessage: () => undefined,
	};
	return new EvalRunner(host, { kernelOwnerId, parentSessionId: undefined });
}

/**
 * Stubs the four per-language owner disposers. The `satisfies` clause is the
 * coupling: the keys must be exactly {@link EVAL_RUNNER_DISPOSERS}, so a
 * renamed or dropped disposer is a type error, not a silently skipped spy.
 */
function spyOnOwnerDisposers() {
	const spies = {
		disposeKernelSessionsByOwner: vi
			.spyOn(pythonExecutor, "disposeKernelSessionsByOwner")
			.mockResolvedValue(undefined),
		disposeRubyKernelSessionsByOwner: vi
			.spyOn(rubyExecutor, "disposeRubyKernelSessionsByOwner")
			.mockResolvedValue(undefined),
		disposeJuliaKernelSessionsByOwner: vi
			.spyOn(juliaExecutor, "disposeJuliaKernelSessionsByOwner")
			.mockResolvedValue(undefined),
		disposeVmContextsByOwner: vi.spyOn(jsContextManager, "disposeVmContextsByOwner").mockResolvedValue(undefined),
	};
	return spies satisfies Record<DisposerName, unknown>;
}

/** Global sweeps that would reap kernels belonging to unrelated sessions. */
function spyOnGlobalDisposers() {
	return {
		disposeAllKernelSessions: vi.spyOn(pythonExecutor, "disposeAllKernelSessions").mockResolvedValue(undefined),
		disposeAllRubyKernelSessions: vi.spyOn(rubyExecutor, "disposeAllRubyKernelSessions").mockResolvedValue(undefined),
		disposeAllJuliaKernelSessions: vi
			.spyOn(juliaExecutor, "disposeAllJuliaKernelSessions")
			.mockResolvedValue(undefined),
		disposeAllVmContexts: vi.spyOn(jsContextManager, "disposeAllVmContexts").mockResolvedValue(undefined),
	};
}

describe("EvalRunner.disposeKernels fan-out", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("disposes all four eval backends by the runner's own owner id", async () => {
		const spies = spyOnOwnerDisposers();
		const globals = spyOnGlobalDisposers();
		const runner = makeEvalRunner("owner-fanout");
		expect(runner.getKernelOwnerId()).toBe("owner-fanout");

		await withTimeout(runner.disposeKernels(), DISPOSE_TIMEOUT_MS, "disposeKernels never settled");

		for (const [name, spy] of Object.entries(spies)) {
			expect(spy, `${name} call count`).toHaveBeenCalledTimes(1);
			// Exact arity: a disposer handed extra scoping arguments would mean
			// ownership is no longer expressed by the owner id alone.
			expect(spy.mock.calls[0], `${name} call args`).toEqual(["owner-fanout"]);
		}
		// Owner-scoped only: a session's teardown must never sweep kernels that
		// belong to other sessions.
		for (const [name, spy] of Object.entries(globals)) {
			expect(spy, `${name} must not be called`).not.toHaveBeenCalled();
		}
	});

	it("runs every disposer even when one rejects, then reports an AggregateError", async () => {
		const spies = spyOnOwnerDisposers();
		const failure = new Error("ruby kernel shutdown exploded");
		spies.disposeRubyKernelSessionsByOwner.mockRejectedValue(failure);
		const runner = makeEvalRunner("owner-partial-failure");

		const thrown = await withTimeout(
			runner.disposeKernels().then(
				() => undefined,
				(error: unknown) => error,
			),
			DISPOSE_TIMEOUT_MS,
			"disposeKernels never settled",
		);

		expect(thrown).toBeInstanceOf(AggregateError);
		const aggregate = thrown as AggregateError;
		expect(aggregate.message).toBe("Failed to dispose one or more eval kernels");
		expect(aggregate.errors).toEqual([failure]);
		// The surviving backends were still asked to release the owner: one
		// backend's failure must not strand the other three's kernels.
		for (const [name, spy] of Object.entries(spies)) {
			expect(spy, `${name} call args`).toHaveBeenCalledWith("owner-partial-failure");
		}
	});

	it("collects every rejection in fan-out order", async () => {
		const spies = spyOnOwnerDisposers();
		const pythonFailure = new Error("python kernel shutdown exploded");
		const jsFailure = new Error("JS context shutdown exploded");
		spies.disposeKernelSessionsByOwner.mockRejectedValue(pythonFailure);
		spies.disposeVmContextsByOwner.mockRejectedValue(jsFailure);
		const runner = makeEvalRunner("owner-multi-failure");

		const thrown = await withTimeout(
			runner.disposeKernels().then(
				() => undefined,
				(error: unknown) => error,
			),
			DISPOSE_TIMEOUT_MS,
			"disposeKernels never settled",
		);

		expect(thrown).toBeInstanceOf(AggregateError);
		// Python is the first disposer in the fan-out and JS the last; the
		// aggregate preserves that order so logs name the failing backend.
		expect((thrown as AggregateError).errors).toEqual([pythonFailure, jsFailure]);
		expect(spies.disposeRubyKernelSessionsByOwner).toHaveBeenCalledWith("owner-multi-failure");
		expect(spies.disposeJuliaKernelSessionsByOwner).toHaveBeenCalledWith("owner-multi-failure");
	});
});

/**
 * `createAgentSession`'s startup-failure branch builds its cleanup steps inline
 * (they run only when session construction throws before the session exists, so
 * there is no runtime seam to observe them from). Pinning the registered
 * (label, disposer) pairs from the source keeps that path honest: a backend
 * added to `EvalRunner.disposeKernels()` but forgotten here — or vice versa —
 * shows up as a label-list diff.
 */
describe("createAgentSession startup-failure cleanup registration", () => {
	interface OwnerScopedStep {
		label: string;
		disposer: string | null;
	}

	function readOwnerScopedCleanupSteps(): OwnerScopedStep[] {
		const sdkPath = path.join(import.meta.dir, "..", "..", "src", "sdk.ts");
		const source = readFileSync(sdkPath, "utf8");
		const blockStart = source.indexOf("const cleanupSteps: StartupFailureCleanupStep[] = [];");
		expect(blockStart, "startup-failure cleanup block not found in sdk.ts").toBeGreaterThan(-1);
		const blockEnd = source.indexOf("await runStartupFailureCleanupSteps(cleanupSteps);", blockStart);
		expect(blockEnd, "runStartupFailureCleanupSteps call not found in sdk.ts").toBeGreaterThan(blockStart);
		const block = source.slice(blockStart, blockEnd);

		// Each step spans from its own `label:` to the next one, so the cleanup
		// expression is attributed to the label it was registered with.
		const labels = [...block.matchAll(/label: "([^"]+)"/g)];
		return labels.flatMap((match, index) => {
			const start = match.index;
			if (start === undefined) return [];
			const end = labels[index + 1]?.index ?? block.length;
			const body = block.slice(start, end);
			// Only the owner-scoped steps are this test's business; "runtime",
			// "async jobs" and "auth storage" clean up unrelated resources.
			if (!body.includes("evalKernelOwnerId")) return [];
			const disposer = body.match(/cleanup: \(\) =>\s*([A-Za-z0-9_$]+)\(evalKernelOwnerId\)/)?.[1] ?? null;
			return [{ label: match[1] ?? "", disposer }];
		});
	}

	it("registers every owner-scoped disposer under its stable label", () => {
		expect(readOwnerScopedCleanupSteps()).toEqual([
			{ label: "computer sessions", disposer: "releaseComputerSessionsForOwner" },
			{ label: "eval kernels", disposer: "disposeKernelSessionsByOwner" },
			{ label: "Ruby kernels", disposer: "disposeRubyKernelSessionsByOwner" },
			{ label: "Julia kernels", disposer: "disposeJuliaKernelSessionsByOwner" },
			{ label: "JS VM contexts", disposer: "disposeVmContextsByOwner" },
		]);
	});

	it("covers every backend EvalRunner.disposeKernels fans out to", () => {
		const registered = new Set(readOwnerScopedCleanupSteps().map(step => step.disposer));
		const missing = EVAL_RUNNER_DISPOSERS.filter(name => !registered.has(name));
		expect(missing, "backends disposed on session teardown but not on startup failure").toEqual([]);
	});
});

describe("disposeVmContextsByOwner last-owner-out", () => {
	afterEach(async () => {
		// Restore first so the sweep below is the real one no matter how these
		// groups are ordered or filtered — a stubbed sweep would leak workers.
		vi.restoreAllMocks();
		await withTimeout(
			jsContextManager.disposeAllVmContexts(),
			DISPOSE_TIMEOUT_MS,
			"disposeAllVmContexts never settled",
		);
	});

	it(
		"keeps a co-owned context alive until its last owner is disposed",
		async () => {
			using tempDir = TempDir.createSync("@omp-js-owner-disposal-");
			const session = makeSession(tempDir.path());
			const evalSessionId = `js-owner-disposal:${crypto.randomUUID()}`;
			const run = (code: string, kernelOwnerId: string) =>
				withTimeout(
					executeJs(code, { cwd: tempDir.path(), sessionId: evalSessionId, session, kernelOwnerId }),
					CELL_TIMEOUT_MS,
					`JS cell never settled: ${code}`,
				);
			const dispose = (ownerId: string) =>
				withTimeout(
					jsContextManager.disposeVmContextsByOwner(ownerId),
					DISPOSE_TIMEOUT_MS,
					`disposeVmContextsByOwner(${ownerId}) never settled`,
				);

			// One live context, two owners: the parent seeds state, the subagent
			// joins the same context and can read it.
			await run("var marker = 41;", "owner-a");
			const joined = await run("return marker + 1;", "owner-b");
			expect(joined.output.trim()).toBe("42");

			// First owner out only deregisters: the context (and its state) must
			// survive for the owner still attached.
			await dispose("owner-a");
			const survived = await run("return marker + 1;", "owner-b");
			expect(survived.output.trim()).toBe("42");

			// Last owner out kills the context; the next cell gets a fresh one
			// with none of the old state.
			await dispose("owner-b");
			const rebuilt = await run("return typeof marker;", "owner-b");
			expect(rebuilt.output.trim()).toBe("undefined");
		},
		CELL_TIMEOUT_MS * 2,
	);
});
