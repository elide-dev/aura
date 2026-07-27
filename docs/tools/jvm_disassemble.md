# jvm_disassemble

> Compile Java or Kotlin, then disassemble the bytecode with `javap -c`.

## Source
- Entry: `packages/coding-agent/src/tools/jvm-disassemble.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/jvm-disassemble.md`
- Key collaborators:
  - `packages/coding-agent/src/runtime/service.ts` — `RuntimeService.jvm()`.
  - `packages/coding-agent/src/runtime/transport/local.ts` — the `disassemble` flow of `runtime/jvm`: one temp workdir, compile, then `javap`.
  - `packages/coding-agent/src/runtime/jvm.ts` — `deriveJvmMainClass()`, `JVM_BYTECODE_RELEASE`.
  - `packages/coding-agent/src/tools/jvm-common.ts` — `renderJvmPayload()`, `requireRuntimeService()`.
  - `packages/coding-agent/src/tools/index.ts` — registers the built-in via `JvmDisassembleTool.createIf`.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `language` | `"java" \| "kotlin"` | Yes | Source language. |
| `code` | `string` | Yes | Java or Kotlin source. |
| `mainClass` | `string` | No | Class to disassemble. Must be a class name (`/^[\w.$]+$/`). Defaults to the derived class. |
| `timeoutMs` | `number` | No | Kills the compile or the disassembly after this many milliseconds. |

## Outputs
A single text block plus `details` carrying the raw `RuntimeJvmResult`.

- On success the text is the `javap` listing (trailing newlines trimmed), or `(no output)` if it is empty.
- On any failure — including a failed compile — the text is `formatExecResult(result)` so the compiler's diagnostics survive.
- `details`: `{ exitCode, stdout, stderr, durationMs, killed, action: "disassemble", phase, language, className }`.

## Flow
1. `JvmDisassembleTool.createIf(session)` returns `null` unless `runtime.enabled` is truthy.
2. Params are sent as `runtime/jvm` with `action: "disassemble"` and `cwd` = the session cwd.
3. The endpoint opens one temp workdir, derives the class name, writes the source, and compiles: `<binary> javac -- --release 17 <className>.java` or `<binary> kotlinc -- Main.kt -cp . -d out`.
4. A nonzero or killed compile returns immediately with `phase: "compile"`.
5. Disassemble: `<binary> javap -- -c <className>` (Java) or `<binary> javap -- -c -classpath out MainKt` (Kotlin).
6. Every invocation runs with the workdir as its cwd and with `JAVA_HOME`/`JDK_HOME` stripped. The workdir is removed in a `finally` block.

## Modes / Variants
- **Java**: `javap` reads the class from the workdir root.
- **Kotlin**: `javap` is pointed at `out` with `-classpath`.

## Side Effects
- Filesystem: one temp dir per call, removed afterwards. Nothing is written into the project.
- Subprocesses: two runtime spawns (compile, `javap`).
- Network: first use may download the managed runtime when `runtime.autoDownload` is on.
- Approval: `approval = "exec"`.

## Limits & Caps
- Disassembly of a large class is verbose, but nothing is truncated by the tool: past `tools.artifactSpillThreshold` (default 50KB) the central spill saves the complete listing as a session artifact and keeps a head/tail preview inline with a `Read artifact://<id> for full output` reference.
- `--release 17` applies to the compile, so the bytecode shown is class-file version 61.
- Requires runtime >= 1.4.

## Errors
- `The runtime service is unavailable on this session (runtime.enabled may be false, or this host does not provide it).` when no runtime service is wired.
- `jvm_disassemble requires \`language\` and \`code\`.` as an `invalid-params` protocol error.
- `mainClass must be a class name (letters, digits, "_", "$", "."), got: <value>` — `invalid-params`. The derived class becomes a bare argv element for `java`/`javap`, so a value that could read as a flag is refused.
- `runtime-missing` with installation guidance; `cancelled` on abort.

## Notes
- `loadMode = "discoverable"`.
- Nothing is executed: the program is compiled and inspected, never run.
