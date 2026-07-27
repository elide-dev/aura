# jvm_run

> Compile and run a Java or Kotlin program on the embedded JVM.

## Source
- Entry: `packages/coding-agent/src/tools/jvm-run.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/jvm-run.md`
- Key collaborators:
  - `packages/coding-agent/src/runtime/service.ts` — `RuntimeService.jvm()`.
  - `packages/coding-agent/src/runtime/transport/local.ts` — the `run` flow of `runtime/jvm`: one temp workdir, `javac`/`kotlinc`, then `java`.
  - `packages/coding-agent/src/runtime/jvm.ts` — `deriveJvmMainClass()`, `jvmSourceFile()`, `jvmClasspath()`, `JVM_BYTECODE_RELEASE`.
  - `packages/coding-agent/src/runtime/format.ts` — `formatExecResult()`.
  - `packages/coding-agent/src/tools/jvm-common.ts` — `requireRuntimeService()`.
  - `packages/coding-agent/src/tools/index.ts` — registers the built-in via `JvmRunTool.createIf`.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `language` | `"java" \| "kotlin"` | Yes | Source language. |
| `code` | `string` | Yes | Java or Kotlin source. |
| `mainClass` | `string` | No | Entrypoint class. Must be a class name (`/^[\w.$]+$/`). Defaults to the derived class (see Flow). |
| `timeoutMs` | `number` | No | Kills the compile or the run after this many milliseconds. |

`cwd` is not a parameter; the session cwd is passed through as the protocol's `cwd` (it only affects path resolution, which this action does not use).

## Outputs
A single text block plus `details` carrying the raw `RuntimeJvmResult`.

- Text is `formatExecResult(result)` — stdout, a `--- stderr ---` section, and an exit annotation.
- `details`: `{ exitCode, stdout, stderr, durationMs, killed, action: "run", phase, language, className }`. `phase` is `"run"` normally and `"compile"` when the flow stopped at the compiler.

## Flow
1. `JvmRunTool.createIf(session)` returns `null` unless `runtime.enabled` is truthy.
2. `execute()` requires `session.getRuntimeService?.()`; a missing service throws `The runtime service is unavailable on this session (runtime.enabled may be false, or this host does not provide it).`
3. Params are sent as `runtime/jvm` with `action: "run"` and `cwd` = the session cwd.
4. The endpoint resolves the binary (auto-provisioning when allowed), then opens one temp workdir for the whole flow.
5. The target class is derived: an explicit `mainClass` wins (and is validated as a class name); otherwise Java takes `public class X`, then the first `class X`, then `Main`; Kotlin is always `MainKt`.
6. The source is written as `<className>.java` (Java) or `Main.kt` (Kotlin) inside the workdir.
7. Compile: `<binary> javac -- --release 17 <className>.java`, or `<binary> kotlinc -- Main.kt -cp . -d out`. Every invocation runs with the workdir as its cwd and with `JAVA_HOME`/`JDK_HOME` stripped from the environment.
8. A nonzero or killed compile returns immediately with `phase: "compile"` — the program is not run.
9. Run: `<binary> java -- -cp . <className>` (Java) or `<binary> java -- -cp out MainKt` (Kotlin).
10. The workdir is removed in a `finally` block; cleanup failures are swallowed so they cannot mask the result.

## Modes / Variants
- **Java**: compiles in place at bytecode release 17, classpath `.`.
- **Kotlin**: compiles into `out/` with the Kotlin stdlib available, classpath `out`.

## Side Effects
- Filesystem: one temp dir per call, removed afterwards. Nothing is written into the project.
- Subprocesses: two runtime spawns (compile, run); one more (`--version`) only via `runtime status`.
- Network: first use may download the managed runtime when `runtime.autoDownload` is on.
- Approval: `approval = "exec"`.

## Limits & Caps
- Output is not truncated by the tool. Text past `tools.artifactSpillThreshold` (default 50KB) is saved in full as a session artifact by the central spill, and the inline content becomes a head/tail preview plus a `Read artifact://<id> for full output` reference — the same mechanism `bash` uses. There is no per-stream character cap.
- No implicit timeout; `timeoutMs` applies to each invocation separately, not to the flow as a whole.
- `--release 17` is a floor for portability, so language features newer than Java 17 are rejected by the compiler.
- Requires runtime >= 1.4.

## Errors
- `The runtime service is unavailable on this session (runtime.enabled may be false, or this host does not provide it).` when no runtime service is wired.
- `jvm_run requires \`language\` and \`code\`.` as an `invalid-params` protocol error.
- `mainClass must be a class name (letters, digits, "_", "$", "."), got: <value>` — `invalid-params`. The derived class becomes a bare argv element for `java`/`javap`, so a value that could read as a flag is refused.
- `runtime-missing` with installation guidance; `cancelled` on abort.
- Compile and run failures are **not** errors: they come back as a result whose `exitCode` is nonzero.

## Notes
- `loadMode = "discoverable"`, so `jvm_run` is reached through tool discovery rather than the always-on schema.
- The host's `JAVA_HOME`/`JDK_HOME` are removed from the spawn environment: the runtime's `java` honors them while its `javac` always uses the embedded JDK, and the split produces `UnsupportedClassVersionError`.
