/**
 * The GUEST half of the Elide JS kernel: the analogue of `../js/worker-entry.ts`,
 * evaluated once inside a Tier 2 context so that context speaks
 * `WorkerInbound`/`WorkerOutbound` from its first cell.
 *
 * It is the same shape as the Bun worker entry — build a {@link Transport}, hand
 * it to a real {@link WorkerCore} — but neither direction of that transport is a
 * message port, because Tier 2 gives a host exactly three channels into a
 * context: eval source in, streamed stdout/stderr out, and one eval result.
 *
 * - **Outbound** frames ride stdout, one JSON line per message behind
 *   `framePrefix`. They are written through the `process.stdout.write` captured
 *   at bootstrap, BEFORE `JsRuntime`'s `patchStdioOnce` wraps it: the patched
 *   writer routes into the active run's `onText`, so framing through it would
 *   feed every frame back into the run that produced it (observed as runaway
 *   allocation, not as a hang — the guest heap dies first).
 * - **Inbound** arrives two ways. Between cells the host evaluates
 *   `__omp_guest_deliver__(msg)` directly. *During* a cell it cannot: an eval
 *   holds the single execution thread, so a second `contextCall` would queue
 *   behind the very run it is meant to answer. Mid-run traffic — today only
 *   `tool-reply` — therefore arrives over a **file spool** the guest polls while
 *   a run is in flight. That poll timer is also what keeps the guest event loop,
 *   and so the host's `contextCall`, alive across a tool call: a promise with no
 *   pending handle behind it does not hold an eval open.
 *
 * This module is bundled into the guest, never driven from the host, and
 * `./guest-bundle.ts` owns every constant the two halves share. Importing it
 * host-side is inert on purpose — the eval-surface scan in the parity suite
 * imports every module in this directory, and a guest bootstrap that ran on
 * import would take the host's `process.stdout` with it.
 */
import * as fs from "node:fs";
import { WorkerCore } from "../js/worker-core";
import type { Transport, WorkerInbound, WorkerOutbound } from "../js/worker-protocol";

export interface ElideGuestBootstrapConfig {
	/** Line prefix marking a protocol frame among the guest's ordinary stdout. */
	framePrefix: string;
	/** Append-only file the host writes mid-run inbound messages to. */
	inboxPath: string;
	/** Poll cadence for {@link ElideGuestBootstrapConfig.inboxPath}, in milliseconds. */
	pollMillis: number;
}

const LINE_FEED = 0x0a;

/** Wire one Tier 2 context up as a JS eval kernel. Called once, by the bootstrap. */
export function startElideGuest(settings: ElideGuestBootstrapConfig): void {
	// Bound before `WorkerCore` exists, so no JsRuntime can have patched it yet.
	const writeFrameLine = process.stdout.write.bind(process.stdout) as (chunk: string) => boolean;

	const listeners = new Set<(msg: WorkerInbound) => void>();
	/** Runs the guest has been handed and not yet answered with a `result`. */
	let activeRuns = 0;
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	/** Bytes of the spool already consumed. Only ever advanced past a complete line. */
	let inboxOffset = 0;

	const deliver = (msg: WorkerInbound): void => {
		for (const listener of [...listeners]) listener(msg);
	};

	/**
	 * Consume every COMPLETE line the spool has grown since the last poll.
	 *
	 * The offset advances only past the final newline in what was read, so a write
	 * the host has not finished flushing is re-read next tick instead of being
	 * decoded as a truncated line — and a multi-byte rune can never be split,
	 * since every boundary decoded here is a line feed.
	 */
	const drainInbox = (): void => {
		let size: number;
		try {
			size = fs.statSync(settings.inboxPath).size;
		} catch {
			// The host creates the spool lazily; nothing to read until it does.
			return;
		}
		if (size <= inboxOffset) return;
		let bytes: Buffer;
		const handle = fs.openSync(settings.inboxPath, "r");
		try {
			const buffer = Buffer.alloc(size - inboxOffset);
			const read = fs.readSync(handle, buffer, 0, buffer.length, inboxOffset);
			bytes = buffer.subarray(0, read);
		} finally {
			fs.closeSync(handle);
		}
		const lastBreak = bytes.lastIndexOf(LINE_FEED);
		if (lastBreak < 0) return;
		inboxOffset += lastBreak + 1;
		for (const line of bytes.toString("utf8", 0, lastBreak).split("\n")) {
			if (line.length === 0) continue;
			let parsed: WorkerInbound;
			try {
				parsed = JSON.parse(line) as WorkerInbound;
			} catch {
				// A corrupt spool line is unanswerable from here; dropping it leaves the
				// run to fail on its own missing reply rather than on a parse error.
				continue;
			}
			deliver(parsed);
		}
	};

	const stopPolling = (): void => {
		if (!pollTimer) return;
		clearTimeout(pollTimer);
		pollTimer = undefined;
	};

	const startPolling = (): void => {
		if (pollTimer) return;
		const step = (): void => {
			// Rescheduled first: a throwing drain must not silently end the poll and
			// strand every later reply.
			pollTimer = setTimeout(step, settings.pollMillis);
			drainInbox();
		};
		pollTimer = setTimeout(step, settings.pollMillis);
	};

	const transport: Transport = {
		send: (msg: WorkerOutbound) => {
			writeFrameLine(`${settings.framePrefix}${JSON.stringify(msg)}\n`);
			if (msg.type !== "result") return;
			activeRuns = Math.max(0, activeRuns - 1);
			// The last run is answered: drop the timer so the event loop can drain
			// and the host's `contextCall` settles.
			if (activeRuns === 0) stopPolling();
		},
		onMessage: handler => {
			listeners.add(handler);
			return () => {
				listeners.delete(handler);
			};
		},
		close: () => {
			stopPolling();
		},
	};

	new WorkerCore(transport, { mode: "isolated" });

	(globalThis as unknown as Record<string, unknown>).__omp_guest_deliver__ = (msg: WorkerInbound): void => {
		if (msg.type === "run") {
			activeRuns += 1;
			startPolling();
		}
		deliver(msg);
	};
}

const bootstrap = (globalThis as unknown as { __OMP_ELIDE_KERNEL__?: ElideGuestBootstrapConfig }).__OMP_ELIDE_KERNEL__;
if (bootstrap) startElideGuest(bootstrap);
