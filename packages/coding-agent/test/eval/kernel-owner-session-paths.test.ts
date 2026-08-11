/**
 * Pins eval **owner identity** across the session paths the fork threaded its
 * own `runtimeServiceScope` object through: child agent sessions, structured
 * subagents, vibe workers, and the commit agent.
 *
 * The collapse thesis is that upstream's `kernelOwnerId` already carries what
 * the fork's scope object carries, so the scope threading can be deleted. That
 * only holds if the identity rules below are true, and they are invisible at the
 * type level:
 *
 *   - one kernel session, N owners: a child that inherits `parentEvalSessionId`
 *     shares the parent's eval session id (same kernel) but mints its own
 *     `evalKernelOwnerId` (its own disposal ticket);
 *   - a child that inherits nothing lands on a *different* kernel session;
 *   - `shareEvalSession: false` (the eval bridge's children) opts out of the
 *     shared kernel entirely;
 *   - a vibe worker — detached from the turn that spawned it — still inherits
 *     the parent's kernel;
 *   - the commit agent registers no `eval` tool at all, so its minted owner id
 *     is inert and owner-scoped disposal has nothing to reap.
 *
 * Companion to `kernel-owner-disposal-coverage.test.ts` (Task 4), which pins the
 * disposal fan-out these owner ids are the key for.
 *
 * **Scope — read before trusting this file as a gate.** It pins the two *ends* of
 * the inheritance chain, not the wire between them: the producers (where
 * `parentEvalSessionId` is put onto `ExecutorOptions` — `structured-subagent.ts`,
 * `vibe/runtime.ts`) and the consumer (where an `AgentSession` config turns it
 * into a shared kernel + a fresh owner). The intermediate forwarding hops —
 * `task/executor.ts`'s `parentEvalSessionId: options.parentEvalSessionId` into
 * the child `createAgentSession`, and `sdk.ts`'s forward of the same field into
 * the `AgentSession` config — are **not** pinned here or anywhere in the repo.
 * Deleting either one leaves every test in this file green while subagents and
 * vibe workers silently stop sharing the parent's kernel.
 *
 * Within that scope these are regression gates: anything that re-mints an
 * inherited kernel session, shares one owner id across sessions, or stops a
 * spawn path from *producing* the inheritance has to break a test here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { runCommitAgentSession } from "@oh-my-pi/pi-coding-agent/commit/agentic/agent";
import * as commitAgentTools from "@oh-my-pi/pi-coding-agent/commit/agentic/tools";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { runStructuredSubagent } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition, SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import { Snowflake, TempDir, withTimeout } from "@oh-my-pi/pi-utils";

/** Bounds every real async wait so a hang fails loudly instead of stalling the suite. */
const WAIT_TIMEOUT_MS = 20_000;

const OWNER_PREFIX = "agent-session:";

/** The owner id shape `sdk.ts` and `AgentSession` both mint. */
function expectMintedOwnerId(ownerId: string, label: string): void {
	expect(ownerId.startsWith(OWNER_PREFIX), `${label} owner prefix (${ownerId})`).toBe(true);
	expect(Snowflake.valid(ownerId.slice(OWNER_PREFIX.length)), `${label} owner suffix (${ownerId})`).toBe(true);
}

