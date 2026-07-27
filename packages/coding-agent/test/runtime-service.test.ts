import { describe, expect, test } from "bun:test";
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
		await svc.status();
		expect(ep.requests.map(r => r.method)).toEqual([
			"runtime/run",
			"runtime/check",
			"runtime/build",
			"runtime/insights",
			"runtime/profile",
			"runtime/spawn",
			"runtime/status",
		]);
	});

	test("returns unwrapped results", async () => {
		const svc = new RuntimeService(new RecordingEndpoint());
		const r = await svc.run({ code: "1" });
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toBe("ok");
	});
});
