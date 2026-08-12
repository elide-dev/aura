/**
 * The host half of the embedded Elide JS kernel, driven hermetically.
 *
 * Every case here runs against {@link createScriptedTransport} rather than the
 * native library, because what is under test is the translation the factory
 * performs — framing, run settlement, and the ordering rules between an eval and
 * the control traffic that has to reach the runtime *while* it runs. The ABI
 * below that seam is already pinned by the Tier 2 suites, and the end-to-end
 * behaviour above it by the artifact-gated half of the parity suite.
 *
 * The settlement cases matter more than they look. A cell that cannot answer
 * itself — it exited, it was interrupted, it blew the output budget, it drained
 * its event loop with a tool call outstanding — must still settle its run *as a
 * value*, because nothing above this seam has a timer that would notice. A run
 * left open here is a hung eval tool.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import type { ElideJsKernelSession } from "../../../src/eval/elide/kernel";
import { createElideEmbeddedKernelFactory } from "../../../src/eval/elide/kernel-embedded";
import type { WorkerOutbound } from "../../../src/eval/js/worker-protocol";
import {
	createScriptedTransport,
	frame,
	okResult,
	type ScriptedTransport,
	scriptedFactoryOptions,
} from "./scripted-context";

/** Bounds every real wait so a wedged kernel fails loudly, under Bun's 5s default. */
const WAIT_TIMEOUT_MS = 4_000;
const SNAPSHOT = { cwd: "/tmp/elide-kernel-test", sessionId: "js-elide:kernel-test" };

let tempDir: TempDir;
let transport: ScriptedTransport;

beforeEach(() => {
	tempDir = TempDir.createSync("@omp-elide-kernel-");
	transport = createScriptedTransport();
});

afterEach(() => {
	tempDir[Symbol.dispose]();
});

/** Open one session and collect everything it emits. */
async function openSession(bootstrapSource?: string): Promise<{
	session: ElideJsKernelSession;
	messages: WorkerOutbound[];
	errors: Error[];
	waitFor(predicate: (messages: WorkerOutbound[]) => boolean, label: string): Promise<void>;
}> {
	const factory = createElideEmbeddedKernelFactory(scriptedFactoryOptions(transport, tempDir.path(), bootstrapSource));
	const session = await factory.open({ cwd: SNAPSHOT.cwd, sessionId: SNAPSHOT.sessionId });
	const messages: WorkerOutbound[] = [];
	const errors: Error[] = [];
	session.onMessage(msg => messages.push(msg));
	session.onError(error => errors.push(error));
	const waitFor = (predicate: (seen: WorkerOutbound[]) => boolean, label: string): Promise<void> =>
		withTimeout(
			(async () => {
				while (!predicate(messages)) await Bun.sleep(1);
			})(),
			WAIT_TIMEOUT_MS,
			label,
		);
	return { session, messages, errors, waitFor };
}

function hasResult(runId: string) {
	return (messages: WorkerOutbound[]): boolean => messages.some(msg => msg.type === "result" && msg.runId === runId);
}

function resultFor(messages: WorkerOutbound[], runId: string): Extract<WorkerOutbound, { type: "result" }> {
	const found = messages.find(msg => msg.type === "result" && msg.runId === runId);
	if (found?.type !== "result") throw new Error(`no result for ${runId}`);
	return found;
}

describe("embedded Elide kernel context spec", () => {
	it("opens a js/ts context with the label, cwd, and streaming the checklist names", async () => {
		await openSession();
		expect(transport.opens).toEqual([
			{
				languages: ["js", "ts"],
				primaryLanguage: "js",
				streamOutput: true,
				workingDir: SNAPSHOT.cwd,
				label: SNAPSHOT.sessionId,
			},
		]);
	});

	it("never deduplicates two byte-identical opens", async () => {
		const factory = createElideEmbeddedKernelFactory(scriptedFactoryOptions(transport, tempDir.path()));
		const first = await factory.open({ cwd: SNAPSHOT.cwd, sessionId: SNAPSHOT.sessionId });
		const second = await factory.open({ cwd: SNAPSHOT.cwd, sessionId: SNAPSHOT.sessionId });
		expect(second).not.toBe(first);
		expect(transport.contexts.size).toBe(2);
	});
});

