import { afterEach, describe, expect, it } from "bun:test";
import type { SessionSnapshot, WorkerInbound, WorkerOutbound } from "@oh-my-pi/pi-coding-agent/eval/js/worker-protocol";
import { withTimeout } from "@oh-my-pi/pi-utils";
import { getElideJsKernelFactory, setElideJsKernelFactory } from "../../../src/eval/elide/kernel";
import { setElideWorkerCloseTimeoutMsForTests, spawnElideWorker } from "../../../src/eval/elide/worker";
import { createFakeElideJsKernelFactory } from "./fake-kernel";

/**
 * Bounds every real async wait so a hang fails loudly instead of stalling the
 * suite. Kept under Bun's 5s per-test default so the named message below wins
 * the race and says which wait hung.
 */
const WAIT_TIMEOUT_MS = 4_000;

/** The gate global a mid-run cell parks on; unique to this file. */
const GATE_KEY = "__omp_elide_worker_gate";

interface RunGate {
	entered(): void;
	wait: Promise<void>;
}

type GateHost = { [GATE_KEY]?: RunGate };

interface OutboundSource {
	onMessage(handler: (msg: WorkerOutbound) => void): () => void;
}

interface FaultSource {
	onError(handler: (error: Error) => void): () => void;
}

function snapshotFor(sessionId: string): SessionSnapshot {
	return { cwd: process.cwd(), sessionId, localRoots: {} };
}

function nextOutbound(
	source: OutboundSource,
	predicate: (msg: WorkerOutbound) => boolean,
	what: string,
): Promise<WorkerOutbound> {
	const { promise, resolve } = Promise.withResolvers<WorkerOutbound>();
	let unsubscribe = (): void => {};
	unsubscribe = source.onMessage(msg => {
		if (!predicate(msg)) return;
		unsubscribe();
		resolve(msg);
	});
	return withTimeout(promise, WAIT_TIMEOUT_MS, `${what} never arrived`);
}

function nextFault(source: FaultSource, what: string): Promise<Error> {
	const { promise, resolve } = Promise.withResolvers<Error>();
	let unsubscribe = (): void => {};
	unsubscribe = source.onError(error => {
		unsubscribe();
		resolve(error);
	});
	return withTimeout(promise, WAIT_TIMEOUT_MS, `${what} never arrived`);
}

async function initialize(
	source: OutboundSource & { send(msg: WorkerInbound): void },
	sessionId: string,
): Promise<void> {
	const ready = nextOutbound(source, msg => msg.type === "ready", `${sessionId} ready`);
	source.send({ type: "init", snapshot: snapshotFor(sessionId) });
	expect((await ready).type).toBe("ready");
}

