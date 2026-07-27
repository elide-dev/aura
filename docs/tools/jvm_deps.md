# jvm_deps

> Analyze JVM dependencies with `jdeps`, over provided source or an existing artifact.

## Source
- Entry: `packages/coding-agent/src/tools/jvm-deps.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/jvm-deps.md`
- Key collaborators:
  - `packages/coding-agent/src/runtime/service.ts` — `RuntimeService.jvm()`.
  - `packages/coding-agent/src/runtime/transport/local.ts` — the `deps` flow of `runtime/jvm` (`jvmDepsFromSource` / `jvmDepsFromPath`).
  - `packages/coding-agent/src/runtime/jvm.ts` — `deriveJvmMainClass()`, `JVM_BYTECODE_RELEASE`.
  - `packages/coding-agent/src/runtime/format.ts` — `formatExecResult()`.
  - `packages/coding-agent/src/tools/index.ts` — registers the built-in via `JvmDepsTool.createIf`.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `path` | `string` | No | Existing `.class`, `.jar`, or class directory, resolved against the session cwd. Selects artifact mode. |
| `language` | `"java" \| "kotlin"` | No | Source language (source mode). |
| `code` | `string` | No | Source to compile and analyze (source mode). |
| `mainClass` | `string` | No | Entrypoint class. Defaults to the derived class. |
| `timeoutMs` | `number` | No | Kills the compile or the analysis after this many milliseconds. |

Exactly one mode must be satisfiable: `path`, or `language` + `code`. `path` wins when both are present.

## Outputs
A single text block plus `details` carrying the raw `RuntimeJvmResult`.

- Text is `formatExecResult(result)` — `jdeps` writes its report to stdout, and its complaints to stderr, so both are shown.
- `details`: `{ exitCode, stdout, stderr, durationMs, killed, action: "deps", phase, language?, className? }`. `language`/`className` are present only in source mode.

## Flow (artifact mode)
1. Params are sent as `runtime/jvm` with `action: "deps"` and `cwd` = the session cwd.
2. `path` is resolved against `cwd` and must exist.
3. `<binary> jdeps -- <absolute path>` runs in `cwd`. No workdir, nothing compiled, nothing written.

## Flow (source mode)
1. `language` and `code` are required; without them the call is `invalid-params`.
2. The endpoint opens one temp workdir, derives the class name, writes the source, and compiles (`javac -- --release 17 <className>.java`, or `kotlinc -- Main.kt -cp . -d out`). A failed compile returns with `phase: "compile"`.
3. `<binary> jdeps -- <className>.class` (Java) or `<binary> jdeps -- out` (Kotlin).
4. The workdir is removed in a `finally` block. `JAVA_HOME`/`JDK_HOME` are stripped from the spawn environment.

## Modes / Variants
- **artifact**: read-only analysis of something already on disk.
- **source**: compile-then-analyze, useful for "what would this code pull in".

## Side Effects
- Filesystem: source mode creates and removes one temp dir; artifact mode touches nothing.
- Subprocesses: two runtime spawns in source mode, one in artifact mode.
- Network: first use may download the managed runtime when `runtime.autoDownload` is on.
- Approval: `approval = "exec"`.

## Limits & Caps
- No `--multi-release`, `--module-path`, or summary/dot-output flags are exposed; the report is `jdeps`' default form.
- Report text goes through the same `400_000`-character bound and the central artifact spill.
- Requires runtime >= 1.4.

## Errors
- `The runtime service is unavailable on this session (runtime.enabled may be false, or this host does not provide it).` when no runtime service is wired.
- `jvm_deps requires either \`path\` (existing .class/.jar) or \`language\` + \`code\`.` — `invalid-params`.
- `No class file or jar found at <absolute path>.` — `invalid-params`, with `data.path`.
- `runtime-missing` with installation guidance; `cancelled` on abort.

## Notes
- `loadMode = "discoverable"`.
- `jdeps` often reports a nonzero exit alongside a useful report (for example on an unresolved dependency); read the text, not just the exit code.
