/**
 * Python engine selection at the eval-tool dispatch seam.
 *
 * Elide is an ENGINE for `language: "python"`, not a new language: the
 * tool-facing surface (`details.language` / `details.languages`) still says
 * `python` no matter which engine ran the cell.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as evalIndex from "@oh-my-pi/pi-coding-agent/eval";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { withTimeout } from "@oh-my-pi/pi-utils";
import elidePythonBackend from "../../../src/eval/elide/python";
import { closeElidePythonContextsForTests, findEvalToolBridgeUse } from "../../../src/eval/elide/python-executor";
import {
	type ElidePythonKernelFactory,
	type ElidePythonKernelSession,
	ensureElidePythonKernelFactory,
	resetElidePythonKernelInstallForTests,
	setElidePythonKernelFactory,
} from "../../../src/eval/elide/python-kernel";

const WAIT_TIMEOUT_MS = 4_000;

/** The exact fallback wording surfaced when `elide` is asked for but unavailable. */
const FALLBACK_NOTICE = "Elide Python engine unavailable; ran on the CPython engine.";

type EnvName = "PI_PY" | "AURA_EVAL_PY_ENGINE";

const savedEnv = new Map<EnvName, string | undefined>();
let restoreFactory: ElidePythonKernelFactory | undefined;

interface FakeFactory extends ElidePythonKernelFactory {
	opens: { sessionId: string; cwd: string }[];
	runs: string[];
	resets: number;
}

/** A kernel that echoes canned output; enough to pin dispatch, namespacing, and reset. */
function createFakePythonKernelFactory(): FakeFactory {
	const factory: FakeFactory = {
		opens: [],
		runs: [],
		resets: 0,
		async open(options) {
			factory.opens.push({ sessionId: options.sessionId, cwd: options.cwd });
			const session: ElidePythonKernelSession = {
				async run(code, runOptions) {
					factory.runs.push(code);
					runOptions.onText("fake-python-cell-ran\n");
					return { type: "ok" };
				},
				async reset() {
					factory.resets += 1;
				},
				async interrupt() {},
				async close() {},
			};
			return session;
		},
	};
	return factory;
}

function makeSession(settings = Settings.isolated()): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings,
	} as unknown as ToolSession;
}

const mockResult = {
	output: "ok",
	exitCode: 0,
	cancelled: false,
	truncated: false,
	artifactId: undefined,
	totalLines: 1,
	totalBytes: 2,
	outputLines: 1,
	outputBytes: 2,
	displayOutputs: [],
};

