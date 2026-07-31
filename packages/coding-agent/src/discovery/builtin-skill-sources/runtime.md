---
name: runtime
description: Innate execution on the managed polyglot runtime — running JavaScript, TypeScript, Python, Java, and Kotlin with `run`, selecting execution engines, validating projects with `check`, and choosing between runtime tools and `bash`/`eval`.
---

# The managed runtime

Code execution is innate. A managed polyglot runtime is resolved (or downloaded)
for you and driven through named tools, so path controls, output budgets,
process ownership and approval policy all apply. Reaching for the runtime's
command-line binary through `bash` bypasses every one of those, and by default
the shell interceptor blocks the attempt and names the tool to use instead.
Do not read a command that *does* go through as permission: the interceptor
stands down when its target tool is not registered, and the user can switch the
whole group off — the reason to use the innate tool is the policy, not the
block.

## `run` — one program, one process

Provide **exactly one** source form:

- Inline: `{ language: "ts" | "js" | "python" | "java" | "kotlin",
  code: "…" }` — the source is written to a temp file and executed.
  `language` defaults to `ts`.
- Existing file: `{ path: "tools/report.py" }` — `language` is inferred from
  `.js`/`.ts`/`.py`/`.java`/`.kt` (including common module variants).

Optional: `engine`, `args`, `stdin`, `cwd` (defaults to the session directory),
`timeoutMs`, and `mainClass` for Java/Kotlin. The result carries the resolved
engine and language, stdout, stderr, exit code, and JVM phase/class metadata
where applicable.

**Path mode is not a convenience — it changes semantics.** An inline snippet
runs from a scratch file, so relative imports, sibling modules and data files
resolve against the temp directory and break. A `path` run executes the file
where it lives, so `import "./util.ts"`, `open("fixtures/data.json")` and the
project's own module resolution all work. If a snippet needs anything from the
project, `write` it into the project and run it by path instead of inlining it.

Every call is a fresh process. Nothing carries over between calls — no
variables, no imports, no open handles.

Python is a CPython-compatible engine (3.12), not the host's `python3`. Host
site-packages are not on the path; treat it as a clean interpreter.

Engine routing:

| Language | Default | Engine choice |
| --- | --- | --- |
| JavaScript / TypeScript | Bun | Bun or the embedded engine |
| Python | Embedded | Embedded only |
| Java / Kotlin | Embedded | Embedded only |
Invalid language/engine pairs fail before execution. Java and Kotlin compile
and run in a scratch workdir; `mainClass` overrides entrypoint derivation.
Use `check` / `build` rather than `run` for multi-file JVM projects.

## `run` vs `bash` vs `eval`

- `run` — you have a self-contained JavaScript, TypeScript, Python, Java, or
  Kotlin program and want its output. This is the default for direct execution.
- `bash` — you have a *shell* task: invoking installed CLIs, pipelines, git,
  package managers, file plumbing.
- `eval` — you want a **persistent kernel**: incremental exploration where state
  survives across calls (imports → define → probe → use). Use it when the next
  step depends on objects the previous step built. `run` cannot do that; `eval`
  is the wrong tool for a self-contained script you want to run once.

## Project-level tools

- `check` — resolve dependencies and compile supported source sets through the
  managed project build, without requesting deliverable artifacts. This is a
  fast build-integrity gate, not a replacement for project-specific static
  analysis: the runtime strips TypeScript types rather than running `tsc`, so
  invoke the project's declared typecheck/check command when TypeScript type
  correctness is the contract. Optional `cwd`, `timeoutMs`.
- `build` — assemble artifacts. `targets` takes `:`-prefixed build targets with
  interleaved per-target options, passed through verbatim (e.g.
  `[":deps", "--fresh", ":compile"]`); omit it for the default build. Use
  `check` when validation is the goal and `build` when artifacts are.

Both read the project configuration in `cwd`, so run them from the project root
rather than a subdirectory.

Unsure what a project supports? Call `project_advice` first — it reads the
working directory in place and reports the commands, declared name/version and
dependencies the project itself declares. It is read-only and executes nothing.

## Availability

The runtime is resolved from, in order: an explicit configured path, the
`AURA_RUNTIME_BIN` environment override, a managed copy downloaded into the
agent's own directory, then the `PATH`. When none is present and auto-download
is enabled, the first call provisions it; when it is disabled, the tool returns
installation guidance instead of failing the task. Nothing is installed into the
project.

If the runtime tools are absent from this session entirely, runtime support is
switched off in settings — say so rather than emulating them through `bash`.

## Going further

- `skill://insights` — instrument a program without editing it.
- `skill://profiling` — find where the time goes.
- `skill://jvm` — Java and Kotlin on the embedded JVM.
- `skill://stateful-debugger` — publish a CDP/DAP endpoint, or serve a directory.
