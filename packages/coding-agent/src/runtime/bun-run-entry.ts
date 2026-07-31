import { pathToFileURL } from "node:url";

export const BUN_RUN_WORKER_ARG = "__omp_worker_runtime_bun_run";

/** Execute one materialized JavaScript/TypeScript program in an isolated Bun worker. */
export async function runBunGuest(argv: string[]): Promise<void> {
	const [sourcePath, ...programArgs] = argv;
	if (!sourcePath) throw new Error("Bun run worker requires a source path.");
	const worker = new Worker(pathToFileURL(sourcePath).href, { argv: programArgs, ref: true });
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	worker.addEventListener("close", event => {
		process.exitCode = "code" in event && typeof event.code === "number" ? event.code : 1;
		resolve();
	});
	worker.addEventListener("error", event => reject(event.error ?? new Error(event.message)));
	await promise;
}
