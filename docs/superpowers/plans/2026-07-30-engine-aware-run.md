# Engine-Aware Unified Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `run` execute JavaScript/TypeScript with Bun by default, retain explicit Elide JS/TS, execute Python/Java/Kotlin with Elide, remove `jvm_run`, and replace the benchmark's bare-`tsc` verifier with task-owned Bun.

**Architecture:** Extend the runtime protocol with an optional engine and resolved execution metadata. `SelectedRuntimeEndpoint` dispatches Bun requests to a new one-shot child-process endpoint using OMP's CLI re-entry command, while Elide requests retain existing process/embedded selection. Java/Kotlin `run` requests adapt to the existing `runtime/jvm` run action. The benchmark image owns a pinned Bun verifier and exposes a model-free smoke before paid arms.

**Tech Stack:** Bun/TypeScript, ArkType, JSON-RPC runtime protocol, Bun subprocesses, existing Elide process/embedded adapters, Harbor/Docker metaharness, Bun test, Biome/tsgo.

## Global Constraints

- `engine` is optional; defaults are js/ts→bun and python/java/kotlin→elide.
- Explicit Elide remains valid for JavaScript and TypeScript.
- Bun is invalid for Python, Java, and Kotlin; reject invalid pairs before side effects.
- Java/Kotlin support code or path, args, stdin, cwd, timeout, cancellation, and optional `mainClass`.
- Remove only `jvm_run`; keep the five specialized JVM tools.
- No compatibility alias, deprecated shim, or re-export for `jvm_run`.
- Do not ship or resolve a second Bun executable; re-enter the current Aura/Bun host.
- `runtime.adapter` applies only to Elide.
- The task verifier never uses `/opt/omp`, an agent-adjacent runtime, or bare `tsc`.
- User-facing prose says “the runtime” except for the explicit API enum value `engine: "elide"`.
- Follow `docs/aura/FORK.md`; add rows only for newly touched upstream files.

---

### Task 1: Engine contract and validation

**Files:**
- Modify: `packages/coding-agent/src/runtime/protocol.ts`
- Modify: `packages/coding-agent/src/tools/runtime-run.ts`
- Modify: `packages/coding-agent/test/runtime-protocol.test.ts`
- Modify: `packages/coding-agent/test/runtime-run-tool.test.ts`

**Interfaces:**
- Produces: `RunEngine = "bun" | "elide"`.
- Produces: `resolveRunTarget(params): { language: RuntimeLanguage; engine: RunEngine }` or an `invalid-params` error.
- Extends: `RuntimeRunParams` with `engine?: RunEngine` and `mainClass?: string`.
- Extends: `RuntimeExecResult` with optional/resolved `engine` and `language` metadata without breaking specialized JVM result fields.

- [ ] **Step 1: Add failing engine-matrix tests**

