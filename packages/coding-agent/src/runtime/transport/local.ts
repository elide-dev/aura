import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MINIMUM_RUNTIME_VERSION } from "../dist";
import {
	errorResponse,
	okResponse,
	RUNTIME_PROTOCOL_VERSION,
	type RuntimeBuildParams,
	type RuntimeExecResult,
	type RuntimeInsightsParams,
	type RuntimeLanguage,
	type RuntimeProfileParams,
	RuntimeRpcError,
	type RuntimeRpcRequest,
	type RuntimeRpcResponse,
	type RuntimeRunParams,
	type RuntimeStatusResult,
} from "../protocol";
import { provisionRuntime } from "../provision";
import { type ResolvedRuntime, resolveRuntimeBinary } from "../resolve";
import type { RuntimeEndpoint } from "../service";

export interface LocalEndpointOptions {
	explicitPath?: string;
	autoDownload?: boolean;
	/** Environment used for binary resolution and for spawned runtime processes. Defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
	onProgress?: (message: string) => void;
	/** Injectable for tests. */
	provision?: typeof provisionRuntime;
	resolve?: typeof resolveRuntimeBinary;
}

const GUEST_EXT: Record<RuntimeLanguage, string> = { js: "js", ts: "ts", python: "py" };

const MISSING_GUIDANCE =
	"The runtime is not installed. It downloads automatically on first use when runtime.autoDownload is on; " +
	"or point AURA_RUNTIME_BIN (or the runtime.path setting) at an existing binary. Requires runtime >= 1.4.";

/** Per-call subprocess endpoint: services protocol requests by shelling the runtime CLI. */
export class LocalRuntimeEndpoint implements RuntimeEndpoint {
	constructor(private readonly opts: LocalEndpointOptions = {}) {}

	async request(req: RuntimeRpcRequest, signal?: AbortSignal): Promise<RuntimeRpcResponse> {
		try {
			switch (req.method) {
				case "runtime/status":
					return okResponse(req.id, await this.status());
				case "runtime/run":
					return okResponse(req.id, await this.execRun(req.params as RuntimeRunParams, signal));
				case "runtime/insights":
					return okResponse(req.id, await this.execInsights(req.params as RuntimeInsightsParams, signal));
				case "runtime/profile":
					return okResponse(req.id, await this.execProfile(req.params as RuntimeProfileParams, signal));
				case "runtime/check":
					return okResponse(req.id, await this.execBuild(req.params as RuntimeBuildParams, [], signal));
				case "runtime/build": {
					const params = req.params as RuntimeBuildParams;
					return okResponse(req.id, await this.execBuild(params, params.targets ?? [], signal));
				}
				default:
					return errorResponse(req.id, new RuntimeRpcError("invalid-params", `Unknown method ${req.method}`));
			}
		} catch (e) {
			if (e instanceof RuntimeRpcError) return errorResponse(req.id, e);
			return errorResponse(req.id, new RuntimeRpcError("internal", String(e)));
		}
	}

	private resolveFn(): typeof resolveRuntimeBinary {
		return this.opts.resolve ?? resolveRuntimeBinary;
	}

	private async locate(): Promise<ResolvedRuntime | null> {
		return this.resolveFn()({ explicitPath: this.opts.explicitPath, env: this.opts.env });
	}

	/** Resolve the binary; auto-provision when allowed. Throws runtime-missing otherwise. */
	private async ensureBinary(): Promise<ResolvedRuntime> {
		const found = await this.locate();
		if (found) return found;
		if (this.opts.autoDownload !== false && !this.opts.explicitPath) {
			const provision = this.opts.provision ?? provisionRuntime;
			const binaryPath = await provision({ onProgress: this.opts.onProgress });
			return { binaryPath, source: "managed" };
		}
		throw new RuntimeRpcError("runtime-missing", MISSING_GUIDANCE);
	}

	private async status(): Promise<RuntimeStatusResult> {
		const found = await this.locate();
		if (!found) {
			return { available: false, guidance: MISSING_GUIDANCE, protocolVersion: RUNTIME_PROTOCOL_VERSION };
		}
		const result = await this.spawn([found.binaryPath, "--version"], {});
		const version = parseVersion(result.stdout);
		const tooOld = version !== undefined && !meetsMinimumVersion(version);
		return {
			available: result.exitCode === 0 && !tooOld,
			version,
			binaryPath: found.binaryPath,
			source: found.source,
			guidance: tooOld ? belowFloorGuidance(version) : undefined,
			protocolVersion: RUNTIME_PROTOCOL_VERSION,
		};
	}

	private async execRun(params: RuntimeRunParams, signal?: AbortSignal): Promise<RuntimeExecResult> {
		return this.withGuestFile(params, async (bin, guestFile, language) => {
			const argv = [bin, "run", "--error-format=plain", "--no-color", "-l", language, guestFile];
			if (params.args?.length) argv.push("--", ...params.args);
			return this.spawn(argv, params, signal);
		});
	}

