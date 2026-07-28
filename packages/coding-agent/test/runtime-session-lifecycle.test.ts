import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "../src/async";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { runStartupFailureCleanupSteps } from "../src/sdk";

function createAgent(): Agent {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("expected bundled test model");
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
	const sessions: AgentSession[] = [];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@aura-runtime-session-lifecycle-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(async () => {
		vi.useRealTimers();
		for (const session of sessions.splice(0)) await session.dispose();
		authStorage.close();
		AsyncJobManager.resetForTests();
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	function createSession(
		agentKind: "main" | "sub",
		disposeRuntimeService?: () => Promise<void>,
	): AgentSession {
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			agentKind,
			disposeRuntimeService,
			agentId: agentKind === "main" ? "Main" : "Sub",
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
