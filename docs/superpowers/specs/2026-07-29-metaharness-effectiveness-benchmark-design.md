# Metaharness Effectiveness Benchmark Design

## Objective

Produce reproducible evidence that Aura's runtime tools improve agent efficiency without reducing task effectiveness. Measure three distinct claims:

1. **Causal tool effect:** current Aura with runtime tools versus the same current Aura with runtime tools withheld.
2. **Whole-product regression:** the winning current configuration versus a pinned pre-runtime Aura build.
3. **Runtime overhead:** deterministic direct-versus-runtime and process-versus-embedded microbenchmarks.

The benchmark must measure wall-clock duration, task effectiveness, token usage, reliability, runtime-tool adoption, tool calls, and estimated cost. If a gate fails or remains inconclusive, use normalized traces and deterministic reproductions to diagnose one cause at a time, make one bounded fix, and rerun the frozen comparison.

## Existing Metaharness Support

`packages/metaharness/src/runtime-benchmark.ts` already provides the primary matched arms:

- Bash baseline: `read`, `write`, `edit`, `bash`, `grep`, and `glob`.
- Runtime arm: the baseline tools plus `run`, `check`, `build`, `insights`, `profile`, `runtime_debug`, `serve`, and the JVM tools.

Both arms use the same model, reasoning level, fixtures, and attempts. Task order alternates AB/BA. The existing report includes aggregate pass rate, errors, cost, median trial duration, input/output tokens, tool calls, and runtime-tool adoption. The runtime benchmark suite materializes 12 deterministic Harbor tasks across execution, project validation/build, debugging, profiling, and JVM capabilities.

The proof run requires two reporting additions before execution:

- paired, task-level effect sizes with uncertainty;
- end-to-end elapsed time per arm, in addition to trial duration.

## Experimental Controls

### Current matched control

The primary control is current Aura with runtime tools withheld. This isolates tool availability while holding agent code constant.

### Historical control

The secondary control is an immutable build from a pinned pre-runtime revision. It checks whether the current product regressed or improved as a whole. It does not establish that runtime tools caused the difference because code revision changes with the arm.

### Frozen variables

Record these values in an experiment manifest before the proof run:

- current revision and historical revision;
- source tree cleanliness or patch identity;
- model provider and exact model ID;
- reasoning level;
- task fixture IDs and content hashes;
- runtime executable and embedded-library paths, versions, and hashes;
- operating system, architecture, CPU, memory, Bun version, container backend, and Harbor version;
- installation mode, gateway configuration, timeout multiplier, concurrency, attempts, and task ordering;
- Metaharness and coding-agent launch arguments;
- start time and run names.

No frozen variable may change between comparable arms. A changed variable starts a new experiment.

## Benchmark Sequence

### Stage 0: environment and telemetry preflight

Run one representative task through each intended arm. Confirm:

- provider authentication succeeds through the configured gateway;
- the model and reasoning level match the manifest;
- Harbor records a completed verifier result;
- normalized traces contain duration, input/output/cache tokens, cost, and tool calls;
- the runtime arm resolves the intended runtime artifact and can invoke a runtime tool;
- historical installation is immutable and does not resolve current source accidentally;
- report generation produces non-zero trial counts and durations.

Any missing token, duration, trace, verifier, or artifact data invalidates the preflight. Existing reports containing all-zero task metrics are setup failures, not baseline evidence.

### Stage 1: primary matched pilot

Run all 12 deterministic capability tasks with two attempts per task and concurrency one. Preserve alternating AB/BA order. Use the pilot only to detect setup failures, systematic errors, task ambiguity, unexpectedly low runtime adoption, and gross variance.

Do not tune prompts, tasks, or thresholds from pilot outcomes. Fix only invalid experimental plumbing, then restart both arms under a new experiment identifier.

### Stage 2: primary matched proof run

Run all 12 tasks with five attempts per task and concurrency one. The Bash-only and runtime arms must share model, reasoning, fixtures, attempts, timeouts, installation source, environment, and task order.

Collect per trial:

- verifier outcome and reward;
- error class;
- wall-clock duration;
- end-to-end arm elapsed time;
- input, output, cache-read, and cache-write tokens where available;
- estimated cost;
- total tool calls and calls by tool;
- whether a runtime tool was invoked;
- normalized trace and native artifacts.

If the effectiveness interval cannot resolve the non-inferiority gate, add attempts symmetrically to both arms using the same frozen configuration. Do not stop early because point estimates look favorable.

### Stage 3: historical control

Build or package the pinned pre-runtime revision once. Record its artifact hash. Run it on the same 12 tasks with the same provider, model, reasoning, attempts, timeouts, environment, and concurrency.

Compare it with the winning current arm. Report this separately from the matched tool comparison and explicitly label code-version effects as confounded.

### Stage 4: deterministic microbenchmarks

