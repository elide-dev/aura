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
| packages/coding-agent/package.json | bin: aura alias alongside omp |
| `packages/coding-agent/src/modes/theme/theme.ts` | register built-in `aura` theme in `BUILTIN_THEMES` (import + entry), mirroring `dark`/`light` |
| `packages/coding-agent/src/config/settings-schema.ts` | `theme.dark` default = `aura` (was `titanium`); `theme.light` unchanged; `runtime.*` settings (`runtime.enabled`, `runtime.autoDownload`, `runtime.path`) added to the `tools` tab |
| `packages/coding-agent/src/tools/index.ts` | `ToolSession.getRuntimeService?: () => RuntimeService \| undefined` accessor added beside `getMnemopiSessionState` |
| `packages/coding-agent/src/sdk.ts` | wires `getRuntimeService` on the `toolSession` literal: reads `runtime.*` settings per call and returns `getOrCreateRuntimeService(...)`, or `undefined` when disabled |

## Fork-added directories (additive, no merge risk)

- `packages/coding-agent/src/runtime/` — runtime capability core
- `packages/coding-agent/src/cli/runtime-cli.ts`, `src/commands/runtime.ts`
- `packages/coding-agent/src/tools/runtime-*.ts`, `src/prompts/tools/runtime-*.md`
- `docs/aura/`, `docs/superpowers/`

## Naming rule

Elide is never user-facing; the noun is "the runtime". See
`docs/superpowers/specs/2026-07-25-aura-omp-fork-design.md`.
