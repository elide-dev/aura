# P8 — Runtime skills (#39)

Branch: `feat/aura-chrome-parity` (worktree `.claude/worktrees/aura-chrome-parity`).

## STEP 1: what the fork actually has

**Finding: the fork has no built-in-skills seam.** Every registered skill provider
scans the filesystem for user- or tool-authored content. Evidence:

- `src/capability/skill.ts` defines the `skills` capability. Eight providers register
  against it — `builtin` (native `.aura`/`.omp` skill dirs, plus a second registration
  for managed auto-learn skills), `claude`, `claude-plugins`, `codex`, `agents`,
  `opencode`, `github`, `omp-plugins`. All of them funnel into
  `discovery/helpers.ts:scanSkillsFromDir`, i.e. `<dir>/<name>/SKILL.md` with
  `name`/`description` frontmatter. There is no provider that ships content.
- `src/prompts/skills/` is *not* a skills root — it holds the two prompt templates
  (`autoload.md`, `user-invocation.md`) that `extensibility/skills.ts` renders when a
  skill is invoked.
- `manage_skill` / `learn` write into `getManagedSkillsDir()` (`<agentDir>/managed-skills`),
  a user-owned auto-learn area, not a shipped one.
- `resources_discover` does not exist in this fork; discovery is the capability registry
  (`registerProvider` + `loadCapability`), not a hook.

**The exact analogue that does exist** is one capability over: the **rule**
capability ships bundled content through `discovery/builtin-defaults.ts`, whose
markdown lives in `discovery/builtin-rules/*.md` and is embedded with
`import x from "./x.md" with { type: "text" }` so it survives `bun build --compile`.
That is the fork-native shape for "content that ships with the harness", and it is
what P8 mirrors.

## What was built

`discovery/builtin-skills.ts` — a `builtin-skills` provider on the skills capability,
priority **3** (below managed auto-learn at 5 and every authored provider, so any
same-named skill overrides a bundled one). Sources live in
`discovery/builtin-skill-sources/` and are embedded as text exactly like the rules.

**One deliberate difference from the rules provider:** it materializes to disk.
A `Rule` carries its body in memory and `rule://` serves that body, so
`builtin-defaults` can hand back a virtual path. A `Skill` is a *path* — both
`buildSkillPromptMessage` (`Bun.file(skill.filePath).text()`) and
`SkillProtocolHandler` (`fs.stat` + read, including `skill://<name>/<subpath>`)
re-read the file. A virtual path would list in the system prompt and then fail on
invocation. So the provider writes its embedded sources to
`<agentDir>/builtin-skills/<name>/SKILL.md` (temp-file + rename, only when the
content differs) and then scans that directory with the ordinary
`scanSkillsFromDir`. Every downstream path is therefore unmodified. The embedded
text stays the authority: a drifted file is rewritten on the next load, and a
directory left behind by a retired bundled skill is pruned — but only when it
holds a lone `SKILL.md`, so anything the user added files to is never reclaimed.
An unwritable agent dir degrades to warnings, never a discovery failure.

Gating: the provider skips materialization entirely when `runtime.enabled` is off
(the skills document tools that are then unregistered) or `skills.enableBundled`
is off, read through the settings singleton behind `isSettingsInitialized()` —
the same fallback `discovery/claude.ts` uses for its command toggles.

### The five skills

