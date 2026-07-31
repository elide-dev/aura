# Metaharness Effectiveness Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Metaharness with paired effectiveness/efficiency analysis and frozen-run evidence, then execute current Bash-only, current runtime, pinned historical, and deterministic runtime benchmark arms.

**Architecture:** Keep orchestration and report generation in `packages/metaharness/src/runtime-benchmark.ts`, reusing Harbor's normalized `Trial` records from `runner.ts`. Aggregate attempts within each task, bootstrap across task strata with a fixed seed, render the pre-registered decision gate into the existing comparison report, and persist machine-readable launch metadata beside the report. Run the current matched arms first; only then run the immutable historical binary and deterministic microbenchmarks.

**Tech Stack:** Bun 1.3.14+, TypeScript, Harbor/terminal-bench, Docker, existing Metaharness SQLite/artifact model, Bun test.

## Global Constraints

- Primary model: `openai-codex/gpt-5.6-sol`; reasoning: `xhigh`.
- Primary suite: all 12 `RUNTIME_TASKS`; concurrency: `1`.
- Pilot attempts: `2` per task per arm; proof attempts: `5` per task per arm.
- Historical baseline revision: `2adbb3538b8d7b7df6c09d7e7beefc60b59ce575`, the parent of the first runtime commit.
- Effectiveness gate: lower 95% confidence bound above `-5` percentage points.
- Efficiency gate: at least `15%` faster paired wall-clock or `10%` fewer total tokens; the other metric may regress by at most `5%`.
- Adoption gate: at least `80%` of completed runtime trials overall and at least `50%` in every capability group.
- Comparable arms must share model, reasoning, task fixtures, attempts, timeout, environment, gateway, and task ordering.
- Missing trials, zero durations, missing usage, setup errors, or changed frozen variables invalidate the run.
- No commits unless the user explicitly requests them.

---

### Task 1: Collect Trial-Level Runtime Measurements

**Files:**
- Modify: `packages/metaharness/src/runtime-benchmark.ts`

**Interfaces:**
- Consumes: `readTrials(jobDir: string): Trial[]` from `packages/metaharness/src/runner.ts`.
- Produces: `RuntimeTrialMeasurement`, `RuntimeTaskMeasurement`, and expanded `ArmSummary` records used by analysis and reporting.

- [ ] **Step 1: Add trial measurement contracts**

Add exported structures with exact fields:

```ts
export interface RuntimeTrialMeasurement {
	taskId: string;
	trialName: string;
	status: TrialStatus;
	durationMs: number;
	tokIn: number;
	tokOut: number;
	tokCache: number;
	costUsd: number;
	toolCalls: number;
	runtimeUsed: boolean;
}

export interface RuntimeTaskMeasurement {
	taskId: string;
	group: RuntimeCapabilityGroup;
	trials: RuntimeTrialMeasurement[];
}
```

Expand `ArmSummary` with `tokCache`, `runtimeTrials`, `completedTrials`, `elapsedMs`, and `taskMeasurements`.

- [ ] **Step 2: Make tool counting trial-specific**

Introduce:

```ts
export function countTrialToolCalls(jobDir: string, trialName: string): { total: number; runtimeUsed: boolean }
```

Read only `path.join(jobDir, trialName, "agent", "omp.txt")`. Keep `countToolCalls(jobDir)` as an aggregate wrapper over trial directories so existing callers remain correct.

- [ ] **Step 3: Aggregate normalized Harbor trials by task**

Change `summarizeArm` to use `readTrials(jobDir)`, reject undecided jobs, retain each trial's duration/token/status/cost fields, attach exact per-trial tool usage, and derive `runtimeTrials` from completed trial measurements instead of counting one boolean per task.

- [ ] **Step 4: Smoke the collector against an existing run**

Run:

```bash
cd packages/metaharness
bun -e 'import { summarizeArm } from "./src/runtime-benchmark.ts"; console.log(JSON.stringify(summarizeArm("../../runs/harbor", "runtime-final-smoke", "baseline", [])))'
```

Expected: valid JSON containing `tokCache`, `runtimeTrials`, `completedTrials`, `elapsedMs`, and `taskMeasurements`; no exception for the empty task selection.

### Task 2: Add Paired Statistical Analysis and Decision Gates

**Files:**
- Modify: `packages/metaharness/src/runtime-benchmark.ts`

**Interfaces:**
- Consumes: expanded `ArmSummary.taskMeasurements` from Task 1.
- Produces: `RuntimeComparisonAnalysis` and `analyzeRuntimeComparison(baseline, runtime)` for the markdown report.

- [ ] **Step 1: Add analysis result contracts**

Define exact result types:

```ts
export interface ConfidenceInterval {
	point: number;
	lower: number;
	upper: number;
}

export interface RuntimeComparisonAnalysis {
	passRateDifferencePp: ConfidenceInterval;
	durationRatio: ConfidenceInterval;
	tokenRatio: ConfidenceInterval;
	adoptionOverall: number;
	adoptionByGroup: Record<RuntimeCapabilityGroup, number>;
	verdict: "pass" | "fail" | "inconclusive";
	reasons: string[];
}
```

