/**
 * Bundled runtime skills shipped with the agent.
 *
 * Each `SKILL.md` body is embedded via `with { type: "text" }` so it survives
 * `bun build --compile` (the compiled binary ships no loose skill files; only
 * the embedded text). Mirrors `./builtin-rules` for the rule capability.
 *
 * These carry the strategy the per-tool descriptions cannot: when `cputracing`
 * beats `cpusampling`, what an insight script's hooks can hook, why one-shot
 * runs emit no `close`, how the JVM main class is derived, and that a
 * `runtime_debug` / `serve` job's lifecycle belongs to `hub`.
 *
 * Registered by the lowest-priority `builtin-skills` provider, so a
 * user/project skill of the same name overrides the bundled copy.
 */
import insights from "./insights.md" with { type: "text" };
import jvm from "./jvm.md" with { type: "text" };
import profiling from "./profiling.md" with { type: "text" };
import runtime from "./runtime.md" with { type: "text" };
import statefulDebugger from "./stateful-debugger.md" with { type: "text" };

/** A bundled skill's directory name (matching its frontmatter `name`) and raw `SKILL.md` text. */
export interface BuiltinSkillSource {
	name: string;
	content: string;
}

/** All bundled skills, ordered by name. */
export const BUILTIN_SKILL_SOURCES: readonly BuiltinSkillSource[] = [
	{ name: "insights", content: insights },
	{ name: "jvm", content: jvm },
	{ name: "profiling", content: profiling },
	{ name: "runtime", content: runtime },
	{ name: "stateful-debugger", content: statefulDebugger },
];
