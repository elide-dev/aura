import { parentPort } from "node:worker_threads";
import { ExecutionWorkerCore } from "./worker-core";
import {
	EMBEDDED_DIRECT_EXECUTION_WORKER_ARG,
	type ExecutionWorkerRequest,
	type ExecutionWorkerResponse,
} from "./worker-protocol";
import { createParentPortWorkerTransport } from "./worker-transport";

export function startEmbeddedExecutionWorker(): void {
	const transport = createParentPortWorkerTransport<ExecutionWorkerRequest, ExecutionWorkerResponse>(
		parentPort,
		"embedded-runtime-execution-worker",
	);
	new ExecutionWorkerCore(transport);
}

if (import.meta.main || process.argv.includes(EMBEDDED_DIRECT_EXECUTION_WORKER_ARG)) startEmbeddedExecutionWorker();