	private async execInsights(params: RuntimeInsightsParams, signal?: AbortSignal): Promise<RuntimeExecResult> {
		if (params.insight === undefined && params.insightPath === undefined) {
			throw new RuntimeRpcError("invalid-params", "insights requires insight (inline JS) or insightPath.");
		}
		return this.withGuestFile(params, async (bin, guestFile, language, tempDir) => {
			let insightFile = params.insightPath;
			if (insightFile === undefined) {
				insightFile = path.join(tempDir, "insight.js");
				await fs.writeFile(insightFile, params.insight ?? "");
			}
			const argv = [
				bin,
				"run",
				"--error-format=plain",
				"--no-color",
				`--insights=${insightFile}`,
				"-l",
				language,
				guestFile,
			];
			if (params.args?.length) argv.push("--", ...params.args);
			return this.spawn(argv, params, signal);
		});
	}

	private async execProfile(params: RuntimeProfileParams, signal?: AbortSignal): Promise<RuntimeExecResult> {
		return this.withGuestFile(params, async (bin, guestFile, language) => {
			const argv = [
				bin,
				"run",
				"--error-format=plain",
				"--no-color",
				`--profiler=${params.mode}`,
				"-l",
				language,
				guestFile,
			];
			if (params.args?.length) argv.push("--", ...params.args);
			return this.spawn(argv, params, signal);
		});
	}

	private async execBuild(
		params: RuntimeBuildParams,
		targets: string[],
		signal?: AbortSignal,
	): Promise<RuntimeExecResult> {
		const { binaryPath } = await this.ensureBinary();
		return this.spawn([binaryPath, "build", "--no-color", ...targets], params, signal);
	}

	/** Shared inline-code plumbing: resolve binary, materialize `code` to a temp guest file, clean up. */
	private async withGuestFile(
		params: RuntimeRunParams,
		fn: (bin: string, guestFile: string, language: RuntimeLanguage, tempDir: string) => Promise<RuntimeExecResult>,
	): Promise<RuntimeExecResult> {
		if (params.code === undefined && params.path === undefined) {
			throw new RuntimeRpcError("invalid-params", "run requires code (inline) or path (existing file).");
		}
		if (params.code !== undefined && params.path !== undefined) {
			throw new RuntimeRpcError("invalid-params", "code and path are mutually exclusive.");
		}
		const { binaryPath } = await this.ensureBinary();
		const language: RuntimeLanguage = params.language ?? (params.path ? inferLanguage(params.path) : "ts");
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aura-runtime-"));
		try {
			let guestFile = params.path;
			if (guestFile === undefined) {
				guestFile = path.join(tempDir, `guest.${GUEST_EXT[language]}`);
				await fs.writeFile(guestFile, params.code ?? "");
			}
			return await fn(binaryPath, guestFile, language, tempDir);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	}

	private async spawn(
		argv: string[],
		params: { stdin?: string; timeoutMs?: number; cwd?: string },
		signal?: AbortSignal,
	): Promise<RuntimeExecResult> {
		if (signal?.aborted) throw new RuntimeRpcError("cancelled", "Runtime execution was cancelled.");
		const start = performance.now();
		const proc = Bun.spawn(argv, {
			cwd: params.cwd,
			stdin: params.stdin !== undefined ? new TextEncoder().encode(params.stdin) : undefined,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...(this.opts.env ?? process.env), NO_COLOR: "1" },
		});
		let killed = false;
		const timers: ReturnType<typeof setTimeout>[] = [];
		if (params.timeoutMs) {
			timers.push(
				setTimeout(() => {
					killed = true;
					proc.kill();
				}, params.timeoutMs),
			);
		}
		const onAbort = () => {
			killed = true;
			proc.kill();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			if (signal?.aborted) throw new RuntimeRpcError("cancelled", "Runtime execution was cancelled.");
			return { exitCode, stdout, stderr, durationMs: Math.round(performance.now() - start), killed };
		} finally {
			for (const t of timers) clearTimeout(t);
			signal?.removeEventListener("abort", onAbort);
		}
	}
}

/**
 * Extract a semver-ish version from `--version` output, tolerating a name prefix
 * (e.g. `Elide 9.9.9-fake (build abc)`) so no product name surfaces to users.
 */
function parseVersion(stdout: string): string | undefined {
	return /\d+\.\d+[^\s]*/.exec(stdout)?.[0];
}

/** Leading numeric components of a version, ignoring any `-rc1` / `+build` tail. */
function numericParts(version: string): number[] {
	const core = /^\d+(?:\.\d+)*/.exec(version)?.[0] ?? "";
	return core.split(".").map(Number);
}

/** True when `version` is at least {@link MINIMUM_RUNTIME_VERSION} (numeric, component-wise). */
function meetsMinimumVersion(version: string): boolean {
	const found = numericParts(version);
	const floor = numericParts(MINIMUM_RUNTIME_VERSION);
	for (let i = 0; i < Math.max(found.length, floor.length); i++) {
		const a = found[i] ?? 0;
		const b = floor[i] ?? 0;
		if (a !== b) return a > b;
	}
	return true;
}

function belowFloorGuidance(version: string): string {
	return (
		`The installed runtime is version ${version}, older than the required ${MINIMUM_RUNTIME_VERSION}. ` +
		"Upgrade it, or unset AURA_RUNTIME_BIN / runtime.path so a supported runtime is downloaded automatically."
	);
}

function inferLanguage(file: string): RuntimeLanguage {
	const ext = path.extname(file).toLowerCase();
	if (ext === ".py") return "python";
	if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return "js";
	return "ts";
}
