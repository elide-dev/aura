# Engine-aware unified `run` design

**Date:** 2026-07-30
**Status:** approved design; implementation pending
**Scope:** Aura/OMP fork and its runtime effectiveness benchmark

## Summary

Aura will make `run` the single tool for executing JavaScript, TypeScript, Python, Java, and Kotlin. JavaScript and TypeScript default to Aura's own Bun engine; callers may explicitly select Elide for those languages. Python, Java, and Kotlin use Elide. Invalid language/engine pairs fail before execution starts.

The public `jvm_run` tool will be removed. Its Java/Kotlin compile-and-run behavior moves behind `run`; the five specialized JVM tools remain because they perform distinct operations: disassembly, formatting, JAR work, dependency analysis, and Javadoc generation.

The benchmark will verify TypeScript with a pinned task-owned Bun instead of `/opt/omp/bin/bun` or bare Ubuntu `tsc`. A deterministic, model-free Docker smoke will validate the generated task before a paid campaign.

## Problem

The current `run` implementation sends JavaScript, TypeScript, and Python to Elide. Java and Kotlin use a separate `jvm_run` tool. This creates two execution tools and makes the common operation—run this program—depend on language-specific tool discovery.

The TypeScript benchmark also has an invalid verifier boundary. The source-install-only `/opt/omp/bin/bun` path made historical trials fail, while replacing it with bare Ubuntu `tsc` rejected valid Node/Bun TypeScript because Node types, ESM, top-level await, and Bun APIs were not part of that compiler environment. Runtime trials executed correctly and were graded as failures afterward.

## Goals

- One `run` tool for all five supported languages.
- Bun as the default JavaScript/TypeScript engine.
- Explicit Elide selection retained for JavaScript/TypeScript.
- Elide as the only engine for Python, Java, and Kotlin.
- One coherent code-or-path, args, stdin, cwd, timeout, and cancellation contract.
- No external Bun installation or second Bun version to provision.
- Clean removal of `jvm_run`; no alias or deprecated shim.
- A task-owned TypeScript verifier independent of the agent installation arm.
- A fast verifier smoke that uses no model, credentials, or benchmark attempts.

## Non-goals

- Folding `jvm_disassemble`, `jvm_format`, `jvm_jar`, `jvm_deps`, or `jvm_javadoc` into `run`.
- Removing Elide's JavaScript or TypeScript support.
- Preserving state between Bun calls.
- Running untrusted JavaScript/TypeScript in Aura's main process.
- Changing the semantics of `check`, `build`, `insights`, `profile`, `runtime_debug`, `serve`, or `project_advice` in this change.
- Making the benchmark's historical agent obey current tool-routing policy.

## Public contract

```ts
run({
  code?: string,
  path?: string,
  language?: "js" | "ts" | "python" | "java" | "kotlin",
  engine?: "bun" | "elide",
  args?: string[],
  stdin?: string,
  cwd?: string,
  timeoutMs?: number,
  mainClass?: string,
})
```

`code` and `path` remain mutually exclusive. Path mode infers language from the extension when `language` is omitted. Inline code without `language` defaults to TypeScript. `mainClass` is accepted only for Java and Kotlin.

### Engine matrix

| Language | Default engine | Valid explicit engines |
|---|---|---|
| JavaScript | `bun` | `bun`, `elide` |
| TypeScript | `bun` | `bun`, `elide` |
| Python | `elide` | `elide` |
| Java | `elide` | `elide` |
| Kotlin | `elide` | `elide` |

Engine resolution follows three steps:

1. Resolve language from the explicit field, path extension, or inline TypeScript default.
2. Resolve engine from the explicit field or the matrix default.
3. Validate the pair and language-specific fields before creating a file, worker, runtime process, or JVM work directory.

An invalid pair returns `invalid-params` and names the valid engine or engines for the resolved language. Examples include Python/Bun, Java/Bun, and Kotlin/Bun. `mainClass` with JavaScript, TypeScript, or Python is also `invalid-params`.

Results include the resolved `language` and `engine` in structured details so logs and benchmarks can distinguish defaults from explicit selection.

## Architecture

### Routing boundary

Routing belongs below the tool in the runtime service/endpoint layer. Tool calls, SDK calls, tests, and future non-agent callers must observe the same defaults and validation. `RuntimeRunTool` validates only its schema and forwards the complete request.

A composite run endpoint owns two engines:

- a Bun one-shot endpoint for `engine: "bun"`;
- the existing selected Elide endpoint for `engine: "elide"`.

The existing `runtime.adapter` setting continues to select Elide's process, embedded, or automatic adapter. It does not affect Bun calls. A Bun call must not resolve, provision, probe, or start Elide.

`runtime.enabled` continues to gate the public tool as a whole. When enabled, Bun calls remain available even if Elide is absent. Elide-only calls return the existing missing-runtime guidance.

### Bun endpoint

JavaScript and TypeScript run in a fresh supervised child process using OMP's existing compiled CLI re-entry pattern. The child re-enters the current Aura executable through a hidden selector, analogous to the JavaScript eval subprocess. This preserves source, bundled-JavaScript, and compiled-binary operation without locating or shipping a second `bun` executable.

Each call:

1. Materializes inline code into a temporary `.js` or `.ts` file, or resolves an existing path.
2. Starts the Aura child with the hidden one-shot selector.
3. Applies cwd, environment, program argv, and stdin before loading the guest.
4. Captures stdout, stderr, and exit code without using `console.*` in the parent protocol path.
5. Terminates the child process tree on timeout or cancellation.
6. Removes temporary source after success, failure, timeout, or cancellation.

