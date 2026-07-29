import { parentPort } from "node:worker_threads";
import { consumeWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import { ControlWorkerCore } from "./worker-core";
import {
	type ControlWorkerRequest,
	type ControlWorkerResponse,
	EMBEDDED_DIRECT_CONTROL_WORKER_ARG,
	type EmbeddedWorkerTransport,
} from "./worker-protocol";

export function startEmbeddedControlWorker(): void {
	if (!parentPort) throw new Error("embedded-runtime-control-worker: missing parentPort");
	const port = parentPort;
	const inbox = consumeWorkerInbox();
	const transport: EmbeddedWorkerTransport<ControlWorkerRequest, ControlWorkerResponse> = {
		send(message, transfer) {
			port.postMessage(message, transfer ?? []);
		},
		onMessage(handler) {
			if (inbox) return inbox.bind(message => handler(message as ControlWorkerRequest));
			const listener = (message: unknown): void => handler(message as ControlWorkerRequest);
			port.on("message", listener);
			return () => port.off("message", listener);
		},
		close() {
			port.close();
		},
	};
	new ControlWorkerCore(transport);
}

if (import.meta.main || process.argv.includes(EMBEDDED_DIRECT_CONTROL_WORKER_ARG)) startEmbeddedControlWorker();
