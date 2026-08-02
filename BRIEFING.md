# Inherent Capability Optimization Briefing

## Objective

Improve Aura's inherent harness capabilities without restoring runtime or Superpowers as visible skills. The immediate defect is the JVM dependency-analysis path; the broader goal is a smaller, clearer prompt contract with stronger, task-specific tool-selection telemetry.

This plan starts from commit `f1efa00d36d4608a0cdbfa3d768d81dd6f0fa541` (`feat(coding-agent): make harness capabilities inherent`). The valid focused comparison against pinned vanilla OMP revision `06343fe4200c4e32d18f08df5a6a8bd84dcc710` established:

- Both products passed all six focused trials.
- Aura used 28 tool calls versus vanilla's 34 and 280,194 input tokens versus 305,753.
- Aura selected `run` before `bash` in all TypeScript trials.
- Aura selected `jvm_deps` before `bash` in only two of three JVM trials.
- The failing JVM selection trace redundantly compiled `Report.java`, attempted to execute `Report.class` through `run`, then repeated dependency analysis.
- The focused benchmark incorrectly reported `INCONCLUSIVE` because the broad adoption gate treated unrepresented capability groups as 0% adoption.

The performance problem is therefore model behavior at the JVM tool boundary, not runtime execution. Adapter microbenchmarks already show the runtime path itself is faster than the shell baseline for Java compile/run.

## Non-negotiable architecture

1. Runtime and core workflow policy remain inherent prompt/tool capabilities. They MUST NOT reappear in skill discovery, `/skill`, skill cards, promoted-skill telemetry, or bundled-skill materialization.
2. Cross-tool selection policy belongs in the high-order system prompt. Mechanical invocation rules belong in tool prompts and schemas. The same rule MUST NOT be repeated at all three layers.
3. `run` and `check` remain the default execution and validation capabilities. Specialized JVM tools own formatting, bytecode, JAR, and dependency workflows.
4. Successful tool output is evidence. The model MUST NOT rerun an equivalent shell or runtime command merely to reconfirm it.
5. Benchmark tasks remain deterministic, dependency-free, and task-specific. The focused loop stays small; the broad suite is a regression gate, not the tuning loop.
6. Historical vanilla OMP is a whole-product control only. The causal comparison for each optimization is the frozen pre-change Aura binary versus the changed Aura binary.
7. No new tool, alias, compatibility shim, runtime skill, or benchmark-only production branch is permitted.

## Success criteria

### Focused JVM/TypeScript gate

Run three alternating attempts per task against the frozen pre-change Aura binary. The changed binary MUST satisfy all of the following:

- 6/6 verifier passes and zero harness errors.
- TypeScript: `run` is the first capability tool in 3/3 trials.
- JVM dependencies: `jvm_deps` is the first capability tool in 3/3 trials.
- Zero promoted core runtime/Superpowers skill loads.
- Zero `bash` calls before the first successful expected capability call.
- Zero repeated calls to the expected capability after its first successful result unless intervening source changes invalidate that result.
- TypeScript median tool calls do not exceed the pre-change median.
- JVM median tool calls are at most 4, with no trial above 5.
- JVM median input tokens do not increase relative to the matched pre-change arm.
- The focused report returns `PASS`, not `INCONCLUSIVE`, when all represented tasks meet their gates.

Duration and cost remain reported but are not standalone prompt-adoption gates because provider latency and pricing noise can move independently of tool choice.

### Broad regression gate

After the focused gate passes, run the full task matrix with three attempts per arm. The changed binary MUST satisfy:

- Every task passes 3/3; no systematic runtime-only error class appears.
- Every eligible trial uses its declared expected capability.
- Expected capability selected first in at least 90% of eligible trials, with no represented group below 80%.
- Zero promoted core runtime/Superpowers skill loads.
- No task-level pass-rate regression.
- Existing paired efficiency gate passes: either meaningful duration improvement with token safety, or meaningful token improvement with duration safety.
- Groups with no eligible task are displayed as `n/a` and are excluded from adoption gates.

