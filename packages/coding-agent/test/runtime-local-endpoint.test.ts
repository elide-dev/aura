import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RuntimeExecResult, RuntimeStatusResult } from "../src/runtime/protocol";
import { createRequest, RuntimeRpcError, unwrapResponse } from "../src/runtime/protocol";
import { LocalRuntimeEndpoint } from "../src/runtime/transport/local";

let dir: string;
let fakeBin: string;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "aura-ep-"));
	fakeBin = path.join(dir, "elide");
	// Fake runtime: prints its argv so tests can assert the mapping; `--version` prints a version.
	await fs.writeFile(
		fakeBin,
		`#!/bin/sh\nif [ "$1" = "--version" ]; then echo "9.9.9-fake"; exit 0; fi\necho "ARGS:$@"\n`,
		{ mode: 0o755 },
	);
});

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

describe("LocalRuntimeEndpoint", () => {
	test("run maps to the pinned argv shape and writes inline code to a temp file", async () => {
		const ep = new LocalRuntimeEndpoint({ explicitPath: fakeBin, autoDownload: false });
		const res = await ep.request(
			createRequest("runtime/run", { code: "print(1)", language: "python", args: ["a", "b"] }),
		);
		const out = unwrapResponse<RuntimeExecResult>(res);
		expect(out.exitCode).toBe(0);
		expect(out.stdout).toContain("run --error-format=plain --no-color -l python ");
		expect(out.stdout).toContain("guest.py");
		expect(out.stdout).toContain("-- a b");
	});

	test("check maps to a validation build", async () => {
		const ep = new LocalRuntimeEndpoint({ explicitPath: fakeBin, autoDownload: false });
		const out = unwrapResponse<RuntimeExecResult>(await ep.request(createRequest("runtime/check", {})));
		expect(out.stdout.trim()).toBe("ARGS:build --no-color");
	});

	test("build passes targets through", async () => {
		const ep = new LocalRuntimeEndpoint({ explicitPath: fakeBin, autoDownload: false });
		const out = unwrapResponse<RuntimeExecResult>(
			await ep.request(createRequest("runtime/build", { targets: [":deps", "--fresh"] })),
		);
		expect(out.stdout.trim()).toBe("ARGS:build --no-color :deps --fresh");
	});

	test("status reports version without provisioning", async () => {
		const ep = new LocalRuntimeEndpoint({ explicitPath: fakeBin, autoDownload: false });
		const out = unwrapResponse<RuntimeStatusResult>(await ep.request(createRequest("runtime/status", undefined)));
		expect(out.available).toBe(true);
		expect(out.version).toBe("9.9.9-fake");
		expect(out.source).toBe("flag");
	});

	test("missing runtime yields runtime-missing guidance (status) and error (run)", async () => {
		const ep = new LocalRuntimeEndpoint({ explicitPath: path.join(dir, "nope"), autoDownload: false });
		const status = unwrapResponse<RuntimeStatusResult>(await ep.request(createRequest("runtime/status", undefined)));
		expect(status.available).toBe(false);
		expect(status.guidance).toBeDefined();
		const runRes = await ep.request(createRequest("runtime/run", { code: "1" }));
		expect(() => unwrapResponse(runRes)).toThrow(RuntimeRpcError);
	});

	test("run without code or path is invalid-params", async () => {
		const ep = new LocalRuntimeEndpoint({ explicitPath: fakeBin, autoDownload: false });
		const res = await ep.request(createRequest("runtime/run", {}));
		try {
			unwrapResponse(res);
			throw new Error("expected error");
		} catch (e) {
			expect((e as RuntimeRpcError).code).toBe("invalid-params");
		}
	});

	test("insights places --insights before -l and materializes inline insight", async () => {
		const ep = new LocalRuntimeEndpoint({ explicitPath: fakeBin, autoDownload: false });
		const out = unwrapResponse<RuntimeExecResult>(
			await ep.request(
				createRequest("runtime/insights", { code: "1", language: "js", insight: "export default {}" }),
			),
		);
		const insightsAt = out.stdout.indexOf("--insights=");
		const langAt = out.stdout.indexOf(" -l ");
		expect(insightsAt).toBeGreaterThan(-1);
		expect(langAt).toBeGreaterThan(-1);
		expect(insightsAt).toBeLessThan(langAt);
		expect(out.stdout.slice(insightsAt, langAt)).toContain("insight.js");
	});

	test("profile places --profiler before -l", async () => {
		const ep = new LocalRuntimeEndpoint({ explicitPath: fakeBin, autoDownload: false });
		const out = unwrapResponse<RuntimeExecResult>(
			await ep.request(createRequest("runtime/profile", { code: "1", language: "js", mode: "cpusampling" })),
		);
		const profilerAt = out.stdout.indexOf("--profiler=cpusampling");
		const langAt = out.stdout.indexOf(" -l ");
		expect(profilerAt).toBeGreaterThan(-1);
		expect(langAt).toBeGreaterThan(-1);
		expect(profilerAt).toBeLessThan(langAt);
	});

	test("version parsing strips a name prefix from --version output", async () => {
		const prefixedBin = path.join(dir, "prefixed");
		await fs.writeFile(
			prefixedBin,
			`#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Elide 9.9.9-fake (build abc)"; exit 0; fi\necho "ARGS:$@"\n`,
			{ mode: 0o755 },
		);
		const ep = new LocalRuntimeEndpoint({ explicitPath: prefixedBin, autoDownload: false });
		const out = unwrapResponse<RuntimeStatusResult>(await ep.request(createRequest("runtime/status", undefined)));
		expect(out.version).toBe("9.9.9-fake");
		expect(out.version).not.toContain("Elide");
	});

	test("timeout kills the process and reports killed", async () => {
		const slowBin = path.join(dir, "slow");
		await fs.writeFile(slowBin, `#!/bin/sh\nsleep 5\n`, { mode: 0o755 });
		const ep = new LocalRuntimeEndpoint({ explicitPath: slowBin, autoDownload: false });
		const out = unwrapResponse<RuntimeExecResult>(
			await ep.request(createRequest("runtime/run", { code: "1", timeoutMs: 200 })),
		);
		expect(out.killed).toBe(true);
	}, 10_000);
});
