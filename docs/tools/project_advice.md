# project_advice

> Ask the runtime for its own build/run/test/install guidance for the current project. Read-only.

## Source
- Entry: `packages/coding-agent/src/tools/runtime-advice.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/runtime-advice.md`
- Key collaborators:
  - `packages/coding-agent/src/runtime/service.ts` — `RuntimeService.advice()`.
  - `packages/coding-agent/src/runtime/transport/local.ts` — `execAdvice()` spawns `project advice` in the real directory.
  - `packages/coding-agent/src/runtime/format.ts` — `formatExecResult()`.
  - `packages/coding-agent/src/tools/index.ts` — registers the built-in via `RuntimeAdviceTool.createIf`.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `cwd` | `string` | No | Project directory to inspect. Defaults to the session cwd. |
| `timeoutMs` | `number` | No | Kill the invocation after this many milliseconds. |

There are no other inputs: the guidance is derived entirely from what the
directory contains, so there is nothing to configure but where to look.

## Outputs
A single text block plus `details` carrying the raw `RuntimeExecResult`.

- The guidance report is one blob of text: what the runtime's commands are, whether an
  `elide.pkl` project configuration is present, the declared project name/version, and
  the project's declared dependencies.
- `details`: `{ exitCode, stdout, stderr, durationMs, killed }`.

## Flow
1. `RuntimeAdviceTool.createIf(session)` returns `null` unless `runtime.enabled` is truthy.
2. `execute()` requires `session.getRuntimeService?.()`; a missing service throws `The runtime service is unavailable on this session (runtime.enabled may be false, or this host does not provide it).`
3. Params are forwarded with `cwd` defaulted to `session.cwd` as a `runtime/advice` request.
4. `LocalRuntimeEndpoint` resolves (and may auto-provision) the binary.
5. The endpoint spawns `<binary> project advice --error-format=plain --no-color` with `cwd` as the working directory and `NO_COLOR=1` in the environment.
6. `formatExecResult()` renders stdout, then stderr, then an exit annotation.

## Modes / Variants
None. One fixed invocation.

## Side Effects
- Filesystem: reads only. No temp directory is created and nothing is written — unlike
  every other runtime flow, this one has **no request workdir**, because the guidance
  comes from *detecting* `elide.pkl` and package manifests and a temp directory would
  always look like an empty project.
- Subprocesses: one runtime binary spawn per call, with a fixed argv.
- Network: first use may download the managed runtime when `runtime.autoDownload` is on.
- Approval: `approval = "read"` — the argv is fixed, the caller supplies no code, no
  arguments and no output path, and the flow only inspects a directory the session can
  already read. The other runtime tools are `"exec"` because they run code; this one
  does not.

## Limits & Caps
- The report is not truncated by the tool: past `tools.artifactSpillThreshold` (default
  50KB) the central spill saves the complete report as a session artifact and keeps a
  head/tail preview inline with a `Read artifact://<id> for full output` reference. It
  spills as a single blob, not per stream.
- No implicit timeout; unbounded unless `timeoutMs` is supplied.
- Requires runtime >= 1.4.

## Errors
- `The runtime service is unavailable on this session (runtime.enabled may be false, or this host does not provide it).` when no runtime service is wired.
- `runtime-missing` with installation guidance when no binary can be resolved or provisioned.
- `cancelled` on abort.
- A runtime that cannot produce advice is reported as it reported itself: its stderr and
  nonzero exit code are surfaced verbatim rather than reinterpreted. Availability of this
  guidance depends on the installed runtime build — it is known to have crashed on some
  1.4.0 nightlies, and works on the pinned 1.4.x line.

## Notes
- `loadMode = "discoverable"`, so `project_advice` is reached through tool discovery
  rather than the always-on schema, and it is not an essential tool.
- The runtime's own output is already plain: it is invoked with `--no-color` *and*
  `NO_COLOR=1`, and the pinned runtime emits no ANSI escapes under either, so no
  escape-stripping pass is applied on the way out.
