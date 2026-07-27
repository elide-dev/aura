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
	/**
	 * Deadline (ms) for the response headers to arrive — the connect phase only. An
	 * unreachable host can hang instead of refusing, so this bounds the wait. Default 30s.
	 * The body transfer is deliberately uncapped; see {@link stallTimeoutMs}.
	 */
	connectTimeoutMs?: number;
	/**
	 * Abort the body transfer when no bytes arrive for this long (ms). Default 60s.
	 * This replaces an overall transfer cap so a healthy-but-slow download on a thin
	 * link is never killed for taking a while.
	 */
	stallTimeoutMs?: number;
	onProgress?: (message: string) => void;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_STALL_TIMEOUT_MS = 60_000;

/**
 * Stream `url` into `destPath`, hashing as it goes, and return the sha256 hex.
 *
 * Two independent guards, each with its own error message so the caller can tell
 * "your network is down" from "the server went quiet" from "this is just slow":
 * `connectTimeoutMs` bounds the wait for response headers, and `stallTimeoutMs`
 * bounds the gap between body chunks. Streaming (rather than buffering the whole
 * archive) also keeps peak memory flat regardless of dist size.
 */
async function downloadToFile(
	url: string,
	destPath: string,
	connectTimeoutMs: number,
	stallTimeoutMs: number,
): Promise<string> {
	const controller = new AbortController();
	let connectTimedOut = false;
	let stalled = false;

	const connectTimer = setTimeout(() => {
		connectTimedOut = true;
		controller.abort();
	}, connectTimeoutMs);
	let response: Response;
	try {
		response = await fetch(url, { signal: controller.signal });
	} catch (cause) {
		if (connectTimedOut) {
			throw new RuntimeRpcError(
				"download-failed",
				`Runtime download failed: ${url} did not respond within ${connectTimeoutMs}ms.`,
				{ url, connectTimeoutMs },
			);
		}
		throw new RuntimeRpcError("download-failed", `Runtime download failed: cannot reach ${url}.`, {
			url,
			cause: String(cause),
		});
	} finally {
		clearTimeout(connectTimer);
	}
	if (!response.ok) {
		throw new RuntimeRpcError("download-failed", `Runtime download failed: HTTP ${response.status} for ${url}.`, {
			url,
			status: response.status,
		});
	}
	const body = response.body;
	if (!body) {
		throw new RuntimeRpcError("download-failed", `Runtime download failed: empty response body for ${url}.`, { url });
	}

	const hasher = new Bun.CryptoHasher("sha256");
	const sink = Bun.file(destPath).writer();
	const reader = body.getReader();
	let stallTimer: ReturnType<typeof setTimeout> | undefined;
	const armStallTimer = () => {
		stallTimer = setTimeout(() => {
			stalled = true;
			controller.abort();
		}, stallTimeoutMs);
	};
	try {
		for (;;) {
			armStallTimer();
			let chunk: Awaited<ReturnType<typeof reader.read>>;
			try {
				chunk = await reader.read();
			} finally {
				clearTimeout(stallTimer);
			}
			if (chunk.done) break;
			hasher.update(chunk.value);
			sink.write(chunk.value);
		}
	} catch (cause) {
		if (stalled) {
			throw new RuntimeRpcError(
				"download-failed",
				`Runtime download stalled: no data from ${url} for ${stallTimeoutMs}ms.`,
				{ url, stallTimeoutMs },
			);
		}
		throw new RuntimeRpcError("download-failed", `Runtime download failed: transfer from ${url} broke off.`, {
			url,
			cause: String(cause),
		});
	} finally {
		// A failing flush (disk full, for one) must not replace whatever typed error is
		// already in flight. On the success path a short write is caught downstream when
		// extraction fails on the truncated archive (the checksum hashes the network
		// bytes, not the file), so swallowing here costs no correctness.
		try {
			await sink.end();
		} catch {
			// ignored on purpose — see above
		}
	}
	return hasher.digest("hex");
}

/**
 * In-flight provisions keyed by `<targetRoot>\0<version>`. Two cold-start callers
 * racing for the same install would otherwise both download, and the loser's
 * install step could tear down the winner's tree while it is already in use.
 */
const inFlight = new Map<string, Promise<string>>();

/**
 * Download → sha256-verify → extract → atomic rename into
 * `<targetRoot>/<version>/`. Returns the runtime binary path. Idempotent:
 * an existing install for `version` short-circuits without network access.
 *
 * Concurrency-safe: concurrent calls for the same `<targetRoot>/<version>` share
 * a single download and install (only the first caller's `onProgress` is driven),
 * and a completed install by another process is adopted rather than replaced.
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

	const key = `${root}\u0000${version}`;
	const joined = inFlight.get(key);
	if (joined) return joined;
	const task = installRuntime(opts, { version, dist, root, versionDir }).finally(() => {
		if (inFlight.get(key) === task) inFlight.delete(key);
	});
	inFlight.set(key, task);
	return task;
}

interface InstallTarget {
	version: string;
	dist: RuntimeDistEntry;
	root: string;
	versionDir: string;
}

/** The uncoordinated download+install body. Always reached through {@link provisionRuntime}. */
async function installRuntime(opts: ProvisionOptions, target: InstallTarget): Promise<string> {
	const { version, dist, root, versionDir } = target;
	const progress = opts.onProgress ?? (() => {});
	const url = distDownloadUrl(dist, opts.baseUrl);
	const staging = path.join(root, `.staging-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	await fs.mkdir(staging, { recursive: true });
	try {
		progress(`Downloading runtime ${version}…`);
		const archivePath = path.join(staging, dist.file);
		const actual = await downloadToFile(
			url,
			archivePath,
			opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
			opts.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
		);

		progress("Verifying checksum…");
		if (actual !== dist.sha256) {
			throw new RuntimeRpcError("download-failed", "Runtime download failed checksum verification.", {
				url,
				expected: dist.sha256,
				actual,
			});
		}

		progress("Extracting…");
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
			throw new RuntimeRpcError("download-failed", "Runtime archive did not contain the expected runtime binary.", {
				url,
			});
		}

		// Rename-arbitrated install. `rename` is the race arbiter: it either places our
		// tree or fails because another process already placed theirs, with no window in
		// between for a check to go stale. Losing means adopting the winner's install —
		// this never removes a `versionDir` it did not create, because a runtime process
		// may already be executing out of it.
		await fs.mkdir(path.dirname(versionDir), { recursive: true });
		try {
			await fs.rename(extractDir, versionDir);
		} catch (cause) {
			if (["EEXIST", "ENOTEMPTY"].includes((cause as NodeJS.ErrnoException).code ?? "")) {
				const rival = await findBinaryInTree(versionDir);
				if (rival) {
					progress(`Runtime ${version} installed.`);
					return rival;
				}
			}
			throw new RuntimeRpcError(
				"download-failed",
				`Runtime install could not be placed at ${versionDir}. Remove that directory and retry.`,
				{ versionDir, cause: String(cause) },
			);
		}
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
