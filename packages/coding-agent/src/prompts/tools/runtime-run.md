Execute code on the managed polyglot runtime (JavaScript, TypeScript, Python).

Use this for direct code execution instead of `bash` (which is for shell
commands) or `eval` (the notebook-style kernel). Provide either `code`
(inline source; runs from a temp file) or `path` (an existing file — this
preserves the project working directory and imports). Python runs on a
CPython-compatible engine (3.12).

Inputs: `code` XOR `path`; `language` (js | ts | python; default ts for
inline code, inferred from the extension for files); optional `args`,
`stdin`, `timeoutMs`, `cwd`.

The result reports stdout, stderr, and the exit code. A missing runtime
returns installation guidance rather than failing.
