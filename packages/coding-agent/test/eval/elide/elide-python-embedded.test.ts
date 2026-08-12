/**
 * The Elide Python backend against a REAL embedded runtime.
 *
 * Gated on `AURA_RUNTIME_EMBEDDED_LIB`: without an artifact there is nothing to
 * open, and a skipped suite is honest where a mocked one would not be. Cells go
 * through the backend rather than `EvalTool` so the assertions are about the
 * engine, not the tool's cell plumbing.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import elidePythonBackend from "../../../src/eval/elide/python";
import { closeElidePythonContextsForTests } from "../../../src/eval/elide/python-executor";
import {
	createElideEmbeddedPythonKernelFactory,
	type ElideEmbeddedPythonKernelFactory,
	type ElidePythonKernelFactory,
	setElidePythonKernelFactory,
} from "../../../src/eval/elide/python-kernel";

const LIBRARY = Bun.env.AURA_RUNTIME_EMBEDDED_LIB;

function makeSession(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "eval.pyEngine": "elide" }),
	} as unknown as ToolSession;
}

const SESSION_ID = "elide-python-embedded";

async function run(code: string, options: { reset?: boolean } = {}) {
	return await elidePythonBackend.execute(code, {
		cwd: process.cwd(),
		sessionId: SESSION_ID,
		sessionFile: undefined,
		kernelOwnerId: undefined,
		reset: options.reset ?? false,
		session: makeSession(),
		onChunk: () => {},
	});
}

describe.skipIf(!LIBRARY)("Elide Python backend on the embedded runtime", () => {
	let factory: ElideEmbeddedPythonKernelFactory | undefined;
	let restore: ElidePythonKernelFactory | undefined;

	beforeAll(() => {
		factory = createElideEmbeddedPythonKernelFactory({ libraryPath: LIBRARY });
		restore = setElidePythonKernelFactory(factory);
	});

	// Teardown gets its own budget and swallows failures: shutting the native
	// runtime down is slower than Bun's 5s hook default, and a slow close must not
	// be reported as a failing cell.
	afterAll(async () => {
		await closeElidePythonContextsForTests().catch(() => undefined);
		await factory?.dispose().catch(() => undefined);
		setElidePythonKernelFactory(restore);
	}, 120_000);

	it("keeps state across cells", async () => {
		const first = await run("carried = 41");
		expect(first.exitCode).toBe(0);
		const second = await run("print(carried + 1)");
		expect(second.exitCode).toBe(0);
		expect(second.output).toContain("42");
	}, 120_000);

	it("reports a raised error as a value, not a throw", async () => {
		const result = await run("raise ValueError('boom')");
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("boom");
		// The context survived: the next cell still sees the earlier globals.
		const after = await run("print(carried)");
		expect(after.exitCode).toBe(0);
		expect(after.output).toContain("41");
	}, 60_000);

	it("survives sys.exit(3) with the exit status and its variables", async () => {
		const result = await run("import sys\nsys.exit(3)");
		expect(result.exitCode).toBe(3);
		expect(result.cancelled).toBe(false);
		const after = await run("print(carried)");
		expect(after.exitCode).toBe(0);
		expect(after.output).toContain("41");
	}, 60_000);

	/** `allowThreads: true` is load-bearing: without it `threading` raises here. */
	it("runs real threads", async () => {
		const result = await run(
			[
				"import threading",
				"out = [None] * 4",
				"def work(i):",
				"    out[i] = i * i",
				"ts = [threading.Thread(target=work, args=(i,)) for i in range(4)]",
				"for t in ts: t.start()",
				"for t in ts: t.join()",
				"print(out)",
			].join("\n"),
		);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("[0, 1, 4, 9]");
	}, 60_000);

	it("wipes state on reset", async () => {
		const wiped = await run("print(carried)", { reset: true });
		expect(wiped.exitCode).toBe(1);
		expect(wiped.output).toContain("carried");
	}, 60_000);
});
