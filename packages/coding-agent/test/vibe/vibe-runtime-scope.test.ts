/**
 * Contract: a background vibe worker spawn inherits the originating top-level
 * session's root runtime scope by identity.
 *
 * The root session owns the runtime service cache and its lease. A vibe worker
 * runs detached from the turn that spawned it, so if it were handed anything
 * other than the *same* scope object it would open a competing cache — and,
 * worse, could dispose one the root still holds. Pinning identity (`toBe`) is
 * the whole point here: a structurally-equal copy is exactly the bug.
 *
 * Fork-owned. Upstream deleted its `test/vibe/vibe-runtime.test.ts` suite (which
 * this contract used to live in) while still maintaining `src/vibe/runtime.ts`,
 * so the contract is pinned here instead, in a file with no upstream counterpart
 * to conflict with.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import type { RuntimeServiceScope } from "../../src/runtime";

function createSession(options: { manager?: AsyncJobManager; runtimeServiceScope?: RuntimeServiceScope }): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionFile: () => null,
		getSessionId: () => "vibe-test-parent",
		getAgentId: () => "Main",
		getArtifactsDir: () => null,
		getSessionSpawns: () => "*",
		sessionManager: undefined,
		runtimeServiceScope: options.runtimeServiceScope,
		asyncJobManager: options.manager,
	} as unknown as ToolSession;
}

function makeResult(id: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "prompt",
		exitCode: 0,
		output: "All done.",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
		...overrides,
	} as SingleResult;
}

/** Minimal stand-in for a live worker session; the registry only needs it addressable. */
function createFakeWorkerSession(): AgentSession {
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
	} as unknown as AgentSession;
}

describe("vibe worker runtime scope", () => {
	const managers: AsyncJobManager[] = [];

	function createManager(): AsyncJobManager {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		return manager;
	}

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		VibeSessionRegistry.resetGlobalForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) {
			await manager.dispose({ timeoutMs: 1000 });
		}
		VibeSessionRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("passes the exact root runtime scope into a vibe worker spawn", async () => {
		const runtimeServiceScope: RuntimeServiceScope = {
			readSettings: () => ({
				enabled: true,
				autoDownload: false,
				path: "/root/runtime",
				version: "",
				adapter: "process",
				embeddedPath: "",
			}),
		};
		let observedScope: RuntimeServiceScope | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			observedScope = options.runtimeServiceScope;
			AgentRegistry.global().register({
				id: options.id,
				displayName: options.id,
				kind: "sub",
				parentId: "Main",
				session: createFakeWorkerSession(),
				status: "idle",
			});
			return makeResult(options.id, { output: "scope inherited" });
		});
		const manager = createManager();
		const session = createSession({ manager, runtimeServiceScope });

		const { jobId } = await VibeSessionRegistry.global().spawn(session, {
			cli: "fast",
			name: "Scoped",
			prompt: "Use the root runtime.",
		});
		await manager.getJob(jobId)?.promise;

		// Identity, not equality: a copied scope would mean a competing cache.
		expect(observedScope).toBe(runtimeServiceScope);
	});
});
