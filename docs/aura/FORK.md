# Aura fork inventory

This repository is a fork of [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)
(`upstream` remote). `main` is aura's mainline; upstream is merged regularly.

**Merge gate:** `bun run check:ts` and the TS test suite must be green before
and after every upstream merge.

## Upstream files modified by the fork

| File | Why |
|---|---|
| `packages/utils/src/dirs.ts` | brand constants: APP_NAME=aura, CONFIG_DIR_NAME=.aura, LEGACY_CONFIG_DIR_NAME=.omp (read-only compat for pre-rebrand project dirs); profile env resolution/precedence AURA_PROFILE → OMP_PROFILE → PI_PROFILE; `readInheritedProfileFromEnvSafe` (was `readPiProfileFromEnvSafe`) scans all three profile vars in that precedence for the pre-profile `PI_CODING_AGENT_DIR` snapshot, since `setProfile` writes all three |
| `packages/coding-agent/src/cli.ts` | env-profile bootstrap reads AURA_PROFILE (canonical) alongside legacy OMP_PROFILE/PI_PROFILE |
| `packages/coding-agent/src/task/discovery.ts` | `TASK_AGENT_CONFIG_SOURCES` derives from CONFIG_DIR_NAME + LEGACY_CONFIG_DIR_NAME (was a single hardcoded `".omp"`; stale value filtered out all project/user agent dirs after rebrand). Project agent dirs are consumed in priority order so `.aura/agents` beats legacy `.omp/agents` on a name collision, and `projectAgentsDir` only ever reports a writable base |
| `packages/coding-agent/package.json` | bin: aura alias alongside omp |
| `packages/coding-agent/src/modes/theme/theme.ts` | register built-in `aura` theme in `BUILTIN_THEMES` (import + entry), mirroring `dark`/`light` |
| `packages/coding-agent/src/config/settings-schema.ts` | `theme.dark` default = `aura` (was `titanium`); `theme.light` unchanged; `runtime.*` settings (`runtime.enabled`, `runtime.autoDownload`, `runtime.path`) added to the `tools` tab |
| `packages/coding-agent/src/tools/index.ts` | `ToolSession.getRuntimeService?: () => RuntimeService \| undefined` accessor added beside `getMnemopiSessionState`; imports the five `Runtime*Tool` classes and registers `run`/`check`/`build`/`insights`/`profile` in `BUILTIN_TOOLS` via their `createIf` gates |
| `packages/coding-agent/src/tools/builtin-names.ts` | appended `run`, `check`, `build`, `insights`, `profile` to `BUILTIN_TOOL_NAMES` (no collision with the `search`→`grep` / `find`→`glob` legacy alias map) |
| `packages/coding-agent/src/tools/essential-tools.ts` | added `run`, `check`, `build` to `ESSENTIAL_BUILTIN_TOOL_NAMES` so they stay top-level and a re-register cannot demote them (issue #5764 guard); `insights`/`profile` stay `discoverable` |
| `packages/coding-agent/src/config/settings.ts` | project config resolves to `<cwd>/${CONFIG_DIR_NAME}/config.yml` (was a hardcoded `.omp`): `#projectConfigPath()` is the sole write target, `#loadProjectConfigYaml()` falls back to `<cwd>/.omp/config.yml` for reads (narrowed to the `modelRoles` slice at the `#loadProjectSettings` call site) and seeds the first branded write so legacy keys carry forward. Still required after the legacy-base work — it is the only path that reads a legacy `config.yml` at all |
| `packages/coding-agent/src/discovery/omp-extension-roots.ts` | project extension roots read `<cwd>/${CONFIG_DIR_NAME}/settings.json` (was a hardcoded `.omp`) with a `.omp` read fallback via `readProjectSettingsExtensions`; `scopeDirs` folded into the call site. Still required after the legacy-base work: the legacy base contributes no settings documents, so this `extensions` slice remains the only `.omp/settings.json` compat |
| `packages/coding-agent/src/config.ts` | `priorityList` entries are typed `ConfigBase` and carry `legacy?`; `.omp` added as a READ-ONLY project base directly below `.aura` (user level excludes it — pre-rebrand user state is the agent-dir helpers' business). `ConfigDirEntry` gained `writable`, which every write path must honor |
| `packages/coding-agent/src/discovery/builtin.ts` | native provider reads the legacy `.omp` project dir alongside the branded one: `getConfigDirs` returns `{dir, level, legacy?}`, `findNearestProjectConfigDir` probes branded-then-legacy per ancestor (AGENTS.md/RULES.md/SYSTEM.md), skills walk both bases, project MCP paths include `.omp/{mcp,.mcp}.json`. `loadSettings` SKIPS legacy dirs so no legacy `config.yml`/`settings.json` is ever loaded wholesale |
| `packages/coding-agent/src/modes/components/agent-dashboard.ts` | `#saveGeneratedAgent` picks the highest-priority *writable* config dir instead of `dirs[0]` (legacy `.omp` must never receive a new agent file) |
| `packages/coding-agent/src/secrets/index.ts` | project secrets read `<cwd>/${CONFIG_DIR_NAME}/secrets.yml` (was a hardcoded `.omp`) with a `.omp` read fallback via `loadProjectSecretsFile` |
| `packages/coding-agent/src/cli/agents-cli.ts` | `agents unpack --project` targets `<projectDir>/${CONFIG_DIR_NAME}/agents` (was a hardcoded `.omp`); discovery reads both dirs, so the write side is branded-only |
| `packages/coding-agent/src/advisor/watchdog.ts` | `collectConfigCandidates` probes `NATIVE_CONFIG_DIR_NAMES` (branded + legacy `.omp`) per ancestor instead of only `.omp`, and the owner-dir/level classification keys off that list |
| `packages/coding-agent/src/cli/args.ts` | `getExtraHelpText` documents `AURA_PROFILE` first with `OMP_PROFILE` marked legacy; `agents unpack` examples use `${APP_NAME}` and `${CONFIG_DIR_NAME}` |
| `packages/coding-agent/src/cli-commands.ts` | register runtime command |
| `packages/coding-agent/src/sdk.ts` | wires `getRuntimeService` on the `toolSession` literal: reads `runtime.*` settings per call and returns `getOrCreateRuntimeService(...)`, or `undefined` when disabled |
| `docs/settings.md` | appended a `### Runtime` subsection under `### Tools and approvals` documenting `runtime.enabled` / `runtime.autoDownload` / `runtime.path` and linking the five runtime tool pages |
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

## Fork-added files and directories (additive, no merge risk)

- `packages/coding-agent/src/runtime/` — runtime capability core
- `packages/coding-agent/src/cli/runtime-cli.ts`, `src/commands/runtime.ts`
- `packages/coding-agent/src/tools/runtime-*.ts`, `src/prompts/tools/runtime-*.md`
- `packages/coding-agent/src/modes/theme/aura.json` — the `aura` built-in theme
  registered by the `theme.ts` row above
- `packages/coding-agent/test/runtime-*.test.ts`, `test/aura-bin.test.ts`,
  `test/aura-theme.test.ts`, `packages/utils/test/branding.test.ts` — fork-owned
  tests; safe to keep verbatim through any upstream merge
- `packages/coding-agent/test/discovery/legacy-omp-project-base.test.ts`,
  `test/legacy-omp-compat-paths.test.ts`, `test/cli-help-profile-env.test.ts` —
  legacy `.omp` compat contract: file surfaces load, `.aura` wins conflicts,
  legacy settings documents never become live, writes stay branded
- `docs/tools/{run,check,build,insights,profile}.md` — root docs pages required by the
  `omp://` docs-coverage guard (`test/internal-urls/docs-tool-coverage.test.ts` asserts one
  `docs/tools/<name>.md` per entry in `BUILTIN_TOOL_NAMES`)
- `docs/aura/`, `docs/superpowers/`

## Naming rule

Elide is never user-facing; the noun is "the runtime". See
`docs/superpowers/specs/2026-07-25-aura-omp-fork-design.md`.
