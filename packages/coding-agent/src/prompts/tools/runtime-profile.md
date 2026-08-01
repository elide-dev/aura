Profile a program on the managed runtime. `mode: "cputracing"` gives exact call
tracing; `"cpusampling"` gives lower-overhead statistical sampling and SHOULD be
used for longer runs.

Provide the program via `code` or `path`. Returns a text report.
