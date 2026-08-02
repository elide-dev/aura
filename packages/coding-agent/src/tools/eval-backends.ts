import { $flag } from "@oh-my-pi/pi-utils";
import { isPythonEnabled } from "../config/settings";
import type { ToolSession } from ".";

export interface EvalBackendsAllowance {
	python: boolean;
	js: boolean;
	ruby: boolean;
	julia: boolean;
}

/** Read per-backend allowance from settings (py/js default on; rb/jl opt-in, default off). */
export function readEvalBackendsAllowance(session: ToolSession): EvalBackendsAllowance {
	return {
		python: session.settings.get("eval.py") ?? true,
		js: session.settings.get("eval.js") ?? true,
		ruby: session.settings.get("eval.rb") ?? false,
		julia: session.settings.get("eval.jl") ?? false,
	};
}

/**
 * Materialize the active eval backend allowance. The legacy Python capability
 * is an umbrella gate: PI_PY may narrow eval.py, but cannot re-enable Python
 * when python.enabled is false. Other env flags override their per-key setting.
 */
export function resolveEvalBackends(session: ToolSession): EvalBackendsAllowance {
	const settings = readEvalBackendsAllowance(session);
	return {
		python: isPythonEnabled(session.settings) && $flag("PI_PY", settings.python),
		js: $flag("PI_JS", settings.js),
		ruby: $flag("PI_RB", settings.ruby),
		julia: $flag("PI_JL", settings.julia),
	};
}
