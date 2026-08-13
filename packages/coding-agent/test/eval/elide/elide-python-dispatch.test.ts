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
	resetElidePythonKernelInstallForTests,
	setElidePythonKernelFactory,
} from "../../../src/eval/elide/python-kernel";

const WAIT_TIMEOUT_MS = 4_000;

/** The exact fallback wording surfaced when `elide` is asked for BY NAME but unavailable. */
const FALLBACK_NOTICE = "Elide Python engine unavailable; ran on the CPython engine.";

/** The exact wording surfaced when a bridge-using cell is rerouted off the runtime engine. */
const BRIDGE_REROUTE_NOTICE =
	"This cell calls eval tool helpers; the Elide Python engine has no tool bridge yet, so it ran on the CPython engine. " +
	"It ran in the CPython kernel's own session state, so it does not see variables that earlier cells set on the Elide engine.";

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

const NO_RUNTIME_LIBRARY = "/nonexistent/no-python-kernel-for-dispatch.so";

function makeSession(settings = Settings.isolated()): ToolSession {
	// `isAvailable()` is also the install site, and since only SUCCESS is
	// memoized a pre-primed failed attempt does not stick. A nonblank
	// configured path is BINDING, so stamping it on every test session keeps
	// these cases hermetic even with AURA_RUNTIME_EMBEDDED_LIB exported.
	settings.set("runtime.embeddedPath" as never, NO_RUNTIME_LIBRARY as never);
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings,
	} as unknown as ToolSession;
}

