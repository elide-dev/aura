# Aura on the OMP fork — design

**Date:** 2026-07-25
**Status:** approved design, pre-implementation
**Repo:** this repository (BREAKDANCE) is a fork of [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) (OMP, omp.sh)

## Summary

Aura is rebuilt as a first-class product inside a fork of OMP, replacing the
previous composition (BUCKSHOT: `@earendil-works/pi-coding-agent` SDK + bun
patches + the `oh-my-pi@0.2.0` orchestrator extension). The fork adds one
differentiator to OMP's harness: **innate runtime capabilities** —
`run` / `check` / `build` / `insights` / `profile` — executed on the Elide
runtime and dispatched through an aura-defined JSON-RPC protocol so the
transport can move from per-call subprocess to broker daemon or in-process
later without touching the tools.

BUCKSHOT (`~/workspace/labs/BUCKSHOT`) is **conceptual reference only** — no
source port. Its engine/desktop/plugins/builder stay where they are.

## Naming principle

To Aura, Elide is simply **the runtime**. Every user-facing and API surface
says "runtime": CLI `aura runtime status`, settings `runtime.*`, RPC methods
`runtime/*`, code directory `src/runtime/`, flag `--runtime`, env
`AURA_RUNTIME_BIN` (with `ELIDE_BIN` honored as a compatibility alias).
"Elide" appears only where it genuinely denotes the Elide distribution
(version pins, download URLs, sha256s, internal docs).

## 1. Repo & upstream strategy

- `upstream` remote → `can1357/oh-my-pi`; `main` is aura's mainline; upstream
  is merged regularly (target: weekly-ish; OMP moves fast — v17.x).
- **Diff discipline:** new code is additive (new directories); edits to
  upstream files are contained to a known set: `packages/utils/src/dirs.ts`
  (branding), `packages/coding-agent/src/tools/{index,builtin-names}.ts`
  (registry), `config/settings-schema.ts`, `sdk.ts` (wiring), release
  scripts (binary names).
- `docs/aura/FORK.md` inventories every upstream file the fork touches, so
  merge conflicts are anticipated, not discovered.
- **Merge gate:** OMP's own suite (`bun run ci:check:full` + TS/Rust tests)
  must be green before and after every upstream merge.

## 2. Branding (aura identity)

First-party source branding — no bun patches:

- `packages/utils/src/dirs.ts`: `APP_NAME = "aura"`,
  `CONFIG_DIR_NAME = ".aura"`; keep `PI_CONFIG_DIR` / `PI_CODING_AGENT_DIR`
  compat and add `AURA_*` aliases.
- Bin entry `aura` in `packages/coding-agent/package.json`; release scripts
  emit `aura-<platform>` binaries.
- Aura theme regenerated from `@elide/tokens` into OMP's theme format,
  shipped via the resources/themes discovery and set as default.
- **Branding guard tests**: binary name, config dir, banner identity,
  first-run state in `~/.aura`. Deep string rebranding (help text, notices)
  is a later, isolated pass.

## 3. Runtime capability core — `packages/coding-agent/src/runtime/`

Core integration (mnemopi/snapcompact house pattern), in three layers:

- **`protocol.ts`** — aura-defined JSON-RPC 2.0 contract: methods
  `runtime/run`, `runtime/check`, `runtime/build`, `runtime/insights`,
  `runtime/profile`, `runtime/status`; `protocolVersion`; typed structured
  errors (`runtime-missing`, `download-failed`, `timeout`, `nonzero-exit`)
  so tools render actionable guidance, never raw stderr.
- **`service.ts`** — `RuntimeService`, the only surface tools see. Speaks
  the protocol to an endpoint; never knows the dispatch mechanism.
- **`transport/`** — `Endpoint` interface (`request(method, params,
  signal)`). V1 ships the **local broker endpoint**: services protocol
  requests by invoking the Elide CLI per call (BUCKSHOT-proven semantics:
  inline code or path mode, args/stdin/timeout, project cwd preserved).
  The protocol is the seam: a stdio broker daemon (subproc) or embedded
  endpoint (inproc) are later drop-ins with zero tool changes.
- **`provision.ts`** — auto-download on first use. Resolution:
  `--runtime` / `AURA_RUNTIME_BIN` / `ELIDE_BIN` →
  `~/.aura/runtime/<pinned-version>/bin/elide` (fetched with per-platform
  sha256 verification, atomic temp-dir+rename install, progress via tool
  `onUpdate`) → PATH fallback. Offline/download failure degrades to
  guidance, never a crash. Requires Elide ≥ 1.4.

Implementation knowledge carried over from BUCKSHOT: file-backed Python runs
on GraalPy 3.12; stdin `-` source mode does not work; the runtime binary
dlopens `../lib`, so `bin/` is never staged alone.

## 4. Tools & settings

Five built-ins in `BUILTIN_TOOLS` behind a shared `createIf` gate
(`runtime.enabled`, default on):

| Tool | Load mode | Notes |
|---|---|---|
| `run` | essential | execute code on the runtime; description delineates vs `bash` (shell) and OMP's `eval` |
| `check` | essential | |
| `build` | essential | |
| `insights` | discoverable (via `hub`) | |
| `profile` | discoverable (via `hub`) | |

All: own TypeBox schema, `approval: "exec"`, house-style
`renderCall`/`renderResult`. Name collision check done: none of the five
collide with OMP built-ins.

Settings: `runtime.enabled`, `runtime.autoDownload` (default true),
`runtime.version`, `runtime.path`.

CLI: `aura runtime status` (wraps `runtime/status`) reports readiness for
humans and smoke tests.

**Not in v1:** managed debug/serve processes, JVM tools, project_advice,
runtime shell policy (bash-tool routing enforcement).

## 5. Assurance backbone

All four layers gate the port; every capability lands test-first.

1. **TDD per capability** — protocol/service unit tests against a mock
   endpoint; provisioning tests against a local fixture HTTP server
   (checksum mismatch, partial download, offline); integration tests tagged
   to require a real runtime, exercising all five methods end-to-end.
2. **Upstream green** — the fork keeps OMP's full check+test CI matrix;
   every phase and every upstream merge lands only on green.
3. **Bench** — OMP's in-repo `metaharness` (not a port of BUCKSHOT's bench):
   an aura capability benchmark adapter scores the innate tools against
   bash-based baselines.
4. **Binary smoke** — CI compiles the `aura` binary per platform and
   cold-runs it: `--version`, branding assertions, first-run runtime
   download against the fixture server, one real `run` round-trip,
   `aura runtime status`.

## 6. Delivery phases

1. **Fork hygiene** — upstream suite green locally; `docs/aura/FORK.md`;
   AGENTS.md/CLAUDE.md addendum for fork conventions.
2. **Branding** — `dirs.ts` + bin name + guard tests.
3. **Runtime core** — protocol → service → local broker endpoint →
   provisioning (TDD throughout).
4. **Tools** — the five tools + settings + `aura runtime status`.
5. **Packaging** — binary build + smoke tests in CI.
6. **Bench** — metaharness adapter.
7. **Upstream merge drill** — one real merge of a newer `upstream/main`;
   document the playbook.