`serve` remains outside Harbor's model-behavior suite because it requires a live hub supervisor and daemon lifecycle. Its real launch/readiness/stop contracts remain covered by coding-agent integration tests.

## Phase 1 — Freeze controls and make benchmark telemetry truthful

### 1. Preserve immutable comparison artifacts

Before production edits:

- Build and copy the coding-agent binary at `f1efa00d36d4608a0cdbfa3d768d81dd6f0fa541` to a source-mounted, ignored benchmark-artifact directory.
- Preserve the embedded runtime library used by that build.
- Preserve or rebuild vanilla OMP at revision `06343fe4200c4e32d18f08df5a6a8bd84dcc710` in the same source-mounted artifact directory.
- Record SHA-256 values for both binaries, the embedded library, task fixtures, system prompt, tool prompts, and tool registration in each benchmark manifest.
- Confirm both branded config trees, `~/.aura/agent` and `~/.omp/agent`, receive generated gateway configuration. Credentials remain host-side.

No treatment prompt may be edited before these hashes are recorded.

### 2. Add a shared ordered transcript analyzer

Create `packages/metaharness/src/runtime-transcript.ts` and its focused test file. Move JSONL tool-event interpretation out of the two benchmark entrypoints into this module.

The analyzer must:

- Ignore malformed or truncated trailing JSONL records.
- Preserve tool-call order.
- Pair `tool_execution_start` and `tool_execution_end` by call ID.
- Record total calls, capability calls, first capability tool, and successful capability calls.
- Detect reads of promoted core runtime or Superpowers skills, including namespaced `skill://superpowers:<name>` URLs.
- Given an expected capability, report:
  - whether it was used;
  - whether it was the first capability tool;
  - whether `bash` ran before its first success;
  - whether the same capability was repeated after success;
  - whether a source-changing `write` or `edit` occurred between successful repeats.
- Treat an expected-tool repeat as redundant only when no intervening source mutation could invalidate the earlier result.

Tests must use representative transcript events and assert behavior, not source text. Cover a truncated final line, failed-then-successful retry, successful repeat without mutation, and valid repeat after an edit.

### 3. Declare task-specific expected capabilities

Update `RuntimeTaskDefinition` in `packages/metaharness/src/runtime-benchmark-suite.ts` with an optional `expectedCapability` field. Populate it explicitly:

| Task | Expected capability |
|---|---|
| `python-execution` | `run` |
| `typescript-execution` | `run` |
| `project-validation` | `check` |
| `runtime-debugging` | `run` |
| `instrumentation` | `insights` |
| `cpu-sampling` | `profile` |
| `call-tracing` | `insights` |
| `java-execution` | `run` |
| `bytecode-inspection` | `jvm_disassemble` |
| `executable-jar` | `jvm_jar` |
| `jvm-dependencies` | `jvm_deps` |

Replace the stale `project-build` fixture, which no longer targets an inherent tool after `build` was removed, with a deterministic `jvm-formatting` fixture whose `runtimeTools` is `["jvm_format"]` and whose expected capability is `jvm_format`. Add `jvm_format` to `TaskRuntimeTool`. The fixture must supply malformed Java source and an exact expected formatted artifact, require `jvm_format` to write the artifact, then compile and execute it. Its verifier must compare the generated artifact with the expected artifact and assert the program's exact output. This checks files produced by the task, not implementation source.

Keep `runtimeTools` as the tool-exposure list. `expectedCapability` is the measurement contract, not an inferred alias for the first element.

### 4. Fix adoption denominators and report selection quality

Update `packages/metaharness/src/runtime-benchmark.ts` and `packages/metaharness/src/inherent-capability-benchmark.ts` to consume the shared analyzer.

Required metric changes:

