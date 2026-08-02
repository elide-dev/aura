import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RuntimeLaunchDescriptor } from "../src/runtime/protocol";
import { createRequest, RuntimeRpcError, unwrapResponse } from "../src/runtime/protocol";
import type { resolveRuntimeBinary } from "../src/runtime/resolve";
import { LocalRuntimeEndpoint } from "../src/runtime/transport/local";
import { matchRuntimeEndpoint } from "../src/tools/runtime-launch";

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

describe("runtime/spawn — removed debug descriptors", () => {
	test("rejects the retired debug mode instead of silently serving", async () => {
		await expect(descriptor({ mode: "debug", path: guest, directory: staticDir, cwd: dir })).rejects.toMatchObject({
			code: "invalid-params",
		});
	});
});

describe("runtime/spawn — serve descriptors", () => {
	test("composes the serve argv with --no-tui and the static-files rule", async () => {
		const d = await descriptor({ directory: "public", cwd: dir });
		expect(d.argv).toEqual([fakeBin, "serve", staticDir, "--no-tui"]);
		expect(d.endpointPattern).toEqual([
			{ pattern: "Serving static files on\\s+(\\S+)", group: 1, prefix: "http://" },
		]);
	});

	test("port and host are appended only when supplied", async () => {
		const d = await descriptor({ directory: staticDir, port: 8123, host: "0.0.0.0", cwd: dir });
		expect(d.argv.slice(-4)).toEqual(["--port", "8123", "--host", "0.0.0.0"]);
	});

	test("a non-integer or out-of-range port is invalid-params", async () => {
		for (const port of [0, 70_000, 1.5]) {
			await expect(descriptor({ directory: staticDir, port, cwd: dir })).rejects.toMatchObject({
				code: "invalid-params",
			});
		}
	});

	test("a missing directory, or a file in its place, is invalid-params", async () => {
		await expect(descriptor({ cwd: dir })).rejects.toMatchObject({ code: "invalid-params" });
		await expect(descriptor({ directory: "nope", cwd: dir })).rejects.toMatchObject({
			code: "invalid-params",
		});
		await expect(descriptor({ directory: guest, cwd: dir })).rejects.toMatchObject({
			code: "invalid-params",
		});
	});
});

/** The endpoint rule must parse the banner printed by the pinned runtime. */
describe("runtime/spawn — the shipped rule parses the real serve banner", () => {
	test("serve", async () => {
		const d = await descriptor({ directory: staticDir, cwd: dir });
		const banner =
			'Serving from directory: "/tmp/pub"\nServing /tmp/pub at http://"127.0.0.1":8080\n' +
			"Serving static files on 127.0.0.1:8080\n";
		expect(matchRuntimeEndpoint(banner, d.endpointPattern)).toBe("http://127.0.0.1:8080");
	});
});

describe("runtime/spawn — resolution", () => {
	test("a missing runtime is a runtime-missing error, never a partial descriptor", async () => {
		const ep = new LocalRuntimeEndpoint({ explicitPath: path.join(dir, "gone"), autoDownload: false });
		const res = await ep.request(createRequest("runtime/spawn", { directory: staticDir, cwd: dir }));
		expect(() => unwrapResponse(res)).toThrow(RuntimeRpcError);
		expect(() => unwrapResponse(res)).toThrow(/not installed/);
	});

	test("a PATH-resolved binary carries a shim warning; a managed one does not", async () => {
		const onPath = new LocalRuntimeEndpoint({
			autoDownload: false,
			resolve: async () => ({ binaryPath: fakeBin, source: "path" }),
		});
		const d = unwrapResponse<RuntimeLaunchDescriptor>(
			await onPath.request(createRequest("runtime/spawn", { directory: staticDir, cwd: dir })),
		);
		expect(d.source).toBe("path");
		expect(d.shimWarning).toMatch(/PATH/);
		expect(d.shimWarning).not.toMatch(/elide/i);
		// The remedy must be something that exists: `runtime.path` / AURA_RUNTIME_BIN
		// are real, and `aura runtime` has no install subcommand to point at.
		expect(d.shimWarning).toContain("runtime.path");
		expect(d.shimWarning).toContain("AURA_RUNTIME_BIN");
		expect(d.shimWarning).not.toMatch(/runtime install/);

		const managed = new LocalRuntimeEndpoint({
			autoDownload: false,
			resolve: async () => ({ binaryPath: fakeBin, source: "managed" }),
		});
		const m = unwrapResponse<RuntimeLaunchDescriptor>(
			await managed.request(createRequest("runtime/spawn", { directory: staticDir, cwd: dir })),
		);
		expect(m.shimWarning).toBeUndefined();
	});

	test("an obsolete or unknown mode is invalid-params", async () => {
		for (const mode of ["debug", "repl"]) {
			await expect(descriptor({ mode, directory: staticDir, cwd: dir })).rejects.toMatchObject({
				code: "invalid-params",
			});
		}
	});

	test("invalid params are rejected before the binary is resolved, so no download is triggered", async () => {
		// Composition runs first on purpose: provisioning downloads hundreds of
		// megabytes, and a typo'd mode or path must not pay for one to be told no.
		let provisioned = 0;
		let resolved = 0;
		const ep = new LocalRuntimeEndpoint({
			autoDownload: true,
			resolve: async () => {
				resolved++;
				return null;
			},
			provision: async () => {
				provisioned++;
				return fakeBin;
			},
		});
		for (const params of [
			{ mode: "repl", directory: staticDir, cwd: dir },
			{ mode: "debug", directory: staticDir, cwd: dir },
			{ directory: "nope", cwd: dir },
			{ directory: staticDir, port: 0, cwd: dir },
		]) {
			const res = await ep.request(createRequest("runtime/spawn", params));
			expect(() => unwrapResponse(res)).toThrow(RuntimeRpcError);
		}
		expect(provisioned).toBe(0);
		expect(resolved).toBe(0);

		// Sanity: valid params DO resolve, so the assertion above is about ordering
		// rather than a resolve call that never happens.
		unwrapResponse(await ep.request(createRequest("runtime/spawn", { directory: staticDir, cwd: dir })));
		expect(resolved).toBe(1);
		expect(provisioned).toBe(1);
	});
});
