import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveJsEvalEngine } from "../../src/eval/elide/settings";
import type { ToolSession } from "../../src/tools";

let originalJsEngine: string | undefined;

function restoreEnv(name: "AURA_EVAL_JS_ENGINE", value: string | undefined): void {
	if (value === undefined) {
		delete Bun.env[name];
		return;
	}
	Bun.env[name] = value;
}

function makeSession(settings = Settings.isolated()): Pick<ToolSession, "settings"> {
	return { settings };
}

describe("eval.jsEngine", () => {
	beforeEach(() => {
		originalJsEngine = Bun.env.AURA_EVAL_JS_ENGINE;
		delete Bun.env.AURA_EVAL_JS_ENGINE;
	});

	afterEach(() => {
		restoreEnv("AURA_EVAL_JS_ENGINE", originalJsEngine);
	});

	it('defaults to "bun" on bare settings', () => {
		expect(resolveJsEvalEngine(makeSession())).toBe("bun");
	});

	it('returns "elide" when the setting selects it', () => {
		const session = makeSession(Settings.isolated({ "eval.jsEngine": "elide" }));
		expect(resolveJsEvalEngine(session)).toBe("elide");
	});

	it("lets AURA_EVAL_JS_ENGINE override the configured engine", () => {
		Bun.env.AURA_EVAL_JS_ENGINE = "elide";
		const session = makeSession(Settings.isolated({ "eval.jsEngine": "bun" }));
		expect(resolveJsEvalEngine(session)).toBe("elide");
	});

	it("throws when AURA_EVAL_JS_ENGINE names an unknown engine", () => {
		Bun.env.AURA_EVAL_JS_ENGINE = "nope";
		expect(() => resolveJsEvalEngine(makeSession())).toThrow(/nope/);
	});

	/** An engine name the enum does not know is rejected, not silently defaulted. */
	it("does not accept an unknown engine value from the environment", () => {
		Bun.env.AURA_EVAL_JS_ENGINE = "deno";
		expect(() => resolveJsEvalEngine(makeSession())).toThrow(/deno/);
	});

	/**
	 * The stored value gets the same validation the env override gets. Without it a
	 * malformed `eval.jsEngine` flows through unchecked, misses the `elide` branch
	 * in `resolveBackend`, and runs on Bun forever with no notice — silently
	 * ignoring a setting `docs/settings.md` promises is an error. That stays wrong
	 * once a kernel lands, which is exactly when it would be hardest to notice.
	 */
	it("throws when the stored setting names an unknown engine", () => {
		const session = makeSession(Settings.isolated({ "eval.jsEngine": "deno" }));
		expect(() => resolveJsEvalEngine(session)).toThrow(/deno/);
		expect(() => resolveJsEvalEngine(session)).toThrow(/eval\.jsEngine/);
	});

	it("accepts both valid stored values", () => {
		for (const engine of ["bun", "elide"] as const) {
			expect(resolveJsEvalEngine(makeSession(Settings.isolated({ "eval.jsEngine": engine })))).toBe(engine);
		}
	});

	/** A valid env override does not rescue a malformed stored value silently. */
	it("reports a malformed stored value even when the env override is valid", () => {
		Bun.env.AURA_EVAL_JS_ENGINE = "bun";
		const session = makeSession(Settings.isolated({ "eval.jsEngine": "deno" }));
		expect(() => resolveJsEvalEngine(session)).toThrow(/deno/);
	});

	it("ignores an empty or whitespace-only AURA_EVAL_JS_ENGINE", () => {
		const session = makeSession(Settings.isolated({ "eval.jsEngine": "elide" }));
		Bun.env.AURA_EVAL_JS_ENGINE = "";
		expect(resolveJsEvalEngine(session)).toBe("elide");
		Bun.env.AURA_EVAL_JS_ENGINE = "   ";
		expect(resolveJsEvalEngine(session)).toBe("elide");
	});
});