- Preserve `runtimeUsed` for backwards-compatible report context, but calculate adoption from `expectedCapabilityUsed` on eligible tasks.
- Exclude tasks without `expectedCapability` from adoption denominators.
- Represent groups with zero eligible trials as `null`/`n/a`, never `0%`.
- Gate only represented groups.
- Add overall and per-group first-capability selection rates.
- Add counts for promoted core skill loads, shell-before-capability, and redundant post-success repeats.
- Add the same facts to the historical report arm without treating historical deltas as causal.
- Include task-level tool-call and input-token rows so a group aggregate cannot hide a single regressing task.

Add regression tests proving:

- A two-task focused suite can pass without being penalized for absent project/debugging/profiling groups.
- An eligible task that uses the wrong runtime tool does not count as adopted.
- `n/a` groups render correctly.
- Shell-before-success and redundant-repeat failures produce explicit verdict reasons.
- Historical rows render but do not change the current-versus-baseline verdict.
- Existing bootstrap confidence intervals remain deterministic.

## Phase 2 — Harden the JVM dependency boundary

Use test-driven development: add failing observable-contract tests, run them, then change production code.

### 5. Reject compiled artifacts through `run`

The bad trace passed `Report.class` with `language: "java"`, bypassing extension inference and causing the runtime to read bytecode as source. Fix the shared validation boundary in `packages/coding-agent/src/runtime/protocol.ts`, inside `resolveRunTarget`, so every process, embedded, and Bun endpoint sees the same rule.

Contract:

- `run({ path: "Report.class", language: "java" })` fails with `invalid-params` before endpoint side effects.
- `.jar` paths fail identically.
- The error states that `run` executes source files, not compiled JVM artifacts, and directs dependency inspection to `jvm_deps`; execution of project-built artifacts remains a project toolchain command.
- Valid `.java`, `.kt`, `.js`, `.ts`, and `.py` paths remain unchanged.
- Inline Java/Kotlin source remains unchanged.

Add protocol/endpoint tests that assert the surfaced error code and message and prove the endpoint was not called. Do not duplicate validation in individual adapters.

### 6. Make the direct `jvm_deps` route unmistakable

Tighten these surfaces together:

- `packages/coding-agent/src/prompts/tools/jvm-deps.md`
- `packages/coding-agent/src/tools/jvm-deps.ts`
- Relevant rendered tool-schema/tool-prompt contract tests

The contract must say, once and concisely:

- A `.java` or `.kt` `path` is compiled in scratch space before `jdeps`; precompilation is unnecessary.
- A `.class`, `.jar`, or class-directory `path` is analyzed directly.
- `language` plus `code` is the inline-source alternative.
- `output` writes the report while the tool result also returns it; rereading the output solely to confirm a successful call is redundant.
- Prefer the source path when the task starts from source.

Do not add this mechanical detail to the high-order system prompt. That prompt already owns the broader rules: use the specialized JVM tool and do not repeat successful equivalent work.

Add or extend `packages/coding-agent/test/jvm-tools.test.ts` to prove a source path compiles and produces dependency output in one call, including `java.sql`, and that an output file receives the same successful report. Use the real runtime service seam already used by the JVM contract tests; no `mock.module()` and no source-grep assertions.

### 7. Preserve concise prompt size

Measure before and after with:

```bash
bun scripts/tool-prompt-usage.ts --json \
  packages/coding-agent/src/prompts/tools/runtime-run.md \
  packages/coding-agent/src/prompts/tools/jvm-deps.md
```

The combined rendered token count must not increase. If the new JVM distinction requires added words, remove an equal or larger amount of schema-derivable or duplicated prose from the same two prompts. Record both measurements in the benchmark report or implementation notes, not in production comments.

## Phase 3 — Run the focused causal comparison

### 8. Build and preflight the treatment

- Build the changed coding-agent binary.
- Run `bun check` in `packages/coding-agent` and `packages/metaharness`.
- Run focused tests for protocol resolution, JVM tools, runtime endpoint selection, system-prompt inventory, transcript analysis, and both benchmark analyzers.
- Run the embedded-runtime telemetry preflight and generated TypeScript verifier smoke.
- Confirm the treatment manifest hashes differ only where expected.

