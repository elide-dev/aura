# build

> Assemble project artifacts on the managed runtime's build system.

## Source
- Entry: `packages/coding-agent/src/tools/runtime-build.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/runtime-build.md`
- Key collaborators:
  - `packages/coding-agent/src/runtime/service.ts` — `RuntimeService.build()`.
  - `packages/coding-agent/src/runtime/transport/local.ts` — spawns the runtime `build` subcommand with the caller's targets.
  - `packages/coding-agent/src/runtime/format.ts` — `formatExecResult()`.
  - `packages/coding-agent/src/tools/index.ts` — registers the built-in via `RuntimeBuildTool.createIf`.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `targets` | `string[]` | No | `':'`-prefixed build targets with interleaved per-target options, passed through verbatim (e.g. `[":deps", "--fresh", ":compile"]`). Omit for the default build. |
| `cwd` | `string` | No | Project directory. Defaults to the session cwd. |
| `timeoutMs` | `number` | No | Kill the build after this many milliseconds. |

## Outputs
A single text block plus `details` carrying the raw `RuntimeExecResult`.

- Text is built by `formatExecResult()`: stdout, then `--- stderr ---` plus stderr when non-empty, then a kill notice when applicable, then `(exit code N)` for a non-zero exit; `(no output, exit code N)` when both streams are empty.
- `details`: `{ exitCode, stdout, stderr, durationMs, killed }`.

## Flow
1. `RuntimeBuildTool.createIf(session)` returns `null` unless `runtime.enabled` is truthy.
2. `execute()` requires `session.getRuntimeService?.()`; a missing service throws `The runtime service is unavailable on this session (runtime.enabled may be false, or this host does not provide it).`
3. Params are forwarded with `cwd` defaulted to `session.cwd` as a `runtime/build` request.
4. `LocalRuntimeEndpoint` resolves (and may auto-provision) the runtime binary, then spawns `<binary> build --no-color <...targets>`. `targets` are appended verbatim with no parsing or validation on the agent side.
5. `timeoutMs` and the caller abort signal both kill the process and set `killed`.

## Modes / Variants
- **Default build**: `targets` omitted; the runtime picks the project's default target set.
- **Explicit targets**: `targets` selects specific targets and per-target flags, in order.

## Side Effects
- Filesystem: writes build artifacts and caches into the project directory.
- Subprocesses: one runtime binary spawn per call.
- Network: dependency resolution may fetch; first use may download the managed runtime when `runtime.autoDownload` is on.
- Approval: `approval = "exec"`.

## Limits & Caps
- Output text capped at `400_000` characters per stream — a last-resort bound only; the central artifact spill (`tools.artifactSpillThreshold`) handles large output well below it.
- No implicit timeout; builds are unbounded unless `timeoutMs` is supplied.
- Requires runtime >= 1.4.

## Errors
- `The runtime service is unavailable on this session (runtime.enabled may be false, or this host does not provide it).` when no runtime service is wired.
- `runtime-missing` with installation guidance when the binary cannot be found or provisioned.
- `cancelled` on abort.
- Build failures are reported as a non-zero `exitCode` with diagnostics in the text, not as a thrown error.
- Unknown or malformed targets are rejected by the runtime, not by the tool.

## Notes
- `loadMode = "essential"`, so `build` stays top-level in the callable schema.
- `check` and `build` share one build driver: `check` passes an empty target list, `build` passes the caller's.