Ratios are runtime divided by baseline; values below `1` are improvements.

- [ ] **Step 2: Implement deterministic task-stratified bootstrap**

Aggregate attempts within each task before comparison. Use a fixed-seed local PRNG and 10,000 bootstrap resamples of the 12 task strata. Calculate percentile 95% intervals for pass-rate difference, geometric mean duration ratio, and total-token ratio. Treat non-positive durations or absent token totals as invalid evidence and return an inconclusive reason rather than manufacturing a ratio.

- [ ] **Step 3: Evaluate the pre-registered gate**

Return `pass` only when effectiveness, efficiency, hidden-regression, reliability, and adoption gates all hold. Return `inconclusive` when an interval crosses a threshold, measurements are missing, or adoption is below threshold. Return `fail` when a confidence bound establishes effectiveness inferiority or an efficiency regression beyond the allowed bound.

- [ ] **Step 4: Render paired evidence**

Extend `formatComparison` with:

- paired effect table showing point estimate and 95% interval;
- overall and per-group adoption;
- explicit `PASS`, `FAIL`, or `INCONCLUSIVE` decision;
- exact reason lines;
- task matrix with per-arm pass rate, median duration, total tokens, and runtime adoption.

- [ ] **Step 5: Smoke deterministic analysis**

Execute a Bun one-liner that constructs two 12-task summaries with runtime pass rate equal to baseline, runtime duration ratio `0.80`, token ratio `0.90`, and full adoption; call `analyzeRuntimeComparison` twice and compare JSON outputs byte-for-byte.

Expected: identical results and verdict `pass`.

### Task 3: Persist Frozen Metadata and Arm Wall-Clock Time

**Files:**
- Modify: `packages/metaharness/src/runtime-benchmark.ts`

**Interfaces:**
- Consumes: parsed `RuntimeBenchmarkCliOptions` and each `ArmLaunch`.
- Produces: `path.join(jobsDir, "_bench", `${prefix}-runtime-manifest.json`)` and per-arm elapsed milliseconds in the report.

- [ ] **Step 1: Extend CLI options**

Add:

```ts
manifestRevision: string | undefined;
historicalRevision: string | undefined;
historicalBinary: string | undefined;
```

Parse `--revision`, `--historical-revision`, and `--historical-binary`. Require the historical binary basename to contain `x64`, `x86_64`, or `amd64`, matching runner architecture inference.

- [ ] **Step 2: Measure launch wall-clock**

Wrap each Harbor runner process with `performance.now()`. Accumulate elapsed milliseconds by arm and pass the totals to `summarizeArm`. Keep trial-duration sums separate from end-to-end arm elapsed time.

- [ ] **Step 3: Write the frozen manifest before launching**

Persist JSON containing schema version `1`, prefix, revisions, model, thinking, attempts, task IDs, task content hashes, tools by arm, jobs directory, gateway URL, host-network setting, microbenchmark iterations, embedded-library path, runtime-relevant environment values, Bun version, platform, architecture, CPU model, logical CPU count, and start timestamp.

Use `Bun.hash()` for task file content and `Bun.file`/`Bun.write` for I/O. Do not invoke Git from benchmark code; the launch command supplies both revisions.

- [ ] **Step 4: Add optional historical launches**

When all historical flags are present, append one historical Bash-tool launch per task using `--binary=${historicalBinary}` instead of `--install=source`. Summarize it as a distinct historical section. Do not merge historical results into the causal Bash/runtime gate.

- [ ] **Step 5: Preflight manifest smoke**

Run one task with two attempts only after Task 4's verification is complete:

```bash
cd packages/metaharness
bun run bench:runtime --agent-only --task python-execution --attempts 2 \
  --prefix runtime-effectiveness-preflight \
  --revision "$(git -C ../.. rev-parse HEAD)" \
  --historical-revision 2adbb3538b8d7b7df6c09d7e7beefc60b59ce575
```

Expected: both matched jobs complete, the manifest exists, trial/token/duration fields are non-zero, runtime adoption is recorded, and the report emits a decision rather than crashing.

### Task 4: Verify Reporting Contracts After the Smoke Works

**Files:**
- Modify: `packages/metaharness/src/runtime-benchmark.test.ts`
- Modify: `packages/metaharness/README.md`
- Modify: `packages/coding-agent/CHANGELOG.md`
- Modify only if a new fork-owned source file was added: `docs/aura/FORK.md`

**Interfaces:**
- Consumes: behavior proven by Tasks 1-3.
- Produces: regression coverage and user-facing launch instructions.

- [ ] **Step 1: Add trial-collection regression coverage**

Create temporary Harbor-like trial directories with separate transcripts. Assert per-trial tool totals, runtime adoption, cache tokens, task grouping, and completed-trial counts.

- [ ] **Step 2: Add paired-analysis boundary coverage**

Cover these observable contracts independently:

- identical seeded inputs produce identical intervals;
- non-inferior effectiveness plus a 20% duration win passes;
- effectiveness lower bound at or below `-5` percentage points does not pass;
- one efficiency metric regressing beyond 5% prevents a pass;
- missing/zero usage returns inconclusive;
- overall adoption below 80% returns inconclusive;
- one capability group below 50% returns inconclusive.

