import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Tool as AiTool } from "@oh-my-pi/pi-ai";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool, getEvalToolDescription } from "@oh-my-pi/pi-coding-agent/tools/eval";

function makeSession(opts: { spawns?: string | null; backends?: Record<string, boolean> }): ToolSession {
	const settings = Settings.isolated();
	for (const [key, value] of Object.entries(opts.backends ?? {})) settings.set(key as never, value);
	return {
		cwd: "/tmp/eval-test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => opts.spawns ?? "*",
		settings,
	} as unknown as ToolSession;
}

/** Pull the model-facing cell-schema fields (sorted `language` enum + descriptions) from the flat wire schema. */
function wireCellFields(tool: EvalTool): {
	languages: string[];
	languageDescription?: string;
	codeDescription?: string;
} {
	const wire = toolWireSchema(tool as unknown as AiTool) as {
		properties?: {
			language?: { enum?: string[]; const?: string; description?: string };
			code?: { description?: string };
		};
	};
	const props = wire.properties;
	const language = props?.language;
	const languages = Array.isArray(language?.enum)
		? [...language.enum].sort()
		: typeof language?.const === "string"
			? [language.const]
			: [];
	return {
		languages,
		languageDescription: language?.description,
		codeDescription: props?.code?.description,
	};
}

describe("eval tool description", () => {
	it("advertises agent() when spawns are allowed", () => {
		const text = getEvalToolDescription({ py: true, js: true, spawns: true });
		expect(text).toContain("agent(prompt");
	});

	it("omits agent() when the session forbids spawning", () => {
		// Subagents with spawns: undefined (resolved to "") cannot launch tasks.
		// The prelude doc must not promise a helper that always throws.
		const text = getEvalToolDescription({ py: true, js: true, spawns: false });
		expect(text).not.toContain("agent(prompt");
	});

	it("EvalTool description reflects spawn policy from the session", () => {
		const wildcard = new EvalTool(makeSession({ spawns: "*" })).description;
		const denied = new EvalTool(makeSession({ spawns: "" })).description;
		expect(wildcard).toContain("agent(prompt");
		expect(denied).not.toContain("agent(prompt");
	});
});

describe("eval tool description JS engine", () => {
	const savedEngineEnv = Bun.env.AURA_EVAL_JS_ENGINE;

	afterEach(() => {
		if (savedEngineEnv === undefined) delete Bun.env.AURA_EVAL_JS_ENGINE;
		else Bun.env.AURA_EVAL_JS_ENGINE = savedEngineEnv;
	});

	it("promises Bun globals by default", () => {
		const text = getEvalToolDescription({ py: true, js: true });
		expect(text).toContain("JS runs under **Bun**");
		expect(text).toContain("Bun.$");
		expect(text).not.toContain("managed runtime");
	});

	it("promises only what survives a fallback when the runtime engine is selected", () => {
		const text = getEvalToolDescription({ py: true, js: true, jsEngine: "elide" });
		expect(text).toContain("JS runs on the **managed runtime**");
		expect(text).not.toContain("JS runs under **Bun**");
		// Every claim on this line has to hold on BOTH engines: the description is
		// assembled long before any cell runs, and a session that asks for the
		// runtime engine still lands on Bun when no library resolves. `Bun.$` is the
		// one Bun-only global, so it is the one that goes.
		expect(text).not.toContain("Bun.$");
		expect(text).toContain("Bun.file");
		expect(text).toContain("top-level `await`/`return` work");
	});

	it("says nothing about either engine when JS is disabled", () => {
		const text = getEvalToolDescription({ py: true, js: false, jsEngine: "elide" });
		expect(text).not.toContain("managed runtime");
		expect(text).not.toContain("JS runs under **Bun**");
	});

	it("EvalTool follows the session's engine setting", () => {
		const session = makeSession({ backends: {} });
		session.settings.set("eval.jsEngine" as never, "elide" as never);
		expect(new EvalTool(session).description).toContain("JS runs on the **managed runtime**");
	});

	it("degrades to the Bun line instead of throwing on a malformed engine", () => {
		// A bad engine value is reported as a ToolError when a cell actually runs.
		// A getter that assembles the tool's description is the wrong place to raise
		// it: throwing here takes the whole tool listing down over a typo.
		Bun.env.AURA_EVAL_JS_ENGINE = "not-an-engine";
		const session = makeSession({ backends: {} });
		let description = "";
		expect(() => {
			description = new EvalTool(session).description;
		}).not.toThrow();
		expect(description).toContain("JS runs under **Bun**");
	});
});

/**
 * The Python engine line exists for ONE reason: the runtime engine has no tool
 * bridge, so a helper-calling cell is rerouted to CPython and lands in a
 * different state universe. Nothing in the code the model wrote hints at that.
 */
