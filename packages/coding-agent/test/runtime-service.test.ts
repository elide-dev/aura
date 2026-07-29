import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { okResponse, type RuntimeRpcRequest, type RuntimeRpcResponse } from "../src/runtime/protocol";
import { type RuntimeEndpoint, RuntimeService } from "../src/runtime/service";

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
