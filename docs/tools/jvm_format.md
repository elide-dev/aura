# jvm_format

> Format Java (Google Java Format) or Kotlin (ktfmt) source and return the formatted code.

## Source
- Entry: `packages/coding-agent/src/tools/jvm-format.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/jvm-format.md`
- Key collaborators:
  - `packages/coding-agent/src/runtime/service.ts` — `RuntimeService.jvm()`.
  - `packages/coding-agent/src/runtime/transport/local.ts` — the `format` flow of `runtime/jvm`: write, format in place, read back.
  - `packages/coding-agent/src/tools/jvm-common.ts` — `renderJvmPayload()`, `requireRuntimeService()`.
  - `packages/coding-agent/src/tools/index.ts` — registers the built-in via `JvmFormatTool.createIf`.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `language` | `"java" \| "kotlin"` | Yes | Source language. |
| `code` | `string` | Yes | Source to format. |
| `timeoutMs` | `number` | No | Kills the formatter after this many milliseconds. |

## Outputs
A single text block plus `details` carrying the raw `RuntimeJvmResult`.

- On success the text is the formatted source (trailing newlines trimmed), read back from the workdir — not the formatter's stdout, which is a progress line.
- On failure the text is `formatExecResult(result)`.
- `details`: `{ exitCode, stdout, stderr, durationMs, killed, action: "format", phase: "format", language, formatted? }`.

## Flow
1. `JvmFormatTool.createIf(session)` returns `null` unless `runtime.enabled` is truthy.
2. Params are sent as `runtime/jvm` with `action: "format"` and `cwd` = the session cwd.
3. The endpoint opens one temp workdir and writes the source as `Source.java` or `Source.kt`.
4. Format: `<binary> javaformat --allow-write -- -i Source.java` (Java) or `<binary> ktfmt --allow-write -- Source.kt` (Kotlin). `--allow-write` is the runtime's guest-write grant; `-i` makes Google Java Format rewrite the file instead of printing.
5. On success the file is read back into `formatted`; the invocation's own streams stay in `stdout`/`stderr`.
6. The workdir is removed in a `finally` block. `JAVA_HOME`/`JDK_HOME` are stripped from the spawn environment.

## Modes / Variants
- **Java**: Google Java Format.
- **Kotlin**: ktfmt.

## Side Effects
- Filesystem: one temp dir per call, removed afterwards. **Your files are never modified** — the formatted source is returned, not written; apply it with `edit` or `write`.
- Subprocesses: one runtime spawn.
- Network: first use may download the managed runtime when `runtime.autoDownload` is on.
- Approval: `approval = "exec"`.

## Limits & Caps
- One source unit per call; there is no batch/directory mode.
- Formatter failure (a syntax error) surfaces as a nonzero result, not a partial format.
- Requires runtime >= 1.4.

## Errors
- `The runtime service is unavailable on this session (runtime.enabled may be false, or this host does not provide it).` when no runtime service is wired.
- `jvm_format requires \`language\` and \`code\`.` as an `invalid-params` protocol error.
- `runtime-missing` with installation guidance; `cancelled` on abort.

## Notes
- `loadMode = "discoverable"`.
- `mainClass` is not a parameter: formatting does not depend on the entrypoint.
