/**
 * The Elide Python engine against a REAL embedded runtime.
 *
 * Gated on `AURA_RUNTIME_EMBEDDED_LIB`: without an artifact there is nothing to
 * open, and a skipped suite is honest where a mocked one would not be.
 *
 * Two suites, split by what they are about. The first drives the BACKEND
 * directly, so its assertions are about the engine rather than the tool's cell
 * plumbing. The second drives `EvalTool` with a session that configures nothing,
 * because what it pins is the dispatch decision the flipped default produces.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { $which } from "@oh-my-pi/pi-utils";
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

	/**
	 * Pins a DEFECT the prompt now discloses: unlike the CPython/IPython kernel,
	 * this engine does not echo a bare trailing expression — the cell succeeds
	 * with empty output, which a model reads as "the value is empty" unless the
	 * prompt warns it (eval.md's pyElide line does). The day result capture or
	 * an echo transform lands (capabilities.captureResultValue, or a host-side
	 * AST wrap), this test MUST flip to assert the echo and the prompt clause
	 * MUST come out — that is the point of pinning it.
	 */
	it("does not echo a bare trailing expression (print() is required)", async () => {
		const setup = await run("kept = 7");
		expect(setup.exitCode).toBe(0);
		const bare = await run("kept * 6");
		expect(bare.exitCode).toBe(0);
		expect(bare.output.trim()).toBe("");
		// The value exists; only the echo is missing.
		const printed = await run("print(kept * 6)");
		expect(printed.exitCode).toBe(0);
		expect(printed.output).toContain("42");
	}, 60_000);

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

const HAS_CPYTHON = Boolean(Bun.env.PYTHON ?? ($which("python3") ? "python3" : $which("python")));

/** The model-visible text of a tool result, with any image parts dropped. */
function cellText(content: readonly { type: string }[]): string {
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map(part => part.text)
		.join("\n");
}

/**
 * The default flip, end to end on a real artifact: a session that configures
 * NOTHING serves plain python cells from a runtime context, and a bridge-using
 * cell in that same session is rerouted to CPython.
 *
 * Cells go through `EvalTool` rather than the backend because the thing under
 * test is the dispatch decision, not the engine.
 */
describe.skipIf(!LIBRARY)("Default-session python dispatch on the embedded runtime", () => {
	let factory: ElideEmbeddedPythonKernelFactory | undefined;
	let restore: ElidePythonKernelFactory | undefined;
	let savedEngineEnv: string | undefined;

	/** Nothing stored, nothing exported: the schema default has to be what picks elide. */
	function defaultSession(): ToolSession {
		return {
			cwd: process.cwd(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getEvalSessionId: () => "elide-python-default-dispatch",
			settings: Settings.isolated(),
		} as unknown as ToolSession;
	}

	beforeAll(() => {
		savedEngineEnv = Bun.env.AURA_EVAL_PY_ENGINE;
		delete Bun.env.AURA_EVAL_PY_ENGINE;
		factory = createElideEmbeddedPythonKernelFactory({ libraryPath: LIBRARY });
		restore = setElidePythonKernelFactory(factory);
	});

	afterAll(async () => {
		await closeElidePythonContextsForTests().catch(() => undefined);
		await factory?.dispose().catch(() => undefined);
		setElidePythonKernelFactory(restore);
		if (savedEngineEnv === undefined) delete Bun.env.AURA_EVAL_PY_ENGINE;
		else Bun.env.AURA_EVAL_PY_ENGINE = savedEngineEnv;
	}, 120_000);

	it("serves plain cells from a runtime context, with state across calls and no notice", async () => {
		const tool = new EvalTool(defaultSession());
		const first = await tool.execute("default-real-1", { language: "py", code: "kept = 7" });
		expect(first.details?.notice).toBeUndefined();

		const second = await tool.execute("default-real-2", { language: "py", code: "print(kept * 6)" });
		expect(cellText(second.content)).toContain("42");
		expect(second.details?.notice).toBeUndefined();
		expect(second.details?.language).toBe("python");
	}, 120_000);

	/**
	 * The reroute, and the state split it costs. `kept` was set on the runtime
	 * context by the test above; the CPython kernel this cell lands in has never
	 * heard of it, which is exactly what the notice warns about.
	 */
	it.skipIf(!HAS_CPYTHON)(
		"routes a bridge-using cell to CPython, into its own state universe",
		async () => {
			const tool = new EvalTool(defaultSession());
			const result = await tool.execute("default-real-bridge", {
				language: "py",
				code: "print(len(read('package.json')) > 0)\nprint('kept' in dir())",
			});

			expect(result.details?.notice).toContain("ran on the CPython engine");
			expect(result.details?.notice).toContain("does not see variables");
			const text = cellText(result.content);
			expect(text).toContain("True");
			// Two state universes: the runtime context's `kept` is not here.
			expect(text).toContain("False");
		},
		180_000,
	);
});
