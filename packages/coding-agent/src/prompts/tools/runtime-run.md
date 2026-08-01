Execute JavaScript, TypeScript, Python, Java, or Kotlin directly on the managed
runtime; use `bash` for shell commands and `eval` for notebook-style execution.

Provide exactly one of `code` (temporary source) or `path` (existing file;
preserves project-relative imports and data access). Inline language defaults to
`ts`; path language is inferred unless supplied. JavaScript/TypeScript default
to Bun and may select either available engine; Python/Java/Kotlin require the
embedded engine.

Returns resolved language/engine, stdout, stderr, exit code, and JVM compile/run
phase when applicable. Missing runtime returns installation guidance instead of
failure.
