/**
 * Engine selection for JavaScript eval cells. The `eval.jsEngine` setting picks
 * the engine (Bun remains the default); `AURA_EVAL_JS_ENGINE` overrides it for
 * the process, mirroring `runtimeAdapterFromEnvironment`.
 */
import type { ToolSession } from "../../tools";

/** Engine that executes JavaScript eval cells. */
export type JsEvalEngine = "bun" | "elide";

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
	if (value === "bun" || value === "elide") return value;
	throw new Error(`AURA_EVAL_JS_ENGINE must be bun or elide; received ${JSON.stringify(value)}.`);
}

/** Resolve the JavaScript eval engine for a session: setting, then env override. */
export function resolveJsEvalEngine(session: Pick<ToolSession, "settings">): JsEvalEngine {
	return jsEvalEngineFromEnvironment(session.settings.get("eval.jsEngine") ?? "bun");
}
