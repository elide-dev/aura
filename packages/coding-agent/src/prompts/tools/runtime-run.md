Execute JavaScript, TypeScript, Python, Java, or Kotlin on the managed polyglot
runtime.

Use this for direct code execution instead of `bash` (which is for shell
commands) or `eval` (the notebook-style kernel). Provide either `code`
(inline source; runs from a temp file) or `path` (an existing file — this
preserves project-relative imports and data access).

Inputs: `code` XOR `path`; optional `language` (`js` | `ts` | `python` |
`java` | `kotlin`, default `ts` inline and inferred from a file extension),
`engine`, `args`, `stdin`, `timeoutMs`, `cwd`, and `mainClass` for
Java/Kotlin.

JavaScript and TypeScript default to Bun and support either available engine.
Python, Java, and Kotlin use the embedded engine only. The result reports the
resolved engine and language plus stdout, stderr, exit code, and JVM
compile/run phase where applicable. A missing runtime returns installation
guidance rather than failing.
