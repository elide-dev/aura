---
name: profiling
description: Spot-profile JavaScript, TypeScript or Python with the `profile` tool — choosing between cpusampling and cputracing, and reading the report without over-reading its numbers.
---

# Spot profiling

`profile` runs a program on the managed runtime under a profiler and returns the
report as text. Same source rules as `run`: **exactly one** of `code` (inline)
or `path` (existing file), plus optional `language`, `args`, `stdin`, `cwd`,
`timeoutMs`. `mode` is required.

```json
{ "language": "js", "path": "work.js", "mode": "cpusampling" }
```

```json
{ "language": "python", "code": "print(sum(range(1000)))", "mode": "cputracing" }
```

## Choosing the mode

This is the only real decision, and picking wrong wastes the run.

**`cpusampling`** — statistical. The profiler interrupts on a timer and
attributes wall-clock time to whatever root is executing. Overhead is low and
roughly constant, so the program's own behaviour is largely preserved.

- Use it to answer *"where is the time going?"*
- Prefer it for anything long enough to matter — I/O-shaped work, programs that
  run for seconds, anything you would otherwise time with a stopwatch.
- Short runs give you almost no samples, and a hot function that finishes
  between two samples is invisible. Below roughly a second of work, sampling
  tells you nothing you can trust.

**`cputracing`** — exact. Every root entry and exit is recorded, so invocation
counts are precise and split by runtime state (interpreted vs compiled).

- Use it to answer *"how much work does this actually do?"* — comparing two
  algorithms, confirming a memoization landed, proving a call is not made.
- The instrumentation is heavy and it distorts what it measures: tracing
  overhead dominates cheap functions, and it inhibits the inlining that would
  otherwise happen. Treat tracing *timings* as unusable; only the counts are
  meaningful.
- On a long or call-heavy run the trace is enormous and slow. Shrink the input
  first, then trace.

The usual sequence is: sample the real workload to find the hot region, then
trace a reduced input to understand why it is hot.

## Reading the report

The report is a per-root table: invocation counts, time attributed, and the
split across runtime states. Read it for **relationships**, not absolutes.

- Absolute milliseconds and JIT/compiled percentages vary substantially between
  runs on the same input — warm-up, compilation timing and machine noise all
  move them. Never assert on them and never report them as a measurement.
- Call-count relationships (`inner` ran 10× per `outer`) and the *ranking* of
  roots by attributed time are stable and are what you should quote.
- A root you expected to be hot but which does not appear at all usually means
  it was inlined or the run was too short to sample — not that it is free.

When you need a defensible before/after claim, assert on semantic program output
and on stable call-count relationships. For exact, filtered counts, instrument
instead: see `skill://insights`.