### 9. Execute the matched focused benchmark

Run `bun run bench:inherent` from `packages/metaharness` with:

- model `openai-codex/gpt-5.6-sol`;
- thinking `high`;
- three attempts;
- tasks `typescript-execution` and `jvm-dependencies`;
- alternating treatment/control order;
- frozen pre-change Aura binary as the legacy/control arm;
- changed source build as the inherent/treatment arm;
- the same gateway, task fixtures, embedded library selection, and verifier image for both arms.

Do not tune against partial trials. Let the complete six-pair campaign finish, then read the aggregate report and all JVM traces.

If any focused criterion fails:

1. Classify the failure as selection, schema misuse, tool-result misunderstanding, runtime defect, or verifier defect.
2. Fix the narrowest owning layer.
3. Add a contract test for any runtime defect.
4. Preserve a new control binary before the next prompt treatment.
5. Rerun the complete matched campaign under a new prefix; never overwrite or combine attempts across treatments.

The phase is complete only when the focused report is `PASS` and the raw traces satisfy the zero-shell-before-success and zero-redundant-repeat criteria.

## Phase 4 — General inherent-prompt simplification

Only begin after Phase 3 passes. This prevents a broad prompt rewrite from hiding the JVM cause.

### 10. Audit the inherent prompt layers

Scope:

- The inherent capability block in `packages/coding-agent/src/prompts/system/system-prompt.md`.
- `runtime-run.md`, `runtime-check.md`, `runtime-insights.md`, `runtime-profile.md`, `runtime-serve.md`.
- `jvm-disassemble.md`, `jvm-format.md`, `jvm-jar.md`, `jvm-deps.md`.
- Their tool schemas under `packages/coding-agent/src/tools/`.

For every instruction, assign exactly one owner:

- System prompt: precedence, selection, lifecycle, and cross-tool safety.
- Tool prompt: workflow-specific mechanics and output interpretation.
- Schema description: field meaning, allowed combinations, defaults, and units.

Delete duplicates from lower-value layers. Keep the system block short enough to remain visible on every request, but do not trade away a decision rule for token savings. Never move inherent policy into a skill.

Specific cleanup targets:

- Remove shell-policy repetition from individual runtime prompts when the system prompt already states the rule.
- Keep source-versus-path and output semantics next to the affected tool.
- Keep hub lifecycle policy in the system/serve boundary; do not teach a second stop mechanism.
- Keep `run`/specialized-JVM precedence in one high-order sentence plus the concrete specialist prompt.
- Preserve exact failure guidance that prevents a plausible wrong tool call; remove marketing and implementation plumbing.

Measure all changed prompts before and after with `scripts/tool-prompt-usage.ts` for both `o200k_base` and `cl100k_base`. Total rendered tokens across the changed prompt set MUST decrease, and no individual prompt may grow without an explicit behavior-protecting reason in the report.

### 11. Protect implicit UI behavior

Rerun the existing skill discovery, slash-command, skill-message, settings, and system-prompt inventory contracts. Add a test only if a real user-visible path is uncovered. Required result:

- No runtime or core workflow pseudo-skill appears in discovery or UI.
- No removed bundled runtime skill is rematerialized.
- `skill://runtime` is not restored as a supported path.
- Tools remain discoverable through their schemas, system inventory, and `xd://` protocol surface.

## Phase 5 — Broad behavior regression and vanilla comparison

### 12. Run the full current-versus-baseline suite

Run `bun run bench:runtime` with all task fixtures and three attempts per arm. The baseline arm receives file/shell tools; the runtime arm receives `run`, `check`, and only the specialist required by each task. Alternate arm order and preserve one job per task/arm.

Evaluate:

- verifier pass and error rates;
- expected-capability adoption and first selection;
- promoted skill loads;
- shell-before-success and redundant-repeat counts;
- paired duration, input, output, cache, cost, and tool-call deltas;
- task and group breakdowns;
- bootstrap confidence intervals;
- runtime telemetry success/failure durations.