Cover omitted defaults, explicit js/ts Elide, invalid Python/Java/Kotlin Bun, path inference, inline TypeScript default, `mainClass` rejection for non-JVM languages, and exact `invalid-params` messages. Assert invalid requests do not reach a fake endpoint.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
bun test test/runtime-protocol.test.ts test/runtime-run-tool.test.ts
```

Expected: failures because `engine`, `mainClass`, and target resolution are absent.

- [ ] **Step 3: Implement the protocol and pure resolver**

Use an exhaustive table:

```ts
const RUN_ENGINES: Record<RuntimeLanguage, readonly RunEngine[]> = {
  js: ["bun", "elide"],
  ts: ["bun", "elide"],
  python: ["elide"],
  java: ["elide"],
  kotlin: ["elide"],
};
```

Resolve language first, then engine, then language-specific fields. Return `RuntimeRpcError("invalid-params", ...)` before endpoint dispatch.

- [ ] **Step 4: Update the public tool schema**

Add `engine` and `mainClass`, expand language to five members, and update the summary. Keep `code` XOR `path` validation in the runtime boundary rather than duplicating it in the tool.

- [ ] **Step 5: Run focused tests and verify GREEN**

```bash
bun test test/runtime-protocol.test.ts test/runtime-run-tool.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/coding-agent/src/runtime/protocol.ts packages/coding-agent/src/tools/runtime-run.ts packages/coding-agent/test/runtime-protocol.test.ts packages/coding-agent/test/runtime-run-tool.test.ts
git commit -m "feat(runtime): add engine-aware run contract"
```

### Task 2: One-shot Bun execution endpoint

**Files:**
- Create: `packages/coding-agent/src/runtime/transport/bun.ts`
- Create: `packages/coding-agent/src/runtime/bun-run-entry.ts`
- Modify: `packages/coding-agent/src/cli.ts`
- Modify: `packages/coding-agent/src/runtime/transport/selected.ts`
- Create: `packages/coding-agent/test/runtime-bun-endpoint.test.ts`
- Modify: `packages/coding-agent/test/runtime-embedded-endpoint.test.ts`

**Interfaces:**
- Produces: `BunRuntimeEndpoint implements RuntimeEndpoint` for `runtime/run` js/ts requests.
- Produces: hidden selector `__omp_worker_runtime_bun_run`.
- Consumes: `resolveWorkerSpawnCmd(selector)` and the engine resolver from Task 1.

- [ ] **Step 1: Add failing Bun endpoint integration tests**

Use the real current Bun/Aura host to cover inline JS/TS, file-backed sibling imports, top-level await, argv, stdin, cwd, environment, nonzero exit, timeout, cancellation, cleanup, and a successful call after termination.

- [ ] **Step 2: Run the new test and verify RED**

```bash
bun test test/runtime-bun-endpoint.test.ts
```

Expected: module/selector unavailable.

- [ ] **Step 3: Implement the hidden one-shot entry**

The child receives a source path plus program args after the selector, rewrites `process.argv` to program shape, and imports the source with a cache-busting file URL. Parent-selected cwd/env and piped stdin already define process behavior. Uncaught guest failures set a nonzero exit and write the native Bun diagnostic to stderr.

- [ ] **Step 4: Implement `BunRuntimeEndpoint`**

For inline code, create one temporary `.js`/`.ts` source and delete it in `finally`. Spawn the command returned by `resolveWorkerSpawnCmd`, append selector payload and args, pipe stdin/stdout/stderr, race exit against abort/timeout, terminate the process tree, and return `RuntimeExecResult` with `engine: "bun"` and the resolved language.

- [ ] **Step 5: Route Bun before Elide adapter selection**

`SelectedRuntimeEndpoint.request` resolves every `runtime/run` target. Bun goes directly to the Bun endpoint; Elide continues through existing process/embedded/auto logic. Status and close include the Bun endpoint without probing Elide for a Bun call.

- [ ] **Step 6: Run focused routing and Bun tests**

```bash
bun test test/runtime-bun-endpoint.test.ts test/runtime-embedded-endpoint.test.ts
```

- [ ] **Step 7: Add worker-host smoke coverage**

Extend `--smoke-test` with a bounded Bun-run child probe that prints an exact sentinel and exits, covering source and compiled CLI re-entry.

- [ ] **Step 8: Commit**

```bash
git add packages/coding-agent/src/runtime/transport/bun.ts packages/coding-agent/src/runtime/bun-run-entry.ts packages/coding-agent/src/cli.ts packages/coding-agent/src/runtime/transport/selected.ts packages/coding-agent/test/runtime-bun-endpoint.test.ts packages/coding-agent/test/runtime-embedded-endpoint.test.ts
git commit -m "feat(runtime): execute JavaScript and TypeScript with Bun"
```

### Task 3: Unified Java and Kotlin execution

**Files:**
- Modify: `packages/coding-agent/src/runtime/protocol.ts`
- Modify: `packages/coding-agent/src/runtime/service.ts`
- Modify: `packages/coding-agent/src/runtime/transport/selected.ts`
- Modify: `packages/coding-agent/src/runtime/transport/local.ts`
- Modify: `packages/coding-agent/src/runtime/jvm.ts`
- Modify: `packages/coding-agent/test/runtime-jvm-endpoint.test.ts`
- Modify: `packages/coding-agent/test/runtime-integration.test.ts`

**Interfaces:**
- Extends: `RuntimeJvmParams` with source-path, args, and stdin support for `action: "run"`.
- Produces: Java/Kotlin `runtime/run` adaptation to `runtime/jvm { action: "run" }`.
- Returns: common execution fields plus JVM phase/class metadata and resolved `engine: "elide"`.

- [ ] **Step 1: Add failing Java/Kotlin unified-run tests**

Cover inline and path source, args, stdin, cwd, main-class derivation/override, compile failure, cancellation, and invalid Bun selection.

- [ ] **Step 2: Verify RED**

```bash
bun test test/runtime-jvm-endpoint.test.ts
```

- [ ] **Step 3: Extend JVM run plumbing**

Read path source without mutating it, materialize under its source basename, pass program args after the main class, write stdin to the Java process, and preserve current compiler workdir/environment safeguards.

- [ ] **Step 4: Adapt Java/Kotlin `runtime/run` requests**

At the composite endpoint, map resolved Java/Kotlin Elide calls onto `runtime/jvm` action `run`. Adapt the response ID and retain all JVM metadata.

- [ ] **Step 5: Run focused unit and real-binary tests**

```bash
bun test test/runtime-jvm-endpoint.test.ts
AURA_RUNTIME_BIN="$PWD/../../out/aura-elide-linux-x64/bin/elide" bun test test/runtime-integration.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/coding-agent/src/runtime/protocol.ts packages/coding-agent/src/runtime/service.ts packages/coding-agent/src/runtime/transport/selected.ts packages/coding-agent/src/runtime/transport/local.ts packages/coding-agent/src/runtime/jvm.ts packages/coding-agent/test/runtime-jvm-endpoint.test.ts packages/coding-agent/test/runtime-integration.test.ts
git commit -m "feat(runtime): run Java and Kotlin through unified tool"
```

### Task 4: Remove public `jvm_run`

**Files:**
- Remove: `packages/coding-agent/src/tools/jvm-run.ts`
- Remove: `packages/coding-agent/src/prompts/tools/jvm-run.md`
- Remove: `docs/tools/jvm_run.md`
- Modify: `packages/coding-agent/src/tools/index.ts`
- Modify: `packages/coding-agent/src/tools/builtin-names.ts`
- Modify: `packages/coding-agent/src/discovery/builtin-skill-sources/jvm.md`
- Modify: runtime gallery fixtures and tool-registry tests located by symbol references
- Modify: `docs/aura/FORK.md`

**Interfaces:**
- Removes: `JvmRunTool`, `JvmRunToolParams`, and tool name `jvm_run`.
- Preserves: internal `runtime/jvm` run action and five specialized JVM tools.

- [ ] **Step 1: Use LSP references for `JvmRunTool` and `jvm_run`**

Migrate every code caller and expected registry entry. Plain prose/docs occurrences are handled after symbol-aware callers.

- [ ] **Step 2: Add failing registry contract**

Assert `run` is essential, `jvm_run` is absent, and the five specialized names remain discoverable.

- [ ] **Step 3: Delete the tool and migrate prompts/skills/docs**

Examples become `run({ language: "java" | "kotlin", engine: "elide", ... })`. Remove files rather than leaving redirects or aliases.

- [ ] **Step 4: Run registry/docs tests**

```bash
bun test test/runtime-tool-registry.test.ts test/internal-urls/docs-tool-coverage.test.ts test/discovery/builtin-skills.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add -A packages/coding-agent/src/tools/jvm-run.ts packages/coding-agent/src/prompts/tools/jvm-run.md docs/tools/jvm_run.md packages/coding-agent/src/tools packages/coding-agent/src/discovery/builtin-skill-sources packages/coding-agent/test docs/aura/FORK.md
git commit -m "refactor(runtime): replace jvm_run with run"
```

### Task 5: User-facing engine diagnostics and documentation

**Files:**
- Modify: `packages/coding-agent/src/prompts/tools/runtime-run.md`
- Modify: `docs/tools/run.md`
- Modify: `packages/coding-agent/src/discovery/builtin-skill-sources/runtime.md`
- Modify: `packages/coding-agent/src/cli/runtime-cli.ts`
- Modify: `packages/coding-agent/src/cli/doctor-cli.ts`
- Modify: `packages/coding-agent/src/tools/runtime-renderer.ts`
- Modify: `docs/settings.md`
- Modify: `docs/environment-variables.md`
- Modify: `packages/coding-agent/CHANGELOG.md`
- Modify: corresponding CLI/renderer tests

**Interfaces:**
- Displays: resolved engine/language for `run`.
- Documents: `runtime.adapter` as Elide-only selection.
- Reports: intrinsic Bun engine separately from Elide status.

- [ ] **Step 1: Add failing renderer/diagnostic assertions**

Pin engine display, Bun availability without Elide, and Elide adapter diagnostics.

- [ ] **Step 2: Update prompts, skills, docs, renderer, and diagnostics**

Use exact matrix examples and invalid-pair behavior. Add Breaking Changes entry for `jvm_run` removal and Changed/Added entries for engine-aware `run`.

- [ ] **Step 3: Run focused UI/CLI tests**

```bash
bun test test/runtime-tool-renderers.test.ts test/runtime-cli.test.ts test/doctor-cli.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add packages/coding-agent/src/prompts/tools/runtime-run.md docs/tools/run.md packages/coding-agent/src/discovery/builtin-skill-sources/runtime.md packages/coding-agent/src/cli/runtime-cli.ts packages/coding-agent/src/cli/doctor-cli.ts packages/coding-agent/src/tools/runtime-renderer.ts docs/settings.md docs/environment-variables.md packages/coding-agent/CHANGELOG.md packages/coding-agent/test
git commit -m "docs(runtime): document engine-aware run"
```

### Task 6: Task-owned Bun benchmark verifier

**Files:**
- Modify: `packages/metaharness/src/runtime-benchmark-suite.ts`
- Modify: `packages/metaharness/src/runtime-benchmark-suite.test.ts`
- Modify: `packages/metaharness/src/runtime-benchmark.ts`
- Modify: `packages/metaharness/src/runtime-benchmark.test.ts`
- Modify: `packages/metaharness/README.md`

**Interfaces:**
- Produces: TypeScript verifier invoking a pinned task-owned Bun.
- Produces: model-free verifier-smoke mode that exits before auth/model launch on failure.
- Updates: task tool lists from `jvm_run` to `run` for Java/Kotlin execution.

- [ ] **Step 1: Replace the current regression test with a failing task-owned Bun contract**

Assert generated Dockerfile has a pinned Bun source stage, verifier path is task-owned, and neither `/opt/omp/bin/bun` nor `/usr/bin/tsc` appears.

- [ ] **Step 2: Verify RED**

```bash
bun test src/runtime-benchmark-suite.test.ts src/runtime-benchmark.test.ts
```

- [ ] **Step 3: Implement pinned Bun materialization**

Derive the Bun tag from the repository `packageManager` pin or one shared constant validated against it. Copy the architecture-compatible Bun binary into the final Ubuntu task image and invoke it from a stable path.

- [ ] **Step 4: Add deterministic Docker verifier smoke**

Materialize the TypeScript task, build its image, add a reference program using Node imports, TypeScript syntax, and top-level await, execute `tests/test.sh`, and require reward `1`. This path performs no gateway or model calls.

- [ ] **Step 5: Update benchmark tool/adoption manifests**

Java/Kotlin execution tasks expose `run`; no manifest or report names `jvm_run`. Normal TypeScript runtime calls default to Bun; focused explicit-Elide coverage remains outside the causal arm.

- [ ] **Step 6: Run deterministic preflight and tests**

```bash
bun test src/runtime-benchmark-suite.test.ts src/runtime-benchmark.test.ts
bun run bench:runtime --verify-suite --task typescript-execution
```

- [ ] **Step 7: Commit**

```bash
git add packages/metaharness/src/runtime-benchmark-suite.ts packages/metaharness/src/runtime-benchmark-suite.test.ts packages/metaharness/src/runtime-benchmark.ts packages/metaharness/src/runtime-benchmark.test.ts packages/metaharness/README.md
git commit -m "fix(metaharness): verify TypeScript with task-owned Bun"
```

### Task 7: Integration gate and final cleanup

**Files:**
- Modify: root/package test scripts only if needed to make artifact-backed tests non-skippable in the runtime bundle lane
- Modify: `scripts/build-relocatable-runtime-bundle.test.ts`
- Modify: `docs/aura/FORK.md`
- Modify: affected changelog/docs from final behavior only

**Interfaces:**
- Produces: one repeatable command proving Bun, Elide Python/JS/TS, and unified JVM execution against packaged artifacts.

- [ ] **Step 1: Run package checks**

```bash
bun --cwd=packages/coding-agent run check
bun --cwd=packages/metaharness run check
```

- [ ] **Step 2: Run focused and full package tests**

```bash
bun --cwd=packages/coding-agent test
bun --cwd=packages/metaharness test
```

- [ ] **Step 3: Run real artifact integrations**

```bash
AURA_RUNTIME_BIN="$PWD/out/aura-elide-linux-x64/bin/elide" bun --cwd=packages/coding-agent test test/runtime-integration.test.ts
AURA_RUNTIME_EMBEDDED_LIB="$PWD/out/aura-elide-linux-x64/lib/libelide_embed.so" bun --cwd=packages/coding-agent test test/runtime-embedded-integration.test.ts
```

The tests must report executed cases, not a skipped suite.

- [ ] **Step 4: Run the actual CLI smoke**

Exercise JavaScript/TypeScript default Bun, explicit Elide TypeScript, default Elide Python, Java, and Kotlin through `run`, then `aura --smoke-test` on the packaged binary.

- [ ] **Step 5: Review and remove obsolete scaffolding**

Remove stale generated benchmark arms only when they would be mistaken for valid evidence. Keep diagnostic failures if they are intentionally retained as investigation artifacts. Do not commit `out/`, `runs/`, Bazel links, or other build outputs.

- [ ] **Step 6: Commit final cleanup**

```bash
git add packages/coding-agent packages/metaharness docs scripts package.json
git commit -m "test(runtime): gate unified execution integrations"
```

- [ ] **Step 7: Pause before benchmark campaign**

Do not launch the five-attempt effectiveness campaign. Present commit list, exact verification evidence, remaining limitations, and the model-free preflight command for review.