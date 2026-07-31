import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ptree } from "@oh-my-pi/pi-utils";
import { resolveWorkerSpawnCmd, workerEnvFromParent } from "../../subprocess/worker-client";
import { BUN_RUN_WORKER_ARG } from "../bun-run-entry";
import type { RuntimeExecResult, RuntimeRpcRequest, RuntimeRpcResponse, RuntimeRunParams } from "../protocol";
import { errorResponse, okResponse, RuntimeRpcError, resolveRunTarget, toRuntimeRpcError } from "../protocol";
import type { RuntimeEndpoint } from "../service";

export interface BunRuntimeEndpointOptions {
	env?: NodeJS.ProcessEnv;
}

/** One-shot JavaScript/TypeScript execution through the current Aura/Bun host. */
export class BunRuntimeEndpoint implements RuntimeEndpoint {
	constructor(private readonly options: BunRuntimeEndpointOptions = {}) {}

	async request(request: RuntimeRpcRequest, signal?: AbortSignal): Promise<RuntimeRpcResponse> {
		try {
			if (request.method !== "runtime/run") {
				throw new RuntimeRpcError("invalid-params", `Bun endpoint does not support ${request.method}.`);
			}
			if (signal?.aborted) throw new RuntimeRpcError("cancelled", "Runtime execution was cancelled.");
			const params = request.params as RuntimeRunParams;
			const target = resolveRunTarget(params);
			if (target.engine !== "bun" || (target.language !== "js" && target.language !== "ts")) {
				throw new RuntimeRpcError(
					"invalid-params",
					"Bun endpoint requires a JavaScript or TypeScript Bun request.",
				);
			}
			return okResponse(request.id, await this.#execute(params, target.language, signal));
		} catch (error) {
			return errorResponse(request.id, toRuntimeRpcError(error));
		}
	}

	async #execute(params: RuntimeRunParams, language: "js" | "ts", signal?: AbortSignal) {
		const start = performance.now();
		const cwd = path.resolve(params.cwd ?? process.cwd());
		let temporaryDirectory: string | undefined;
		try {
			let sourcePath: string;
			if (params.path !== undefined) {
				sourcePath = path.resolve(cwd, params.path);
			} else {
				temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "aura-bun-run-"));
				sourcePath = path.join(temporaryDirectory, `guest.${language}`);
				await Bun.write(sourcePath, params.code ?? "");
			}
			const spawnCommand = resolveWorkerSpawnCmd(BUN_RUN_WORKER_ARG);
			const command = [...spawnCommand.cmd];
			if (spawnCommand.cwd && command[1] && !path.isAbsolute(command[1])) {
				command[1] = path.resolve(spawnCommand.cwd, command[1]);
			}
			command.push(sourcePath, ...(params.args ?? []));
			const result = await ptree.exec(command, {
				cwd,
				env: this.#environment(),
				input: params.stdin,
				timeout: params.timeoutMs,
				signal,
				detached: true,
				allowAbort: true,
				allowNonZero: true,
				stderr: "full",
			});
			if (signal?.aborted) throw new RuntimeRpcError("cancelled", "Runtime execution was cancelled.");
			return {
				exitCode: result.exitCode ?? 1,
				stdout: result.stdout,
				stderr: result.stderr,
				durationMs: Math.round(performance.now() - start),
				killed: result.exitError?.aborted === true,
				engine: "bun" as const,
				language,
			};
		} finally {
			if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
		}
	}

	#environment(): Record<string, string> {
		const overlay: Record<string, string> = {};
		for (const [key, value] of Object.entries(this.options.env ?? {})) {
			if (value !== undefined) overlay[key] = value;
		}
		return workerEnvFromParent({ ...overlay, NO_COLOR: "1" });
	}
}

/** Distribution smoke probe for source, bundled, and compiled CLI worker re-entry. */
export async function smokeTestBunRunWorker(): Promise<void> {
	const endpoint = new BunRuntimeEndpoint();
	const response = await endpoint.request({
		jsonrpc: "2.0",
		id: 1,
		method: "runtime/run",
		params: {
			code: "const answer: number = await Promise.resolve(42); console.log('bun-worker:' + answer);",
			language: "ts",
		},
	});
	if ("error" in response) throw new Error(`Bun run worker smoke failed: ${response.error.message}`);
	const result = response.result as RuntimeExecResult;
	if (result.exitCode !== 0 || result.stdout !== "bun-worker:42\n" || result.stderr !== "") {
		throw new Error(
			`Bun run worker smoke returned exit=${result.exitCode}, stdout=${JSON.stringify(result.stdout)}, stderr=${JSON.stringify(result.stderr)}`,
		);
	}
}
