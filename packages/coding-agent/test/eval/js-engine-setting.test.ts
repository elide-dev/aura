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

	it("ignores an empty or whitespace-only AURA_EVAL_JS_ENGINE", () => {
		const session = makeSession(Settings.isolated({ "eval.jsEngine": "elide" }));
		Bun.env.AURA_EVAL_JS_ENGINE = "";
		expect(resolveJsEvalEngine(session)).toBe("elide");
		Bun.env.AURA_EVAL_JS_ENGINE = "   ";
		expect(resolveJsEvalEngine(session)).toBe("elide");
	});
});