describe("embedded Elide kernel protocol translation", () => {
	it("evaluates the guest bootstrap once, then delivers inbound messages to it", async () => {
		const { session, waitFor, messages } = await openSession("/* guest bootstrap */");
		transport.script(async (code, context) => {
			if (code.includes("__omp_guest_deliver__")) {
				const inbound = JSON.parse(code.slice(code.indexOf("(") + 1, code.lastIndexOf(")")));
				if (inbound.type === "init") context.write(frame({ type: "ready" }));
				if (inbound.type === "run") context.write(frame({ type: "result", runId: inbound.runId, ok: true }));
			}
			return { type: "eval-result", requestId: 0n, result: okResult() };
		});

		session.send({ type: "init", snapshot: SNAPSHOT });
		await waitFor(seen => seen.some(msg => msg.type === "ready"), "kernel never reported ready");
		session.send({ type: "run", runId: "run-1", code: "1 + 1", filename: "cell.js", snapshot: SNAPSHOT });
		await waitFor(hasResult("run-1"), "run never settled");

		expect(transport.evals[0]).toBe("/* guest bootstrap */");
		expect(transport.evals[1]).toContain('"type":"init"');
		expect(transport.evals[2]).toContain('"runId":"run-1"');
		// One bootstrap, not one per message.
		expect(transport.evals.filter(code => code === "/* guest bootstrap */")).toHaveLength(1);
		expect(resultFor(messages, "run-1").ok).toBe(true);
	});

	it("reassembles frames split across chunk boundaries, mid-rune included", async () => {
		const { session, waitFor, messages } = await openSession();
		const payload = frame({ type: "text", runId: "run-1", chunk: "héllo ✓\n" });
		const bytes = new TextEncoder().encode(payload);
		transport.script(async (code, context) => {
			if (code.includes('"type":"run"')) {
				// Split inside the multi-byte rune: decoding either half alone corrupts it.
				for (let index = 0; index < bytes.length; index += 7) {
					context.writeBytes(bytes.subarray(index, Math.min(index + 7, bytes.length)));
					await Bun.sleep(0);
				}
				context.write(frame({ type: "result", runId: "run-1", ok: true }));
			}
			return { type: "eval-result", requestId: 0n, result: okResult() };
		});

		session.send({ type: "run", runId: "run-1", code: "x", filename: "cell.js", snapshot: SNAPSHOT });
		await waitFor(hasResult("run-1"), "run never settled");
		const text = messages.find(msg => msg.type === "text");
		expect(text).toEqual({ type: "text", runId: "run-1", chunk: "héllo ✓\n" });
	});

	it("attributes unframed guest output to the running cell", async () => {
		const { session, waitFor, messages } = await openSession();
		transport.script(async (code, context) => {
			if (code.includes('"type":"run"')) {
				context.write("a child process wrote this\n");
				context.write("and this went to stderr\n", "stderr");
				context.write(frame({ type: "result", runId: "run-1", ok: true }));
			}
			return { type: "eval-result", requestId: 0n, result: okResult() };
		});

		session.send({ type: "run", runId: "run-1", code: "x", filename: "cell.js", snapshot: SNAPSHOT });
		await waitFor(hasResult("run-1"), "run never settled");
		expect(messages.filter(msg => msg.type === "text").map(msg => msg.chunk)).toEqual([
			"a child process wrote this\n",
			"and this went to stderr\n",
		]);
	});
});

