# run

> Execute JavaScript, TypeScript, or Python source on the managed polyglot runtime.

## Source
- Entry: `packages/coding-agent/src/tools/runtime-run.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/runtime-run.md`
- Key collaborators:
  - `packages/coding-agent/src/runtime/service.ts` — `RuntimeService.run()`, the only runtime surface tools see.
  - `packages/coding-agent/src/runtime/transport/local.ts` — per-call subprocess endpoint that shells the runtime CLI.
  - `packages/coding-agent/src/runtime/protocol.ts` — `runtime/run` request and `RuntimeExecResult`.
  - `packages/coding-agent/src/runtime/format.ts` — `formatExecResult()` renders stdout/stderr/exit for the model.
  - `packages/coding-agent/src/tools/index.ts` — registers the built-in via `RuntimeRunTool.createIf`.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `code` | `string` | No | Inline source to execute. Mutually exclusive with `path`; exactly one of the two is required. |
| `path` | `string` | No | Existing file to run. Preserves the project working directory and imports. |
| `language` | `"js" \| "ts" \| "python"` | No | Language for inline code. Defaults to `ts` for `code`; inferred from the extension for `path`. |
| `args` | `string[]` | No | Arguments passed to the program after `--`. |
| `stdin` | `string` | No | Data piped to the program's stdin. |
| `timeoutMs` | `number` | No | Kill the run after this many milliseconds. No timeout when omitted. |
| `cwd` | `string` | No | Working directory. Defaults to the session cwd. |

## Outputs
A single text block plus `details` carrying the raw `RuntimeExecResult`.

- Text is built by `formatExecResult()`: trailing-newline-trimmed stdout, then `--- stderr ---` plus stderr when non-empty, then `(process was killed: timeout or cancellation)` when killed, then `(exit code N)` for any non-zero exit. When nothing at all was produced the text is `(no output, exit code N)`.
- `details`: `{ exitCode, stdout, stderr, durationMs, killed }`.

## Flow
1. `RuntimeRunTool.createIf(session)` returns `null` unless the `runtime.enabled` setting is truthy, so the tool is absent from the schema when runtime capabilities are off.
2. `execute()` reads `session.getRuntimeService?.()`. A missing service throws `The runtime service is unavailable on this session (runtime.enabled may be false, or this host does not provide it).`
3. Params are forwarded with `cwd` defaulted to `session.cwd`, then dispatched as a `runtime/run` protocol request.
4. `LocalRuntimeEndpoint` resolves the runtime binary (`resolveRuntimeBinary`), auto-provisioning it when `runtime.autoDownload` allows and no explicit path is pinned.
5. Inline `code` is materialized into a temp dir (`aura-runtime-<random>/guest.<ext>`) which is removed in a `finally` block; `path` is used as-is.
6. The endpoint spawns `<binary> run --error-format=plain --no-color -l <language> <file>` plus `-- <args>`, with `NO_COLOR=1` in the environment.
7. `timeoutMs` and the caller abort signal both kill the process and set `killed`; an already-aborted signal short-circuits before spawn.

## Modes / Variants
- **Inline code**: `code` (+ optional `language`) runs from a temp file; the temp dir is not the project root.
- **File run**: `path` runs in place, preserving project-relative imports and the session cwd.
- **Piped input**: `stdin` feeds the program's standard input.

## Side Effects
- Filesystem: creates and removes a temp dir per inline-code call; the executed program itself may write anywhere it is permitted to.
- Subprocesses: spawns the runtime binary once per call.
- Network: first use may download the managed runtime when `runtime.autoDownload` is on.
- Approval: `approval = "exec"`, so the call goes through exec approval like `bash`.

## Limits & Caps
- Output text is capped at `60_000` characters per stream by `formatExecResult()`, with a `… output truncated (N chars total)` marker.
- No implicit execution timeout; unbounded unless `timeoutMs` is supplied.
- Requires runtime >= 1.4.

## Errors
- `The runtime service is unavailable on this session (runtime.enabled may be false, or this host does not provide it).` when no runtime service is wired.
- `run requires code (inline) or path (existing file).` and `code and path are mutually exclusive.` as `invalid-params` protocol errors.
- A missing, non-provisionable runtime surfaces `runtime-missing` with installation guidance instead of an opaque failure.
- Cancellation surfaces as `cancelled`.
- A non-zero program exit is **not** an error; it is reported in the text and in `details.exitCode`.

## Notes
- `loadMode = "essential"`, so `run` stays top-level in the callable schema.
- Prefer `run` over `bash` for executing source, and over `eval` when you do not want notebook-style kernel state.
- Python runs on a CPython-compatible engine (3.12).
