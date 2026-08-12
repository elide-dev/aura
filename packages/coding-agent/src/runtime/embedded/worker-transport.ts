import { consumeWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import type { EmbeddedWorkerTransport } from "./worker-protocol";

/** Minimal `parentPort` surface the embedded worker transport drives. */
export interface EmbeddedWorkerPort {
	postMessage(message: unknown, transfer?: readonly unknown[]): void;
	on(event: "message", listener: (message: unknown) => void): unknown;
	off(event: "message", listener: (message: unknown) => void): unknown;
	close(): void;
}

/**
 * Transport shared by the embedded execution and control worker entrypoints;
 * `label` names the worker in the missing-`parentPort` diagnostic.
 *
 * The CLI host imports worker modules dynamically, so it pre-buffers the
 * messages the parent posted before the worker spawned in a worker inbox (see
 * `installWorkerInbox`). Bind that inbox when present so the handshake is
 * replayed to the first subscriber. Loaded directly (tests, SDK fallback) there
 * is no inbox, and the listener attached below wins Bun's pre-spawn flush.
 */
export function createParentPortWorkerTransport<Inbound, Outbound>(
	port: EmbeddedWorkerPort | null | undefined,
	label: string,
): EmbeddedWorkerTransport<Inbound, Outbound> {
	if (!port) throw new Error(`${label}: missing parentPort`);
	const boundPort = port;
	const inbox = consumeWorkerInbox();
	return {
		send(message, transfer) {
			boundPort.postMessage(message, transfer ?? []);
		},
		onMessage(handler) {
			if (inbox) return inbox.bind(message => handler(message as Inbound));
			const listener = (message: unknown): void => handler(message as Inbound);
			boundPort.on("message", listener);
			return () => boundPort.off("message", listener);
		},
		close() {
			boundPort.close();
		},
	};
}