No globals, module cache, handles, or guest state survive between calls. A guest crash is isolated to the child process.

### Elide endpoint

Explicit Elide JavaScript/TypeScript and all Python calls continue through the existing selected process/embedded endpoint. Existing adapter selection, ABI/schema checks, fresh-context isolation, cancellation, and fallback rules remain unchanged.

### Java and Kotlin through `run`

Resolved Java/Kotlin calls map to the existing `runtime/jvm` method with `action: "run"`. The JVM run contract expands to support:

- inline source or a source path;
- program arguments;
- stdin;
- cwd;
- timeout/cancellation;
- optional `mainClass` override.

The existing compiler/runtime work directory, Java 17 floor, environment hygiene, Kotlin libraries, main-class derivation, compile-error phase, and output capture remain authoritative. `RuntimeJvmResult` remains structurally compatible with the common execution result while retaining compile/run phase and class metadata.

## Tool consolidation

The public `jvm_run` tool is deleted from:

- built-in and essential/discoverable tool registries;
- tool-name unions and documentation coverage;
- prompts, bundled JVM skills, gallery fixtures, and help text;
- benchmark tool lists and adoption accounting;
- tests and expected tool counts.

All callers migrate directly to `run({ language: "java" | "kotlin", ... })`. No alias, re-export, hidden compatibility tool, or deprecation shim remains.

The following tools remain separate:

- `jvm_disassemble`
- `jvm_format`
- `jvm_jar`
- `jvm_deps`
- `jvm_javadoc`

They remain discoverable rather than essential.

## Diagnostics and documentation

The `run` tool description, runtime skill, JVM skill, tool docs, settings docs, and CLI diagnostics will explain the engine matrix. `aura runtime status` and `aura doctor` will report Bun as an intrinsic engine and Elide's selected adapter/status separately. User-facing text continues to call Elide “the runtime” except where the explicit API value `engine: "elide"` must be named.

The coding-agent changelog records the `jvm_run` removal as a breaking change and engine-aware `run` as added/changed behavior.

## Benchmark correction

The TypeScript task image will own its verifier runtime. Its Dockerfile copies a Bun version pinned to the repository's `packageManager` version from an architecture-compatible Bun image into a stable task path. The verifier invokes that task-owned Bun, never:

- `/opt/omp/bin/bun`, which exists only in source-install arms;
- an agent binary's adjacent files;
- bare `tsc`, Node typings, or a guessed module configuration.

The normal TypeScript runtime arm exercises `run` with the default Bun engine. Focused engine-parity coverage explicitly exercises `engine: "elide"`; the main causal arm does not mix engines.

A deterministic verifier smoke runs before model work. It materializes the TypeScript task, builds the task image, installs representative valid sources, and runs the generated verifier against:

- a `node:fs` import;
- TypeScript syntax;
- top-level await;
- the expected sorted BFS output.

This smoke requires neither the auth broker/gateway nor a model. A failed smoke prevents the benchmark campaign from starting. A one-attempt TypeScript-only agent preflight remains the next gate after deterministic verification.

## Error handling

- Invalid engine/language pairs: `invalid-params`, before side effects.
- Invalid source shape or language-specific fields: `invalid-params`.
- Missing Bun child-host entry: internal execution error with compiled/source launch diagnostics.
- Missing Elide for an Elide call: existing runtime-missing guidance.
- Java/Kotlin compile failure: successful tool response with nonzero exit and `phase: "compile"`, matching current JVM behavior.
- Timeout/cancellation: killed execution result where a child or guest was active; temporary resources always cleaned.

## Test strategy

### Unit and contract tests

- Every language with omitted and explicit engines.
- Every invalid pair, proving no backend call occurs.
- Path inference and inline TypeScript default.
- `mainClass` acceptance/rejection.
- Result details contain resolved engine/language.
- Registry and docs contain no `jvm_run` surface.
- Existing specialized JVM tools remain registered.

### Bun integration

- Inline JavaScript and TypeScript exact output.
- File-backed TypeScript with sibling import and top-level await.
- Args, stdin, cwd, and environment.
- Nonzero exit, timeout, cancellation, and subsequent clean call.
- Source-mode and compiled-Aura CLI re-entry smoke.

### Elide integration

- Default Python.
- Explicit Elide JavaScript and TypeScript.
- Existing process/embedded parity and isolation tests.
- Missing Elide does not prevent a Bun call.

### Unified JVM integration

- Java and Kotlin inline and path execution through `run`.
- Args and stdin.
- Main-class derivation and override.
- Compile failure.
- Removal of public `jvm_run` without weakening the underlying JVM flow tests.

### Benchmark preflight

- Generated Docker/verifier contract test.
- Model-free task-image execution smoke.
- One-attempt TypeScript baseline/runtime/historical preflight before any five-attempt campaign.

## Migration and rollout

This is a clean cutover. Existing internal `runtime/jvm` protocol support remains because the five specialized JVM tools share it, but its `run` action is reached publicly through `run` only.

Implementation checkpoints should be committed separately:

1. Engine matrix and Bun endpoint.
2. Java/Kotlin unified run and `jvm_run` removal.
3. Prompt, docs, renderer, and diagnostics migration.
4. Benchmark task-owned Bun verifier and deterministic smoke.
5. Integration verification and changelog cleanup.

The full effectiveness campaign remains blocked until all checkpoints pass their focused tests and the deterministic benchmark smoke.