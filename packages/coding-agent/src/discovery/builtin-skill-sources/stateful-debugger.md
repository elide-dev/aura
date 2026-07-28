---
name: stateful-debugger
description: Publish a CDP or DAP debug endpoint with `runtime_debug`, or a static HTTP server with `serve` — long-lived runtime jobs whose lifecycle belongs to `hub`, not to a stop tool.
---

# Long-lived runtime jobs: `runtime_debug` and `serve`

Both of these tools start a process that outlives the call. Neither returns a
finished result; each returns an **endpoint plus a hub job name**, and the job
keeps running until something stops it. Everything below about the lifecycle
applies identically to both.

## `runtime_debug` — publish a debug endpoint

```json
{ "path": "src/problem.ts", "protocol": "cdp" }
```

`path` is **required and there is no inline-code mode** — the file has to
outlive the call that started it, so write the program to disk first and pass
its path. `language` is inferred from the extension. Optional: `args`, `cwd`,
`timeoutMs` (guest execution timeout), `waitSeconds` (how long startup output is
watched for the endpoint; default 15).

`protocol` picks the wire format:

- `cdp` (default) — Chrome DevTools Protocol. Returns a `ws://` URL. Open it in
  Chrome/Chromium DevTools.
- `dap` — Debug Adapter Protocol. Returns a bare `host:port`. Attach VS Code or
  another DAP client.

**The program starts suspended and stays suspended until a client attaches.** It
will produce no output and make no progress on its own. That is the feature —
but it means "nothing happened" is the expected state, not a failure, and it
means this tool is only useful when a *human* is going to attach. If nobody is
attaching, you want `run`, `insights` or `debug`.

`runtime_debug` is **not** the `debug` tool. `debug` is the interactive stepping
debugger this agent drives itself — breakpoints, stepping, variable inspection,
all from tool calls. `runtime_debug` publishes an endpoint for an *external*
debugger and gives this agent no stepping control at all. Reach for `debug` to
debug something yourself; reach for `runtime_debug` to hand a session to the
user.

## `serve` — static files over HTTP

```json
{ "directory": "javadoc-out" }
```

`directory` is required and resolves against `cwd` (default: the session
directory). Optional `port` (default 8080), `host` (default `127.0.0.1`), and
`waitSeconds` (default 15). Use it to preview a built site, generated API docs,
or any directory of static assets.

## Lifecycle is hub's — there is no separate stop tool

The result of either tool carries a hub job name. That name is the handle for
everything afterwards:

- `hub {op: "logs", name}` — read the job's output. `follow: true` waits for
  more; reuse the returned cursor.
- `hub {op: "stop", name}` — graceful tree termination. **This is the only
  supported way to stop the job.** Never hunt the PID and kill it through
  `bash`.

Two consequences worth planning around:

- **Endpoint scraping is best-effort.** The tool watches startup output for
  `waitSeconds` and reports the endpoint if it appears. If it does not, the job
  is *still returned* along with whatever startup output there was — the process
  may simply still be coming up. Poll `hub logs` before concluding anything
  failed, and raise `waitSeconds` for a slow-starting program rather than
  retrying the launch (a retry leaves the first job running and, for `serve`,
  the port already taken).
- **A session without `hub` cannot stop what it started.** When the `hub` tool
  is not available, the result says so explicitly. Believe it: nothing in the
  session can terminate the job. Report that to the user along with the endpoint
  so they can stop it themselves — do not start a second one.

Leaving a server running holds its port. Stop the job as soon as the user is
done with it, and stop it before starting another `serve` on the same port.
