# jvm_jar

> Build a JAR from Java/Kotlin source, or list an existing JAR's entries.

## Source
- Entry: `packages/coding-agent/src/tools/jvm-jar.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/jvm-jar.md`
- Key collaborators:
  - `packages/coding-agent/src/runtime/service.ts` — `RuntimeService.jvm()`.
  - `packages/coding-agent/src/runtime/transport/local.ts` — the `jar` flow of `runtime/jvm` (`jvmJarCreate` / `jvmJarInspect`) plus `refuseExistingOutput()`.
  - `packages/coding-agent/src/runtime/jvm.ts` — `deriveJvmMainClass()`, `JVM_BYTECODE_RELEASE`.
  - `packages/coding-agent/src/runtime/format.ts` — `formatExecResult()` on failure.
  - `packages/coding-agent/src/tools/index.ts` — registers the built-in via `JvmJarTool.createIf`.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `action` | `"create" \| "inspect"` | Yes | Build a jar from source, or list an existing one. Sent as the protocol's `mode` (the protocol `action` is `"jar"`). |
| `language` | `"java" \| "kotlin"` | create | Source language. |
| `code` | `string` | create | Source to compile into the jar. |
| `mainClass` | `string` | No | Manifest main class. Must be a class name (`/^[\w.$]+$/`). Defaults to the derived class. |
| `output` | `string` | create | Destination jar path, resolved against the session cwd and required to be **inside** it. |
| `overwrite` | `boolean` | No | Required to replace an existing `output`. |
| `jar` | `string` | inspect | Existing jar to list, resolved against the session cwd. |
| `timeoutMs` | `number` | No | Kills the compile or the `jar` invocation after this many milliseconds. |

## Outputs
A single text block plus `details` carrying the raw `RuntimeJvmResult`.

- create, on success: `Built <output> (main class <className>).\n[contents]\n<listing>`.
- inspect, on success: `Entries of <jar>:\n<listing>`.
- On any failure — including a failed compile — the text is `formatExecResult(result)`.
- `details`: `{ exitCode, stdout, stderr, durationMs, killed, action: "jar", phase, language?, className?, output?, jar?, listing? }`. `output` is the absolute path written (create); `jar` is the absolute path listed (inspect).

## Flow (create)
1. Params are sent as `runtime/jvm` with `action: "jar"`, `mode: "create"`, and `cwd` = the session cwd.
2. `language`, `code`, and `output` are all required; a missing one is `invalid-params`.
3. `output` is resolved against `cwd` and must land strictly inside it — `.`, `..`, an ancestor, or an absolute path elsewhere is refused, whatever `overwrite` says.
4. **If it exists and `overwrite` is not `true` the call fails before anything is spawned** and the existing file is untouched. An existing *directory* at `output` is refused even with `overwrite: true` — a jar is a file.
5. The endpoint opens one temp workdir, derives the class name, writes the source, and compiles (`javac -- --release 17 <className>.java`, or `kotlinc -- Main.kt -cp . -d out`). A failed compile returns with `phase: "compile"`.
6. Jar: `<binary> jar -- --create --file aura-out.jar --main-class <className>` followed by the sorted `*.class` files in the workdir (Java) or `-C out .` (Kotlin).
7. The archive is copied to `output`, creating parent directories as needed.
8. `<binary> jar -- --list --file aura-out.jar` produces `listing`.
9. The workdir is removed in a `finally` block. `JAVA_HOME`/`JDK_HOME` are stripped from the spawn environment.

## Flow (inspect)
1. `jar` is required; a missing one is `invalid-params`.
2. `jar` is resolved against `cwd` and must exist.
3. `<binary> jar -- --list --file <absolute jar>` runs in `cwd` — no workdir, nothing compiled.

## Modes / Variants
- **Java create**: every `.class` file the compiler emitted in the workdir root, sorted, is added.
- **Kotlin create**: the `out` directory is added wholesale with `-C out .`.
- **inspect**: read-only.

## Side Effects
- Filesystem: create writes `output` (and its parent directories) inside the session cwd — paths outside it are refused — one of only two runtime tools that write outside a temp dir. The temp workdir is removed afterwards.
- Subprocesses: three runtime spawns for create (compile, jar, list); one for inspect.
- Network: first use may download the managed runtime when `runtime.autoDownload` is on.
- Approval: `approval = "exec"`.

## Limits & Caps
- One compilation unit per call; there is no multi-source or dependency-classpath mode.
- No signing, no `Class-Path` manifest entries, no reproducible-build flags.
- The listing goes through the same `400_000`-character bound and the central artifact spill.
- Requires runtime >= 1.4.

## Errors
- `The runtime service is unavailable on this session (runtime.enabled may be false, or this host does not provide it).` when no runtime service is wired.
- `jvm_jar create requires \`language\`, \`code\`, and \`output\` (cwd-relative path for the built jar).` — `invalid-params`.
- `jvm_jar inspect requires \`jar\` (path to an existing .jar).` — `invalid-params`.
- `No jar found at <absolute path>.` — `invalid-params`, with `data.jar`.
- `Refusing to overwrite <absolute path> — pass overwrite: true to replace it.` — `invalid-params`, with `data.output`.
- `Refusing to write output to <absolute path> — output must be a path inside the working directory (<cwd>), not the directory itself or one of its parents.` — `invalid-params`, with `data.output`.
- `Refusing to write the jar to <absolute path> — it is an existing directory.` — `invalid-params`, with `data.output`.
- `mainClass must be a class name (letters, digits, "_", "$", "."), got: <value>` — `invalid-params`.
- `runtime-missing` with installation guidance; `cancelled` on abort.

## Notes
- `loadMode = "discoverable"`.
- The in-workdir archive is always named `aura-out.jar`; only the copy at `output` carries your name.
