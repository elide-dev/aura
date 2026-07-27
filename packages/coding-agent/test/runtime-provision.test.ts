import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as dns from "node:dns/promises";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RuntimeRpcError } from "../src/runtime/protocol";
import { provisionRuntime } from "../src/runtime/provision";

/** A name RFC 2606 guarantees is never registered — the DNS-failure fixture. */
const UNRESOLVABLE_HOST = "aura-runtime-does-not-exist.invalid";

/**
 * Whether this host's resolver answers for `.invalid` anyway (NXDOMAIN-hijacking
 * networks). Probed at module scope, not in `beforeAll`, because `test.skipIf` is
 * evaluated when the test is registered — before any hook has run. The probe is
 * time-bounded so a wedged resolver cannot stall importing this file; a probe that
 * does not answer in time counts as "does not resolve", which is the case the test
 * below is written for anyway.
 */
const invalidNameResolves = await Promise.race([
	dns
		.lookup(UNRESOLVABLE_HOST)
		.then(() => true)
		.catch(() => false),
	new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2_000).unref?.()),
]);

let server: ReturnType<typeof Bun.serve>;
let archive: Uint8Array;
let archiveSha: string;
let workRoot: string;
/** Server-side request count per path, so tests can prove a download happened only once. */
const hits = new Map<string, number>();

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
			hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);
			// A body that trickles one chunk and then goes quiet forever — exercises the
			// stall detector without waiting on a real slow link.
			if (url.pathname.endsWith("/stall.txz")) {
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(archive.slice(0, 8));
							// Deliberately never close: the client must give up on its own.
						},
					}),
				);
			}
			if (url.pathname.endsWith(".txz")) return new Response(archive);
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
			connectTimeoutMs: 250,
		}).catch(e => e);
		expect(err).toBeInstanceOf(RuntimeRpcError);
		expect((err as RuntimeRpcError).code).toBe("download-failed");
		// Either connect-phase message is legitimate: a dead port may refuse outright or
		// hang until the 250ms connect deadline, depending on the host's stack.
		expect((err as RuntimeRpcError).message).toMatch(/cannot reach|did not respond within 250ms/);
	});

	// Some networks (captive portals, ISP resolvers that hijack NXDOMAIN) answer for
	// `.invalid` names, which would turn this case into a false failure about someone
	// else's DNS. Probed once above; skipped rather than failed when that happens.
	test.skipIf(invalidNameResolves)(
		"an unresolvable host is reported as unreachable, not as a timeout",
		async () => {
			const err = await provisionRuntime({
				baseUrl: `http://${UNRESOLVABLE_HOST}`,
				dist: { file: "fake.txz", sha256: archiveSha, archive: "txz" },
				version: "0.0.0-test",
				targetRoot: path.join(workRoot, "managed-dns"),
				// Long enough that DNS failure, not the deadline, is what surfaces.
				connectTimeoutMs: 15_000,
			}).catch(e => e);
			expect(err).toBeInstanceOf(RuntimeRpcError);
			expect((err as RuntimeRpcError).code).toBe("download-failed");
			expect((err as RuntimeRpcError).message).toContain("cannot reach");
		},
		20_000,
	);

	test("a body that goes quiet is reported as a stall, not as unreachable", async () => {
		const err = await provisionRuntime({
			baseUrl: `http://localhost:${server.port}`,
			dist: { file: "stall.txz", sha256: archiveSha, archive: "txz" },
			version: "0.0.0-stall",
			targetRoot: path.join(workRoot, "managed-stall"),
			// Generous connect deadline: the server answers immediately, then stops sending.
			connectTimeoutMs: 5_000,
			stallTimeoutMs: 300,
		}).catch(e => e);
		expect(err).toBeInstanceOf(RuntimeRpcError);
		expect((err as RuntimeRpcError).code).toBe("download-failed");
		expect((err as RuntimeRpcError).message).toContain("stalled");
		expect((err as RuntimeRpcError).message).not.toContain("cannot reach");
		expect((err as RuntimeRpcError).data).toMatchObject({ stallTimeoutMs: 300 });
	}, 15_000);

	test("concurrent provisions share one download and one install", async () => {
		const targetRoot = path.join(workRoot, "managed-concurrent");
		hits.delete("/concurrent.txz");
		const call = () =>
			provisionRuntime({
				baseUrl: `http://localhost:${server.port}`,
				dist: { file: "concurrent.txz", sha256: archiveSha, archive: "txz" },
				version: "0.0.0-test",
				targetRoot,
			});
		const [a, b, c] = await Promise.all([call(), call(), call()]);
		expect(b).toBe(a);
		expect(c).toBe(a);
		expect((await fs.stat(a)).isFile()).toBe(true);
		// The whole point: exactly one request reached the server.
		expect(hits.get("/concurrent.txz")).toBe(1);
	}, 15_000);

	test("an install that lands while we download is adopted, not clobbered", async () => {
		const targetRoot = path.join(workRoot, "managed-noclobber");
		const versionDir = path.join(targetRoot, "0.0.0-test");
		// Stand in for "another process finished first": a complete install plus a
		// sentinel that must survive. `provisionRuntime`'s fast path would short-circuit
		// on it, so plant it only after the download is under way.
		// Sync writes so the rival install is on disk before the download even starts —
		// no ordering race between the fixture and the code under test.
		const plantRival = () => {
			fsSync.mkdirSync(path.join(versionDir, "bin"), { recursive: true });
			fsSync.writeFileSync(path.join(versionDir, "bin", "elide"), "#!/bin/sh\necho rival\n", { mode: 0o755 });
			fsSync.writeFileSync(path.join(versionDir, "RIVAL"), "do not delete");
		};
		const bin = await provisionRuntime({
			baseUrl: `http://localhost:${server.port}`,
			dist: { file: "fake.txz", sha256: archiveSha, archive: "txz" },
			version: "0.0.0-test",
			targetRoot,
			onProgress: message => {
				if (message.startsWith("Downloading")) plantRival();
			},
		});
		expect(bin).toBe(path.join(versionDir, "bin", "elide"));
		expect(await Bun.file(path.join(versionDir, "RIVAL")).text()).toBe("do not delete");
		expect(await Bun.file(bin).text()).toContain("rival");
	}, 15_000);

	test("an occupied but binaryless versionDir errors instead of being deleted", async () => {
		const targetRoot = path.join(workRoot, "managed-occupied");
		const versionDir = path.join(targetRoot, "0.0.0-test");
		// Nothing usable here, but it is not ours to remove — something else may own it.
		await fs.mkdir(versionDir, { recursive: true });
		await fs.writeFile(path.join(versionDir, "SOMEONE-ELSES"), "keep me");

		const err = await provisionRuntime({
			baseUrl: `http://localhost:${server.port}`,
			dist: { file: "fake.txz", sha256: archiveSha, archive: "txz" },
			version: "0.0.0-test",
			targetRoot,
		}).catch(e => e);
		expect(err).toBeInstanceOf(RuntimeRpcError);
		expect((err as RuntimeRpcError).code).toBe("download-failed");
		expect((err as RuntimeRpcError).message).toContain("could not be placed");
		expect(await Bun.file(path.join(versionDir, "SOMEONE-ELSES")).text()).toBe("keep me");
	}, 15_000);
});