describe("spawnElideWorker", () => {
	const teardowns: (() => Promise<void>)[] = [];
	let restoreCloseTimeoutMs: number | undefined;

	afterEach(async () => {
		for (const teardown of teardowns.splice(0)) {
			await withTimeout(teardown(), WAIT_TIMEOUT_MS, "worker teardown never settled");
		}
		if (restoreCloseTimeoutMs !== undefined) {
			setElideWorkerCloseTimeoutMsForTests(restoreCloseTimeoutMs);
			restoreCloseTimeoutMs = undefined;
		}
		delete (globalThis as GateHost)[GATE_KEY];
	});

	it("hands back a worker handle in elide mode", () => {
		const factory = createFakeElideJsKernelFactory();
		const handle = spawnElideWorker(factory, { cwd: process.cwd(), sessionId: "elide-shape" });
		teardowns.push(() => handle.terminate());

		expect(handle.mode).toBe("elide");
		expect(typeof handle.send).toBe("function");
		expect(typeof handle.onMessage).toBe("function");
		expect(typeof handle.onError).toBe("function");
		expect(typeof handle.close).toBe("function");
		expect(typeof handle.terminate).toBe("function");
	});

	it("carries an init/run round-trip over the existing worker protocol", async () => {
		const factory = createFakeElideJsKernelFactory();
		const sessionId = "elide-round-trip";
		const handle = spawnElideWorker(factory, { cwd: process.cwd(), sessionId });
		teardowns.push(() => handle.terminate());

		// `init` is sent before `factory.open` settles: the adapter must queue it.
		await initialize(handle, sessionId);
		expect(factory.opens).toEqual([{ cwd: process.cwd(), sessionId }]);

		const ok = nextOutbound(handle, msg => msg.type === "result" && msg.runId === "run-ok", "run-ok result");
		handle.send({
			type: "run",
			runId: "run-ok",
			code: "globalThis.__ompElideRoundTrip = 41 + 1;",
			filename: "[elide-round-trip-ok].js",
			snapshot: snapshotFor(sessionId),
		});
		expect(await ok).toMatchObject({ type: "result", runId: "run-ok", ok: true });

		// A throwing cell proves the body really executed in the kernel's runtime
		// and that its failure comes back as a value on the same channel.
		const failed = nextOutbound(
			handle,
			msg => msg.type === "result" && msg.runId === "run-throw",
			"run-throw result",
		);
		handle.send({
			type: "run",
			runId: "run-throw",
			code: "if (globalThis.__ompElideRoundTrip !== 42) throw new Error('state lost'); throw new Error('cell boom');",
			filename: "[elide-round-trip-throw].js",
			snapshot: snapshotFor(sessionId),
		});
		const result = await failed;
		expect(result).toMatchObject({ type: "result", runId: "run-throw", ok: false });
		expect(result.type === "result" && !result.ok ? result.error.message : "").toContain("cell boom");
	});

	it("reports an open failure through onError and never throws out of send", async () => {
		const factory = createFakeElideJsKernelFactory({ failOpen: true });
		const sessionId = "elide-open-failure";
		const handle = spawnElideWorker(factory, { cwd: process.cwd(), sessionId });
		teardowns.push(() => handle.terminate());

		const fault = nextFault(handle, "open failure");
		expect(() => handle.send({ type: "init", snapshot: snapshotFor(sessionId) })).not.toThrow();
		const error = await fault;
		expect(error.message).toContain("failed to open");
		expect(error.message).toContain(sessionId);

		// A kernel that never opened has nothing to close gracefully: `close()`
		// answers false without burning the grace period (pinned by making that
		// period far longer than the wait below).
		restoreCloseTimeoutMs = setElideWorkerCloseTimeoutMsForTests(60_000);
		expect(await withTimeout(handle.close(), 1_000, "close never settled after a failed open")).toBe(false);
	});

	it("fans out a kernel fault raised mid-run", async () => {
		const factory = createFakeElideJsKernelFactory();
		const sessionId = "elide-midrun-fault";
		const handle = spawnElideWorker(factory, { cwd: process.cwd(), sessionId });
		teardowns.push(() => handle.terminate());
		await initialize(handle, sessionId);

		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		(globalThis as GateHost)[GATE_KEY] = { entered: () => entered.resolve(), wait: release.promise };

		const settled = nextOutbound(handle, msg => msg.type === "result" && msg.runId === "run-fault", "gated result");
		const fault = nextFault(handle, "mid-run kernel fault");
		handle.send({
			type: "run",
			runId: "run-fault",
			code: `globalThis.${GATE_KEY}.entered(); await globalThis.${GATE_KEY}.wait;`,
			filename: "[elide-midrun-fault].js",
			snapshot: snapshotFor(sessionId),
		});
		await withTimeout(entered.promise, WAIT_TIMEOUT_MS, "gated cell never started");

		expect(factory.sessions).toHaveLength(1);
		factory.sessions[0]?.fail(new Error("kernel crashed mid-run"));
		expect((await fault).message).toContain("kernel crashed mid-run");

		release.resolve();
		expect(await settled).toMatchObject({ type: "result", runId: "run-fault", ok: true });
	});

	it("resolves close() true once the kernel acks and releases the session", async () => {
		const factory = createFakeElideJsKernelFactory();
		const sessionId = "elide-graceful-close";
		const handle = spawnElideWorker(factory, { cwd: process.cwd(), sessionId });
		teardowns.push(() => handle.terminate());
		await initialize(handle, sessionId);

		expect(await withTimeout(handle.close(), WAIT_TIMEOUT_MS, "close never settled")).toBe(true);
		expect(factory.closes).toBe(1);
	});

	it("resolves close() false when the closed ack never arrives", async () => {
		restoreCloseTimeoutMs = setElideWorkerCloseTimeoutMsForTests(5);
		const factory = createFakeElideJsKernelFactory({ dropClosed: true });
		const sessionId = "elide-close-timeout";
		const handle = spawnElideWorker(factory, { cwd: process.cwd(), sessionId });
		teardowns.push(() => handle.terminate());
		await initialize(handle, sessionId);

		expect(await withTimeout(handle.close(), WAIT_TIMEOUT_MS, "close never settled")).toBe(false);
		// No ack means no graceful release: the session is left alive for terminate().
		expect(factory.closes).toBe(0);
	});

	it("terminates unconditionally and idempotently", async () => {
		const factory = createFakeElideJsKernelFactory();
		const sessionId = "elide-terminate";
		const handle = spawnElideWorker(factory, { cwd: process.cwd(), sessionId });
		await initialize(handle, sessionId);

		await withTimeout(handle.terminate(), WAIT_TIMEOUT_MS, "first terminate never settled");
		await withTimeout(handle.terminate(), WAIT_TIMEOUT_MS, "second terminate never settled");
		expect(factory.closes).toBe(1);
	});

	it("waits for a session that opens after terminate() before resolving", async () => {
		const gate = Promise.withResolvers<void>();
		const factory = createFakeElideJsKernelFactory({ openGate: gate.promise });
		const handle = spawnElideWorker(factory, { cwd: process.cwd(), sessionId: "elide-terminate-during-open" });

		let settled = false;
		const terminated = handle.terminate().then(() => {
			settled = true;
		});
		// The kernel is still under construction. A resolved terminate() means the
		// worker is gone, so it must not report that while a session is still on
		// its way — the caller (disposal, process exit) would leak it.
		await Bun.sleep(10);
		expect(settled).toBe(false);
		expect(factory.sessions).toHaveLength(0);

		gate.resolve();
		await withTimeout(terminated, WAIT_TIMEOUT_MS, "terminate never settled after the open landed");
		expect(factory.sessions).toHaveLength(1);
		expect(factory.closes).toBe(1);
	});

	it("stops waiting for a never-settling open after the grace period", async () => {
		restoreCloseTimeoutMs = setElideWorkerCloseTimeoutMsForTests(5);
		const stuck = Promise.withResolvers<void>();
		const factory = createFakeElideJsKernelFactory({ openGate: stuck.promise });
		const handle = spawnElideWorker(factory, { cwd: process.cwd(), sessionId: "elide-terminate-hung-open" });

		// A kernel whose open never lands must not wedge process-exit disposal.
		await withTimeout(handle.terminate(), WAIT_TIMEOUT_MS, "terminate never settled on a hung open");
		expect(factory.closes).toBe(0);

		// Giving up on the wait is not abandoning the session: the open chain still
		// releases it whenever it finally lands.
		stuck.resolve();
		await Bun.sleep(10);
		expect(factory.closes).toBe(1);
	});

	it("drops sends issued after close instead of throwing", async () => {
		const factory = createFakeElideJsKernelFactory();
		const sessionId = "elide-send-after-close";
		const handle = spawnElideWorker(factory, { cwd: process.cwd(), sessionId });
		teardowns.push(() => handle.terminate());
		await initialize(handle, sessionId);
		expect(await withTimeout(handle.close(), WAIT_TIMEOUT_MS, "close never settled")).toBe(true);

		const seen: WorkerOutbound[] = [];
		const faults: Error[] = [];
		handle.onMessage(msg => seen.push(msg));
		handle.onError(error => faults.push(error));
		expect(() =>
			handle.send({
				type: "run",
				runId: "run-after-close",
				code: "globalThis.__ompElideAfterClose = true;",
				filename: "[elide-send-after-close].js",
				snapshot: snapshotFor(sessionId),
			}),
		).not.toThrow();

		await Bun.sleep(10);
		expect(seen).toEqual([]);
		expect(faults).toEqual([]);
	});
});

describe("elide JS kernel factory slot", () => {
	afterEach(() => {
		setElideJsKernelFactory(undefined);
	});

	it("starts empty and returns the previous factory on set", () => {
		expect(getElideJsKernelFactory()).toBeUndefined();

		const factory = createFakeElideJsKernelFactory();
		expect(setElideJsKernelFactory(factory)).toBeUndefined();
		expect(getElideJsKernelFactory()).toBe(factory);
		expect(setElideJsKernelFactory(undefined)).toBe(factory);
		expect(getElideJsKernelFactory()).toBeUndefined();
	});
});
