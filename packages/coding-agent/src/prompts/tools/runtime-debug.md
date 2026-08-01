Publish a JS/TS/Python program's debug endpoint from the managed runtime as a
supervised background job. `path` is required; inline code cannot outlive the
call. `protocol: "cdp"` (default) returns `ws://`; `"dap"` returns `host:port`.

The program starts suspended until an external debugger attaches. This differs
from `debug`, which the agent drives interactively.

Returns the endpoint plus a hub job name. Use `hub logs` for output and
`hub stop` to release the job; no separate stop tool exists. No hub? Report that
the job cannot be stopped from this session. A missing endpoint after the wait
still returns the job and startup output; inspect `hub logs` before declaring
failure.
