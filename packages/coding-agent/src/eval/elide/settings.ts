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
 * `"runtime"` is the non-Bun engine. The value is deliberately not the product
 * name: by the fork's naming rule the product is never user-facing and the noun
 * is "the runtime", and this string is typed into config files and env vars.
 * The module and directory names around it are code-internal and stay as they
 * are.
 */
export type JsEvalEngine = "bun" | "runtime";

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
	if (value === "bun" || value === "runtime") return value;
	throw new Error(`AURA_EVAL_JS_ENGINE must be bun or runtime; received ${JSON.stringify(value)}.`);
}

/** Resolve the JavaScript eval engine for a session: setting, then env override. */
export function resolveJsEvalEngine(session: Pick<ToolSession, "settings">): JsEvalEngine {
	return jsEvalEngineFromEnvironment(session.settings.get("eval.jsEngine") ?? "bun");
}
