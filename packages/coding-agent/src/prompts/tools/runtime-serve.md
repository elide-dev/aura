Serve a static directory over HTTP on the managed runtime to preview built
sites, generated docs, or other static assets.

Returns the URL plus a hub job name. Use `hub logs` for output and `hub stop` to
release the job and port; no separate stop tool exists. No hub? Report that the
job cannot be stopped from this session. A missing URL after the wait still
returns the job and startup output; inspect `hub logs` before declaring failure.
