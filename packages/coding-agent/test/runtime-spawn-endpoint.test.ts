import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RuntimeLaunchDescriptor } from "../src/runtime/protocol";
import { createRequest, RuntimeRpcError, unwrapResponse } from "../src/runtime/protocol";
import type { resolveRuntimeBinary } from "../src/runtime/resolve";
import { LocalRuntimeEndpoint } from "../src/runtime/transport/local";

let dir: string;
let fakeBin: string;
let guest: string;
let staticDir: string;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "aura-spawn-"));
	fakeBin = path.join(dir, "elide");
	// The descriptor flow never executes the binary — it only has to exist and be
	// resolvable — but the ARGS-echo shape is kept so the file is runnable if a
	// future test wants to.
	await fs.writeFile(fakeBin, `#!/bin/sh\necho "ARGS:$@"\n`, { mode: 0o755 });
	guest = path.join(dir, "app.ts");
	await fs.writeFile(guest, "console.log(1)\n");
	staticDir = path.join(dir, "public");
	await fs.mkdir(staticDir);
});

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

function endpoint(overrides: { explicitPath?: string; resolve?: typeof resolveRuntimeBinary } = {}) {
	return new LocalRuntimeEndpoint({ explicitPath: fakeBin, autoDownload: false, ...overrides });
}

async function descriptor(params: Record<string, unknown>): Promise<RuntimeLaunchDescriptor> {
	return unwrapResponse<RuntimeLaunchDescriptor>(await endpoint().request(createRequest("runtime/spawn", params)));
}

describe("runtime/spawn — debug descriptors", () => {
	test("composes the CDP argv and carries the ws:// recognition rule", async () => {
		const d = await descriptor({ mode: "debug", path: guest, cwd: dir });
		expect(d.argv).toEqual([
			fakeBin,
			"run",
			"--debugger=cdp",
			"--error-format=plain",
			"--no-color",
			"-l",
			"ts",
			guest,
		]);
		expect(d.cwd).toBe(dir);
		expect(d.env).toEqual({ NO_COLOR: "1" });
		expect(d.endpointPattern).toEqual([{ pattern: "ws://\\S+" }]);
		expect(d.source).toBe("flag");
		expect(d.shimWarning).toBeUndefined();
	});

	test("dap selects the debugger flag and the `listening on` rule", async () => {
		const d = await descriptor({ mode: "debug", path: guest, protocol: "dap", cwd: dir });
		expect(d.argv).toContain("--debugger=dap");
		expect(d.endpointPattern).toEqual([{ pattern: "listening on\\s+(\\S+)", group: 1 }]);
	});

	test("language is inferred from the extension and overridable", async () => {
		const py = path.join(dir, "app.py");
		await fs.writeFile(py, "print(1)\n");
		expect((await descriptor({ mode: "debug", path: py, cwd: dir })).argv).toContain("python");
		expect((await descriptor({ mode: "debug", path: py, language: "js", cwd: dir })).argv).toContain("js");
	});

	test("guest args go after `--`, and timeoutMs becomes the runtime's own timeout flag", async () => {
		const d = await descriptor({ mode: "debug", path: guest, args: ["a", "b"], timeoutMs: 2500, cwd: dir });
		expect(d.argv.join(" ")).toContain("--timeout 2500ms");
		expect(d.argv.slice(-3)).toEqual(["--", "a", "b"]);
	});

	test("a missing or absent path is invalid-params, not a launch", async () => {
		await expect(descriptor({ mode: "debug", cwd: dir })).rejects.toMatchObject({ code: "invalid-params" });
		await expect(descriptor({ mode: "debug", path: path.join(dir, "nope.ts"), cwd: dir })).rejects.toMatchObject({
			code: "invalid-params",
		});
	});

	test("a directory in place of the program file is refused", async () => {
		await expect(descriptor({ mode: "debug", path: staticDir, cwd: dir })).rejects.toMatchObject({
			code: "invalid-params",
		});
	});
});

describe("runtime/spawn — serve descriptors", () => {
	test("composes the serve argv with --no-tui and the static-files rule", async () => {
		const d = await descriptor({ mode: "serve", directory: "public", cwd: dir });
		expect(d.argv).toEqual([fakeBin, "serve", staticDir, "--no-tui"]);
		expect(d.endpointPattern).toEqual([
			{ pattern: "Serving static files on\\s+(\\S+)", group: 1, prefix: "http://" },
		]);
	});

	test("port and host are appended only when supplied", async () => {
		const d = await descriptor({ mode: "serve", directory: staticDir, port: 8123, host: "0.0.0.0", cwd: dir });
		expect(d.argv.slice(-4)).toEqual(["--port", "8123", "--host", "0.0.0.0"]);
	});

	test("a non-integer or out-of-range port is invalid-params", async () => {
		for (const port of [0, 70_000, 1.5]) {
			await expect(descriptor({ mode: "serve", directory: staticDir, port, cwd: dir })).rejects.toMatchObject({
				code: "invalid-params",
			});
		}
	});

	test("a missing directory, or a file in its place, is invalid-params", async () => {
		await expect(descriptor({ mode: "serve", cwd: dir })).rejects.toMatchObject({ code: "invalid-params" });
		await expect(descriptor({ mode: "serve", directory: "nope", cwd: dir })).rejects.toMatchObject({
			code: "invalid-params",
		});
		await expect(descriptor({ mode: "serve", directory: guest, cwd: dir })).rejects.toMatchObject({
			code: "invalid-params",
		});
	});
});

describe("runtime/spawn — resolution", () => {
	test("a missing runtime is a runtime-missing error, never a partial descriptor", async () => {
		const ep = new LocalRuntimeEndpoint({ explicitPath: path.join(dir, "gone"), autoDownload: false });
		const res = await ep.request(createRequest("runtime/spawn", { mode: "serve", directory: staticDir, cwd: dir }));
		expect(() => unwrapResponse(res)).toThrow(RuntimeRpcError);
		expect(() => unwrapResponse(res)).toThrow(/not installed/);
	});

	test("a PATH-resolved binary carries a shim warning; a managed one does not", async () => {
		const onPath = new LocalRuntimeEndpoint({
			autoDownload: false,
			resolve: async () => ({ binaryPath: fakeBin, source: "path" }),
		});
		const d = unwrapResponse<RuntimeLaunchDescriptor>(
			await onPath.request(createRequest("runtime/spawn", { mode: "serve", directory: staticDir, cwd: dir })),
		);
		expect(d.source).toBe("path");
		expect(d.shimWarning).toMatch(/PATH/);
		expect(d.shimWarning).not.toMatch(/elide/i);

		const managed = new LocalRuntimeEndpoint({
			autoDownload: false,
			resolve: async () => ({ binaryPath: fakeBin, source: "managed" }),
		});
		const m = unwrapResponse<RuntimeLaunchDescriptor>(
			await managed.request(createRequest("runtime/spawn", { mode: "serve", directory: staticDir, cwd: dir })),
		);
		expect(m.shimWarning).toBeUndefined();
	});

	test("an unknown mode is invalid-params", async () => {
		await expect(descriptor({ mode: "repl" })).rejects.toMatchObject({ code: "invalid-params" });
	});
});
