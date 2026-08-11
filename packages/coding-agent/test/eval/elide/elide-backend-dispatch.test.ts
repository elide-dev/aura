/**
 * Engine selection at the eval-tool dispatch seam.
 *
 * Elide is an ENGINE for `language: "js"`, not a new language: every case below
 * drives a `js` cell through `EvalTool` and asserts the tool-facing surface —
 * `details.language` / `details.languages` — still says `js` no matter which
 * engine ran it. That is the same invariant `test/tools/eval-description.test.ts`
 * pins from the schema side, which is why this feature must not touch it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as evalIndex from "@oh-my-pi/pi-coding-agent/eval";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { withTimeout } from "@oh-my-pi/pi-utils";
import elideBackend from "../../../src/eval/elide";
import { type ElideJsKernelFactory, setElideJsKernelFactory } from "../../../src/eval/elide/kernel";
import { createFakeElideJsKernelFactory } from "./fake-kernel";

/** Bounds every real await so a wedged kernel fails loudly, under Bun's 5s default. */
const WAIT_TIMEOUT_MS = 4_000;

/** The exact fallback wording surfaced when `elide` is asked for but unavailable. */
const FALLBACK_NOTICE = "Elide JS engine unavailable; ran on the Bun engine.";

type EnvName = "PI_JS" | "AURA_EVAL_JS_ENGINE";

const savedEnv = new Map<EnvName, string | undefined>();
let restoreFactory: ElideJsKernelFactory | undefined;

function restoreEnv(name: EnvName, value: string | undefined): void {
	if (value === undefined) {
		delete Bun.env[name];
		return;
	}
	Bun.env[name] = value;
}

