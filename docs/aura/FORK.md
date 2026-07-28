# Aura fork inventory

This repository is a fork of [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)
(`upstream` remote). `main` is aura's mainline; upstream is merged regularly.

**Merge gate:** `bun run check:ts` and the TS test suite must be green before
and after every upstream merge.

## Upstream files modified by the fork

| File | Why |
|---|---|
| `packages/utils/src/dirs.ts` | brand constants: APP_NAME=aura, CONFIG_DIR_NAME=.aura, LEGACY_CONFIG_DIR_NAME=.omp (read-only compat for pre-rebrand project dirs); profile env resolution/precedence AURA_PROFILE → OMP_PROFILE → PI_PROFILE; `readInheritedProfileFromEnvSafe` (was `readPiProfileFromEnvSafe`) scans all three profile vars in that precedence for the pre-profile `PI_CODING_AGENT_DIR` snapshot, since `setProfile` writes all three |
| `packages/coding-agent/src/cli.ts` | env-profile bootstrap reads AURA_PROFILE (canonical) alongside legacy OMP_PROFILE/PI_PROFILE; handles the top-level `--check` flag (one-line clean-env health probe, no model/network/provisioning) and the top-level `--version`/`-v` (identity block: the runner's `<bin>/<version>` line unchanged, plus a `runtime protocol v<N>` line) before delegating |
| `packages/coding-agent/src/task/discovery.ts` | `TASK_AGENT_CONFIG_SOURCES` derives from CONFIG_DIR_NAME + LEGACY_CONFIG_DIR_NAME (was a single hardcoded `".omp"`; stale value filtered out all project/user agent dirs after rebrand). Project agent dirs are consumed in priority order so `.aura/agents` beats legacy `.omp/agents` on a name collision, and `projectAgentsDir` only ever reports a writable base |
| `packages/coding-agent/package.json` | bin: aura alias alongside omp |
| `packages/coding-agent/src/modes/theme/theme.ts` | register built-in `aura` and `aura-light` themes in `BUILTIN_THEMES` (imports + entries), mirroring `dark`/`light` |
| `packages/coding-agent/src/modes/setup-wizard/scenes/theme.ts` | the wizard is a SECOND source of theme defaults and the path most users actually take, so it is aligned to the brand: the "Match terminal" curated option commits `theme.dark: aura` / `theme.light: aura-light` (was `titanium`/`light`) via the `BRAND_DARK_THEME`/`BRAND_LIGHT_THEME` constants, which must stay equal to the `settings-schema.ts` defaults — a schema default the wizard overwrites is not a default. Its description names the pair; `Titanium`/`Light` remain as named non-default choices (redescribed "Neutral dark/light theme" since they no longer are the defaults) |
| `packages/coding-agent/src/tools/renderers.ts` | one import + one `...runtimeToolRenderers` spread at the head of `toolRenderers`, registering the fourteen runtime tool renderers. The spread is first so a future upstream entry with the same key would win rather than be silently shadowed; all renderer logic lives in the fork-owned `tools/runtime-renderer.ts`, so this row stays a two-line change through any merge |
| `packages/coding-agent/src/cli/gallery-fixtures/index.ts` | one import + one `...runtimeFixtures` spread, adding the runtime tool family's `omp gallery` sample data (the fixtures themselves are the fork-owned sibling module `gallery-fixtures/runtime.ts`). Without it the coverage test still passes — unfixtured tools fall back to a generic sample — but the runtime rows render as placeholder args |
| `packages/coding-agent/src/config/settings-schema.ts` | `theme.dark` default = `aura` (was `titanium`) and `theme.light` default = `aura-light` (was `light`), so the fork's terminal-background auto light/dark switching stays on-brand in both directions; `runtime.*` settings (`runtime.enabled`, `runtime.autoDownload`, `runtime.path`, `runtime.version`, `runtime.allowShell`) added to the `tools` tab, plus `skills.enableBundled` (default `true`, `tools`/`Runtime` tab-group) and its `enableBundled?: boolean` field on `SkillsSettings` — `settings.getGroup("skills")` derives the object from the `skills.*` keys, so the new toggle threads to `loadSkills` with no call-site change. Runtime shell policy: `RUNTIME_SHELL_INTERCEPTOR_RULES` (routing direct runtime-binary shell commands to `run`/`build`/`serve`/`jvm_*`/`project_advice`) spread onto the tail of `DEFAULT_BASH_INTERCEPTOR_RULES`, plus `RUNTIME_SHELL_RULE_KIND`, `isRuntimeShellAllowed`, `applyRuntimeShellOptOut`, `activeBashInterceptorRules` (the always-on split — see the `tools/bash.ts` row), and an optional `kind?: string` group tag on `BashInterceptorRule`. The rules need no `runtime.enabled` check of their own — `checkBashInterception` already skips a rule whose `tool` is absent from `availableTools`, so the group is inert when the runtime tools are unregistered (`tools/bash-interceptor.ts` is therefore unforked) |
| `packages/coding-agent/src/tools/bash.ts` | the interception block no longer sits behind `if (settings.get("bashInterceptor.enabled"))`; it selects its rules through `activeBashInterceptorRules(getBashInterceptorRules(), settings.get("bashInterceptor.enabled"))` and runs whenever that is non-empty. The runtime-routing group is therefore always evaluated (it is policy, and would be inert on every default install since `bashInterceptor.enabled` defaults to `false`), while upstream's deliberately-softened cat/grep/sed nudges stay behind the toggle exactly as before. The runtime group keeps its own two gates: tool availability and the `runtime.allowShell` / `AURA_ALLOW_ELIDE_SHELL` opt-out. Resolve an upstream conflict here by keeping upstream's loop body and re-applying the rule-selection call |
| `packages/coding-agent/src/tools/index.ts` | `ToolSession.getRuntimeService?: () => RuntimeService \| undefined` accessor added beside `getMnemopiSessionState`; imports the five `Runtime*Tool` classes and registers `run`/`check`/`build`/`insights`/`profile` in `BUILTIN_TOOLS` via their `createIf` gates; also imports the six `Jvm*Tool` classes and registers `jvm_run`/`jvm_disassemble`/`jvm_format`/`jvm_jar`/`jvm_deps`/`jvm_javadoc` the same way (same `runtime.enabled` gate, all `discoverable`); plus `RuntimeDebugTool`/`RuntimeServeTool` registered as `runtime_debug`/`serve` on the same gate, and `RuntimeAdviceTool` registered as `project_advice` on the same gate (the one runtime tool with `approval: "read"` — fixed argv, no caller-supplied code or output path) |
| `packages/coding-agent/src/tools/builtin-names.ts` | appended `run`, `check`, `build`, `insights`, `profile` and the six JVM names `jvm_run`, `jvm_disassemble`, `jvm_format`, `jvm_jar`, `jvm_deps`, `jvm_javadoc` to `BUILTIN_TOOL_NAMES` (no collision with the `search`→`grep` / `find`→`glob` legacy alias map; the `jvm_` prefix is the user-facing name, never a product name), then `runtime_debug` and `serve` — `runtime_debug` is deliberately NOT `debug`, which upstream already owns for the interactive stepping debugger (`tools/debug.ts`) — then `project_advice` |
| `packages/coding-agent/src/tools/essential-tools.ts` | added `run`, `check`, `build` to `ESSENTIAL_BUILTIN_TOOL_NAMES` so they stay top-level and a re-register cannot demote them (issue #5764 guard); `insights`/`profile`, all six `jvm_*` tools, and `project_advice` stay `discoverable` (they are reached through discovery, not the always-on schema) |
| `packages/coding-agent/src/config/settings.ts` | project config resolves to `<cwd>/${CONFIG_DIR_NAME}/config.yml` (was a hardcoded `.omp`): `#projectConfigPath()` is the sole write target, `#loadProjectConfigYaml()` falls back to `<cwd>/.omp/config.yml` for reads (narrowed to the `modelRoles` slice at the `#loadProjectSettings` call site) and seeds the first branded write so legacy keys carry forward. Still required after the legacy-base work — it is the only path that reads a legacy `config.yml` at all. Also `getBashInterceptorRules()` pipes the configured rules through `applyRuntimeShellOptOut(..., this.get("runtime.allowShell"))` — this accessor is where the rule set is assembled for `bash`, so it is where the runtime shell opt-out (setting or `AURA_ALLOW_ELIDE_SHELL=1`) lands |
| `packages/coding-agent/src/discovery/omp-extension-roots.ts` | project extension roots read `<cwd>/${CONFIG_DIR_NAME}/settings.json` (was a hardcoded `.omp`) with a `.omp` read fallback via `readProjectSettingsExtensions`; `scopeDirs` folded into the call site. Still required after the legacy-base work: the legacy base contributes no settings documents, so this `extensions` slice remains the only `.omp/settings.json` compat |
| `packages/coding-agent/src/config.ts` | `priorityList` entries are typed `ConfigBase` and carry `legacy?`; `.omp` added as a READ-ONLY project base directly below `.aura`. User level excludes it, and pre-rebrand user state under `~/.omp/agent` is consequently on NO read path — `PI_CONFIG_DIR=.omp` is the workaround, proper adoption belongs in a future `config migrate`. `ConfigDirEntry` gained `writable`, which every write path must honor |
| `packages/coding-agent/src/discovery/builtin.ts` | native provider reads the legacy `.omp` project dir alongside the branded one: `getConfigDirs` returns `{dir, level, legacy?}`; `findNearestProjectConfigDir` became `findNearestProjectConfigFile`, which probes branded-FILE-then-legacy-FILE at the nearest ancestor owning a native config dir (AGENTS.md/RULES.md/SYSTEM.md) — a directory-level probe let any unrelated `.aura/` content mask a legacy `.omp/AGENTS.md`; skills walk both bases; project MCP paths include `.omp/{mcp,.mcp}.json`. **The legacy base is read-only in the sense that nothing is WRITTEN there, not in the sense that its content is inert:** it contributes the same EXECUTABLE surfaces as the branded dir — `hooks/pre/*` and `hooks/post/*` (auto-fire around tool calls, no approval prompt), `tools/*`, `extensions/` + `extensions:` modules, TS/JS-backed `commands/*`, and MCP servers. That is deliberate (`.omp` is the user's own pre-rebrand dir, same trust as `.aura` and as the `.claude`/`.codex`/`.gemini` bases whose hooks/tools the sibling providers already load) and is pinned by a test. The single exception is settings documents: `loadSettings` SKIPS legacy dirs, so no legacy `config.yml`/`settings.json` is ever loaded wholesale |
| `packages/coding-agent/src/modes/components/agent-dashboard.ts` | `#saveGeneratedAgent` picks the highest-priority *writable* config dir instead of `dirs[0]` (legacy `.omp` must never receive a new agent file) |
| `packages/coding-agent/src/secrets/index.ts` | project secrets read `<cwd>/${CONFIG_DIR_NAME}/secrets.yml` (was a hardcoded `.omp`) with a `.omp` read fallback via `loadProjectSecretsFile` |
| `packages/coding-agent/src/cli/agents-cli.ts` | `agents unpack --project` targets `<projectDir>/${CONFIG_DIR_NAME}/agents` (was a hardcoded `.omp`); discovery reads both dirs, so the write side is branded-only |
| `packages/coding-agent/src/advisor/watchdog.ts` | `collectConfigCandidates` probes `NATIVE_CONFIG_DIR_NAMES` (branded + legacy `.omp`) per ancestor instead of only `.omp`, and the owner-dir/level classification keys off that list |
| `packages/coding-agent/src/cli/args.ts` | `Args.prependSystemPrompt`; `Args.runtime` (the `--runtime <path>` flag); `getExtraHelpText` documents `AURA_PROFILE` first with `OMP_PROFILE` marked legacy; `agents unpack` examples use `${APP_NAME}` and `${CONFIG_DIR_NAME}` |
| `packages/coding-agent/src/system-prompt.ts` | `prependSystemPrompt` / `resolvedPrependSystemPrompt` on `BuildSystemPromptOptions`, resolved through the same `withDeadline` prep as the append pair and `unshift`ed as its own leading block (a template slot could not sit above a custom prompt that replaced block 0); the resolved text also joins the customization/always-apply-rule dedupe sources |
| `packages/coding-agent/src/cli/flag-tables.ts` | `--prepend-system-prompt <text-or-file>` and `--runtime <path>` added to `STRING_SETTERS` (the single source of truth for string-valued launch flags, so the profile bootstrap and subcommand resolver pick it up automatically) |
| `packages/coding-agent/src/main.ts` | `discoverPrependSystemPromptFile` (`PREPEND_SYSTEM.md`, project then global, mirroring `discoverAppendSystemPromptFile`), resolved in `buildSessionOptions` and applied through a fourth `applyResolvedSystemPromptInputs` parameter; `--prepend-system-prompt` also joins the fork-cache-shape check; the `--version` launch-flag path prints `RUNTIME_PROTOCOL_LINE` under `VERSION`, matching the top-level interception in `cli.ts`; `--runtime <path>` applied as an ephemeral `Settings.override("runtime.path", …)` alongside the other CLI-flag overrides, so every `settings.get("runtime.path")` site (innate-tool endpoint resolution included) observes it |
| `packages/coding-agent/src/commands/launch.ts` | `prepend-system-prompt: Flags.string(...)` and `runtime: Flags.string(...)` declared for oclif's generated `--help`; the real parse lives in `cli/args.ts` (same pattern as `--auto-approve` / `--approval-mode`) |
| `packages/coding-agent/src/cli-commands.ts` | register runtime and doctor commands |
| `packages/coding-agent/src/sdk.ts` | `CreateAgentSessionOptions.prependSystemPrompt`, forwarded to `buildSystemPrompt` as `resolvedPrependSystemPrompt` and included in the fork-cache-shape check; wires `getRuntimeService` on the `toolSession` literal: reads `runtime.*` settings per call and returns `getOrCreateRuntimeService(...)`, or `undefined` when disabled |
| `packages/coding-agent/src/discovery/index.ts` | one line: `import "./builtin-skills";` in the provider side-effect import block, registering the bundled runtime-skills provider |
| `packages/coding-agent/src/capability/skill.ts` | added `BUILTIN_SKILLS_PROVIDER_ID = "builtin-skills"`, mirroring `BUILTIN_DEFAULTS_PROVIDER_ID` on the rule capability, so consumers can identify a bundled skill without importing (and registering) the provider |
| `packages/coding-agent/src/extensibility/skills.ts` | `loadSkills` destructures `enableBundled = true` and `isSourceEnabled` gains an explicit `BUILTIN_SKILLS_PROVIDER_ID` branch above the third-party toggles. Load-bearing: the fallback at the end of `isSourceEnabled` returns `anyThirdPartySkillToggleEnabled`, which would let the Codex/Claude/Pi toggles silently retire an agent-native bundled skill (the same class of bug as issue #2401 for managed skills) |
| `docs/settings.md` | appended a `### Runtime` subsection under `### Tools and approvals` documenting `runtime.enabled` / `runtime.autoDownload` / `runtime.path` / `runtime.allowShell` and linking the runtime tool pages (the five core tools, the six `jvm_*` tools, `runtime_debug`/`serve`, and `project_advice`), plus a `#### Runtime shell policy` subsection covering the interceptor rules and the opt-out, and a `#### Bundled runtime skills` subsection covering `skills.enableBundled` and the materialization directory |
| `AGENTS.md` | appended the `## Aura fork conventions` section (points contributors at this file, states the runtime naming rule, locates specs/plans) |
| `bun.lock` | one line: the `aura` bin entry mirroring the `packages/coding-agent/package.json` change. Regenerate with `bun install` rather than resolving a merge conflict by hand |

### Upstream tests de-hardcoded for the rebrand

One mechanical class of change, applied to every upstream test that baked the
brand into a literal: `".omp"` → `CONFIG_DIR_NAME` and `"omp"` → `APP_NAME`
(imported from `@oh-my-pi/pi-utils` / `@oh-my-pi/pi-utils/dirs`). No upstream
expectation was weakened — only the path/name literals moved behind the
constants that `packages/utils/src/dirs.ts` now brands. Prefer resolving an
upstream merge conflict in these by taking upstream's assertion and
re-substituting the constant.

`packages/coding-agent/test/`: `acp-mcp-isolation`, `cli-max-time-flag`,
`cli/completions`, `debug/dap-config`, `debug/report-bundle-logs`,
`discovery/builtin-rules-md`, `discovery/disabled-extensions`,
`discovery/omp-plugins`, `discovery/pi-config-dir`,
`extension-dashboard-mcp-parity`, `gc-cli`,
`issue-4197-plugin-resolution-cache`, `main-interactive-input`,
`marketplace/manager`, `marketplace/project-scope`, `model-hub`,
`modes/controllers/omfg-controller`, `sdk-skills`,
`selector-settings-side-effects`, `settings-reload-cwd`,
`system-prompt-dedup`, `task/discovery`, `tools/gh`, `update-cli`.

`settings-reload-cwd` and `discovery/omp-plugins` additionally carry fork-added
cases pinning the project-config brand split (branded path canonical, `.omp`
read fallback, writes never legacy); keep those alongside upstream's.
`discovery/pi-config-dir` expects the fork's `writable` field on
`ConfigDirEntry`.

`packages/utils/test/`: `dirs-cache`, `dirs-python-gateway`, `profiles`.

`packages/coding-agent/test/skills.test.ts` additionally carries one fork line:
`enableBundled: false` in its `DISABLE_ALL_BUILTIN_SKILLS` helper. That helper
means "every built-in skill source off", and the bundled runtime provider is a
new source; without it the tests asserting an exact custom-directory skill list
(and the "empty when all sources disabled" case) would see the five bundled
skills. Resolve an upstream conflict by keeping upstream's toggles and
re-appending this one.

## Fork-added files and directories (additive, no merge risk)

- `packages/coding-agent/src/runtime/` — runtime capability core
- `packages/coding-agent/src/cli/runtime-cli.ts`, `src/commands/runtime.ts`
- `packages/coding-agent/src/cli/doctor-cli.ts`, `src/commands/doctor.ts`
- `packages/coding-agent/src/cli/version-identity.ts` — `--version` identity line
  (`<app>/<version>` + runtime protocol version)
- `packages/coding-agent/src/discovery/builtin-skills.ts`,
  `src/discovery/builtin-skill-sources/*.md` — bundled runtime skills, materialized
  into the agent dir under a `.bundled.json` manifest that is the sole prune authority
- `packages/coding-agent/src/tools/runtime-*.ts` (including `runtime-launch.ts`, which
  starts runtime launch descriptors through the upstream `hub` supervisor rather than
  keeping a process registry of its own), `src/prompts/tools/runtime-*.md`
- `packages/coding-agent/src/tools/runtime-renderer.ts` — TUI renderers for the whole
  runtime tool family. One factory over declarative per-tool `describeCall` /
  `describeResult` specs, in the `glob`/`hub` house style (status line + short output
  preview, `inline`, `mergeCallAndResult`). It adds no truncation of its own: the
  central spill in `tools/output-meta.ts` stays the sole authority, and the renderer
  only strips the notices (`(exit code N)`, the spill's own footer) that the header
  restates. `src/cli/gallery-fixtures/runtime.ts` is its `omp gallery` sample data
- `packages/coding-agent/src/modes/theme/aura.json`, `src/modes/theme/aura-light.json` —
  the `aura` / `aura-light` built-in themes registered by the `theme.ts` row above.
  `aura-light` is the brand light counterpart: same `vars` brand palette (magenta /
  violet / purple), deepened `*Deep` variants where the brand hue is used as text on a
  near-white surface, and a `colors` sub-key set held equal to `light.json`'s by
  `test/aura-light-theme.test.ts`
- `packages/coding-agent/test/runtime-*.test.ts`, `test/doctor-cli.test.ts`,
  `test/doctor-command-registration.test.ts`, `test/doctor-tool-gate-drift.test.ts`,
  `test/aura-bin.test.ts`,
  `test/aura-theme.test.ts`, `test/aura-light-theme.test.ts`,
  `test/runtime-tool-renderers.test.ts`, `packages/utils/test/branding.test.ts` — fork-owned
  tests; safe to keep verbatim through any upstream merge
- `packages/coding-agent/test/discovery/legacy-omp-project-base.test.ts`,
  `test/legacy-omp-compat-paths.test.ts`, `test/cli-help-profile-env.test.ts` —
  legacy `.omp` compat contract: file surfaces load, `.aura` wins conflicts, a
  non-empty `.aura/` never masks a legacy single-file surface, the legacy
  executable surfaces (`hooks/`, `tools/`) DO load by design, legacy settings
  documents never become live, writes stay branded
- `docs/tools/{run,check,build,insights,profile,runtime_debug,serve}.md` — root docs pages required by the
  `omp://` docs-coverage guard (`test/internal-urls/docs-tool-coverage.test.ts` asserts one
  `docs/tools/<name>.md` per entry in `BUILTIN_TOOL_NAMES`)
- `packages/coding-agent/src/discovery/builtin-skills.ts` + `src/discovery/builtin-skill-sources/`
  (`runtime.md`, `insights.md`, `profiling.md`, `jvm.md`, `stateful-debugger.md`, `index.ts`) —
  the bundled runtime skills, embedded via `with { type: "text" }` so they survive
  `bun build --compile`, exactly as `discovery/builtin-rules/` does for rules. The provider
  materializes them into `<agentDir>/builtin-skills/<name>/SKILL.md` before scanning:
  unlike a `Rule` (whose body lives in memory and is served by `rule://`), a `Skill` is a
  path, and `buildSkillPromptMessage` plus the `skill://` handler both re-read
  `Skill.filePath` off disk. What it wrote is recorded in a `.bundled.json` manifest,
  and that manifest is the only deletion authority — the same directory is a place a
  user may park a skill of their own, and a bare user-authored `SKILL.md` is
  shape-identical to one we wrote. Priority 3 — below managed auto-learn (5) and every
  authored provider — so any same-named skill overrides a bundled one
- `packages/coding-agent/test/discovery/builtin-skills.test.ts` — fork-owned
- `docs/aura/`, `docs/superpowers/`

## Naming rule

Elide is never user-facing; the noun is "the runtime". See
`docs/superpowers/specs/2026-07-25-aura-omp-fork-design.md`.
