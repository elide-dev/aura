# Aura v1 Parity Plan (BUCKSHOT → fork)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute task-by-task. Each task's brief is this file's task section PLUS the referenced section of the gap analysis, which carries the porting shape.

**Goal:** Reach functional parity with Aura v1 (BUCKSHOT) on `main`, per the gap analysis at `.superpowers/sdd/parity-gap-analysis.md` (committed copy: `docs/aura/parity-gap-analysis.md`).

**Spec:** the gap analysis IS the spec — 16 gaps (1 L, 3 M, 12 S); 18 BUCKSHOT capabilities are superseded by OMP-native features and are explicitly NOT ported (analysis "Things deliberately not gaps" section is binding).

## Global Constraints

- Naming rule: user-facing text says "the runtime"/"the embedded JVM", never "Elide". Compat exceptions kept: `ELIDE_BIN`, `AURA_ALLOW_ELIDE_SHELL`.
- One protocol bump: gaps #28/#30/#31 land as a single `RUNTIME_PROTOCOL_VERSION = 2` with the workdir abstraction (#29) underneath — never piecemeal.
- Reuse fork seams, never duplicate: `hub` for background processes (#31), `bash-interceptor` rules for shell policy (#32), `output-meta.ts` + `session/artifacts.ts` for spill (#34).
- Every task: TDD; `bun run check:ts` exit 0; biome clean; FORK.md row for any upstream file touched; new tools need `docs/tools/<name>.md` (coverage guard) and registry entries (builtin-names, BUILTIN_TOOLS, essential-tools where applicable).
- Baseline discipline: full-sweep failures compared by NAME against the ~11-failure machine baseline.

## Tasks (execution order per analysis)

### P1. Runtime workdir + protocol v2 groundwork (#29)
`RuntimeWorkdir` in transport/local.ts: mkdtemp once per request-handler flow, bound `run(args, opts)` closure, rm -rf in finally; endpoint-internal only. JVM env hygiene helper (strip JAVA_HOME/JDK_HOME). Bump RUNTIME_PROTOCOL_VERSION to 2 in this task (methods added in P2/P6/P7 ride it). Tests: workdir reuse across two invocations in one flow; cleanup on throw; env stripping.

### P2. JVM tool suite (#28) — L
Analysis section "#28 + #29" is the brief. `runtime/jvm` method with action union; six tools `jvm_run|jvm_disassemble|jvm_format|jvm_jar|jvm_deps|jvm_javadoc` (discoverable, createIf-gated); `deriveJvmMainClass` ported verbatim with tests; `--release 17`; overwrite guards on jar/javadoc (refuse without `overwrite: true`); six docs pages. Integration tests against real runtime (skipIf-gated) for compile→run and compile→disassemble flows.

### P3. `aura doctor` + `--check` (#33) — M
Analysis section "#33" is the brief. Aggregates existing probes (identity/runtime/natives/tools/plugins/terminal/memory), pure `buildDoctorReport`, no model/network/provisioning, `--json`, exit semantics (hard failures nonzero). `--check` = one-line clean-env probe.

### P4. Managed debug/serve via hub (#31) — M
Analysis section "#31" is the brief. `runtime/spawn` returns a launch descriptor; `debug`/`serve` tools start it through hub (job-name handles; no stop_runtime_process tool); endpoint scraping regexes + wait-window fallback in the tools; PATH-shim guard note.

### P5. Runtime shell policy (#32) — S
Append rules to DEFAULT_BASH_INTERCEPTOR_RULES (`elide`, `bunx elide`, `npx @elide-dev/elide` → `run`); message names innate tools + opt-out; honor `AURA_ALLOW_ELIDE_SHELL=1` + `runtime.allowShell` setting where the rule set is assembled. Regex coverage accepted for v1 (routing enforcement, not sandbox).

### P6. Runtime output spill (#34) — S
Replace format.ts's private cap with output-meta.ts + session/artifacts.ts spill, matching bash.ts. Stream results tail-biased; single-blob reports (profile, jvm_disassemble, jvm_deps, project_advice) cap-and-spill as one unit. Verify no downstream double-truncation.

### P7. `project_advice` (#30) — S
`runtime/advice` method; real cwd, read-only, ANSI-stripped, single-blob spill; `project_advice` tool (discoverable); live-test skip guard (verify against pinned 1.4.1+; BUCKSHOT noted a crash on an older nightly).

### P8. Runtime skills (#39) — M
Five skills ported/rewritten under the naming rule: runtime.md (was elide.md), insights.md, profiling.md, jvm.md, stateful-debugger.md. jvm.md + stateful-debugger.md gated on P2/P4. Declared to the fork's resource loader.

### P9. Small deltas batch 1: `--runtime` flag + `runtime.version` setting (#35); `--version` identity line (#43); system-prompt `prepend` (#42)
Per analysis sections. `--runtime` threads into resolveRuntimeEndpointOptions as explicitPath; `runtime.version` allows pin/rollback of the managed install.

### P10. `aura-light` theme (#36) + runtime tool renderers (#40)
aura-light generated from the same tokens, registered, `theme.light` default → aura-light; auto light/dark stays on-brand. Renderers per bash/hub conventions for all five (+ six JVM) tools.

### P11. Chrome (optional, last): banner (#37), editor chrome (#38), fast-start (#41)
Banner via startup-splash seam (no keybinding hints — upstream header owns them). Editor chrome deferred-by-default (upstream file on merge path); fast-start is a judgment call — confirm with the user before building.

## Also absorbed here (from the base-issue backlog)
- Renderers (base backlog) = P10. Spill (base backlog K) = P6.
- Cross-process download file-lock: optional; attach to P1 if trivial, else drop.

## Explicitly not ported
`--vanilla`, `AURA_DISABLE/ENABLE`, bun-patch machinery, pi_natives staging, context-mode shim, OSC 777, `AURA_NO_NOTIFY` (aliases exist) — per the analysis's binding "not gaps" section.
