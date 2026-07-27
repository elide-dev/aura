Start a debug server for a JS/TS/Python program on the managed runtime, as a
supervised background job. `path` is the program file to debug (required — there
is no inline-code mode, because the file has to outlive this call). `protocol`
selects the wire protocol: `cdp` (default, Chrome DevTools — returns a `ws://`
URL) or `dap` (Debug Adapter Protocol, e.g. VS Code — returns `host:port`).
Optional `language` (inferred from the extension), `args`, `cwd`, `timeoutMs`
(guest execution timeout), and `waitSeconds` (how long to watch startup output
for the endpoint; default 15).

The program starts suspended and stays suspended until a debug client attaches.
The result is the endpoint plus a **hub job name**: read its output with
`hub {op:"logs", name}`, and stop it with `hub {op:"stop", name}`. There is no
separate stop tool. (If this session has no `hub` tool, the result says so and
points at the `/jobs` picker instead.) `cdp` returns a `ws://` URL; `dap` returns
a bare `host:port`. If no endpoint appears within the wait window the job is
still returned along with its startup output — it may simply still be starting,
so poll `hub logs` before concluding anything failed.

Note this is not the `debug` tool: `debug` is the interactive stepping debugger
this agent drives itself, while `runtime_debug` publishes an endpoint for an
external debugger to attach to.
