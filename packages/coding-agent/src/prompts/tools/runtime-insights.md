Run a program on the managed runtime with JavaScript instrumentation. Provide
the program via `code` or `path`; provide instrumentation via `insight` or
`insightPath`.

Hooks source loads and function enter/return; observations accompany program
output. One-shot runs emit no close event.
