Serve a directory of static files over HTTP on the managed runtime, as a
supervised background job. `directory` is required (resolved against `cwd`, which
defaults to the session directory); optional `port` and `host` default to the
runtime's own (`127.0.0.1:8080`), and `waitSeconds` bounds how long the startup
output is watched for the URL (default 15).

Use it to preview a built site, generated API docs, or any directory of static
assets. The result is the URL plus a **hub job name**: read its output with
`hub {op:"logs", name}`, and stop it with `hub {op:"stop", name}` — there is no
separate stop tool, and leaving a server running holds the port. If no URL
appears within the wait window the job is still returned along with its startup
output; it may simply still be starting, so poll `hub logs` before concluding
anything failed.
