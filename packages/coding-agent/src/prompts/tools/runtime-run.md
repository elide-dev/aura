Execute JavaScript, TypeScript,{{#if python}} Python,{{/if}} Java, or Kotlin directly. Use `bash` for
shell commands and `eval` for persistent notebook exploration.

Provide exactly one of `code` or `path`; a path retains project-relative imports
and data access. Inline source defaults to TypeScript, path language is inferred,
and JavaScript/TypeScript default to Bun.

Returns the resolved language/engine, streams, exit status, and JVM phase.
Missing runtime support yields setup guidance.
