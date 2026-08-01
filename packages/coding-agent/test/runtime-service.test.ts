import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Span, trace } from "@opentelemetry/api";
import { okResponse, type RuntimeRpcRequest, type RuntimeRpcResponse } from "../src/runtime/protocol";
import { type RuntimeEndpoint, RuntimeService } from "../src/runtime/service";
import { subscribeTelemetry, type TelemetryEvent } from "../src/telemetry/events";

class RecordingEndpoint implements RuntimeEndpoint {
	requests: RuntimeRpcRequest[] = [];
	async request(req: RuntimeRpcRequest): Promise<RuntimeRpcResponse> {
		this.requests.push(req);
		if (req.method === "runtime/status") {
			return okResponse(req.id, { available: true, protocolVersion: 1 });
		}
		return okResponse(req.id, { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1, killed: false });
	}
}

class ClosingEndpoint extends RecordingEndpoint {
	closeCount = 0;
	readonly closeGate = Promise.withResolvers<void>();

	close(): Promise<void> {
		this.closeCount += 1;
		return this.closeGate.promise;
	}
}

describe("RuntimeService", () => {
	test("maps each capability to its protocol method", async () => {
		const ep = new RecordingEndpoint();
		const svc = new RuntimeService(ep);
		await svc.run({ code: "console.log(1)" });
		await svc.check({});
		await svc.build({ targets: [":compile"] });
		await svc.insights({ code: "x", insight: "y" });
		await svc.profile({ code: "x", mode: "cpusampling" });
		await svc.spawn({ mode: "serve", directory: "public" });
		await svc.advice({});
		await svc.status();
		expect(ep.requests.map(r => r.method)).toEqual([
			"runtime/run",
			"runtime/check",
			"runtime/build",
			"runtime/insights",
			"runtime/profile",
			"runtime/spawn",
			"runtime/advice",
			"runtime/status",
		]);
	});

	test("returns unwrapped results", async () => {
		const svc = new RuntimeService(new RecordingEndpoint());
		const r = await svc.run({ code: "1" });
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toBe("ok");
	});

	test("publishes bounded runtime facts and annotates the active tool span", async () => {
		const events: TelemetryEvent[] = [];
		const attributes: Record<string, string | number | boolean> = {};
		const activeSpan = {
			setAttribute(key: string, value: string | number | boolean) {
				attributes[key] = value;
				return this;
			},
		} as unknown as Span;
		const spanSpy = spyOn(trace, "getActiveSpan").mockReturnValue(activeSpan);
		const unsubscribe = subscribeTelemetry(event => events.push(event));
		try {
			const result = await new RuntimeService(new RecordingEndpoint()).run(
				{
					code: "console.log(1)",
					language: "ts",
				},
				undefined,
				"session-a",
			);
			expect(result.exitCode).toBe(0);
		} finally {
			unsubscribe();
			spanSpy.mockRestore();
		}

		const event = events.find(candidate => candidate.type === "runtime.call.completed");
		expect(event).toMatchObject({
			type: "runtime.call.completed",
			sessionId: "session-a",
			method: "runtime/run",
			language: "ts",
			outcome: "ok",
			exitCode: 0,
			killed: false,
		});
		expect(event).not.toHaveProperty("stdout");
		expect(event).not.toHaveProperty("stderr");
		expect(event).not.toHaveProperty("params");
		expect(attributes).toMatchObject({
			"aura.runtime.method": "runtime/run",
			"aura.runtime.language": "ts",
			"aura.runtime.outcome": "ok",
			"aura.runtime.exit_code": 0,
			"aura.runtime.killed": false,
		});
		expect(attributes["aura.runtime.duration_ms"]).toBeNumber();
	});

	test("classifies runtime protocol failures once without changing the thrown error", async () => {
		const events: TelemetryEvent[] = [];
		const unsubscribe = subscribeTelemetry(event => events.push(event));
		const service = new RuntimeService({
			async request(req) {
				return {
					jsonrpc: "2.0",
					id: req.id,
					error: { code: "timeout", message: "guest timed out" },
				};
			},
		});
		try {
			await expect(service.run({ code: "while(true){}", language: "js" })).rejects.toMatchObject({
				name: "RuntimeRpcError",
				code: "timeout",
			});
		} finally {
			unsubscribe();
		}

		const runtimeEvents = events.filter(candidate => candidate.type === "runtime.call.completed");
		expect(runtimeEvents).toHaveLength(1);
		expect(runtimeEvents[0]).toMatchObject({
			method: "runtime/run",
			language: "js",
			outcome: "timeout",
			errorType: "timeout",
		});
		expect(runtimeEvents[0]).not.toHaveProperty("message");
	});

	test("classifies non-zero, killed, cancelled, and unexpected failures exactly once without mutation", async () => {
		const controller = new AbortController();
		controller.abort();
		const unexpected = new Error("endpoint exploded");
		const cases = [
			{
				name: "non-zero",
				response: { exitCode: 2, stdout: "", stderr: "bad", durationMs: 1, killed: false },
				expected: { outcome: "error", exitCode: 2, killed: false, errorType: "non_zero_exit" },
			},
			{
				name: "killed",
				response: { exitCode: 137, stdout: "", stderr: "", durationMs: 1, killed: true },
				expected: { outcome: "timeout", exitCode: 137, killed: true, errorType: "killed" },
			},
			{
				name: "cancelled",
				error: new Error("cancelled"),
				signal: controller.signal,
				expected: { outcome: "cancelled", errorType: "cancelled" },
			},
			{
				name: "unexpected",
				error: unexpected,
				expected: { outcome: "error", errorType: "unknown" },
			},
		] as const;
		for (const testCase of cases) {
			const events: TelemetryEvent[] = [];
			const unsubscribe = subscribeTelemetry(event => events.push(event));
			const service = new RuntimeService({
				async request(req) {
					if ("error" in testCase) throw testCase.error;
					return okResponse(req.id, testCase.response);
				},
			});
			let result: unknown;
			let failure: unknown;
			try {
				result = await service.run(
					{ code: "process.exit(2)", language: "js" },
					"signal" in testCase ? testCase.signal : undefined,
					"session-a",
				);
			} catch (error) {
				failure = error;
			} finally {
				unsubscribe();
			}
			const runtimeEvents = events.filter(event => event.type === "runtime.call.completed");
			expect(runtimeEvents, testCase.name).toHaveLength(1);
			expect(runtimeEvents[0], testCase.name).toMatchObject({
				sessionId: "session-a",
				method: "runtime/run",
				language: "js",
				...testCase.expected,
			});
			if ("error" in testCase) expect(failure, testCase.name).toBe(testCase.error);
			else expect(result, testCase.name).toEqual(testCase.response);
		}
	});

	test("records JVM and spawn action and resolved language", async () => {
		const events: TelemetryEvent[] = [];
		const unsubscribe = subscribeTelemetry(event => events.push(event));
		const service = new RuntimeService(new RecordingEndpoint());
		try {
			await service.jvm({ action: "disassemble", language: "java", code: "class Main {}" });
			await service.spawn({ mode: "debug", path: "main.py", language: "python" });
		} finally {
			unsubscribe();
		}
		expect(events.filter(event => event.type === "runtime.call.completed")).toEqual([
			expect.objectContaining({ method: "runtime/jvm", action: "disassemble", language: "java" }),
			expect.objectContaining({ method: "runtime/spawn", action: "debug", language: "python" }),
		]);
	});

	test("telemetry sink and span failures preserve the runtime result", async () => {
		const events: TelemetryEvent[] = [];
		const failingUnsubscribe = subscribeTelemetry(() => {
			throw new Error("sink failed");
		});
		const collectingUnsubscribe = subscribeTelemetry(event => events.push(event));
		const spanSpy = spyOn(trace, "getActiveSpan").mockReturnValue({
			setAttribute() {
				throw new Error("span failed");
			},
		} as unknown as Span);
		try {
			const result = await new RuntimeService(new RecordingEndpoint()).run({ code: "1" }, undefined, "session-a");
			expect(result.exitCode).toBe(0);
		} finally {
			failingUnsubscribe();
			collectingUnsubscribe();
			spanSpy.mockRestore();
		}
		expect(events.filter(event => event.type === "runtime.call.completed")).toHaveLength(1);
	});

	test("close is idempotent and waits for endpoint settlement", async () => {
		const endpoint = new ClosingEndpoint();
		const service = new RuntimeService(endpoint);
		let settled = false;
		const first = service.close();
		void first.finally(() => {
			settled = true;
		});
		const second = service.close();
		expect(second).toBe(first);
		expect(endpoint.closeCount).toBe(1);
		await Promise.resolve();
		expect(settled).toBe(false);
		endpoint.closeGate.resolve();
		await first;
		expect(settled).toBe(true);
	});

	test("calls begun after close return an internal error without reaching the endpoint", async () => {
		const endpoint = new ClosingEndpoint();
		const service = new RuntimeService(endpoint);
		const close = service.close();
		let thrown: unknown;
		try {
			await service.run({ code: "1" });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toMatchObject({
			name: "RuntimeRpcError",
			code: "internal",
		});
		expect(endpoint.requests).toHaveLength(0);
		endpoint.closeGate.resolve();
		await close;
	});

	test("runtime status and doctor modules load when the native addon is unavailable", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aura-runtime-import-"));
		try {
			const preloadPath = path.join(directory, "forbid-native.ts");
			const entryPath = path.join(directory, "entry.ts");
			await fs.writeFile(
				preloadPath,
				[
					'import { plugin } from "bun";',
					"plugin({",
					'  name: "forbid-pi-natives",',
					"  setup(build) {",
					"    build.onResolve({ filter: /@oh-my-pi\\/pi-natives/ }, () => {",
					'      throw new Error("pi-natives must not load");',
					"    });",
					"  },",
					"});",
				].join("\n"),
			);
			await fs.writeFile(
				entryPath,
				[
					`import ${JSON.stringify(path.resolve(import.meta.dir, "../src/cli/runtime-cli.ts"))};`,
					`import ${JSON.stringify(path.resolve(import.meta.dir, "../src/cli/doctor-cli.ts"))};`,
				].join("\n"),
			);
			const child = Bun.spawn([process.execPath, "--preload", preloadPath, entryPath], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
			expect(exitCode, stderr).toBe(0);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
