import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolvePyEvalEngine, resolvePyEvalEngineChoice } from "../../src/eval/elide/settings";
import type { ToolSession } from "../../src/tools";

let originalPyEngine: string | undefined;

function restoreEnv(name: "AURA_EVAL_PY_ENGINE", value: string | undefined): void {
	if (value === undefined) {
		delete Bun.env[name];
		return;
	}
	Bun.env[name] = value;
}

function makeSession(settings = Settings.isolated()): Pick<ToolSession, "settings"> {
	return { settings };
}

describe("eval.pyEngine", () => {
	beforeEach(() => {
		originalPyEngine = Bun.env.AURA_EVAL_PY_ENGINE;
		delete Bun.env.AURA_EVAL_PY_ENGINE;
	});

	afterEach(() => {
		restoreEnv("AURA_EVAL_PY_ENGINE", originalPyEngine);
	});

	it('defaults to "elide" on bare settings', () => {
		expect(resolvePyEvalEngine(makeSession())).toBe("elide");
	});

	it('returns "cpython" when the setting selects it', () => {
		expect(resolvePyEvalEngine(makeSession(Settings.isolated({ "eval.pyEngine": "cpython" })))).toBe("cpython");
	});

	it("lets AURA_EVAL_PY_ENGINE override the configured engine", () => {
		Bun.env.AURA_EVAL_PY_ENGINE = "elide";
		expect(resolvePyEvalEngine(makeSession(Settings.isolated({ "eval.pyEngine": "cpython" })))).toBe("elide");
	});

	it("throws when AURA_EVAL_PY_ENGINE names an unknown engine", () => {
		Bun.env.AURA_EVAL_PY_ENGINE = "nope";
		expect(() => resolvePyEvalEngine(makeSession())).toThrow(/nope/);
	});

	/** `bun` is a valid JS engine and never a valid Python one; the enums do not bleed. */
	it("does not accept an unknown engine value from the environment", () => {
		Bun.env.AURA_EVAL_PY_ENGINE = "bun";
		expect(() => resolvePyEvalEngine(makeSession())).toThrow(/bun/);
	});

	/**
	 * The stored value gets the same validation the env override gets. Without it a
	 * malformed `eval.pyEngine` flows through unchecked, misses the `elide` branch
	 * in `resolveBackend`, and runs on CPython forever with no notice.
	 */
	it("throws when the stored setting names an unknown engine", () => {
		const session = makeSession(Settings.isolated({ "eval.pyEngine": "pypy" }));
		expect(() => resolvePyEvalEngine(session)).toThrow(/pypy/);
		expect(() => resolvePyEvalEngine(session)).toThrow(/eval\.pyEngine/);
	});

	it("accepts both valid stored values", () => {
		for (const engine of ["cpython", "elide"] as const) {
			expect(resolvePyEvalEngine(makeSession(Settings.isolated({ "eval.pyEngine": engine })))).toBe(engine);
		}
	});

	/** A valid env override does not rescue a malformed stored value silently. */
	it("reports a malformed stored value even when the env override is valid", () => {
		Bun.env.AURA_EVAL_PY_ENGINE = "cpython";
		expect(() => resolvePyEvalEngine(makeSession(Settings.isolated({ "eval.pyEngine": "pypy" })))).toThrow(/pypy/);
	});

	it("ignores an empty or whitespace-only AURA_EVAL_PY_ENGINE", () => {
		const session = makeSession(Settings.isolated({ "eval.pyEngine": "elide" }));
		Bun.env.AURA_EVAL_PY_ENGINE = "";
		expect(resolvePyEvalEngine(session)).toBe("elide");
		Bun.env.AURA_EVAL_PY_ENGINE = "   ";
		expect(resolvePyEvalEngine(session)).toBe("elide");
	});
});

/**
 * Provenance drives ONE thing: whether an unserveable `elide` selection earns a
 * fallback notice. Now that `elide` is the default, a host with no runtime
 * library would otherwise stamp that notice on every python cell a user who
 * never chose an engine ever runs.
 */
describe("eval.pyEngine provenance", () => {
	beforeEach(() => {
		originalPyEngine = Bun.env.AURA_EVAL_PY_ENGINE;
		delete Bun.env.AURA_EVAL_PY_ENGINE;
	});

	afterEach(() => {
		restoreEnv("AURA_EVAL_PY_ENGINE", originalPyEngine);
	});

	it("reports the default selection as implicit", () => {
		expect(resolvePyEvalEngineChoice(makeSession())).toEqual({ engine: "elide", explicit: false });
	});

	it("reports a stored value as explicit, whichever engine it names", () => {
		for (const engine of ["cpython", "elide"] as const) {
			expect(resolvePyEvalEngineChoice(makeSession(Settings.isolated({ "eval.pyEngine": engine })))).toEqual({
				engine,
				explicit: true,
			});
		}
	});

	it("reports an env override as explicit even with nothing stored", () => {
		Bun.env.AURA_EVAL_PY_ENGINE = "elide";
		expect(resolvePyEvalEngineChoice(makeSession())).toEqual({ engine: "elide", explicit: true });
	});

	/** Blank values are not a choice — exactly the values the resolvers already ignore. */
	it("does not count a blank AURA_EVAL_PY_ENGINE as a choice", () => {
		Bun.env.AURA_EVAL_PY_ENGINE = "   ";
		expect(resolvePyEvalEngineChoice(makeSession())).toEqual({ engine: "elide", explicit: false });
	});
});
