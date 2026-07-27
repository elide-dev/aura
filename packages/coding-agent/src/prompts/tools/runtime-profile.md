Profile a program on the managed runtime. `mode` selects the profiler:
`cputracing` (exact call tracing) or `cpusampling` (statistical sampling —
lower overhead, prefer it for longer runs). Provide the program as `code`
or `path` (as in `run`); the profiler report is returned as text. Same
optional controls as `run` (`language`, `args`, `stdin`, `timeoutMs`,
`cwd`).
