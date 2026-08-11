import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as pythonExecutor from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import * as bashExecutor from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession user shortcut hooks", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-user-shortcut-hooks-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
		}
		await pythonExecutor.disposeAllKernelSessions();
		authStorage?.close();
		authStorage = undefined;
		tempDir.removeSync();
	});

	function createSession(extensionRunner?: ExtensionRunner): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			extensionRunner,
		});
		return session;
	}

	it("invokes user_bash hook and honors replacement result", async () => {
		const replacement = {
			output: "hooked bash output",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 18,
			outputLines: 1,
			outputBytes: 18,
		};
		const emitUserBash = vi.fn().mockResolvedValue({ result: replacement });
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "user_bash"),
			emitUserBash,
		} as unknown as ExtensionRunner;
		const executeBashSpy = vi.spyOn(bashExecutor, "executeBash");

		createSession(extensionRunner);
		const result = await session.executeBash("echo hello", undefined, { excludeFromContext: true });

		expect(emitUserBash).toHaveBeenCalledWith({
			type: "user_bash",
			command: "echo hello",
			excludeFromContext: true,
			cwd: expect.any(String),
		});
		expect(executeBashSpy).not.toHaveBeenCalled();
		expect(result).toEqual(replacement);
		const bashMessage = session.messages.at(-1);
		expect(bashMessage?.role).toBe("bashExecution");
		expect(bashMessage).toMatchObject({
			output: "hooked bash output",
			excludeFromContext: true,
		});
	});

	it("invokes user_python hook and honors replacement result", async () => {
		const replacement = {
			output: "hooked python output",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 20,
			outputLines: 1,
			outputBytes: 20,
			displayOutputs: [],
			stdinRequested: false,
		};
		const emitUserPython = vi.fn().mockResolvedValue({ result: replacement });
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "user_python"),
			emitUserPython,
		} as unknown as ExtensionRunner;
		const executePythonSpy = vi.spyOn(pythonExecutor, "executePython");

		createSession(extensionRunner);
		const result = await session.executePython("print('hi')", undefined, { excludeFromContext: true });

		expect(emitUserPython).toHaveBeenCalledWith({
			type: "user_python",
			code: "print('hi')",
			excludeFromContext: true,
			cwd: expect.any(String),
		});
		expect(executePythonSpy).not.toHaveBeenCalled();
		expect(result).toEqual(replacement);
		const pythonMessage = session.messages.at(-1);
		expect(pythonMessage?.role).toBe("pythonExecution");
		expect(pythonMessage).toMatchObject({
			output: "hooked python output",
			excludeFromContext: true,
		});
	});

	it("routes the local Python shell action through the run tool", async () => {
		const executePythonSpy = vi.spyOn(pythonExecutor, "executePython");
		createSession();
		const execute = vi.fn().mockResolvedValue({
			content: [{ type: "text", text: "embedded output" }],
			details: { exitCode: 0, stdout: "embedded output\n", stderr: "", durationMs: 2, killed: false },
			isError: false,
		});
		vi.spyOn(session, "getToolByName").mockReturnValue({ execute } as never);
		const chunks: string[] = [];

		const result = await session.executePythonShell("print('embedded')", chunk => chunks.push(chunk), {
			excludeFromContext: true,
		});

		expect(executePythonSpy).not.toHaveBeenCalled();
		expect(execute).toHaveBeenCalledWith(
			expect.any(String),
			{ code: "print('embedded')", language: "python", cwd: expect.any(String) },
			expect.any(AbortSignal),
		);
		expect(result).toMatchObject({ output: "embedded output", exitCode: 0, cancelled: false });
		expect(chunks).toEqual(["embedded output"]);
		expect(session.messages.at(-1)).toMatchObject({
			role: "pythonExecution",
			output: "embedded output",
			excludeFromContext: true,
		});
	});

	// A runtime RPC failure no longer throws out of the run tool: it settles as a
	// failed result whose details are the redacted projection (runtime/format.ts).
	// This caller reads details rather than text, so both branches of that shape
	// are pinned here.
	it("reports a cancelled runtime call from the local Python shell as a cancelled result", async () => {
		createSession();
		const execute = vi.fn().mockResolvedValue({
			content: [{ type: "text", text: "The runtime call failed (cancelled): Runtime execution was cancelled." }],
			details: { code: "cancelled", message: "Runtime execution was cancelled." },
			isError: true,
		});
		vi.spyOn(session, "getToolByName").mockReturnValue({ execute } as never);

		const result = await session.executePythonShell("print('embedded')");

		expect(result).toMatchObject({
			output: "",
			exitCode: undefined,
			cancelled: true,
			truncated: false,
			totalLines: 0,
			totalBytes: 0,
			stdinRequested: false,
		});
	});

	it("rethrows a failed runtime call from the local Python shell, carrying the rendered diagnostic", async () => {
		createSession();
		const execute = vi.fn().mockResolvedValue({
			content: [
				{
					type: "text",
					text: "The runtime call failed (internal): Embedded runtime execution worker failed.\n--- stderr ---\nworker exited with signal SIGSEGV",
				},
			],
			details: { code: "internal", message: "Embedded runtime execution worker failed." },
			isError: true,
		});
		vi.spyOn(session, "getToolByName").mockReturnValue({ execute } as never);

		// The detail the throw used to destroy is exactly what the message now carries.
		await expect(session.executePythonShell("print('embedded')")).rejects.toThrow(
			/Embedded runtime execution worker failed[\s\S]*SIGSEGV/,
		);
	});

	it("falls back to normal execution when hook does not return a replacement", async () => {
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "user_bash" || eventType === "user_python"),
			emitUserBash: vi.fn().mockResolvedValue({}),
			emitUserPython: vi.fn().mockResolvedValue(undefined),
		} as unknown as ExtensionRunner;
		vi.spyOn(bashExecutor, "executeBash").mockResolvedValue({
			output: "bash fallback",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 13,
			outputLines: 1,
			outputBytes: 13,
		});
		vi.spyOn(pythonExecutor, "executePython").mockResolvedValue({
			output: "python fallback",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 15,
			outputLines: 1,
			outputBytes: 15,
			displayOutputs: [],
			stdinRequested: false,
		});

		createSession(extensionRunner);
		const bashResult = await session.executeBash("pwd", undefined, { excludeFromContext: true });
		const pythonResult = await session.executePython("1+1", undefined, { excludeFromContext: false });

		expect(bashResult.output).toBe("bash fallback");
		expect(pythonResult.output).toBe("python fallback");
		expect(bashExecutor.executeBash).toHaveBeenCalledTimes(1);
		expect(pythonExecutor.executePython).toHaveBeenCalledTimes(1);
		expect(
			session.messages.some(message => message.role === "bashExecution" && message.excludeFromContext === true),
		).toBe(true);
		expect(
			session.messages.some(message => message.role === "pythonExecution" && message.excludeFromContext === false),
		).toBe(true);
	});

	it("shares Python state between eval and user shortcut execution", async () => {
		createSession();
		const evalSessionId = session.getEvalSessionId();
		if (!evalSessionId) throw new Error("Expected eval session ID");

		await pythonExecutor.executePython("shared_value = 123", {
			cwd: tempDir.path(),
			sessionId: `python:${evalSessionId}`,
			kernelMode: "session",
		});

		const result = await session.executePython("print(shared_value)");

		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("123");
	});
});