function makeSession(settings = Settings.isolated()): ToolSession {
	return {
		// A real directory: the fake kernel runs cells in a real JS runtime that
		// enters the session cwd.
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

describe("EvalTool JS engine dispatch", () => {
	beforeEach(() => {
		for (const name of ["PI_JS", "AURA_EVAL_JS_ENGINE"] as const) {
			savedEnv.set(name, Bun.env[name]);
			delete Bun.env[name];
		}
		// Production installs no kernel factory; start every case from that state.
		restoreFactory = setElideJsKernelFactory(undefined);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setElideJsKernelFactory(restoreFactory);
		restoreFactory = undefined;
		for (const [name, value] of savedEnv) restoreEnv(name, value);
		savedEnv.clear();
		await withTimeout(disposeAllVmContexts(), WAIT_TIMEOUT_MS, "VM context disposal never settled");
	});

	it("runs js cells on the Bun engine by default and never reaches the Elide backend", async () => {
		const jsExecute = vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(mockResult);
		const elideExecute = vi.spyOn(elideBackend, "execute");
		const elideAvailable = vi.spyOn(elideBackend, "isAvailable");

		const tool = new EvalTool(makeSession());
		const result = await withTimeout(
			tool.execute("call-default-engine", { language: "js", code: "const x = 1;" }),
			WAIT_TIMEOUT_MS,
			"default-engine cell",
		);

		expect(jsExecute).toHaveBeenCalledTimes(1);
		expect(elideExecute).not.toHaveBeenCalled();
		// Not even asked about: dispatch short-circuits before the lazy import, so
		// a default session never loads the Elide backend at all.
		expect(elideAvailable).not.toHaveBeenCalled();
		expect(result.details?.notice).toBeUndefined();
		expect(result.details?.language).toBe("js");
	});

	it("falls back to the Bun engine with a notice when elide is selected but no kernel exists", async () => {
		const jsExecute = vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(mockResult);
		const elideExecute = vi.spyOn(elideBackend, "execute");
		const elideAvailable = vi.spyOn(elideBackend, "isAvailable");

		const tool = new EvalTool(makeSession(Settings.isolated({ "eval.jsEngine": "elide" })));
		const result = await withTimeout(
			tool.execute("call-elide-no-kernel", { language: "js", code: "const x = 1;" }),
			WAIT_TIMEOUT_MS,
			"elide-no-kernel cell",
		);

		// Falling back is graceful, but never silent: the cell ran on an engine the
		// caller did not pick, so the result has to say so.
		expect(elideAvailable).toHaveBeenCalledTimes(1);
		expect(await elideAvailable.mock.results[0]?.value).toBe(false);
		expect(jsExecute).toHaveBeenCalledTimes(1);
		expect(elideExecute).not.toHaveBeenCalled();
		expect(result.details?.notice).toBe(FALLBACK_NOTICE);
		expect(result.details?.language).toBe("js");
	});

	it("runs js cells on the Elide backend when a kernel factory is installed", async () => {
		const factory = createFakeElideJsKernelFactory();
		setElideJsKernelFactory(factory);
		const jsExecute = vi.spyOn(evalIndex.jsBackend, "execute");
		// Not mocked: the cell really executes on the injected kernel, so this
		// proves the Elide executor drives the worker protocol end to end.
		const elideExecute = vi.spyOn(elideBackend, "execute");

		const tool = new EvalTool(makeSession(Settings.isolated({ "eval.jsEngine": "elide" })));
		const result = await withTimeout(
			tool.execute("call-elide-kernel", { language: "js", code: "console.log('elide-cell-ran');" }),
			WAIT_TIMEOUT_MS,
			"elide-kernel cell",
		);

		expect(elideExecute).toHaveBeenCalledTimes(1);
		expect(jsExecute).not.toHaveBeenCalled();
		// The kernel really opened, under the Elide-namespaced session key.
		expect(factory.opens).toHaveLength(1);
		expect(factory.opens[0]?.sessionId).toStartWith("js-elide:");
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("elide-cell-ran") });
		// The engine changed; the language the tool reports did not.
		expect(result.details?.language).toBe("js");
		expect(result.details?.languages).toEqual(["js"]);
		expect(result.details?.cells?.[0]?.language).toBe("js");
		expect(result.details?.notice).toBeUndefined();
		expect(result.details?.isError).toBeUndefined();
	});

	it("rejects js cells with the same disabled error on either engine", async () => {
		const factory = createFakeElideJsKernelFactory();
		setElideJsKernelFactory(factory);
		const elideExecute = vi.spyOn(elideBackend, "execute");
		const jsExecute = vi.spyOn(evalIndex.jsBackend, "execute");

		for (const engine of ["bun", "elide"] as const) {
			const tool = new EvalTool(makeSession(Settings.isolated({ "eval.js": false, "eval.jsEngine": engine })));
			await expect(
				tool.execute(`call-js-disabled-${engine}`, { language: "js", code: "const x = 1;" }),
			).rejects.toThrow(/eval\.js = false/);
		}

		// The disable is checked before engine selection: an available Elide kernel
		// must not become a way around `eval.js = false`.
		expect(elideExecute).not.toHaveBeenCalled();
		expect(jsExecute).not.toHaveBeenCalled();
		expect(factory.opens).toHaveLength(0);
	});

	it("surfaces a malformed AURA_EVAL_JS_ENGINE as a ToolError", async () => {
		Bun.env.AURA_EVAL_JS_ENGINE = "nope";
		const jsExecute = vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(mockResult);

		const tool = new EvalTool(makeSession());
		const error = await tool
			.execute("call-bad-engine-env", { language: "js", code: "const x = 1;" })
			.then(() => undefined)
			.catch((thrown: unknown) => thrown);

		// Host misconfiguration the caller can fix, like the disabled-backend cases
		// next to it — so it travels the same ToolError channel, message intact,
		// instead of escaping as an unexpected internal failure.
		expect(error).toBeInstanceOf(ToolError);
		expect((error as Error).message).toContain("AURA_EVAL_JS_ENGINE must be bun or elide");
		expect(jsExecute).not.toHaveBeenCalled();
	});
});
