# insights

> Run code on the managed runtime with an Insights instrumentation script attached.

## Source
- Entry: `packages/coding-agent/src/tools/runtime-insights.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/runtime-insights.md`
- Key collaborators:
  - `packages/coding-agent/src/runtime/service.ts` — `RuntimeService.insights()`.
  - `packages/coding-agent/src/runtime/transport/local.ts` — materializes the program and insight script, then spawns the runtime with `--insights=<file>`.
  - `packages/coding-agent/src/runtime/format.ts` — `formatExecResult()`.
  - `packages/coding-agent/src/tools/index.ts` — registers the built-in via `RuntimeInsightsTool.createIf`.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `code` | `string` | No | Inline program source. Mutually exclusive with `path`; exactly one of the two is required. |
| `path` | `string` | No | Existing program file. |
| `insight` | `string` | No | Inline instrumentation script (JavaScript). One of `insight` / `insightPath` is required. |
| `insightPath` | `string` | No | Existing instrumentation script path. |
| `language` | `"js" \| "ts" \| "python"` | No | Program language. Defaults to `ts` for inline code; inferred from the extension for `path`. |
| `args` | `string[]` | No | Arguments passed to the program after `--`. |
| `stdin` | `string` | No | Data piped to the program's stdin. |
| `timeoutMs` | `number` | No | Kill the run after this many milliseconds. |
| `cwd` | `string` | No | Working directory. Defaults to the session cwd. |

## Outputs
A single text block plus `details` carrying the raw `RuntimeExecResult`.

- Text is built by `formatExecResult()`. Instrumentation observations are interleaved with program output on the runtime's streams; the tool does not separate them.
- `details`: `{ exitCode, stdout, stderr, durationMs, killed }`.

## Flow
1. `RuntimeInsightsTool.createIf(session)` returns `null` unless `runtime.enabled` is truthy.
2. `execute()` requires `session.getRuntimeService?.()`; a missing service throws `The runtime service is unavailable on this session (runtime.enabled may be false, or this host does not provide it).`
3. Params are forwarded with `cwd` defaulted to `session.cwd` as a `runtime/insights` request.
4. `LocalRuntimeEndpoint` rejects the call up front when neither `insight` nor `insightPath` is present.
5. The binary is resolved (auto-provisioned when allowed); inline `code` becomes `<temp>/guest.<ext>` and inline `insight` becomes `<temp>/insight.js`. The temp dir is removed in a `finally` block.
6. The endpoint spawns `<binary> run --error-format=plain --no-color --insights=<insightFile> -l <language> <programFile>` plus `-- <args>`.
7. `timeoutMs` and the caller abort signal both kill the process and set `killed`.

## Modes / Variants
- **Inline program + inline insight**: both materialized to the same temp dir.
- **File program + file insight**: both used in place.
- Any mix of the two; program source and instrumentation source are chosen independently.

## Side Effects
- Filesystem: creates and removes a temp dir when inline sources are used; the instrumented program itself may write anywhere it is permitted to.
- Subprocesses: one runtime binary spawn per call.
- Network: first use may download the managed runtime when `runtime.autoDownload` is on.
- Approval: `approval = "exec"`.

## Limits & Caps
- Output is not truncated by the tool. Text past `tools.artifactSpillThreshold` (default 50KB) is saved in full as a session artifact by the central spill, and the inline content becomes a head/tail preview plus a `Read artifact://<id> for full output` reference — the same mechanism `bash` uses. There is no per-stream character cap.
- No implicit timeout; unbounded unless `timeoutMs` is supplied.
- One-shot runs do not emit close events, so instrumentation that only reports at teardown will appear silent.
- Requires runtime >= 1.4.

## Errors
- `The runtime service is unavailable on this session (runtime.enabled may be false, or this host does not provide it).` when no runtime service is wired.
- `insights requires insight (inline JS) or insightPath.` as an `invalid-params` protocol error.
- `run requires code (inline) or path (existing file).` and `code and path are mutually exclusive.` from the shared program-source plumbing.
- `runtime-missing` with installation guidance; `cancelled` on abort.

## Notes
- `loadMode = "discoverable"`, so `insights` is not top-level — it is reached through tool discovery rather than the always-on schema.
- The instrumentation script is always JavaScript even when the program is TypeScript or Python.
- Insight hooks cover program events such as source load and function enter/return.
