Build a JAR from Java/Kotlin source, or list an existing one.

- `action: "create"` — needs `language`, `code`, and `output` (a path
  relative to the cwd). The source is compiled in a scratch directory, jarred
  with the derived main class in the manifest, and the artifact is copied to
  `output`. This is one of the two runtime tools that write into your
  project: an existing `output` is refused unless you pass `overwrite: true`.
- `action: "inspect"` — needs `jar` (an existing jar, relative to the cwd)
  and lists its entries. Read-only.
