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
| `path` | `string` | No | Existing Java/Kotlin source, `.class`, `.jar`, or class directory, resolved against the session cwd. Selects path mode. |
| `language` | `"java" \| "kotlin"` | No | Source language (inline-source mode). |
| `code` | `string` | No | Source to compile and analyze (inline-source mode). |
| `mainClass` | `string` | No | Entrypoint class. Must be a class name (`/^[\w.$]+$/`). Defaults to the derived class. |
| `output` | `string` | No | Optional cwd-relative file to receive the dependency report. |
| `overwrite` | `boolean` | No | Required to replace an existing `output`. |
| `timeoutMs` | `number` | No | Kills the compile or the analysis after this many milliseconds. |

Exactly one input mode must be satisfiable: `path`, or `language` + `code`. A non-empty `path` wins when both are present; an empty `path` is treated as absent and takes inline-source mode. Java/Kotlin source paths compile in scratch space before analysis; `.class`, JAR, and class-directory paths are analyzed directly.

## Outputs
A single text block plus `details` carrying the raw `RuntimeJvmResult`.

- Text is the dependency report on stdout plus any stderr or exit annotation.
- With `output`, a successful report is also written to the requested file and the text names that absolute path.
- `details`: `{ exitCode, stdout, stderr, durationMs, killed, action: "deps", phase, language?, className?, output? }`. `language`/`className` are present after source compilation; `output` is the absolute path written.

## Flow (path mode)
1. Params are sent as `runtime/jvm` with `action: "deps"` and `cwd` = the session cwd.
2. A `.java` or `.kt` path is read, compiled in a temp workdir, and analyzed as source. Other paths run `<binary> jdeps -- <absolute path>` directly in `cwd`.

## Flow (inline-source mode)
1. `language` and `code` are required; without them the call is `invalid-params`.
2. The endpoint opens one temp workdir, derives the class name, writes the source, and compiles (`javac -- --release 17 <className>.java`, or `kotlinc -- Main.kt -cp . -d out`). A failed compile returns with `phase: "compile"`.
3. `<binary> jdeps -- <className>.class` (Java) or `<binary> jdeps -- out` (Kotlin).
4. The workdir is removed in a `finally` block. `JAVA_HOME`/`JDK_HOME` are stripped from the spawn environment.
5. If `output` was requested and analysis succeeded, the report is written only after the temp workdir has closed.

## Modes / Variants
- **artifact path**: read-only analysis of an existing `.class`, JAR, or class directory.
- **source path**: compile-then-analyze an existing `.java` or `.kt` file.
- **inline source**: compile-then-analyze provided code.

## Side Effects
- Filesystem: source modes create and remove one temp dir. `output` writes one report file strictly inside the session cwd; without it, no project file changes.
- Subprocesses: two runtime spawns in source modes, one in artifact mode.
- Network: first use may download the managed runtime when `runtime.autoDownload` is on.
- Approval: `approval = "exec"`.

## Limits & Caps
- No `--multi-release`, `--module-path`, or summary/dot-output flags are exposed; the report is `jdeps`' default form. Use `output` when another project command needs the report as a file.
- The report is not truncated by the tool; past `tools.artifactSpillThreshold` the central artifact spill preserves it in full and keeps a head/tail preview inline.
- Requires runtime >= 1.4.

## Errors
- `The runtime service is unavailable on this session (runtime.enabled may be false, or this host does not provide it).` when no runtime service is wired.
- `jvm_deps requires \`path\` (source, .class, .jar, or class directory) or \`language\` + \`code\`.` — `invalid-params`.
- `No JVM source, class, JAR, or class directory found at <absolute path>.` — `invalid-params`, with `data.path`.
- `Refusing to overwrite <absolute path> — pass overwrite: true to replace it.` — `invalid-params`, with `data.output`.
- `Refusing to write output to <absolute path> — output must be a path inside the working directory (<cwd>), not the directory itself or one of its parents.` — `invalid-params`, with `data.output`.
- `Refusing to write the dependency report to <absolute path> — it is an existing directory.` — `invalid-params`, with `data.output`.
- `mainClass must be a class name (letters, digits, "_", "$", "."), got: <value>` — `invalid-params`.
- `runtime-missing` with installation guidance; `cancelled` on abort.

## Notes
- `loadMode = "discoverable"`.
- `jdeps` often reports a nonzero exit alongside a useful report (for example on an unresolved dependency); read the text, not just the exit code.