describe("AgentSession eval kernel identity", () => {
	const tempDirs: TempDir[] = [];
	const sessions: AgentSession[] = [];
	let authStorage: AuthStorage | undefined;
	let modelRegistry: ModelRegistry;
	let root: string;

	beforeEach(async () => {
		const tempDir = TempDir.createSync("@omp-eval-owner-session-paths-");
		tempDirs.push(tempDir);
		root = tempDir.path();
		authStorage = await withTimeout(
			AuthStorage.create(path.join(root, "auth.db")),
			WAIT_TIMEOUT_MS,
			"AuthStorage.create never settled",
		);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			await withTimeout(session.dispose(), WAIT_TIMEOUT_MS, "AgentSession.dispose never settled");
		}
		authStorage?.close();
		authStorage = undefined;
		for (const tempDir of tempDirs.splice(0)) tempDir.removeSync();
		vi.restoreAllMocks();
	});

	/**
	 * The cheapest construction of the real thing: `AgentSession`'s constructor is
	 * where the owner id is minted and `parentEvalSessionId` is handed to the
	 * `EvalRunner`, and it needs only these four config fields (the same shape
	 * `agent-session-*.test.ts` files use). Standing up a full `createAgentSession`
	 * would exercise the same two lines through several seconds of session boot.
	 */
	function makeSession(
		name: string,
		options: { parentEvalSessionId?: string; evalKernelOwnerId?: string } = {},
	): AgentSession {
		const cwd = path.join(root, name);
		fs.mkdirSync(cwd, { recursive: true });
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic model to exist");
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const session = new AgentSession({
			agent,
			// In-memory: no session file, so the fallback eval session id is
			// `cwd:<cwd>` and each session below is distinguishable by directory.
			sessionManager: SessionManager.inMemory(cwd),
			settings: Settings.isolated(),
			modelRegistry,
			...options,
		});
		sessions.push(session);
		return session;
	}

	it("shares an inherited eval session id across children while minting one owner each", () => {
		const parent = makeSession("parent");
		const parentEvalSessionId = parent.getEvalSessionId();
		// Grounded, not assumed: with no inherited id the parent's kernel key is
		// derived from its own cwd. The children below sit in *different* cwds, so
		// nothing but the inheritance can make their kernel keys match.
		expect(parentEvalSessionId).toBe(`cwd:${path.join(root, "parent")}`);

		const childA = makeSession("child-a", { parentEvalSessionId: parentEvalSessionId ?? undefined });
		const childB = makeSession("child-b", { parentEvalSessionId: parentEvalSessionId ?? undefined });

		// One kernel session…
		expect(childA.getEvalSessionId(), "child A kernel session").toBe(parentEvalSessionId);
		expect(childB.getEvalSessionId(), "child B kernel session").toBe(parentEvalSessionId);

		// …N owners. Sharing an owner id would make either child's teardown reap
		// the parent's still-live kernel — the exact failure owner scoping exists
		// to prevent (see `kernel-owner-disposal-coverage.test.ts`).
		const owners = [parent.getEvalKernelOwnerId(), childA.getEvalKernelOwnerId(), childB.getEvalKernelOwnerId()];
		expect(new Set(owners).size, `owner ids must be distinct: ${owners.join(", ")}`).toBe(3);
		expectMintedOwnerId(owners[0] ?? "", "parent");
		expectMintedOwnerId(owners[1] ?? "", "child A");
		expectMintedOwnerId(owners[2] ?? "", "child B");
	});

	it("falls back to its own kernel session when no parent eval session id is inherited", () => {
		const parent = makeSession("parent");
		const orphan = makeSession("orphan");

		// The counterpart to the test above: same construction, no inheritance, so
		// the child lands on a kernel session of its own. This is what
		// `shareEvalSession: false` buys at the subagent layer.
		expect(orphan.getEvalSessionId()).toBe(`cwd:${path.join(root, "orphan")}`);
		expect(orphan.getEvalSessionId()).not.toBe(parent.getEvalSessionId());
		expect(orphan.getEvalKernelOwnerId()).not.toBe(parent.getEvalKernelOwnerId());
	});

	it("adopts a caller-supplied kernel owner id verbatim", () => {
		// `createAgentSession` mints ONE `evalKernelOwnerId` and uses it twice: it
		// passes it into this config, and it closes over it in the startup-failure
		// cleanup steps pinned by Task 4. If the constructor re-minted here, those
		// cleanup steps would dispose a ghost owner while the session's real
		// kernels leaked.
		const supplied = `${OWNER_PREFIX}${Snowflake.next()}`;
		const session = makeSession("supplied-owner", { evalKernelOwnerId: supplied });
		expect(session.getEvalKernelOwnerId()).toBe(supplied);
	});
});

const SUBAGENT: AgentDefinition = {
	name: "worker",
	description: "Test worker",
	systemPrompt: "Do the assigned work.",
	source: "bundled",
	tools: ["read"],
};

function makeSubagentResult(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "worker",
		agentSource: "bundled",
		task: "Inspect the target.",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

describe("structured subagent eval session inheritance", () => {
	const PARENT_EVAL_SESSION_ID = "cwd:/parent-of-record";

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function makeParentSession(): ToolSession {
		return {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({
				"task.maxRecursionDepth": 2,
				"task.isolation.mode": "none",
				"task.enableLsp": true,
			}),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getEvalSessionId: () => PARENT_EVAL_SESSION_ID,
		} as unknown as ToolSession;
	}

	/** Runs one subagent through the real primitive and returns the dispatched executor options. */
	async function dispatch(overrides: { shareEvalSession?: boolean }): Promise<ExecutorOptions> {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [SUBAGENT],
			projectAgentsDir: null,
		});
		const dispatched: ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			dispatched.push(options);
			return makeSubagentResult(options.id);
		});

		await withTimeout(
			runStructuredSubagent({
				session: makeParentSession(),
				invocationKind: "task",
				assignment: "Inspect the target.",
				agent: "worker",
				...overrides,
			}),
			WAIT_TIMEOUT_MS,
			"runStructuredSubagent never settled",
		);

		const options = dispatched[0];
		if (!options) throw new Error("Expected runSubprocess to be dispatched exactly once");
		expect(dispatched).toHaveLength(1);
		return options;
	}

	it("hands a task subagent the parent's eval session id", async () => {
		const options = await dispatch({});
		expect(options.parentEvalSessionId).toBe(PARENT_EVAL_SESSION_ID);
	});

	it("withholds the parent eval session id from an eval-bridge child (shareEvalSession: false)", async () => {
		// `eval/agent-bridge.ts` is the only caller that passes `false`: an agent()
		// child spawned from inside a cell must not join the kernel it was called
		// from. Undefined (not the parent's id) is what makes the child's session
		// derive a kernel key of its own — see the AgentSession fallback pin above.
		const options = await dispatch({ shareEvalSession: false });
		expect(options.parentEvalSessionId).toBeUndefined();
	});
});