describe("embedded Elide kernel run settlement", () => {
	it("settles a guest exit as a value naming the exit status, leaving the context open", async () => {
		const { session, waitFor, messages } = await openSession();
		transport.script(async code => {
			if (!code.includes('"type":"run"')) {
				return { type: "eval-result", requestId: 0n, result: okResult() };
			}
			return {
				type: "eval-result",
				requestId: 0n,
				result: okResult({
					exitCode: 3,
					// Survivable guest exit: the eval ends, the context does not.
					contextAlive: true,
					outcome: {
						type: "error",
						error: {
							typeName: "ExitException",
							message: "exit",
							language: "js",
							isSyntaxError: false,
							isHostWrapped: false,
							isInternal: false,
							isCancelled: false,
							isExit: true,
							exitStatus: 3,
						},
					},
				}),
			};
		});

		session.send({ type: "run", runId: "run-1", code: "process.exit(3)", filename: "cell.js", snapshot: SNAPSHOT });
		await waitFor(hasResult("run-1"), "an exiting cell never settled its run");
		const result = resultFor(messages, "run-1");
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected a failed result");
		expect(result.error.message).toContain("exit status 3");
		// Never closed: the next cell keeps the globals the exiting one left behind.
		expect(transport.controls.filter(op => op.type === "close")).toHaveLength(0);
	});

	it("settles an interrupted cell as a value and keeps the context", async () => {
		const { session, waitFor, messages } = await openSession();
		transport.script(async code => {
			if (!code.includes('"type":"run"')) {
				return { type: "eval-result", requestId: 0n, result: okResult() };
			}
			return {
				type: "eval-result",
				requestId: 0n,
				result: okResult({ outcome: { type: "interrupted" } }),
			};
		});

		session.send({ type: "run", runId: "run-1", code: "while(true){}", filename: "cell.js", snapshot: SNAPSHOT });
		await waitFor(hasResult("run-1"), "an interrupted cell never settled its run");
		const result = resultFor(messages, "run-1");
		if (result.ok) throw new Error("expected a failed result");
		expect(result.error.message).toContain("interrupted");
		expect(transport.controls.filter(op => op.type === "close")).toHaveLength(0);
	});

	it("settles a run the guest finished without answering", async () => {
		const { session, waitFor, messages } = await openSession();
		// The eval succeeds but no `result` frame ever arrives: the guest drained its
		// event loop with a tool call outstanding. Nothing above this seam has a
		// timer, so an unsettled run here is a hung eval tool.
		transport.script(async () => ({ type: "eval-result", requestId: 0n, result: okResult() }));

		session.send({ type: "run", runId: "run-1", code: "tool.x({})", filename: "cell.js", snapshot: SNAPSHOT });
		await waitFor(hasResult("run-1"), "an unanswered run was never settled");
		const result = resultFor(messages, "run-1");
		if (result.ok) throw new Error("expected a failed result");
		expect(result.error.message).toContain("without producing a result");
	});

	it("faults instead of looping when the eval itself rejects", async () => {
		const { session, errors } = await openSession();
		// The drain's `isEvalSettled` has to flip on the REJECTION arm too. If it
		// only flipped on success, this pump would poll forever at park cadence and
		// the session would never fault.
		transport.script(async () => {
			throw new Error("scripted eval transport failed");
		});

		session.send({ type: "run", runId: "run-1", code: "x", filename: "cell.js", snapshot: SNAPSHOT });
		await withTimeout(
			(async () => {
				while (errors.length === 0) await Bun.sleep(1);
			})(),
			WAIT_TIMEOUT_MS,
			"a rejecting eval never faulted the session",
		);
		expect(errors[0]?.message).toContain("scripted eval transport failed");
	});
});

