---
name: insights
description: Observe a JavaScript, TypeScript or Python program with the `insights` tool — attach an instrumentation script that hooks source loads and function enter/return without editing the program under study.
---

# Insights instrumentation

`insights` runs a program on the managed runtime with an **instrumentation
script** attached. The script observes the guest from the outside: it hooks
source loads and function entry/return, and its output is emitted alongside the
program's own. The program itself is never modified — which is the whole point.
Reach for it when you want to know what a program *did* without editing it, when
adding `print` statements would perturb the thing you are measuring, or when the
code you need to observe is in a dependency you should not touch.

## Call shape

Supply **one guest source** and **one instrumentation source**; the two choices
are independent and may be mixed.

Guest: `code` (inline) or `path` (existing file).
Instrumentation: `insight` (inline JavaScript) or `insightPath` (a file).

```json
{ "language": "js", "path": "sample.js", "insightPath": "trace.insight.js" }
```

```json
{
  "language": "js",
  "code": "print(6 * 7)",
  "insight": "insight.on('source', e => { if (e.characters) print(e.name); });"
}
```

Same optional controls as `run`: `language`, `args`, `stdin`, `cwd`,
`timeoutMs`. The instrumentation script is **always JavaScript**, whatever the
guest language — instrumenting Python still means writing JS hooks.

The same inline-versus-path rule as `run` applies to both slots: an inline guest
runs from a scratch file and cannot resolve the project's imports, and an
instrumentation script long enough to be worth keeping belongs in a file passed
as `insightPath`.

## Events

- `source` — a source unit was loaded. Inspect `name` and `characters`.
  Fires for the runtime's own internals too, so filter before printing.
- `enter` — a root (function/program body) was entered. With `{ roots: true }`
  the second callback argument exposes the frame, so you can read argument
  values at the moment of the call.
- `return` — a root returned. This is where end-of-program summaries go.

**One-shot runs do not emit a `close` event.** There is no "program is exiting"
hook to flush from, so a summary must be emitted from the `return` of the
top-level root. That root is exposed as `:program` or `:module:eval` depending
on how the guest was loaded — match **both**, and guard with a `reported` flag
so a re-entrant root cannot print the report twice.

## Read argument values at each call

```js
insight.on(
  "enter",
  function (_context, frame) {
    print(`fib(${frame.n})`);
  },
  { roots: true, rootNameFilter: name => name === "fib" },
);
```

`rootNameFilter` is the cheap way to scope instrumentation: without it, `enter`
fires for every root in the program and in whatever it imports.

## Count hot roots and report once

```js
const calls = new Map();
let reported = false;

insight.on(
  "enter",
  function (context) {
    calls.set(context.name, (calls.get(context.name) || 0) + 1);
  },
  { roots: true },
);

insight.on(
  "return",
  function (context) {
    const top = context.name === ":program" || context.name === ":module:eval";
    if (top && !reported) {
      reported = true;
      for (const [name, count] of calls) print(`${name}:${count}`);
    }
  },
  { roots: true },
);
```

## When to prefer this over `profile`

Insights gives **exact, filtered, semantic** counts — "how many times was `fib`
called with n < 2", "which modules got loaded". `profile` gives timings and
whole-program call tables. If the question is "how much work does this
algorithm do", instrument and count; timings and JIT percentages move run to
run and make poor assertions. If the question is "where is the time going",
use `skill://profiling`.