/** The model-visible text of a tool result, with any image parts dropped. */
function cellText(content: readonly { type: string }[]): string {
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map(part => part.text)
		.join("\n");
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
		// Hermeticity rides `makeSession`'s binding `runtime.embeddedPath` stamp
		// (see above); the reset just forgets any earlier file's attempt.
		resetElidePythonKernelInstallForTests();
		// CPython is mocked available by default so the cases below vary one thing at
		// a time; the tests that pin the Piece 1 hoist re-stub it to false.
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

	it("runs python cells on the Elide engine by default when a kernel is installed", async () => {
		const factory = createFakePythonKernelFactory();
		setElidePythonKernelFactory(factory);
		const pyExecute = vi.spyOn(evalIndex.pythonBackend, "execute").mockResolvedValue(mockResult);
		const elideExecute = vi.spyOn(elidePythonBackend, "execute");

		// Nothing stored, nothing exported: the flipped schema default selects elide.
		const tool = new EvalTool(makeSession());
		const result = await withTimeout(
			tool.execute("call-default-py-engine", { language: "py", code: "x = 1" }),
			WAIT_TIMEOUT_MS,
			"default python cell",
		);

		expect(elideExecute).toHaveBeenCalledTimes(1);
		expect(pyExecute).not.toHaveBeenCalled();
		expect(result.details?.notice).toBeUndefined();
		expect(result.details?.language).toBe("python");
	});

	/**
	 * Notice provenance. A user who never chose an engine and has no runtime
	 * library gets exactly the behavior they always had, so a fallback notice on
	 * every python cell would be pure noise.
	 */
	it("falls back to CPython with NO notice when the default selection has no kernel", async () => {
		const pyExecute = vi.spyOn(evalIndex.pythonBackend, "execute").mockResolvedValue(mockResult);
		const elideExecute = vi.spyOn(elidePythonBackend, "execute");

		const tool = new EvalTool(makeSession());
		const result = await withTimeout(
			tool.execute("call-default-py-no-kernel", { language: "py", code: "x = 1" }),
			WAIT_TIMEOUT_MS,
			"default python no-kernel cell",
		);

		expect(pyExecute).toHaveBeenCalledTimes(1);
		expect(elideExecute).not.toHaveBeenCalled();
		expect(result.details?.notice).toBeUndefined();
	});

	it("runs python cells on CPython when the setting pins that engine", async () => {
		const pyExecute = vi.spyOn(evalIndex.pythonBackend, "execute").mockResolvedValue(mockResult);
		const elideExecute = vi.spyOn(elidePythonBackend, "execute");
		const elideAvailable = vi.spyOn(elidePythonBackend, "isAvailable");

		const tool = new EvalTool(makeSession(Settings.isolated({ "eval.pyEngine": "cpython" })));
		const result = await withTimeout(
			tool.execute("call-pinned-cpython", { language: "py", code: "x = 1" }),
			WAIT_TIMEOUT_MS,
			"pinned cpython cell",
		);

		expect(pyExecute).toHaveBeenCalledTimes(1);
		expect(elideExecute).not.toHaveBeenCalled();
		expect(elideAvailable).not.toHaveBeenCalled();
		expect(result.details?.notice).toBeUndefined();
		expect(result.details?.language).toBe("python");
	});

	it("falls back to CPython with a notice when the runtime engine was asked for by name", async () => {
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

	/**
	 * Piece 1 — the hoist. Engine selection resolves ABOVE the CPython
	 * availability gate, so a host with the runtime artifact and no CPython
	 * interpreter reaches the engine it selected instead of being told to install
	 * a kernel the engine does not use.
	 */
	it("runs plain cells on Elide when the host has a kernel but no CPython at all", async () => {
		vi.spyOn(evalIndex.pythonBackend, "isAvailable").mockResolvedValue(false);
		const factory = createFakePythonKernelFactory();
		setElidePythonKernelFactory(factory);
		const pyExecute = vi.spyOn(evalIndex.pythonBackend, "execute");
		const elideExecute = vi.spyOn(elidePythonBackend, "execute");

		const tool = new EvalTool(makeSession());
		const result = await withTimeout(
			tool.execute("call-py-no-cpython", { language: "py", code: "print('hi')" }),
			WAIT_TIMEOUT_MS,
			"no-cpython elide cell",
		);

		expect(elideExecute).toHaveBeenCalledTimes(1);
		expect(pyExecute).not.toHaveBeenCalled();
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("fake-python-cell-ran") });
		expect(result.details?.notice).toBeUndefined();
	});

	/** Neither engine can be served: the error has to name BOTH gaps, not just CPython. */
	it("names both missing engines when neither a runtime kernel nor CPython exists", async () => {
		vi.spyOn(evalIndex.pythonBackend, "isAvailable").mockResolvedValue(false);

		const tool = new EvalTool(makeSession());
		const error = await tool
			.execute("call-py-nothing-installed", { language: "py", code: "x = 1" })
			.then(() => undefined)
			.catch((thrown: unknown) => thrown);

		expect(error).toBeInstanceOf(ToolError);
		expect((error as Error).message).toContain("no runtime Python kernel is installed");
		expect((error as Error).message).toContain("no CPython kernel was found");
	});

	/**
	 * Piece 2 — the reroute. The runtime engine has no Python tool bridge, and the
	 * eval prompt documents the helpers, so a bridge-using cell must RUN on
	 * CPython rather than fail. The notice is not provenance-gated: it explains
	 * surprising state behavior, not a missing install.
	 */
	it("routes a bridge-using cell to CPython with a notice instead of failing it", async () => {
		const factory = createFakePythonKernelFactory();
		setElidePythonKernelFactory(factory);
		const pyExecute = vi.spyOn(evalIndex.pythonBackend, "execute").mockResolvedValue(mockResult);
		const elideExecute = vi.spyOn(elidePythonBackend, "execute");

		const tool = new EvalTool(makeSession());
		const result = await withTimeout(
			tool.execute("call-py-bridge-reroute", { language: "py", code: 'print(read("README.md"))' }),
			WAIT_TIMEOUT_MS,
			"bridge reroute cell",
		);

		expect(pyExecute).toHaveBeenCalledTimes(1);
		expect(elideExecute).not.toHaveBeenCalled();
		// No context is opened for a cell the runtime engine never sees.
		expect(factory.opens).toHaveLength(0);
		expect(result.details?.notice).toBe(BRIDGE_REROUTE_NOTICE);
		expect(result.details?.language).toBe("python");
	});

	/** With no CPython to reroute to, the cell fails as a VALUE naming the real remedy. */
	it("fails a bridge-using cell with the reworded gap when CPython is unavailable", async () => {
		vi.spyOn(evalIndex.pythonBackend, "isAvailable").mockResolvedValue(false);
		const factory = createFakePythonKernelFactory();
		setElidePythonKernelFactory(factory);
		const pyExecute = vi.spyOn(evalIndex.pythonBackend, "execute");

		const tool = new EvalTool(makeSession());
		const result = await withTimeout(
			tool.execute("call-py-bridge-no-cpython", { language: "py", code: 'print(read("README.md"))' }),
			WAIT_TIMEOUT_MS,
			"bridge no-cpython cell",
		);

		expect(pyExecute).not.toHaveBeenCalled();
		const text = cellText(result.content);
		expect(text).toContain("read()");
		expect(text).toContain("no CPython kernel is installed");
		// It can no longer point at the cpython ENGINE: switching would fail the
		// same cell differently on a host with no CPython kernel.
		expect(text).not.toContain("eval.pyEngine");
		expect(factory.opens).toHaveLength(0);
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
	 * helpers do not exist in an Elide context. Dispatch normally reroutes such a
	 * cell to CPython; reaching the executor with one means no CPython kernel
	 * exists, so the refusal names the gap and the remedy that actually applies —
	 * installing a kernel, NOT switching `eval.pyEngine`, which would fail the same
	 * cell differently.
	 */
	it("names the missing bridge helper and the remedy that applies without CPython", async () => {
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
			expect(result.output).toContain("no CPython kernel is installed");
			expect(result.output).toContain("Install the python kernel");
			expect(result.output).not.toContain("eval.pyEngine");
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
