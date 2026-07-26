import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RuntimeRpcError } from "../src/runtime/protocol";
import { provisionRuntime } from "../src/runtime/provision";

let server: ReturnType<typeof Bun.serve>;
let archive: Uint8Array;
let archiveSha: string;
let workRoot: string;

beforeAll(async () => {
	workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aura-prov-"));
	// Build a tiny real .txz: dist/bin/elide (fake shell script)
	const stage = path.join(workRoot, "stage", "elide-dist");
	await fs.mkdir(path.join(stage, "bin"), { recursive: true });
	await fs.writeFile(path.join(stage, "bin", "elide"), "#!/bin/sh\necho 1.4.1-fake\n", { mode: 0o755 });
	const tar = Bun.spawnSync([
		"tar",
		"-cJf",
		path.join(workRoot, "fake.txz"),
		"-C",
		path.join(workRoot, "stage"),
		"elide-dist",
	]);
	if (tar.exitCode !== 0) throw new Error(`fixture tar failed: ${tar.stderr.toString()}`);
	archive = new Uint8Array(await Bun.file(path.join(workRoot, "fake.txz")).arrayBuffer());
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(archive);
	archiveSha = hasher.digest("hex");
	server = Bun.serve({
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname.endsWith("/fake.txz")) return new Response(archive);
			return new Response("not found", { status: 404 });
		},
	});
});

afterAll(async () => {
	server.stop(true);
	await fs.rm(workRoot, { recursive: true, force: true });
});

describe("runtime provisioning", () => {
	test("downloads, verifies, extracts, and returns the binary path", async () => {
		const targetRoot = path.join(workRoot, "managed-ok");
		const progress: string[] = [];
		const bin = await provisionRuntime({
			baseUrl: `http://localhost:${server.port}`,
			dist: { file: "fake.txz", sha256: archiveSha, archive: "txz" },
			version: "0.0.0-test",
			targetRoot,
			onProgress: m => progress.push(m),
		});
		expect(bin.endsWith(path.join("bin", "elide"))).toBe(true);
		expect((await fs.stat(bin)).isFile()).toBe(true);
		expect(progress.length).toBeGreaterThan(0);
		// idempotent: a second call returns the installed binary without re-downloading
		const again = await provisionRuntime({
			baseUrl: "http://localhost:1", // unreachable — must not be contacted
			dist: { file: "fake.txz", sha256: archiveSha, archive: "txz" },
			version: "0.0.0-test",
			targetRoot,
		});
		expect(again).toBe(bin);
	});

	test("checksum mismatch is a typed download-failed error and installs nothing", async () => {
		const targetRoot = path.join(workRoot, "managed-bad");
		const err = await provisionRuntime({
			baseUrl: `http://localhost:${server.port}`,
			dist: { file: "fake.txz", sha256: "0".repeat(64), archive: "txz" },
			version: "0.0.0-test",
			targetRoot,
		}).catch(e => e);
		expect(err).toBeInstanceOf(RuntimeRpcError);
		expect((err as RuntimeRpcError).code).toBe("download-failed");
		expect(await fs.readdir(targetRoot).catch(() => [])).toEqual([]);
	});

	test("unreachable server is a typed download-failed error", async () => {
		const err = await provisionRuntime({
			baseUrl: "http://localhost:1",
			dist: { file: "fake.txz", sha256: archiveSha, archive: "txz" },
			version: "0.0.0-test",
			targetRoot: path.join(workRoot, "managed-offline"),
			timeoutMs: 250,
		}).catch(e => e);
		expect(err).toBeInstanceOf(RuntimeRpcError);
		expect((err as RuntimeRpcError).code).toBe("download-failed");
	});
});
