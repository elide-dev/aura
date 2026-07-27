# check

> Validate the current project on the managed runtime: resolve dependencies and compile every source set without producing artifacts.

## Source
- Entry: `packages/coding-agent/src/tools/runtime-check.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/runtime-check.md`
- Key collaborators:
  - `packages/coding-agent/src/runtime/service.ts` — `RuntimeService.check()`.
  - `packages/coding-agent/src/runtime/transport/local.ts` — services `runtime/check` as a build invocation with an empty target list.
  - `packages/coding-agent/src/runtime/format.ts` — `formatExecResult()`.
  - `packages/coding-agent/src/tools/index.ts` — registers the built-in via `RuntimeCheckTool.createIf`.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `cwd` | `string` | No | Project directory. Defaults to the session cwd. |
| `timeoutMs` | `number` | No | Kill the validation after this many milliseconds. |

## Outputs
A single text block plus `details` carrying the raw `RuntimeExecResult`.

- Text is built by `formatExecResult()`: stdout, then `--- stderr ---` plus stderr when non-empty, then a kill notice when applicable, then `(exit code N)` for a non-zero exit; `(no output, exit code N)` when both streams are empty.
- `details`: `{ exitCode, stdout, stderr, durationMs, killed }`.

## Flow
1. `RuntimeCheckTool.createIf(session)` returns `null` unless `runtime.enabled` is truthy.
2. `execute()` requires `session.getRuntimeService?.()`; a missing service throws `The runtime service is unavailable on this session (runtime.enabled may be false, or this host does not provide it).`
3. Params are forwarded with `cwd` defaulted to `session.cwd` as a `runtime/check` request.
4. `LocalRuntimeEndpoint` resolves (and may auto-provision) the runtime binary, then spawns `<binary> build --no-color` with **no** targets — the runtime's target-less build resolves dependencies and compiles without emitting artifacts.
5. `timeoutMs` and the caller abort signal both kill the process and set `killed`.

## Modes / Variants
- Single mode. `check` is the validation-only sibling of `build`: same underlying build driver, empty target list.

## Side Effects
- Filesystem: the runtime's own dependency resolution may populate its caches and lockfiles in the project directory; no build artifacts are produced.
- Subprocesses: one runtime binary spawn per call.
- Network: dependency resolution may fetch; first use may download the managed runtime when `runtime.autoDownload` is on.
- Approval: `approval = "exec"`.

## Limits & Caps
- Output text capped at `60_000` characters per stream.
- No implicit timeout; unbounded unless `timeoutMs` is supplied.
- Requires runtime >= 1.4.

## Errors
- `The runtime service is unavailable on this session (runtime.enabled may be false, or this host does not provide it).` when no runtime service is wired.
- `runtime-missing` with installation guidance when the binary cannot be found or provisioned.
- `cancelled` on abort.
- Compilation failures are reported as a non-zero `exitCode` with diagnostics in the text, not as a thrown error.

## Notes
- `loadMode = "essential"`, so `check` stays top-level in the callable schema.
- Use `check` as the fast "does the project still hold together" gate after edits; reach for `build` only when artifacts are the goal.
