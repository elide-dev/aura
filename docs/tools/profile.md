# profile

> Profile a program on the managed runtime with CPU tracing or CPU sampling.

## Source
- Entry: `packages/coding-agent/src/tools/runtime-profile.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/runtime-profile.md`
- Key collaborators:
  - `packages/coding-agent/src/runtime/service.ts` — `RuntimeService.profile()`.
  - `packages/coding-agent/src/runtime/transport/local.ts` — spawns the runtime with `--profiler=<mode>`.
  - `packages/coding-agent/src/runtime/format.ts` — `formatExecResult()`.
  - `packages/coding-agent/src/tools/index.ts` — registers the built-in via `RuntimeProfileTool.createIf`.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `mode` | `"cputracing" \| "cpusampling"` | Yes | Profiler mode. `cputracing` is exact call tracing; `cpusampling` is statistical and lower overhead. |
| `code` | `string` | No | Inline program source. Mutually exclusive with `path`; exactly one of the two is required. |
| `path` | `string` | No | Existing program file. |
| `language` | `"js" \| "ts" \| "python"` | No | Program language. Defaults to `ts` for inline code; inferred from the extension for `path`. |
| `args` | `string[]` | No | Arguments passed to the program after `--`. |
| `stdin` | `string` | No | Data piped to the program's stdin. |
| `timeoutMs` | `number` | No | Kill the run after this many milliseconds. |
| `cwd` | `string` | No | Working directory. Defaults to the session cwd. |

## Outputs
A single text block plus `details` carrying the raw `RuntimeExecResult`.

- The profiler report is returned as text, rendered by `formatExecResult()` alongside any program output.
- `details`: `{ exitCode, stdout, stderr, durationMs, killed }`.

## Flow
1. `RuntimeProfileTool.createIf(session)` returns `null` unless `runtime.enabled` is truthy.
2. `execute()` requires `session.getRuntimeService?.()`; a missing service throws `The runtime service is unavailable on this session (runtime.enabled may be false, or this host does not provide it).`
3. Params are forwarded with `cwd` defaulted to `session.cwd` as a `runtime/profile` request.
4. `LocalRuntimeEndpoint` resolves (and may auto-provision) the binary, materializes inline `code` into a temp guest file, and removes the temp dir in a `finally` block.
5. The endpoint spawns `<binary> run --error-format=plain --no-color --profiler=<mode> -l <language> <programFile>` plus `-- <args>`.
6. `timeoutMs` and the caller abort signal both kill the process and set `killed`. A killed run may yield a partial or absent profiler report.

## Modes / Variants
- **`cputracing`**: exact call tracing. Highest fidelity, highest overhead; best for short programs and precise call counts.
- **`cpusampling`**: statistical sampling. Lower overhead; prefer it for longer runs.
- Program source may be inline (`code`) or an existing file (`path`), as in `run`.

## Side Effects
- Filesystem: creates and removes a temp dir for inline code; the profiled program itself may write anywhere it is permitted to.
- Subprocesses: one runtime binary spawn per call.
- Network: first use may download the managed runtime when `runtime.autoDownload` is on.
- Approval: `approval = "exec"`.

## Limits & Caps
- The report is not truncated by the tool: past `tools.artifactSpillThreshold` (default 50KB) the central spill saves the complete report as a session artifact and keeps a head/tail preview inline with a `Read artifact://<id> for full output` reference. Prefer `cpusampling` over `tracing` for busy programs to keep the inline report readable.
- No implicit timeout; unbounded unless `timeoutMs` is supplied.
- Requires runtime >= 1.4.

## Errors
- `The runtime service is unavailable on this session (runtime.enabled may be false, or this host does not provide it).` when no runtime service is wired.
- `run requires code (inline) or path (existing file).` and `code and path are mutually exclusive.` from the shared program-source plumbing.
- `runtime-missing` with installation guidance; `cancelled` on abort.
- An invalid `mode` is rejected by schema validation before dispatch.

## Notes
- `loadMode = "discoverable"`, so `profile` is not top-level — it is reached through tool discovery rather than the always-on schema.
- `mode` is the only required field; unlike `run`, there is no default profiler.