| Skill | Carries |
|---|---|
| `runtime` | `run` inline-vs-path (path preserves project cwd/imports/module resolution — the semantic difference, not a convenience), `run` vs `bash` vs `eval` (persistent kernel), `check` vs `build`, `project_advice` as the "ask first" move, binary resolution order and managed download |
| `insights` | one guest source × one instrumentation source, instrumentation is always JS even for a Python guest, the `source`/`enter`/`return` hooks, **one-shot runs emit no `close`** so the summary must ride the top root's `return` and match both `:program` and `:module:eval` behind a `reported` guard, `rootNameFilter` scoping, and when to prefer exact counts over `profile` |
| `profiling` | `cpusampling` (statistical, low overhead, prefer for anything ≥ ~1s) vs `cputracing` (exact counts, heavy, distorts its own timings, inhibits inlining — trace a reduced input), the sample-then-trace sequence, and how to read the report (relationships and ranking, never absolute ms or JIT %) |
| `jvm` | the six-tool table, main-class derivation (`mainClass` → Kotlin always `MainKt` → Java `public class` → first `class` → `Main`) and its three real failure modes (Java file name must match the derived class; first-class-wins when nothing is public; no `package` declaration in inline source), `--release 17` + stripped `JAVA_HOME`/`JDK_HOME` and why, the `output`-inside-cwd / `overwrite` guards, `jvm_format` returning rather than writing |
| `stateful-debugger` | `runtime_debug` path-only (the file must outlive the call), cdp `ws://` vs dap `host:port`, suspended-until-attach, `runtime_debug` ≠ the innate `debug` stepping tool, `serve`, and the hub-owned lifecycle: `hub logs` / `hub stop`, **no separate stop tool**, best-effort endpoint scraping (poll `hub logs`, raise `waitSeconds`, don't relaunch), and the no-`hub` session caveat |

Naming rule holds: a test asserts no bundled skill contains the string "elide"
in any case. The compat env var is referenced as `AURA_RUNTIME_BIN`, not `ELIDE_BIN`.

## Registration seam (upstream files touched)

| File | Change |
|---|---|
| `src/discovery/index.ts` | one line: `import "./builtin-skills";` |
| `src/capability/skill.ts` | `BUILTIN_SKILLS_PROVIDER_ID`, mirroring `BUILTIN_DEFAULTS_PROVIDER_ID` on the rule capability |
| `src/extensibility/skills.ts` | `enableBundled = true` destructured; explicit provider branch in `isSourceEnabled`. Load-bearing — the function's fallback returns `anyThirdPartySkillToggleEnabled`, so without the branch the Codex/Claude/Pi toggles would retire an agent-native skill set (the #2401 class of bug) |
| `src/config/settings-schema.ts` | `skills.enableBundled` (default `true`, tools/Runtime group) + the `SkillsSettings` field; `settings.getGroup("skills")` threads it to `loadSkills` with no call-site change |
| `test/skills.test.ts` | `enableBundled: false` added to the `DISABLE_ALL_BUILTIN_SKILLS` helper |
| `docs/settings.md` | `#### Bundled runtime skills` subsection |

All rows recorded in `docs/aura/FORK.md`, including the merge-resolution note for
the test helper.

## Tests

`test/discovery/builtin-skills.test.ts` — 11 tests: the five skills load with
frontmatter and provider attribution; each materializes to
`<agentDir>/builtin-skills/<name>/SKILL.md` byte-identical to the embedded source;
a tampered file is repaired on the next load; a retired bundled dir is pruned while
a dir holding extra files is not; the provider is the lowest-priority skill provider;
`loadSkills()` surfaces all five unhidden by default, drops them under
`enableBundled: false`, and drops one named in `ignoredSkills`; and the content
guards (no vendor name, innate tool names present, hub lifecycle language, no
`stop_runtime_process`).

`bun run check:ts` clean, biome clean, full `packages/coding-agent` suite green apart
from three failures reproduced on the unmodified tree (a session-migration
expectation, a PTY daemon test tripping over the developer's `~/.aliases`, and a
cwd-relative eval-worker import in `tools/computer.test.ts`).

## Concerns

- Materializing into `<agentDir>` is a write during discovery. It is idempotent,
  content-compared, and rename-atomic, but it does mean a session start can touch
  the agent directory. `runtime.enabled = false` or `skills.enableBundled = false`
  suppresses it entirely.
- The prune heuristic ("a lone `SKILL.md`") is conservative by design; a retired
  bundled skill that the user added a file to will linger rather than be deleted.
