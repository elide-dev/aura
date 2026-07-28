import { parentPort } from "node:worker_threads";
import { consumeWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import { ExecutionWorkerCore } from "./worker-core";
import type { EmbeddedWorkerTransport, ExecutionWorkerRequest, ExecutionWorkerResponse } from "./worker-protocol";

export function startEmbeddedExecutionWorker(): void {
	if (!parentPort) throw new Error("embedded-runtime-execution-worker: missing parentPort");
	const port = parentPort;
	const inbox = consumeWorkerInbox();
	const transport: EmbeddedWorkerTransport<ExecutionWorkerRequest, ExecutionWorkerResponse> = {
		send(message, transfer) {
			port.postMessage(message, transfer ?? []);
		},
		onMessage(handler) {
			if (inbox) return inbox.bind(message => handler(message as ExecutionWorkerRequest));
			const listener = (message: unknown): void => handler(message as ExecutionWorkerRequest);
			port.on("message", listener);
			return () => port.off("message", listener);
		},
		close() {
			port.close();
		},
	};
	new ExecutionWorkerCore(transport);
}

if (import.meta.main) startEmbeddedExecutionWorker();