The report must use the revised eligibility-aware gate. A missing capability group is `n/a`; a represented low-adoption group is a real failure.

### 13. Run the pinned vanilla whole-product control once

After the current-versus-baseline gate passes, run the same task matrix with the pinned vanilla OMP binary as the historical arm. Use the already-correct dual branded config staging. Report:

- pass/error rates;
- tool calls and token totals;
- expected first-capability selection;
- promoted skill loads;
- task-specific deltas;
- duration and cost as noisy observational metrics.

Label this section `Historical whole-product control`. It MUST NOT alter the causal benchmark verdict because code revision, product branding, prompt architecture, and runtime availability differ simultaneously.

## Phase 6 — Verification and cleanup

### 14. Repository verification

Run, in order:

1. Focused coding-agent contract tests for every changed runtime/tool/prompt surface.
2. Focused metaharness tests for transcript facts, suite materialization, report formatting, and verdict logic.
3. `bun check` in `packages/coding-agent`.
4. `bun check` in `packages/metaharness`.
5. Root `bun check`.
6. Root `bun run test:ts`.

If root tests expose an unrelated pre-existing failure, rerun the exact failing package/test to distinguish it and report the evidence. Do not weaken or skip a relevant failing test.

### 15. Documentation and fork inventory

After successful smoke and benchmark verification:

- Update `packages/metaharness/README.md` with the expected-capability metrics, `n/a` adoption semantics, focused control procedure, and historical-control caveat.
- Update `docs/aura/FORK.md` for every newly touched upstream file and every new fork-owned benchmark file.
- Update `packages/coding-agent/CHANGELOG.md` under `[Unreleased]` for the user-visible compiled-artifact error and direct source-path dependency guidance.
- Remove obsolete benchmark fields, duplicated scanner logic, stale project-build fixture references, and temporary debug output.
- Keep run artifacts ignored; preserve report paths and hashes in the final evidence summary.
- Do not commit or push unless explicitly requested.

## Expected file set

Planned production changes:

- `packages/coding-agent/src/runtime/protocol.ts`
- `packages/coding-agent/src/prompts/tools/runtime-run.md`
- `packages/coding-agent/src/prompts/tools/jvm-deps.md`
- `packages/coding-agent/src/tools/jvm-deps.ts`
- `packages/coding-agent/src/prompts/system/system-prompt.md` only if Phase 4 removes proven duplication

Planned coding-agent tests:

- `packages/coding-agent/test/runtime-embedded-endpoint.test.ts`
- `packages/coding-agent/test/jvm-tools.test.ts`
- `packages/coding-agent/test/system-prompt-inventory.test.ts`

Metaharness changes:

- `packages/metaharness/src/runtime-transcript.ts` (new)
- `packages/metaharness/src/runtime-transcript.test.ts` (new)
- `packages/metaharness/src/runtime-benchmark-suite.ts`
- `packages/metaharness/src/runtime-benchmark-suite.test.ts`
- `packages/metaharness/src/runtime-benchmark.ts`
- `packages/metaharness/src/runtime-benchmark.test.ts`
- `packages/metaharness/src/inherent-capability-benchmark.ts`
- `packages/metaharness/src/inherent-capability-benchmark.test.ts`
- `packages/metaharness/README.md`

Cleanup/documentation:

- `packages/coding-agent/CHANGELOG.md`
- `docs/aura/FORK.md`

## Final evidence format

The implementation handoff must contain:

1. Changed contracts and their owning files.
2. Before/after rendered prompt token counts for both encodings.
3. Focused matched benchmark table and verdict.
4. Per-trial JVM tool sequences proving direct `jvm_deps` use.
5. Broad task/group adoption and first-selection table.
6. Historical vanilla comparison clearly labeled non-causal.
7. Exact test/check commands with pass/fail counts.
8. Remaining risks, limited to evidence-backed items.

No success claim is valid without the focused raw traces, aggregate benchmark report, and repository verification output.