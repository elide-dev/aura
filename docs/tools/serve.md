# serve

> Serve a directory of static files over HTTP on the managed runtime, supervised as a `hub` job.

## Source
- Entry: `packages/coding-agent/src/tools/runtime-serve.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/runtime-serve.md`
- Key collaborators:
  - `packages/coding-agent/src/runtime/service.ts` — `RuntimeService.spawn()`.
  - `packages/coding-agent/src/runtime/transport/local.ts` — composes the launch descriptor (`describeSpawn`); starts nothing.
  - `packages/coding-agent/src/tools/runtime-launch.ts` — starts the descriptor through hub, scrapes the URL, formats the fallback.
  - `packages/coding-agent/src/tools/hub/launch.ts` — `executeLaunch()`; owns the process lifecycle.
  - `packages/coding-agent/src/tools/index.ts` — registers the built-in via `RuntimeServeTool.createIf`.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `directory` | `string` | Yes | Directory of static files to serve, resolved against `cwd`. Must exist and be a directory. |
| `port` | `number` | No | Port to bind; integer 1–65535. Omitted means the runtime's own default (8080). |
| `host` | `string` | No | Interface to bind. Omitted means the runtime's own default (127.0.0.1). |
| `cwd` | `string` | No | Base directory for `directory`, and the process's working directory. Defaults to the session cwd. |
| `waitSeconds` | `number` | No | How long to watch startup output for the URL. Default 15, clamped to 1–300. |

## Outputs
A single text block plus `details` (`RuntimeJobDetails`).

- With a URL: `Serving <absolute directory> at <url>` plus the job handle line naming the `hub` calls that read and stop it.
- Without one: the wait-window fallback (see Modes).
- `details`: `{ mode: "serve", jobName, endpoint?, state?, timedOut, readyMatch?, startupOutput, argv, cwd }`. `timedOut` is hub's own verdict on the readiness window, not a re-derivation from `endpoint`; `readyMatch` is the startup line hub matched. `jobName` is the hub job name — the handle for `hub {op:"logs"|"stop"|"restart", name}`.

## Flow
1. `RuntimeServeTool.createIf(session)` returns `null` unless `runtime.enabled` is truthy.
2. `execute()` requires `session.getRuntimeService?.()`; a missing service throws `The runtime service is unavailable on this session (runtime.enabled may be false, or this host does not provide it).`
3. A `runtime/spawn` request returns a launch descriptor. The endpoint validates the parameters *first* (a nonexistent `directory` or an out-of-range `port` must not trigger a runtime download just to be told `invalid-params`), then resolves (and may auto-provision) the binary, and composes `<binary> serve <absolute dir> --no-tui [--port <p>] [--host <h>]`. `--no-tui` keeps the output plain so the URL can be scraped. No process is started.
4. The descriptor is started through `hub` with `op: "start"`, `pty: false`, `env: { NO_COLOR: "1" }` (an overlay on the broker's environment, not a snapshot of this session's), and `ready.log` set to the descriptor's endpoint pattern with `timeout: waitSeconds`.
5. The URL is extracted from `readyMatch` — the line the broker's own readiness buffer matched, so it is found even when the banner has scrolled past the startup lines. A `hub` `logs` read (first 200 lines) supplies the startup output quoted in the fallbacks, and is the extraction fallback when there was no readiness pattern.
6. The job name is minted as `runtime-serve-<8 hex>`, so concurrent servers never collide.

## Modes / Variants
- **Endpoint scraping** — matches `Serving static files on\s+(\S+)` and returns the capture with an `http://` scheme prepended (output that already carries a scheme is passed through unchanged). On 1.4.2 the banner is written to **stderr**, which is why the scrape reads hub's merged log stream rather than one pipe. Two earlier lines also mention the directory and a quoted URL; the rule deliberately keys on the final, machine-shaped line.
- **Wait-window fallback** — when the rule does not match within `waitSeconds`, the result is *not* an error: the job is real and may still be starting. The text says `The static file server did not report an endpoint within the wait window (<n>s); it may still be starting`, gives the job handle, and quotes the startup output. Poll `hub {op:"logs", name}` before concluding anything failed.
- **Stale-rule fallback** — a distinct case: the banner matched but no URL could be extracted from it. The text says so and quotes the matched line, rather than blaming a timeout that did not happen; `details.timedOut` is `false`, which is how the two are told apart.
- **Failed launch** — when hub reports state `failed`, the result carries `isError: true`, hub's own failure summary, and the job name.

## Side Effects
- Subprocesses: one long-running runtime process per call, owned by the hub broker — it outlives this tool call and holds the port until stopped with `hub {op:"stop", name}`.
- Network: binds a TCP port. First use may download the managed runtime when `runtime.autoDownload` is on.
- Filesystem: read-only over the served directory.
- Approval: `approval = "exec"`.

## Limits & Caps
- `waitSeconds` is clamped to 1–300; the default 15 covers a cold runtime start.
- Startup output is read as the first 200 log lines. Everything after that is still in `hub logs`.
- The job is not `persist`ent or `detached`: it does not survive the broker exiting.
- A port already in use is not pre-checked here; the runtime's own failure appears in the startup output.
- Requires runtime >= 1.4.

## Errors
- `The runtime service is unavailable on this session (runtime.enabled may be false, or this host does not provide it).` when no runtime service is wired.
- `invalid-params`: `serve \`directory\` is required.` / `... does not exist: <path>` / `... is not a directory: <path>`; `port must be an integer from 1 to 65535.`
- `runtime-missing` with installation guidance; `cancelled` on abort.
- A failed launch is reported as an error *result* (with the job name), not a thrown error.

## Notes
- `loadMode = "discoverable"`, so this tool is reached through tool discovery rather than the always-on schema, and it is not an essential tool.
- The short name is kept (unlike its companion `runtime_debug`, which is qualified because `debug` is the built-in stepping debugger) — it matches the other runtime tools `run`, `check`, `build`.
- There is no `stop_runtime_process` tool: `hub {op:"stop", name}` already takes a name, and routing through hub means `hub logs`, `hub wait`, `hub restart`, `hub describe`, and `/jobs` all work on a static server for free.
- When the binary was resolved from `PATH` (`source: "path"`), the result appends a `Note:` warning that it may be a wrapper script running the real binary as a child, so a stop could leave a listener behind. The broker terminates the process *group*, which normally covers that. The remedy the note gives is to point `runtime.path` / `AURA_RUNTIME_BIN` at a real binary, or to take the wrapper off `PATH` so the managed install is used — resolution prefers a `PATH` binary over auto-downloading, so a wrapper there always wins. The managed install carries no such note.
- In a session without the `hub` tool (`--tools serve`, or a subagent with IRC disabled) the server still starts, but the guidance says so and points at the `/jobs` picker instead of naming a tool the model does not have — it would otherwise hold a port with no way to say how to release it. Availability is read from the registry's own active-tool set, not re-derived from hub's gate.
- Pairs with `jvm_javadoc`: generate docs, then serve the output directory to browse them.
