/**
 * Engine selection for JavaScript eval cells. The `eval.jsEngine` setting picks
 * the engine (Bun remains the default); `AURA_EVAL_JS_ENGINE` overrides it for
 * the process, mirroring `runtimeAdapterFromEnvironment`.
 *
 * The accepted values are `bun` and `runtime` — user-facing strings, so they
 * follow the fork's naming rule rather than the internal module layout.
 */
import type { ToolSession } from "../../tools";

/**
 * Engine that executes JavaScript eval cells.
 *
 * `"elide"` is the non-Bun engine. The value is deliberately not the product
 * name: by the fork's naming rule the product is never user-facing and the noun
 * is "the runtime", and this string is typed into config files and env vars.
 * The module and directory names around it are code-internal and stay as they
 * are.
 */
export type JsEvalEngine = "bun" | "elide";

/** The accepted engine values, named once so the two validators cannot drift. */
const JS_EVAL_ENGINES: readonly string[] = ["bun", "elide"];

function isJsEvalEngine(value: string): value is JsEvalEngine {
	return JS_EVAL_ENGINES.includes(value);
}

/**
 * Apply the `AURA_EVAL_JS_ENGINE` override to a configured engine. Empty or
 * whitespace-only values are ignored; an unrecognized value throws.
 */
export function jsEvalEngineFromEnvironment(
	configured: JsEvalEngine,
	env: Readonly<Record<string, string | undefined>> = process.env,
): JsEvalEngine {
	const value = env.AURA_EVAL_JS_ENGINE?.trim();
	if (!value) return configured;
	if (isJsEvalEngine(value)) return value;
	throw new Error(`AURA_EVAL_JS_ENGINE must be bun or elide; received ${JSON.stringify(value)}.`);
}

/**
 * Validate a stored `eval.jsEngine` value. Nothing between the settings document
 * and here checks the enum — `settings.get` hands back whatever the YAML said —
 * so an unrecognized value would otherwise miss the `runtime` branch in
 * `resolveBackend` and run every cell on Bun with no notice at all, silently
 * ignoring a setting the docs promise is an error. Unset means the default.
 */
function jsEvalEngineFromSetting(configured: string | undefined): JsEvalEngine {
	const value = configured?.trim();
	if (!value) return "bun";
	if (isJsEvalEngine(value)) return value;
	throw new Error(`eval.jsEngine must be bun or elide; received ${JSON.stringify(value)}.`);
}

/**
 * Resolve the JavaScript eval engine for a session: setting, then env override.
 * Both inputs are validated, and the stored value is validated first so a
 * malformed setting is reported even when the override would have replaced it —
 * the config is still wrong, and the next process without the override runs on
 * it.
 */
export function resolveJsEvalEngine(session: Pick<ToolSession, "settings">): JsEvalEngine {
	return jsEvalEngineFromEnvironment(jsEvalEngineFromSetting(session.settings.get("eval.jsEngine")));
}

/**
 * Engine that executes Python eval cells.
 *
 * `"cpython"` is the default and names the subprocess kernel every session has
 * always used; `"elide"` serves cells from a persistent guest context on the
 * managed runtime. Same shape as {@link JsEvalEngine}, including the naming
 * rule: these strings are typed into config files and env vars.
 */
export type PyEvalEngine = "cpython" | "elide";

/** The accepted engine values, named once so the two validators cannot drift. */
const PY_EVAL_ENGINES: readonly string[] = ["cpython", "elide"];

function isPyEvalEngine(value: string): value is PyEvalEngine {
	return PY_EVAL_ENGINES.includes(value);
}

/**
 * Apply the `AURA_EVAL_PY_ENGINE` override to a configured engine. Empty or
 * whitespace-only values are ignored; an unrecognized value throws.
 */
export function pyEvalEngineFromEnvironment(
	configured: PyEvalEngine,
	env: Readonly<Record<string, string | undefined>> = process.env,
): PyEvalEngine {
	const value = env.AURA_EVAL_PY_ENGINE?.trim();
	if (!value) return configured;
	if (isPyEvalEngine(value)) return value;
	throw new Error(`AURA_EVAL_PY_ENGINE must be cpython or elide; received ${JSON.stringify(value)}.`);
}

/**
 * Validate a stored `eval.pyEngine` value, for the same reason `eval.jsEngine`
 * is validated above: `settings.get` hands back whatever the YAML said, so an
 * unrecognized value would otherwise miss the `elide` branch in
 * `resolveBackend` and run every cell on CPython with no notice at all.
 */
function pyEvalEngineFromSetting(configured: string | undefined): PyEvalEngine {
	const value = configured?.trim();
	if (!value) return "cpython";
	if (isPyEvalEngine(value)) return value;
	throw new Error(`eval.pyEngine must be cpython or elide; received ${JSON.stringify(value)}.`);
}

/**
 * Resolve the Python eval engine for a session: setting, then env override.
 * The stored value is validated first so a malformed setting is reported even
 * when the override would have replaced it.
 */
export function resolvePyEvalEngine(session: Pick<ToolSession, "settings">): PyEvalEngine {
	return pyEvalEngineFromEnvironment(pyEvalEngineFromSetting(session.settings.get("eval.pyEngine")));
}