- [ ] **Step 3: Add manifest and historical-launch coverage**

Assert exact parsed CLI values, source-vs-binary launch arguments, manifest schema fields, and separate historical report labeling.

- [ ] **Step 4: Run focused package verification**

Run:

```bash
cd packages/metaharness
bun test src/runtime-benchmark.test.ts
bun run check:types
```

Expected: all tests pass and type checking exits zero.

- [ ] **Step 5: Document the proof workflow**

Update `packages/metaharness/README.md` with concrete preflight, pilot, proof, historical, and microbenchmark commands; explain the gate and artifact paths. Add one `Fixed` or `Changed` entry under `packages/coding-agent/CHANGELOG.md` only if coding-agent behavior changed during diagnosis; reporting-only changes belong to Metaharness and require no coding-agent changelog entry.

### Task 5: Execute the Frozen Benchmark Campaign

**Files:**
- Create through benchmark execution: `runs/harbor/_bench/runtime-effectiveness-2026-07-29-*`
- Create through build execution: `runs/harbor/_bench/historical/aura-linux-x64`

**Interfaces:**
- Consumes: verified reporting implementation and historical revision.
- Produces: pilot, proof, historical, and microbenchmark evidence.

- [ ] **Step 1: Build the immutable historical binary**

Create an isolated worktree at revision `2adbb3538b8d7b7df6c09d7e7beefc60b59ce575`, install its locked dependencies, and build its Linux x64 coding-agent binary as `runs/harbor/_bench/historical/aura-linux-x64`. Record SHA-256 in the proof manifest. Do not modify the historical worktree.

- [ ] **Step 2: Run the complete two-attempt pilot**

```bash
bun run bench:runtime --agent-only --attempts 2 \
  --prefix runtime-effectiveness-2026-07-29-pilot \
  --revision "$(git rev-parse HEAD)" \
  --historical-revision 2adbb3538b8d7b7df6c09d7e7beefc60b59ce575
```

Reject and restart under a new prefix if any setup, auth, verifier, telemetry, artifact, or runtime-resolution failure appears.

- [ ] **Step 3: Run the five-attempt matched proof and historical control**

```bash
bun run bench:runtime --agent-only --attempts 5 \
  --prefix runtime-effectiveness-2026-07-29-proof \
  --revision "$(git rev-parse HEAD)" \
  --historical-revision 2adbb3538b8d7b7df6c09d7e7beefc60b59ce575 \
  --historical-binary runs/harbor/_bench/historical/aura-linux-x64
```

Expected: 60 completed current Bash trials, 60 completed current runtime trials, and 60 completed historical trials.

- [ ] **Step 4: Run deterministic microbenchmarks**

```bash
bun run bench:runtime --micro-only --micro-iterations 30 \
  --prefix runtime-effectiveness-2026-07-29-micro
```

If `AURA_RUNTIME_EMBEDDED_LIB` resolves a packaged library, retain the process-vs-embedded section; otherwise preserve the explicit skip and do not imply embedded evidence.

- [ ] **Step 5: Apply the decision gate**

Read the generated report and classify each claim independently. If the matched result passes, preserve all artifacts and report the causal, historical, and microbenchmark findings separately. If it fails or is inconclusive, proceed to Task 6.

### Task 6: Diagnose and Optimize Until the Frozen Gate Resolves

**Files:**
- Create: `runs/harbor/_bench/runtime-effectiveness-2026-07-29-ledger.jsonl`
- Modify: only the source file directly implicated by a grounded trace/reproduction.

**Interfaces:**
- Consumes: proof report, task matrix, normalized traces, and native trial artifacts.
- Produces: one-hypothesis experiment records and a rerun that passes or establishes a remaining blocker.

- [ ] **Step 1: Rank regressions**

Sort task-level paired deltas by pass-rate loss, duration ratio, token ratio, error class, and non-adoption. Select the highest-impact failed gate; do not optimize a secondary metric first.

- [ ] **Step 2: Ground one hypothesis**

Inspect representative winning and losing normalized traces. Classify the cause as selection/adoption, tool contract, adapter startup, round trips/output, runtime correctness/reliability, benchmark plumbing, or model variance. Write one JSONL ledger row with run IDs, task IDs, evidence paths, hypothesis, target metric, and expected movement.

- [ ] **Step 3: Reproduce and make one bounded fix**

Use the smallest deterministic task or microbenchmark that reproduces the cause. Change only the implicated source. Smoke the exact path after the edit.

- [ ] **Step 4: Verify the permanent fix**

Add or update one observable-contract test after the smoke succeeds. Run the focused package test and type check for the changed package.

- [ ] **Step 5: Rerun the full frozen comparison**

Use sequential suffixes beginning with `runtime-effectiveness-2026-07-29-fix-1` while keeping every manifest field except revision and run prefix unchanged. Record before/after evidence and keep/revert decision in the ledger. Repeat Tasks 6.1-6.5 until the gate passes or evidence identifies an external blocker that cannot be changed in this repository.
