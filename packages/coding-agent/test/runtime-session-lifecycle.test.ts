import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../src/async";
import type { CommitAgentState } from "../src/commit/agentic/state";
import { createAnalyzeFileTool } from "../src/commit/agentic/tools/analyze-file";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import type { CustomToolContext } from "../src/extensibility/custom-tools/types";
import { AgentRegistry, MAIN_AGENT_ID } from "../src/registry/agent-registry";
import {
	disposeCachedRuntimeService,
	errorResponse,
	getOrCreateRuntimeService,
	type RuntimeEndpoint,
	RuntimeRpcError,
	RuntimeService,
	type RuntimeServiceScope,
	resetRuntimeServiceForTests,
	resolveRuntimeEndpointOptions,
} from "../src/runtime";
import { createAgentSession, runStartupFailureCleanupSteps } from "../src/sdk";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { TaskTool } from "../src/task";
import type { ToolSession } from "../src/tools";

function testModel() {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("expected bundled test model");
	return model;
}

function createAgent(): Agent {
	const model = testModel();
	const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
	return new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["test"], tools: [] },
		streamFn: mock.stream,
	});
}

describe("runtime ownership in AgentSession disposal", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let agentRegistry: AgentRegistry;
	const sessions: AgentSession[] = [];

	beforeEach(async () => {
		resetRuntimeServiceForTests();
		tempDir = TempDir.createSync("@aura-runtime-session-lifecycle-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		agentRegistry = new AgentRegistry();
	});

	afterEach(async () => {
		vi.useRealTimers();
		for (const session of sessions.splice(0)) await session.dispose();
		await disposeCachedRuntimeService().catch(() => undefined);
		resetRuntimeServiceForTests();
		authStorage.close();
		AsyncJobManager.resetForTests();
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	function createSession(
		agentKind: "main" | "sub",
		disposeRuntimeService?: () => Promise<void>,
		ownedAsyncJobManager?: AsyncJobManager,
	): AgentSession {
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			runtimeServiceScope: {
				readSettings: () => ({
					enabled: false,
					autoDownload: false,
					path: "",
					version: "",
					adapter: "process",
					embeddedPath: "",
				}),
			},
			modelRegistry,
			agentKind,
			disposeRuntimeService,
			ownedAsyncJobManager,
			asyncJobManager: ownedAsyncJobManager,
			agentId: agentKind === "main" ? "Main" : "Sub",
		});
		sessions.push(session);
		return session;
	}

	async function createTopLevelSdkSession(
		agentId?: string,
		settings: Settings = Settings.isolated({
			"compaction.enabled": false,
			"runtime.enabled": false,
		}),
		runtimeServiceScope?: RuntimeServiceScope,
	): Promise<AgentSession> {
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry,
			model: testModel(),
			settings,
			runtimeServiceScope,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			agentRegistry,
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			restrictToolNames: true,
			toolNames: [],
			...(agentId === undefined ? {} : { agentId }),
		});
		sessions.push(session);
		return session;
	}

	function requireRuntimeScope(session: AgentSession): RuntimeServiceScope {
		if (!session.runtimeServiceScope) throw new Error("expected SDK runtime scope");
		return session.runtimeServiceScope;
	}

	function runtimeSettings(): Settings {
		return Settings.isolated({
			"compaction.enabled": false,
			"runtime.enabled": true,
			"runtime.adapter": "process",
			"runtime.path": path.join(tempDir.path(), "missing-runtime"),
			"runtime.autoDownload": false,
		});
	}

	function scopedRuntime(scope: RuntimeServiceScope) {
		const options = resolveRuntimeEndpointOptions(scope.readSettings());
		if (!options) throw new Error("expected enabled root runtime settings");
		return getOrCreateRuntimeService(options, undefined, scope);
	}

	async function createDescendantSdkSession(
		agentId: string,
		parentAgentId: string,
		taskDepth: number,
		settings: Settings,
		runtimeServiceScope: RuntimeServiceScope,
	): Promise<AgentSession> {
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry,
			model: testModel(),
			settings,
			runtimeServiceScope,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			agentRegistry,
			parentTaskPrefix: agentId,
			parentAgentId,
			agentId,
			taskDepth,
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			restrictToolNames: true,
			toolNames: [],
		});
		sessions.push(session);
		return session;
	}

	test("the main session runs runtime cleanup once inside parallel teardown", async () => {
		const cleanupStarted = Promise.withResolvers<void>();
		const cleanupGate = Promise.withResolvers<void>();
		let cleanupCount = 0;
		const session = createSession("main", async () => {
			cleanupCount += 1;
			cleanupStarted.resolve();
			await cleanupGate.promise;
		});
		let persistenceClosed = false;
		vi.spyOn(session.sessionManager, "close").mockImplementation(async () => {
			persistenceClosed = true;
		});

		const first = session.dispose();
		const second = session.dispose();
		try {
			expect(second).toBe(first);
			const cleanupParticipated = await Promise.race([
				cleanupStarted.promise.then(() => true),
				first.then(() => false),
			]);
			expect(cleanupParticipated).toBe(true);
			expect(cleanupCount).toBe(1);
			expect(persistenceClosed).toBe(false);
		} finally {
			cleanupGate.resolve();
		}
		await first;
		expect(persistenceClosed).toBe(true);
		expect(cleanupCount).toBe(1);
	});

	test("root disposal drains an active child runtime job before closing the shared endpoint", async () => {
		const manager = new AsyncJobManager({ maxRunningJobs: 1 });
		const runStarted = Promise.withResolvers<void>();
		const runAborted = Promise.withResolvers<void>();
		const guestSettled = Promise.withResolvers<void>();
		let active = false;
		let jobSettled = false;
		let prematureClose = false;
		let closeCount = 0;
		const endpoint: RuntimeEndpoint = {
			async request(request, signal) {
				if (!signal) throw new Error("expected child job signal");
				active = true;
				runStarted.resolve();
				await new Promise<void>(resolve => {
					signal.addEventListener(
						"abort",
						() => {
							runAborted.resolve();
							void guestSettled.promise.then(resolve);
						},
						{ once: true },
					);
				});
				active = false;
				return errorResponse(request.id, new RuntimeRpcError("cancelled", "cancelled"));
			},
			async close() {
				closeCount += 1;
				if (active) prematureClose = true;
			},
		};
		const runtime = new RuntimeService(endpoint);
		const session = createSession("main", () => runtime.close(), manager);
		const jobId = manager.register(
			"task",
			"child embedded run",
			async ({ signal }) => {
				try {
					await runtime.run({ code: "await guest()", language: "js" }, signal);
					return "completed";
				} finally {
					jobSettled = true;
				}
			},
			{ ownerId: "Child" },
		);
		await runStarted.promise;

		const disposal = session.dispose();
		await runAborted.promise;
		expect(jobSettled).toBe(false);
		expect(closeCount).toBe(0);
		guestSettled.resolve();
		await disposal;
		expect(jobSettled).toBe(true);
		expect(closeCount).toBe(1);
		expect(prematureClose).toBe(false);
		expect(manager.getJob(jobId)).toBeUndefined();
		await expect(runtime.status()).rejects.toMatchObject({ message: "Runtime service is closed." });
	});

	test("disposing an agent-dashboard-style top-level auxiliary session leaves the shared main runtime open", async () => {
		const settings = runtimeSettings();
		const main = await createTopLevelSdkSession(MAIN_AGENT_ID, settings);
		const scope = requireRuntimeScope(main);
		const sharedRuntime = scopedRuntime(scope);
		const auxiliary = await createTopLevelSdkSession(undefined, settings, scope);
		expect(auxiliary.getAgentId()).not.toBe(MAIN_AGENT_ID);

		await auxiliary.dispose();
		expect(await sharedRuntime.status()).toMatchObject({ available: false });

		await main.dispose();
		await expect(sharedRuntime.status()).rejects.toMatchObject({
			code: "internal",
			message: "Runtime service is closed.",
		});
	});

	test("an explicitly identified Main SDK session releases its root runtime lease", async () => {
		const main = await createTopLevelSdkSession(MAIN_AGENT_ID, runtimeSettings());
		const sharedRuntime = scopedRuntime(requireRuntimeScope(main));

		await main.dispose();

		await expect(sharedRuntime.status()).rejects.toMatchObject({
			code: "internal",
			message: "Runtime service is closed.",
		});
	});

	test("two ACP-like top-level sessions sharing an explicit root scope close runtime on last release", async () => {
		const settings = runtimeSettings();
		const first = await createTopLevelSdkSession(undefined, settings);
		const scope = requireRuntimeScope(first);
		const runtime = scopedRuntime(scope);
		const second = await createTopLevelSdkSession(undefined, settings, scope);

		await first.dispose();
		expect(await runtime.status()).toMatchObject({ protocolVersion: 2 });
		await second.dispose();
		await expect(runtime.status()).rejects.toMatchObject({ message: "Runtime service is closed." });
	});

	test("top-level sessions with distinct root scopes never retire each other's runtime", async () => {
		const first = await createTopLevelSdkSession(undefined, runtimeSettings());
		const second = await createTopLevelSdkSession(undefined, runtimeSettings());
		const firstRuntime = scopedRuntime(requireRuntimeScope(first));
		const secondRuntime = scopedRuntime(requireRuntimeScope(second));

		await first.dispose();
		await expect(firstRuntime.status()).rejects.toMatchObject({ message: "Runtime service is closed." });
		expect(await secondRuntime.status()).toMatchObject({ protocolVersion: 2 });
		await second.dispose();
		await expect(secondRuntime.status()).rejects.toMatchObject({ message: "Runtime service is closed." });
	});

	test("subagent settings overlays and nested descendants reuse the root runtime without owning it", async () => {
		const rootSettings = runtimeSettings();
		const root = await createTopLevelSdkSession(MAIN_AGENT_ID, rootSettings);
		const scope = requireRuntimeScope(root);
		const rootRuntime = scopedRuntime(scope);
		const subagentSettings = Settings.isolated({
			"compaction.enabled": false,
			"runtime.enabled": true,
			"runtime.adapter": "embedded",
			"runtime.embeddedPath": "/overlay/should-not-replace.so",
		});
		const subagent = await createDescendantSdkSession("Sub", MAIN_AGENT_ID, 1, subagentSettings, scope);
		const nestedSettings = Settings.isolated({
			"compaction.enabled": false,
			"runtime.enabled": false,
		});
		const nested = await createDescendantSdkSession(
			"Sub.Nested",
			"Sub",
			2,
			nestedSettings,
			requireRuntimeScope(subagent),
		);

		expect(subagent.runtimeServiceScope).toBe(scope);
		expect(nested.runtimeServiceScope).toBe(scope);
		expect(scopedRuntime(requireRuntimeScope(subagent))).toBe(rootRuntime);
		subagentSettings.set("runtime.adapter", "auto");
		subagentSettings.set("runtime.path", "/overlay/mutated-runtime");
		expect(scopedRuntime(requireRuntimeScope(nested))).toBe(rootRuntime);

		await nested.dispose();
		await subagent.dispose();
		expect(await rootRuntime.status()).toMatchObject({ protocolVersion: 2 });
		await root.dispose();
		await expect(rootRuntime.status()).rejects.toMatchObject({ message: "Runtime service is closed." });
	});

	test("commit-agent parallel sonic children share one root-owned runtime scope", async () => {
		const runtimeServiceScope: RuntimeServiceScope = {
			readSettings: () => ({
				enabled: true,
				autoDownload: false,
				path: path.join(tempDir.path(), "missing-runtime"),
				version: "",
				adapter: "process",
				embeddedPath: "",
			}),
		};
		const root = await createTopLevelSdkSession(MAIN_AGENT_ID, runtimeSettings(), runtimeServiceScope);
		const runtime = scopedRuntime(runtimeServiceScope);
		const children: AgentSession[] = [];
		let observedSession: ToolSession | undefined;
		vi.spyOn(TaskTool, "create").mockImplementation(async session => {
			observedSession = session;
			const childScope = session.runtimeServiceScope;
			if (!childScope) throw new Error("expected commit tool runtime scope");
			return {
				execute: async (toolCallId: string) => {
					const child = await createDescendantSdkSession(
						`Commit.${toolCallId}`,
						MAIN_AGENT_ID,
						1,
						Settings.isolated({ "compaction.enabled": false, "runtime.enabled": false }),
						childScope,
					);
					children.push(child);
					return {
						content: [{ type: "text", text: "ok" }],
						details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
					};
				},
			} as unknown as TaskTool;
		});
		const analyze = createAnalyzeFileTool({
			cwd: tempDir.path(),
			authStorage,
			modelRegistry,
			settings: runtimeSettings(),
			spawns: "*",
			state: { overview: { numstat: [] } } as unknown as CommitAgentState,
			runtimeServiceScope,
		});
		const context = {
			sessionManager: { getSessionFile: () => undefined },
		} as unknown as CustomToolContext;

		await analyze.execute("analyze", { files: ["src/one.ts", "src/two.ts"] }, undefined, context);
		expect(root.runtimeServiceScope).toBe(runtimeServiceScope);
		expect(observedSession?.runtimeServiceScope).toBe(runtimeServiceScope);
		expect(children).toHaveLength(2);
		for (const child of children) {
			expect(child.runtimeServiceScope).toBe(runtimeServiceScope);
			expect(scopedRuntime(requireRuntimeScope(child))).toBe(runtime);
		}
		await Promise.all(children.map(child => child.dispose()));
		expect(await runtime.status()).toMatchObject({ protocolVersion: 2 });
		await root.dispose();
		await expect(runtime.status()).rejects.toMatchObject({ message: "Runtime service is closed." });
	});

	test("a subagent never invokes runtime cleanup even if a callback is supplied", async () => {
		let cleanupCount = 0;
		const session = createSession("sub", async () => {
			cleanupCount += 1;
		});
		await session.dispose();
		expect(cleanupCount).toBe(0);
	});

	test("runtime cleanup is bounded so a stuck endpoint cannot strand session disposal", async () => {
		vi.useFakeTimers();
		const cleanupStarted = Promise.withResolvers<void>();
		const neverSettles = Promise.withResolvers<void>();
		const session = createSession("main", async () => {
			cleanupStarted.resolve();
			await neverSettles.promise;
		});
		let settled = false;
		const disposal = session.dispose().finally(() => {
			settled = true;
		});
		const cleanupParticipated = await Promise.race([
			cleanupStarted.promise.then(() => true),
			disposal.then(() => false),
		]);
		expect(cleanupParticipated).toBe(true);
		expect(settled).toBe(false);
		vi.advanceTimersByTime(2_999);
		await Promise.resolve();
		expect(settled).toBe(false);
		vi.advanceTimersByTime(1);
		await disposal;
		expect(settled).toBe(true);
	});
	test("startup cleanup continues after a rejecting runtime close and keeps failures contained", async () => {
		const events: string[] = [];
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		await runStartupFailureCleanupSteps([
			{
				label: "runtime",
				cleanup: async () => {
					events.push("runtime");
					throw new Error("runtime close failed");
				},
			},
			{
				label: "manager",
				cleanup: async () => {
					events.push("manager");
				},
			},
			{
				label: "auth",
				cleanup: () => {
					events.push("auth");
				},
			},
		]);
		expect(events).toEqual(["runtime", "manager", "auth"]);
		expect(warn).toHaveBeenCalledWith(
			"Failed to clean up createAgentSession resource after startup error",
			expect.objectContaining({ resource: "runtime", error: "runtime close failed" }),
		);
	});
});
