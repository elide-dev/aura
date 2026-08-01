Build project artifacts on the managed runtime; use `check` for validation-only
runs.

`targets` accepts `:`-prefixed build targets with interleaved per-target options,
passed verbatim (e.g. `[":deps", "--fresh", ":compile"]`). Omit `targets` for
the default build.
