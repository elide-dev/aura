# runtime_debug

> Start a CDP or DAP debug endpoint for a JS/TS/Python program on the managed runtime, supervised as a `hub` job.

## Source
- Entry: `packages/coding-agent/src/tools/runtime-debug.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/runtime-debug.md`
- Key collaborators:
  - `packages/coding-agent/src/runtime/service.ts` — `RuntimeService.spawn()`.
  - `packages/coding-agent/src/runtime/transport/local.ts` — composes the launch descriptor (`describeSpawn`); starts nothing.
  - `packages/coding-agent/src/tools/runtime-launch.ts` — starts the descriptor through hub, scrapes the endpoint, formats the fallback.
  - `packages/coding-agent/src/tools/hub/launch.ts` — `executeLaunch()`; owns the process lifecycle.
  - `packages/coding-agent/src/tools/index.ts` — registers the built-in via `RuntimeDebugTool.createIf`.

## Why the name is `runtime_debug` and not `debug`
`debug` is already a built-in: the interactive stepping debugger this agent drives
itself (`packages/coding-agent/src/tools/debug.ts`, `DebugTool` — breakpoints,
stepping, variable inspection, documented in `docs/tools/debug.md`). The two are
different tools, not two spellings of one: `debug` steps through code on the
agent's behalf, while `runtime_debug` publishes an endpoint for an *external*
debugger (Chrome DevTools, VS Code) to attach to. Registering this tool as `debug`
would have replaced the stepping debugger in `BUILTIN_TOOLS`, so it takes the
qualified name. The companion tool keeps the short name `serve`, which was free.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `path` | `string` | Yes | Program file to debug, resolved against `cwd`. There is no inline-code mode — see Limits. |
| `protocol` | `"cdp" \| "dap"` | No | Debug wire protocol. Default `cdp` (Chrome DevTools). |
| `language` | `"js" \| "ts" \| "python"` | No | Program language. Inferred from `path`'s extension otherwise (`.py` → python, `.js`/`.mjs`/`.cjs` → js, else ts). |
| `args` | `string[]` | No | Arguments passed to the program after `--`. |
| `cwd` | `string` | No | Working directory for the process and base for `path`. Defaults to the session cwd. |
| `timeoutMs` | `number` | No | Guest execution timeout, passed to the runtime as `--timeout <n>ms`. |
| `waitSeconds` | `number` | No | How long to watch startup output for the endpoint. Default 15, clamped to 1–300. |

## Outputs
A single text block plus `details` (`RuntimeJobDetails`).

- With an endpoint: `<CDP\|DAP> debugger listening at <endpoint>`, the attach hint for that protocol, a note that the program is suspended until a client attaches, and the job handle line naming the `hub` calls that read and stop it.
- Without one: the wait-window fallback (see Modes).
- `details`: `{ mode: "debug", jobName, endpoint?, state?, timedOut, startupOutput, argv, cwd }`. `jobName` is the hub job name — the handle for `hub {op:"logs"|"stop"|"restart", name}`.

## Flow
1. `RuntimeDebugTool.createIf(session)` returns `null` unless `runtime.enabled` is truthy.
2. `execute()` requires `session.getRuntimeService?.()`; a missing service throws `The runtime service is unavailable on this session (runtime.enabled may be false, or this host does not provide it).`
3. A `runtime/spawn` request returns a launch descriptor. The endpoint resolves (and may auto-provision) the binary, validates that `path` is an existing file, and composes `<binary> run --debugger=<protocol> --error-format=plain --no-color [--timeout <n>ms] -l <language> <file> [-- <args>]`. No process is started and no temp directory is created.
4. The descriptor is started through `hub` with `op: "start"`, `pty: false`, `env: { NO_COLOR: "1" }` (an overlay on the broker's environment, not a snapshot of this session's), and `ready.log` set to the descriptor's endpoint pattern with `timeout: waitSeconds` — so hub's own readiness machinery does the waiting.
5. A `hub` `logs` read (first 200 lines) supplies the text that is scraped for the endpoint and, failing that, quoted back as startup output.
6. The job name is minted as `runtime-debug-<protocol>-<8 hex>`, so concurrent debuggers never collide and no name is reused.

## Modes / Variants
- **`cdp`** — matches `ws://\S+` in the startup output and returns the inspector URL whole. Attach with Chrome DevTools.
- **`dap`** — matches `listening on\s+(\S+)` and returns the captured `host:port`. Attach a DAP client such as VS Code.
- **Wait-window fallback** — when no rule matches within `waitSeconds`, the result is *not* an error: the job is real and may still be starting. The text says `did not report an endpoint within the wait window (<n>s); it may still be starting`, gives the job handle, and quotes the startup output so a changed startup banner is diagnosable rather than mysterious. Poll `hub {op:"logs", name}` before concluding anything failed.
- **Failed launch** — when hub reports state `failed`, the result carries `isError: true`, hub's own failure summary, and the job name.

## Side Effects
- Subprocesses: one long-running runtime process per call, owned by the hub broker — it outlives this tool call and must be stopped with `hub {op:"stop", name}`.
- Network: the debug endpoint listens on a local port. First use may download the managed runtime when `runtime.autoDownload` is on.
- Filesystem: none of its own; the debugged program may write anywhere it is permitted to.
- Approval: `approval = "exec"`.

## Limits & Caps
- No inline-code mode. `runtime/run` can write inline source to a request-scoped temp directory because the request owns it; a supervised process outlives the request that started it, so the file would be deleted underneath it. Write the program with `write` first, then debug the path.
- `waitSeconds` is clamped to 1–300; the default 15 covers a cold runtime start.
- Startup output is read as the first 200 log lines. Everything after that is still in `hub logs`.
- The job is not `persist`ent or `detached`: it does not survive the broker exiting.
- Requires runtime >= 1.4.

## Errors
- `The runtime service is unavailable on this session (runtime.enabled may be false, or this host does not provide it).` when no runtime service is wired.
- `invalid-params`: `debug \`path\` (the program to debug) is required.` / `... does not exist: <path>` / `... is not a file: <path>`; `timeoutMs must be a positive number of milliseconds.`
- `runtime-missing` with installation guidance; `cancelled` on abort.
- A failed launch is reported as an error *result* (with the job name), not a thrown error.

## Notes
- `loadMode = "discoverable"`, so this tool is reached through tool discovery rather than the always-on schema, and it is not an essential tool.
- There is no `stop_runtime_process` tool: `hub {op:"stop", name}` already takes a name, and routing through hub means `hub logs`, `hub wait`, `hub restart`, `hub describe`, and `/jobs` all work on a debugger for free.
- When the binary was resolved from `PATH` (`source: "path"`), the result appends a `Note:` warning that it may be a wrapper script running the real binary as a child. The broker terminates the process *group* on stop, which normally covers that, but a surviving listener is worth checking for. The managed install resolves to a real binary and carries no such note.