describe("EvalTool Python engine dispatch", () => {
	beforeEach(async () => {
		for (const name of ["PI_PY", "AURA_EVAL_PY_ENGINE"] as const) {
			savedEnv.set(name, Bun.env[name]);
			delete Bun.env[name];
		}
		restoreFactory = setElidePythonKernelFactory(undefined);
		// `isAvailable()` is also the install site, so pin the process-wide attempt
		// to "no library found" — a nonblank configured path is BINDING, which holds
		// even when this file runs with AURA_RUNTIME_EMBEDDED_LIB exported.
		resetElidePythonKernelInstallForTests();
		await ensureElidePythonKernelFactory({ embeddedPath: "/nonexistent/no-python-kernel-for-dispatch.so" });
		// The CPython backend is mocked available everywhere below; the elide branch
		// sits behind that gate today (recorded).
		vi.spyOn(evalIndex.pythonBackend, "isAvailable").mockResolvedValue(true);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setElidePythonKernelFactory(restoreFactory);
		restoreFactory = undefined;
		resetElidePythonKernelInstallForTests();
		for (const [name, value] of savedEnv) restoreEnv(name, value);
		savedEnv.clear();
		await withTimeout(closeElidePythonContextsForTests(), WAIT_TIMEOUT_MS, "Python context disposal never settled");
	});

	function restoreEnv(name: EnvName, value: string | undefined): void {
		if (value === undefined) {
			delete Bun.env[name];
			return;
		}
		Bun.env[name] = value;
	}

	it("runs python cells on CPython by default and never reaches the Elide backend", async () => {
		const pyExecute = vi.spyOn(evalIndex.pythonBackend, "execute").mockResolvedValue(mockResult);
		const elideExecute = vi.spyOn(elidePythonBackend, "execute");
		const elideAvailable = vi.spyOn(elidePythonBackend, "isAvailable");

		const tool = new EvalTool(makeSession());
		const result = await withTimeout(
			tool.execute("call-default-py-engine", { language: "py", code: "x = 1" }),
			WAIT_TIMEOUT_MS,
			"default python cell",
		);

		expect(pyExecute).toHaveBeenCalledTimes(1);
		expect(elideExecute).not.toHaveBeenCalled();
		expect(elideAvailable).not.toHaveBeenCalled();
		expect(result.details?.notice).toBeUndefined();
		expect(result.details?.language).toBe("python");
	});

	it("falls back to CPython with a notice when the runtime engine has no kernel", async () => {
		const pyExecute = vi.spyOn(evalIndex.pythonBackend, "execute").mockResolvedValue(mockResult);
		const elideExecute = vi.spyOn(elidePythonBackend, "execute");
		const elideAvailable = vi.spyOn(elidePythonBackend, "isAvailable");

		const tool = new EvalTool(makeSession(Settings.isolated({ "eval.pyEngine": "elide" })));
		const result = await withTimeout(
			tool.execute("call-py-elide-no-kernel", { language: "py", code: "x = 1" }),
			WAIT_TIMEOUT_MS,
			"python no-kernel cell",
		);

		expect(elideAvailable).toHaveBeenCalledTimes(1);
		expect(await elideAvailable.mock.results[0]?.value).toBe(false);
		expect(pyExecute).toHaveBeenCalledTimes(1);
		expect(elideExecute).not.toHaveBeenCalled();
		expect(result.details?.notice).toBe(FALLBACK_NOTICE);
		expect(result.details?.language).toBe("python");
	});

	it("runs python cells on the Elide backend when a kernel factory is installed", async () => {
		const factory = createFakePythonKernelFactory();
		setElidePythonKernelFactory(factory);
		const pyExecute = vi.spyOn(evalIndex.pythonBackend, "execute");
		const elideExecute = vi.spyOn(elidePythonBackend, "execute");

		const tool = new EvalTool(makeSession(Settings.isolated({ "eval.pyEngine": "elide" })));
		const result = await withTimeout(
			tool.execute("call-py-elide-kernel", { language: "py", code: "print('hi')" }),
			WAIT_TIMEOUT_MS,
			"python elide cell",
		);

		expect(elideExecute).toHaveBeenCalledTimes(1);
		expect(pyExecute).not.toHaveBeenCalled();
		expect(factory.opens).toHaveLength(1);
		expect(factory.opens[0]?.sessionId).toStartWith("python-elide:");
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("fake-python-cell-ran") });
		// The engine changed; the language the tool reports did not.
		expect(result.details?.language).toBe("python");
		expect(result.details?.languages).toEqual(["python"]);
		expect(result.details?.notice).toBeUndefined();
	});

	it("surfaces a malformed AURA_EVAL_PY_ENGINE as a ToolError", async () => {
		Bun.env.AURA_EVAL_PY_ENGINE = "pypy";
		const pyExecute = vi.spyOn(evalIndex.pythonBackend, "execute").mockResolvedValue(mockResult);

		const tool = new EvalTool(makeSession());
		const error = await tool
			.execute("call-bad-py-engine-env", { language: "py", code: "x = 1" })
			.then(() => undefined)
			.catch((thrown: unknown) => thrown);

		expect(error).toBeInstanceOf(ToolError);
		expect((error as Error).message).toContain("AURA_EVAL_PY_ENGINE must be cpython or elide");
		expect(pyExecute).not.toHaveBeenCalled();
	});
});

describe("Elide Python tool-bridge gap", () => {
	/**
	 * There is no Python-side guest shim over the host tool spool, so the prelude's
	 * helpers do not exist in an Elide context. A cell using one must say so and
	 * name the engine that can serve it, rather than raising a bare NameError.
	 */
	it("names the missing bridge helper and points at the cpython engine", async () => {
		const factory = createFakePythonKernelFactory();
		const restore = setElidePythonKernelFactory(factory);
		try {
			const result = await elidePythonBackend.execute('print(read("README.md"))', {
				cwd: process.cwd(),
				sessionId: "bridge-gap",
				sessionFile: undefined,
				kernelOwnerId: undefined,
				reset: false,
				session: makeSession(),
				onChunk: () => {},
			});
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain("read()");
			expect(result.output).toContain("cpython");
			// The gap is refused before a context is ever opened.
			expect(factory.opens).toHaveLength(0);
		} finally {
			setElidePythonKernelFactory(restore);
		}
	});

	it("does not mistake attribute calls or user-defined names for bridge helpers", () => {
		expect(findEvalToolBridgeUse("with open('f') as f:\n    data = f.read()\n")).toBeUndefined();
		expect(findEvalToolBridgeUse("my_display(1)")).toBeUndefined();
		expect(findEvalToolBridgeUse("agent('do a thing')")).toBe("agent");
	});
});