describe("vibe worker eval session inheritance", () => {
	const PARENT_EVAL_SESSION_ID = "cwd:/vibe-parent-of-record";
	const managers: AsyncJobManager[] = [];

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		VibeSessionRegistry.resetGlobalForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) {
			await withTimeout(manager.dispose({ timeoutMs: 1000 }), WAIT_TIMEOUT_MS, "AsyncJobManager.dispose hung");
		}
		VibeSessionRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	/** Minimal stand-in for a live worker session; the registry only needs it addressable. */
	function makeFakeWorkerSession(): unknown {
		const listeners = new Set<(event: unknown) => void>();
		return {
			isStreaming: false,
			model: undefined,
			subscribe(listener: (event: unknown) => void): () => void {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			async prompt(): Promise<boolean> {
				return true;
			},
			async steer(): Promise<void> {},
			async waitForIdle(): Promise<void> {},
			getLastAssistantMessage() {
				return undefined;
			},
			async abort(): Promise<void> {},
			async dispose(): Promise<void> {},
		};
	}

	it("passes the spawning session's eval session id into a vibe worker spawn", async () => {
		let observed: ExecutorOptions | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			observed = options;
			AgentRegistry.global().register({
				id: options.id,
				displayName: options.id,
				kind: "sub",
				parentId: "Main",
				session: makeFakeWorkerSession() as never,
				status: "idle",
			});
			return makeSubagentResult(options.id);
		});

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		const session = {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({}),
			getSessionFile: () => null,
			getSessionId: () => "vibe-eval-parent",
			getAgentId: () => "Main",
			getArtifactsDir: () => null,
			getSessionSpawns: () => "*",
			getEvalSessionId: () => PARENT_EVAL_SESSION_ID,
			sessionManager: undefined,
			asyncJobManager: manager,
		} as unknown as ToolSession;

		const { jobId } = await withTimeout(
			VibeSessionRegistry.global().spawn(session, {
				cli: "fast",
				name: "EvalScoped",
				prompt: "Share the parent kernel.",
			}),
			WAIT_TIMEOUT_MS,
			"vibe spawn never settled",
		);
		const job = manager.getJob(jobId);
		if (!job) throw new Error(`Expected vibe job ${jobId} to be registered`);
		await withTimeout(job.promise, WAIT_TIMEOUT_MS, "vibe worker turn never settled");

		// A vibe worker runs detached from the turn that spawned it; dropping the
		// inheritance here would silently give every worker its own kernel.
		expect(observed?.parentEvalSessionId).toBe(PARENT_EVAL_SESSION_ID);
	});
});

describe("commit agent has no eval surface", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("builds its session from custom tools only, with a `__none__` built-in whitelist", async () => {
		const commitTools: ReturnType<typeof commitAgentTools.createCommitTools> = [];
		vi.spyOn(commitAgentTools, "createCommitTools").mockReturnValue(commitTools);
		const observed: Array<Parameters<typeof sdkModule.createAgentSession>[0]> = [];
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			observed.push(options);
			return {
				session: {
					prompt: async () => {},
					subscribe: () => () => {},
					dispose: async () => {},
				},
			} as unknown as CreateAgentSessionResult;
		});

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic model to exist");
		await withTimeout(
			runCommitAgentSession({
				cwd: "/tmp",
				model,
				settings: Settings.isolated(),
				modelRegistry: {} as never,
				authStorage: {} as never,
				changelogTargets: [],
				requireChangelog: false,
			}),
			WAIT_TIMEOUT_MS,
			"runCommitAgentSession never settled",
		);

		const options = observed[0];
		if (!options) throw new Error("Expected the commit agent to create exactly one session");
		expect(observed).toHaveLength(1);
		expect(options.toolNames).toEqual(["__none__"]);
		// Identity: the ONLY tools this session gets are the commit tools.
		expect(options.customTools).toBe(commitTools);
	});

	it("registers no eval tool for a `__none__` built-in whitelist", async () => {
		const names = async (toolNames: string[]): Promise<string[]> => {
			using tempDir = TempDir.createSync("@omp-commit-agent-tools-");
			const session: ToolSession = {
				cwd: tempDir.path(),
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
				getSessionId: () => "commit-agent-session",
				getEvalSessionId: () => "commit-agent-eval-session",
			};
			const tools = await withTimeout(
				createTools(session, toolNames),
				WAIT_TIMEOUT_MS,
				`createTools(${toolNames.join(",")}) never settled`,
			);
			return tools.map(tool => tool.name);
		};

		// The claim under test: the commit agent's whitelist yields no `eval`, so
		// its minted owner id never owns a kernel and owner-scoped disposal is a
		// no-op for it.
		expect(await names(["__none__"])).not.toContain("eval");
		// Control — without it the assertion above would pass for a session that
		// simply cannot build an eval tool in this environment.
		expect(await names(["eval"])).toContain("eval");
	});
});
