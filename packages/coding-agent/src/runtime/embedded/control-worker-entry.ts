import { parentPort } from "node:worker_threads";
import { ControlWorkerCore } from "./worker-core";
import {
	type ControlWorkerRequest,
	type ControlWorkerResponse,
	EMBEDDED_DIRECT_CONTROL_WORKER_ARG,
} from "./worker-protocol";
import { createParentPortWorkerTransport } from "./worker-transport";

export function startEmbeddedControlWorker(): void {
	const transport = createParentPortWorkerTransport<ControlWorkerRequest, ControlWorkerResponse>(
		parentPort,
		"embedded-runtime-control-worker",
	);
	new ControlWorkerCore(transport);
}

if (import.meta.main || process.argv.includes(EMBEDDED_DIRECT_CONTROL_WORKER_ARG)) startEmbeddedControlWorker();
