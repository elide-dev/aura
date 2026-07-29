# Aura Relocatable Runtime Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and archive a relocatable Linux x64/glibc Aura distribution containing the compiled CLI, complete Elide process runtime, and embedded runtime libraries.

**Architecture:** A dedicated Bun TypeScript script validates an explicit WHIPLASH distribution, invokes Aura's existing release-binary builder or consumes an explicit prebuilt binary, stages the complete runtime plus a relocatable launcher/config overlay, smoke-tests the staged and extracted layouts, and emits a deterministic `.tar.gz` plus SHA-256. Tests exercise the script against fake distributions and binaries without building production artifacts.

**Tech Stack:** Bun/TypeScript, `node:fs/promises`, Bun subprocesses, POSIX shell launcher, GNU tar, SHA-256.

## Global Constraints

- Initial and only accepted target: Linux x64/glibc.
- The script must receive `--runtime-dist` or `AURA_RUNTIME_DIST`; never guess a sibling checkout.
- Copy the complete WHIPLASH distribution.
- Preserve `libelide_embed.so` and `libelide_embed_engine.so` as sibling files.
- Default runtime settings: enabled, adapter `auto`, auto-download disabled.
- Do not modify user configuration or relocate user auth/state.
- Validate before replacing a prior output; never accept a partial staging directory.
- Do not commit unless explicitly requested.

---

### Task 1: Packaging contract tests

**Files:**
- Create: `scripts/build-relocatable-runtime-bundle.test.ts`

**Interfaces:**
- Consumes CLI: `bun scripts/build-relocatable-runtime-bundle.ts --runtime-dist <dir> --aura-binary <file> --output-dir <dir> [--no-archive] [--skip-smoke]`.
- Produces behavioral coverage for the script implemented in Task 2.

- [x] Create temporary fake runtime and Aura executables. Invoke the absent script with `--no-archive --skip-smoke`; assert the initial run fails because the entrypoint does not exist.
- [x] Assert a successful implementation copies arbitrary runtime files, writes executable `bin/aura` and `bin/aura.bin`, preserves both embedded libraries, and writes the exact runtime overlay.
- [x] Run the generated launcher with a fake `aura.bin` that prints its environment; assert relocatable absolute runtime paths, prepended `PI_CONFIG_FILES`, and argument forwarding.
- [x] Invoke the script with each required runtime artifact missing; assert a nonzero exit and an error naming the missing relative path.
- [x] Run `bun test scripts/build-relocatable-runtime-bundle.test.ts`; retain the expected red failure before implementation.

### Task 2: Bundle builder

**Files:**
- Create: `scripts/build-relocatable-runtime-bundle.ts`
- Modify: `package.json`
- Modify: `docs/aura/FORK.md`

**Interfaces:**
- Consumes the CLI contract from Task 1.
- Produces `out/aura-elide-linux-x64/`, optional `.tar.gz`, and optional `.sha256`.

- [x] Parse the supported flags without a dependency. Resolve paths against the caller's working directory. Reject unknown flags, missing values, unsupported hosts, and missing required input.
- [x] Validate `bin/elide`, `lib/libelide_embed.so`, and `lib/libelide_embed_engine.so` before touching output.
- [x] When `--aura-binary` is absent, run the repository-pinned Bun release compiler against `scripts/ci-release-build-binaries.ts --targets linux-x64` at the repository root and consume `packages/coding-agent/binaries/aura-linux-x64`.
- [x] Stage into a unique sibling temporary directory with `fs.cp(..., { recursive: true, dereference: true })`; install Aura as executable `bin/aura.bin`.
- [x] Write `etc/aura-bundle.yml` with `runtime.enabled: true`, `runtime.adapter: auto`, and `runtime.autoDownload: false`.
- [x] Write an executable POSIX `bin/aura` launcher that derives the bundle root, exports `AURA_RUNTIME_BIN` and `AURA_RUNTIME_EMBEDDED_LIB`, prepends its overlay to `PI_CONFIG_FILES`, and execs `aura.bin` with unchanged arguments.
- [x] Unless `--skip-smoke`, run staged `--version`, `--smoke-test`, and `runtime status --json`; run `ldd` and reject `not found`.
- [x] Atomically replace the output directory after validation. Unless `--no-archive`, run GNU tar with stable ordering/ownership, write SHA-256, extract into a temporary directory, and repeat launcher verification against the extracted bundle.
- [x] Add root script `build:runtime-bundle` and record the fork-owned files in `docs/aura/FORK.md`.
- [x] Run the focused tests and `bun check`.

### Task 3: Produce and prove the real bundle

**Files:**
- Build output only: `out/aura-elide-linux-x64/`
- Build output only: `out/aura-elide-linux-x64.tar.gz`
- Build output only: `out/aura-elide-linux-x64.tar.gz.sha256`

**Interfaces:**
- Consumes the verified WHIPLASH distribution at `/home/sam/workspace/worktrees/WHIPLASH-embedded/.dev/artifacts/dist/current`.
- Produces the user-testable relocatable archive and checksum.

- [x] Confirm the input distribution contains executable `bin/elide` and both embedded libraries.
- [x] Run `bun run build:runtime-bundle --runtime-dist /home/sam/workspace/worktrees/WHIPLASH-embedded/.dev/artifacts/dist/current`.
- [x] Confirm staged and extracted `aura --version`, `aura --smoke-test`, and `aura runtime status --json` succeed and report the bundled paths with embedded ABI readiness.
- [x] Run the existing real embedded integration suite against the staged library.
- [x] Report exact artifact paths, byte sizes, SHA-256, extraction command, and first-run command.