describe("embedded Elide kernel inbound ordering", () => {
	it("spools a tool reply past the queue while the run that needs it is in flight", async () => {
		const { session, waitFor, messages } = await openSession();
		const spooled = Promise.withResolvers<string>();
		transport.script(async (code, context) => {
			if (!code.includes('"type":"run"')) {
				return { type: "eval-result", requestId: 0n, result: okResult() };
			}
			context.write(frame({ type: "tool-call", id: "tc-1", runId: "run-1", name: "echo", args: { v: 1 } }));
			// The eval is still running: a `tool-reply` that queued behind it would
			// deadlock against the very cell it is meant to unblock.
			const inbox = await withTimeout(spooled.promise, WAIT_TIMEOUT_MS, "tool reply never reached the spool");
			context.write(frame({ type: "text", runId: "run-1", chunk: inbox }));
			context.write(frame({ type: "result", runId: "run-1", ok: true }));
			return { type: "eval-result", requestId: 0n, result: okResult() };
		});

		session.send({
			type: "run",
			runId: "run-1",
			code: "await tool.echo({})",
			filename: "cell.js",
			snapshot: SNAPSHOT,
		});
		await waitFor(seen => seen.some(msg => msg.type === "tool-call"), "guest never asked for a tool");
		session.send({ type: "tool-reply", id: "tc-1", reply: { ok: true, value: "pong" } });

		const spoolPath = await withTimeout(
			(async () => {
				while (true) {
					const entries = await Array.fromAsync(new Bun.Glob("*.jsonl").scan({ cwd: tempDir.path() }));
					const found = entries[0];
					if (found) {
						const contents = await readFile(path.join(tempDir.path(), found), "utf8");
						if (contents.includes("tool-reply")) return contents;
					}
					await Bun.sleep(1);
				}
			})(),
			WAIT_TIMEOUT_MS,
			"tool reply was never spooled",
		);
		spooled.resolve(spoolPath.trim());

		await waitFor(hasResult("run-1"), "the parked run never settled");
		const echoed = messages.find(msg => msg.type === "text");
		expect(echoed?.type === "text" ? echoed.chunk : "").toContain('"type":"tool-reply"');
		expect(echoed?.type === "text" ? echoed.chunk : "").toContain('"value":"pong"');
	});
});

describe("embedded Elide kernel lifecycle asks", () => {
	it("interrupts through the control op without disturbing the context", async () => {
		const { session } = await openSession();
		await withTimeout(session.interrupt(), WAIT_TIMEOUT_MS, "interrupt never settled");
		expect(transport.controls.filter(op => op.type === "interrupt")).toHaveLength(1);
		expect(transport.controls.filter(op => op.type === "close")).toHaveLength(0);
	});

	it("re-bootstraps and replays init after a reset, and clears the spool", async () => {
		const { session, waitFor } = await openSession("/* guest bootstrap */");
		transport.script(async (code, context) => {
			if (code.includes('"type":"init"')) context.write(frame({ type: "ready" }));
			if (code.includes('"type":"run"')) {
				const runId = JSON.parse(code.slice(code.indexOf("(") + 1, code.lastIndexOf(")"))).runId;
				context.write(frame({ type: "result", runId, ok: true }));
			}
			return { type: "eval-result", requestId: 0n, result: okResult() };
		});

		session.send({ type: "init", snapshot: SNAPSHOT });
		await waitFor(seen => seen.some(msg => msg.type === "ready"), "kernel never reported ready");
		session.send({ type: "tool-reply", id: "stale", reply: { ok: true, value: 1 } });
		await Bun.sleep(20);

		await withTimeout(session.reset(), WAIT_TIMEOUT_MS, "kernel reset never settled");
		session.send({ type: "run", runId: "run-1", code: "x", filename: "cell.js", snapshot: SNAPSHOT });
		await waitFor(hasResult("run-1"), "the post-reset run never settled");

		// The reset wiped the guest, so the bundle and the init both had to be
		// replayed before the next cell could run.
		expect(transport.evals.filter(code => code === "/* guest bootstrap */")).toHaveLength(2);
		expect(transport.evals.filter(code => code.includes('"type":"init"'))).toHaveLength(2);
		// A reset guest restarts its spool at offset 0; a reply left there would be
		// replayed into the next run.
		const entries = await Array.fromAsync(new Bun.Glob("*.jsonl").scan({ cwd: tempDir.path() }));
		const spool = entries[0];
		if (!spool) throw new Error("no spool file");
		expect(await readFile(path.join(tempDir.path(), spool), "utf8")).toBe("");
	});

	it("closes the context and removes the spool", async () => {
		const { session, waitFor } = await openSession();
		session.send({ type: "tool-reply", id: "x", reply: { ok: true, value: 1 } });
		await Bun.sleep(20);
		session.send({ type: "close" });
		await waitFor(seen => seen.some(msg => msg.type === "closed"), "close was never acknowledged");

		expect(transport.controls.filter(op => op.type === "close")).toHaveLength(1);
		expect(await Array.fromAsync(new Bun.Glob("*.jsonl").scan({ cwd: tempDir.path() }))).toEqual([]);
	});
});
