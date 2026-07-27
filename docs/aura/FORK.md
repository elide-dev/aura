# Aura fork inventory

This repository is a fork of [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)
(`upstream` remote). `main` is aura's mainline; upstream is merged regularly.

**Merge gate:** `bun run check:ts` and the TS test suite must be green before
and after every upstream merge.

## Upstream files modified by the fork

| File | Why |
|---|---|
| `packages/utils/src/dirs.ts` | brand constants: APP_NAME=aura, CONFIG_DIR_NAME=.aura; profile env resolution/precedence AURA_PROFILE → OMP_PROFILE → PI_PROFILE |
| `packages/coding-agent/src/cli.ts` | env-profile bootstrap reads AURA_PROFILE (canonical) alongside legacy OMP_PROFILE/PI_PROFILE |
| `packages/coding-agent/src/task/discovery.ts` | TASK_AGENT_CONFIG_SOURCE derives from CONFIG_DIR_NAME (was hardcoded ".omp"; stale value filtered out all project/user agent dirs after rebrand) |
| `packages/coding-agent/package.json` | bin: aura alias alongside omp |
| `packages/coding-agent/src/modes/theme/theme.ts` | register built-in `aura` theme in `BUILTIN_THEMES` (import + entry), mirroring `dark`/`light` |
| `packages/coding-agent/src/config/settings-schema.ts` | `theme.dark` default = `aura` (was `titanium`); `theme.light` unchanged; `runtime.*` settings (`runtime.enabled`, `runtime.autoDownload`, `runtime.path`) added to the `tools` tab |
| `packages/coding-agent/src/tools/index.ts` | `ToolSession.getRuntimeService?: () => RuntimeService \| undefined` accessor added beside `getMnemopiSessionState`; imports the five `Runtime*Tool` classes and registers `run`/`check`/`build`/`insights`/`profile` in `BUILTIN_TOOLS` via their `createIf` gates |
| `packages/coding-agent/src/tools/builtin-names.ts` | appended `run`, `check`, `build`, `insights`, `profile` to `BUILTIN_TOOL_NAMES` (no collision with the `search`→`grep` / `find`→`glob` legacy alias map) |
| `packages/coding-agent/src/tools/essential-tools.ts` | added `run`, `check`, `build` to `ESSENTIAL_BUILTIN_TOOL_NAMES` so they stay top-level and a re-register cannot demote them (issue #5764 guard); `insights`/`profile` stay `discoverable` |
| `packages/coding-agent/src/cli-commands.ts` | register runtime command |
| `packages/coding-agent/src/sdk.ts` | wires `getRuntimeService` on the `toolSession` literal: reads `runtime.*` settings per call and returns `getOrCreateRuntimeService(...)`, or `undefined` when disabled |
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
`marketplace/manager`, `marketplace/project-scope`,
`modes/controllers/omfg-controller`, `sdk-skills`, `settings-reload-cwd`,
`system-prompt-dedup`, `task/discovery`, `tools/gh`, `update-cli`.

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
- `docs/tools/{run,check,build,insights,profile}.md` — root docs pages required by the
  `omp://` docs-coverage guard (`test/internal-urls/docs-tool-coverage.test.ts` asserts one
  `docs/tools/<name>.md` per entry in `BUILTIN_TOOL_NAMES`)
- `docs/aura/`, `docs/superpowers/`

## Naming rule

Elide is never user-facing; the noun is "the runtime". See
`docs/superpowers/specs/2026-07-25-aura-omp-fork-design.md`.