describe("eval tool description Python engine", () => {
	const savedEngineEnv = Bun.env.AURA_EVAL_PY_ENGINE;

	afterEach(() => {
		if (savedEngineEnv === undefined) delete Bun.env.AURA_EVAL_PY_ENGINE;
		else Bun.env.AURA_EVAL_PY_ENGINE = savedEngineEnv;
	});

	/**
	 * The CPython rendering is the pre-flip text, byte for byte: a caller that
	 * names no engine must not be handed a warning about a reroute that cannot
	 * happen on the engine it is describing.
	 */
	it("says nothing about the bridge reroute on the CPython engine", () => {
		const text = getEvalToolDescription({ py: true, js: true, pyEngine: "cpython" });
		expect(text).toBe(getEvalToolDescription({ py: true, js: true }));
		expect(text).not.toContain("separate CPython kernel");
		expect(text).toContain("Top-level `await` works; `asyncio.run(…)` raises error.\n");
	});

	it("warns that a helper cell may not share variables when the runtime engine is selected", () => {
		const text = getEvalToolDescription({ py: true, js: true, pyEngine: "elide" });
		// "may run on" — not "runs on". The description is assembled long before any
		// cell runs, and a session on the runtime engine still lands on CPython
		// wholesale when no library resolves, where helper cells share state normally.
		expect(text).toContain(
			"A Python cell calling a prelude helper (`read`, `write`, `agent`, …) still works, but may run on a separate CPython kernel that does not share variables with your other Python cells",
		);
		// The engine does not echo a bare trailing expression (pinned by the
		// real-kernel suite); the model must be told to print() what it wants
		// to see, or its inspect-by-trailing-expression habit reads as "empty".
		expect(text).toContain("A bare trailing expression is NOT echoed on this engine: `print()` any value you want to see.");
	});

	it("says nothing about either engine when Python is disabled", () => {
		const text = getEvalToolDescription({ py: false, js: true, pyEngine: "elide" });
		expect(text).toBe(getEvalToolDescription({ py: false, js: true }));
	});

	/**
	 * Keyed off SELECTION, not provenance — unlike the fallback notice. The
	 * reroute bites precisely the default-engine session that HAS a runtime
	 * library, so suppressing the line for default selections would drop it
	 * exactly where it is needed.
	 */
	it("EvalTool warns on the flipped default with nothing configured", () => {
		expect(new EvalTool(makeSession({})).description).toContain("separate CPython kernel");
	});

	it("EvalTool follows a session that pins the CPython engine", () => {
		const session = makeSession({});
		session.settings.set("eval.pyEngine" as never, "cpython" as never);
		expect(new EvalTool(session).description).not.toContain("separate CPython kernel");
	});

	it("degrades to the CPython line instead of throwing on a malformed engine", () => {
		Bun.env.AURA_EVAL_PY_ENGINE = "not-an-engine";
		const session = makeSession({});
		let description = "";
		expect(() => {
			description = new EvalTool(session).description;
		}).not.toThrow();
		expect(description).not.toContain("separate CPython kernel");
	});
});

describe("eval tool dynamic schema", () => {
	// resolveEvalBackends lets PI_* env flags override settings; neutralize them per-test
	// so the schema is driven purely by the isolated settings (and restore to avoid leaks).
	const EVAL_ENV_FLAGS = ["PI_PY", "PI_JS", "PI_RB", "PI_JL"] as const;
	let savedEnv: Record<string, string | undefined>;
	beforeEach(() => {
		savedEnv = {};
		for (const flag of EVAL_ENV_FLAGS) {
			savedEnv[flag] = Bun.env[flag];
			delete Bun.env[flag];
		}
	});
	afterEach(() => {
		for (const flag of EVAL_ENV_FLAGS) {
			const prior = savedEnv[flag];
			if (prior === undefined) delete Bun.env[flag];
			else Bun.env[flag] = prior;
		}
	});

	it("advertises Python in the model-facing eval contract by default", () => {
		const tool = new EvalTool(makeSession({}));
		const fields = wireCellFields(tool);
		expect(fields.languages).toEqual(["js", "py"]);
		expect(fields.languageDescription).toBe('runtime: "py" for the IPython kernel, "js" for the persistent JS VM');
		expect(fields.codeDescription).toBe("code to run in this eval call, verbatim. Use top-level await freely.");
		expect(tool.summary).toBe("Execute Python or JavaScript code in an in-process eval backend");
		expect(tool.description).not.toMatch(/ruby|julia/i);
		const exampleLangs = tool.examples.map(ex => ("call" in ex ? ex.call.language : null));
		expect(exampleLangs).toEqual(["py", "py", "py"]);
	});

	it("advertises rb/jl across enum, descriptions, summary, and prelude once enabled", () => {
		const tool = new EvalTool(makeSession({ backends: { "eval.rb": true, "eval.jl": true } }));
		const fields = wireCellFields(tool);
		expect(fields.languages).toEqual(["jl", "js", "py", "rb"]);
		expect(fields.languageDescription).toBe(
			'runtime: "py" for the IPython kernel, "js" for the persistent JS VM, "rb" for the persistent Ruby kernel, "jl" for the persistent Julia kernel',
		);
		expect(fields.codeDescription).toContain(
			"code to run in this eval call, verbatim. Top-level `await` is available in py/js; rb/jl auto-display the last expression like a REPL.",
		);
		expect(tool.summary).toBe("Execute Python, JavaScript, Ruby, or Julia code in a persistent eval backend");
		expect(tool.description).toMatch(/ruby/i);
		expect(tool.description).toMatch(/julia/i);
		// Ruby examples appear once rb is enabled.
		const rbExampleLangs = tool.examples.filter(ex => "call" in ex && ex.call.language === "rb");
		expect(rbExampleLangs.length).toBe(2);
	});

	it("advertises only the enabled subset of optional backends", () => {
		const tool = new EvalTool(makeSession({ backends: { "eval.rb": true } }));
		const fields = wireCellFields(tool);
		expect(fields.languages).toEqual(["js", "py", "rb"]);
		expect(tool.summary).toBe("Execute Python, JavaScript, or Ruby code in a persistent eval backend");
		expect(tool.description).toMatch(/ruby/i);
		expect(tool.description).not.toMatch(/julia/i);
	});
});