Run the existing runtime microbenchmarks with at least 30 iterations:

```bash
EXPERIMENT_ID=runtime-effectiveness-2026-07-29
bun run bench:runtime --micro-only --micro-iterations 30 --prefix=\"$EXPERIMENT_ID-micro\"
```

When a packaged embedded library is available, set `AURA_RUNTIME_EMBEDDED_LIB` to its absolute path so the report compares process and embedded adapters. Warm every repeated operation before sampling, alternate timed order, validate exact output before accepting a sample, and report p50/p95 latency and ratios. Report embedded cold-open plus first execution separately from warm calls.

Microbenchmarks explain runtime overhead but cannot establish agent effectiveness.

## Analysis

### Effectiveness

Use paired binary analysis for pass/fail outcomes and report:

- pass rate by arm;
- paired pass-rate difference;
- confidence interval;
- discordant pairs by task;
- error counts and error classes;
- results by capability group.

The runtime arm is non-inferior when the lower confidence bound for the paired pass-rate difference remains above `-5` percentage points.

### Wall-clock efficiency

Because task durations differ substantially, calculate paired per-task or per-attempt duration ratios before aggregation. Report geometric mean ratio, median paired ratio, confidence interval, aggregate arm elapsed time, and raw per-task medians. Do not rely only on the existing unpaired aggregate median.

A material wall-clock improvement is at least `15%` faster.

### Token efficiency

Report total and paired input, output, and cache tokens separately, plus total effective tokens under the provider's cache accounting. Include paired ratios and confidence intervals. A material token improvement is at least `10%` fewer total tokens.

### Reliability and adoption

Report new error classes, timeout/cancellation behavior, runtime RPC failures, and runtime-tool adoption by task. All 12 runtime-capability tasks are applicable by construction. The runtime arm must invoke at least one runtime tool in at least `80%` of its completed trials, with no capability group below `50%`; otherwise the result is inconclusive and enters adoption diagnosis.

### Cost and tool calls

Cost and tool-call counts are explanatory secondary metrics. They do not override effectiveness or the efficiency gate.

## Decision Gate

The primary matched run proves improvement only when all conditions hold:

1. **Effectiveness:** runtime is non-inferior at the `-5` percentage-point margin.
2. **Efficiency:** runtime improves paired wall-clock duration by at least `15%` or total tokens by at least `10%`.
3. **No hidden regression:** whichever efficiency metric does not meet the material-win threshold may not regress by more than `5%`.
4. **Reliability:** no new systematic error class or verifier failure mode appears.
5. **Adoption:** the runtime arm meets the pre-registered `80%` overall and `50%` per-capability-group runtime-tool adoption thresholds.

If uncertainty crosses a gate, the result is **inconclusive**. If the point estimate or confidence bound violates a gate, the result is **not optimal** and enters diagnosis. The historical comparison and microbenchmarks are reported independently; they cannot rescue a failed primary gate.

## Systematic Diagnosis and Fix Loop

For each failed dimension:

1. Rank paired regressions by task and capability group.
2. Inspect normalized traces for the largest regressions and representative wins.
3. Classify the likely cause as one of:
   - wrong tool selection or runtime non-adoption;
   - tool contract, schema, or model-facing description;
   - runtime startup or adapter overhead;
   - excessive round trips, output volume, or context growth;
   - runtime correctness, cancellation, or reliability failure;
   - benchmark fixture, verifier, auth, or artifact-collection failure;
   - irreducible model variance.
4. Reproduce deterministically when possible. For agent-only behavior, isolate the smallest task and trace pattern that demonstrates the failure.
5. Write one falsifiable hypothesis and one expected metric movement.
6. Make one bounded source change. Do not bundle unrelated optimizations.
7. Smoke-test the affected task or microbenchmark.
8. Rerun the complete frozen matched suite under a new experiment identifier.
9. Keep the change only if the target metric improves and all primary gates still hold.
10. Record the hypothesis, change, run IDs, raw evidence, result, and keep/revert decision in the experiment ledger.

Never compare a post-fix arm with a pre-fix arm whose model, fixtures, environment, attempts, or runtime artifact differs.

## Deliverables

- frozen experiment manifest;
- preflight evidence;
- raw Metaharness run directories and normalized traces;
- matched current Bash-versus-runtime report with paired uncertainty and task matrix;
- historical-control appendix;
- deterministic microbenchmark report;
- diagnosis ledger for every attempted optimization;
- final go/no-go decision mapped directly to the pre-registered gate.

## Out of Scope

- claiming generality across models before the primary model result is stable;
- changing benchmark tasks after observing comparative outcomes;
- using microbenchmarks as a proxy for task effectiveness;
- accepting a faster arm that reduces pass-rate effectiveness beyond the margin;
- treating missing telemetry, zero-token runs, or setup failures as valid samples.
