Run code on the managed runtime with an Insights instrumentation script
attached. The insight script (JavaScript) hooks program events — source
load, function enter/return — and its observations are emitted alongside
program output. Provide the program as `code` or `path` (as in `run`) and
the instrumentation as `insight` (inline JS) or `insightPath`. One-shot
runs do not emit close events. Same optional controls as `run`
(`language`, `args`, `stdin`, `timeoutMs`, `cwd`).
