import * as fs from "node:fs/promises";
import * as path from "node:path";
import { distDownloadUrl, ELIDE_VERSION, platformKey, RUNTIME_DIST, type RuntimeDistEntry } from "./dist";
import { RuntimeRpcError } from "./protocol";
import { findBinaryInTree, managedRuntimeRoot } from "./resolve";

export interface ProvisionOptions {
	baseUrl?: string;
	version?: string;
	/** Platform dist override (tests/mirrors). Defaults to RUNTIME_DIST[platformKey()]. */
	dist?: RuntimeDistEntry;
	/** Install root override (tests). Defaults to managedRuntimeRoot(). */
	targetRoot?: string;
	/** Network guard (ms) for the download. An unreachable host can hang instead of refusing; default 120s. */
	timeoutMs?: number;
	onProgress?: (message: string) => void;
}

/**
 * Download → sha256-verify → extract → atomic rename into
 * `<targetRoot>/<version>/`. Returns the runtime binary path. Idempotent:
 * an existing install for `version` short-circuits without network access.
 */
export async function provisionRuntime(opts: ProvisionOptions = {}): Promise<string> {
	const version = opts.version ?? ELIDE_VERSION;
	const dist = opts.dist ?? RUNTIME_DIST[platformKey()];
	if (!dist) {
		throw new RuntimeRpcError("download-failed", `No runtime distribution is pinned for platform ${platformKey()}.`, {
			platform: platformKey(),
		});
	}
	const root = opts.targetRoot ?? managedRuntimeRoot();
	const versionDir = path.join(root, version);
	const existing = await findBinaryInTree(versionDir);
	if (existing) return existing;

	const progress = opts.onProgress ?? (() => {});
	const url = distDownloadUrl(dist, opts.baseUrl);
	const staging = path.join(root, `.staging-${process.pid}-${Date.now()}`);
	await fs.mkdir(staging, { recursive: true });
	try {
		progress(`Downloading runtime ${version}…`);
		let response: Response;
		try {
			response = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000) });
		} catch (cause) {
			throw new RuntimeRpcError("download-failed", `Runtime download failed: cannot reach ${url}.`, {
				url,
				cause: String(cause),
			});
		}
		if (!response.ok) {
			throw new RuntimeRpcError("download-failed", `Runtime download failed: HTTP ${response.status} for ${url}.`, {
				url,
				status: response.status,
			});
		}
		const bytes = new Uint8Array(await response.arrayBuffer());

		progress("Verifying checksum…");
		const hasher = new Bun.CryptoHasher("sha256");
		hasher.update(bytes);
		const actual = hasher.digest("hex");
		if (actual !== dist.sha256) {
			throw new RuntimeRpcError("download-failed", "Runtime download failed checksum verification.", {
				url,
				expected: dist.sha256,
				actual,
			});
		}

		progress("Extracting…");
		const archivePath = path.join(staging, dist.file);
		await Bun.write(archivePath, bytes);
		const extractDir = path.join(staging, "extract");
		await fs.mkdir(extractDir, { recursive: true });
		const argv =
			dist.archive === "zip"
				? ["unzip", "-q", archivePath, "-d", extractDir]
				: ["tar", "-xJf", archivePath, "-C", extractDir];
		const proc = Bun.spawnSync(argv);
		if (proc.exitCode !== 0) {
			throw new RuntimeRpcError("download-failed", "Runtime archive extraction failed.", {
				argv,
				stderr: proc.stderr.toString(),
			});
		}

		const binary = await findBinaryInTree(extractDir);
		if (!binary) {
			throw new RuntimeRpcError("download-failed", "Runtime archive did not contain a bin/elide binary.", { url });
		}

		await fs.rm(versionDir, { recursive: true, force: true });
		await fs.mkdir(path.dirname(versionDir), { recursive: true });
		await fs.rename(extractDir, versionDir);
		const installed = await findBinaryInTree(versionDir);
		if (!installed) {
			throw new RuntimeRpcError("download-failed", "Runtime install did not land where expected.", { versionDir });
		}
		progress(`Runtime ${version} installed.`);
		return installed;
	} finally {
		await fs.rm(staging, { recursive: true, force: true });
		// Never leave an empty targetRoot behind on failure paths in tests.
		const leftover = await fs.readdir(root).catch(() => null);
		if (leftover !== null && leftover.length === 0) await fs.rmdir(root).catch(() => {});
	}
}
