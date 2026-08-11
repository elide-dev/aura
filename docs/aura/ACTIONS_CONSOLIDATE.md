# Consolidate the code-execution surfaces (originally: onto `run`)

Handoff plan. Written 2026-08-10 after the first post-merge runtime benchmark
(v17.2.12) came back invalid. Phase 0 is a hard prerequisite for measuring
anything downstream, and its findings still stand.

> **Phase 1's DIRECTION IS SUPERSEDED (2026-08-11).** This plan consolidated the
> code-execution surfaces **onto `run`**. The consolidation happened in the
> opposite direction: `run` and `check` were **retired** from the model surface
> (`0e7871de4`, plus the `3dbf7bca6` follow-up that moved poisoned-service retirement into `callRuntime`), and upstream **`eval` is the single code-execution
> tool** with `bash` owning the shell. Read Phase 1 below as a record of the
> alternative that was considered and rejected, not as an instruction. Its
> *invariants* survive the reversal and are the acceptance criteria for the
> surviving surface — see "Invariants" — but nothing here should be built.
>
> Why the reversal: `eval` (the 🐍/🟧 cell surfaces) already covered py/js
> one-shot execution; `check`'s analogue is `bash` plus diagnostics and it was
> measurably *slower* (project validation 2.08–3.37×); and `run`'s only genuine
> advantage — file + argv + stdin — arrives inside `eval` through the Tier 2
> `EmbeddedContextCall` carrier and its `mainScript` mode
> (`WHIPLASH_QUEUE.md:156-174`). One surface, one gate hierarchy, one telemetry
> path, without a second tool.

> **Superseding context (read first):** `docs/aura/ELIDE_ALIGNMENT.md`. omp's
> `src/eval/` already implements the persistent-kernel framework this plan's
> Phase 1 was going to build — session-scoped kernel ownership, owner-scoped
> disposal, host-callback bridges, streaming, display, cancellation, and a
> shared worker client, across four language families. The architecture and
> sequencing live in the alignment doc.

## What is left for M4

The tool-surface half of this plan is done. What remains, in the alignment doc's
sequencing rather than this one's:

1. **Settings collapse** — fold `runtime.*` and `python.{enabled,embedded,shell}`
   into the `eval.*` hierarchy plus one engine-selection key. User-visible
   migration; deliberately sequenced after the backend lands.
2. **`rb`/`jl`** — decide per language, on measured p50/p95, whether the opt-in
   Ruby/Julia kernels move to Elide, stay put, or are dropped.
3. **The Python engine question** — re-measure only against Tier 2 numbers; the
   ~25 ms embedded floor is per-call context construction, so a persistent
   context may change the answer entirely.
4. **A JVM `ExecutorBackend`** — `java`/`kotlin` on Elide contexts, which is how
   the 5.2× JVM execution win returns to the model after `run`'s retirement.

## Why

Phase 0 is **done** — the runtime arm now works (100% adoption, 24/24 trials,
zero errors). A clean 12-task paired run completed as
`rtbench1786400982708`; report at
`runs/harbor/_bench/rtbench1786400982708-runtime-comparison.md`.

**Pre-registered verdict: INCONCLUSIVE.**

| Metric | Bash | Runtime | Paired estimate |
|---|---:|---:|---|
| Pass rate | 100.0% | 100.0% | 0.000 pp [0.000, 0.000] |
| Errors | 0 | 0 | — |
| Input tokens | 1,322,954 | 1,315,048 | 1.015× [0.968, 1.065] |
| Duration | 1318.7 s | 1354.5 s | 1.036× [0.990, 1.083] |
| Tool calls | 151 | 138 | −8.6% |

Both CIs straddle 1.0. Effectiveness is **unmeasurable** with this task set:
both arms passed all 12 tasks, so the pass-rate CI is literally
[0.000, 0.000]. That is a task-difficulty ceiling, not evidence about the
runtime.

The per-task distribution is the real finding, and it is bimodal:

- **Wins:** typescript-execution 0.658×, cpu-sampling 0.810×,
  instrumentation 0.801×, project-build 0.922×, call-tracing 0.951×
- **Losses:** executable-jar 1.567×, bytecode-inspection 1.218×,
  jvm-dependencies 1.217×, project-validation 1.108×, python-execution 1.084×,
  java-execution 1.070×, runtime-debugging 1.064×

**The JVM group lost on all four tasks** — which contradicts the earlier
prediction that JVM would show the biggest wins, so do not carry that
assumption forward.

### The central contradiction that motivates this work

The deterministic microbenchmark puts **Java compile + run at 0.19×** — the
runtime is **5.2× faster** at the actual JVM work (409.94 ms → 78.20 ms) — yet
every JVM *agent* task costs more tokens. Meanwhile `−13` tool calls with flat
tokens says the runtime takes fewer, more expensive steps.

So the capability is excellent and the *interaction* is expensive. That is a
tool-surface problem, and it is what this plan addresses.

### Scope change: this is efficiency work, not a correctness fix

The first-tool gate question is **answered**. With a working runtime,
`jvm-dependencies` now goes `read → jvm_deps → bash → run` — it picks the
runtime tool *first*, where in the broken run it did `bash javac` before
`jvm_deps` and failed the gate. `bytecode-inspection` and `executable-jar` also
lead with runtime tools; only `java-execution` still goes bash-first.

**The 50% gate failure was the broken runtime, not surface ambiguity.**
Consolidation remains worth doing for token efficiency, one gate hierarchy, and
one telemetry path — but it is no longer urgent on correctness grounds, and
should be sequenced behind the engine work below, which targets the measured
cost directly.

## What went wrong with the last run (root cause, already diagnosed)

1. `bench:runtime` was invoked without `--embedded-lib`.
2. `packages/metaharness/src/runtime-benchmark.ts:237` gates **all** runtime
   injection on `if (opts.runtimeBinary || opts.embeddedLib)`. Both were
   undefined, so `AURA_RUNTIME_BIN`, `AURA_RUNTIME_EMBEDDED_LIB`, and
   `AURA_RUNTIME_ADAPTER=auto` were never passed into the task containers.
   Confirmed: the generated `omp-compose-overlay.yaml` mounts only `src`,
   `node_modules`, and `bin`, and is byte-identical between a failing arm and
   the working `typescript-execution` arm.
3. With no runtime present, `runtime.autoDownload` fired inside the container.
   `packages/coding-agent/src/runtime/provision.ts` downloaded the archive,
   the checksum passed (unconditional, against the pinned dist), then
   `tar -xJf` failed at line 212 → `"Runtime archive extraction failed."`
   **Confirmed:** the task image is `ubuntu:24.04` with only `python3`,
   `openjdk-17-jdk-headless`, and `ca-certificates` installed
   `--no-install-recommends` (see the task's `environment/Dockerfile`). It has
   `tar` but **no `xz`** binary, and GNU `tar -xJf` shells out to `xz`. Verified
   directly: `docker run --rm ubuntu:24.04 which xz unzip` → not found.
4. The agent filed grievances, fell back to `bash`, and the task passed.

Consequence: a 100% pass rate across every arm hid a completely non-functional
runtime, and the "+18% tokens" was the cost of failed calls, grievance writes,
and bash fallback — not tool-surface cost.

Failure counts per runtime arm (`"Runtime archive extraction failed"` hits):
`runtime-debugging` 163, `project-validation` 60, `project-build` 55,
`python-execution` 50, `typescript-execution` **0**, baseline arms **0**.

## Phase 0.5 — Engine sharing and JIT (do this BEFORE Phase 1)

The adapter microbenchmark finally ran (it needs `--embedded-lib`, which the
first run omitted). It shows the embedded adapter is a decisive win for
JS/TS and a **regression for Python**:

| Case | Process | Embedded | Speedup |
|---|---:|---:|---:|
| Warm JS startup | 15.87 ms p50 | 4.82 ms p50 | **3.29×** |
| Warm TS startup | 13.85 ms p50 | 5.98 ms p50 | **2.32×** |
| Cancellation latency | 2.95 ms p50 | 1.00 ms p50 | **2.96×** |
| JS compute | 29.06 ms p50 | 14.86 ms p50 | 1.96× |
| Warm Python startup | 16.46 ms p50 | 24.57 ms p50 | **0.67×** |
| Python compute | 56.20 ms p50 | 72.79 ms p50 | **0.77×** |

Python p95 is far worse than p50 (17.42 ms → **53.12 ms**), which is the
signature of per-call initialization rather than steady-state slowness.

The deterministic micro agrees that the runtime is *not* a general speedup —
Python startup 1.39×, TS startup 1.72×, Python compute 2.60×, TS compute 3.03×,
project validation 3.37× — with the advantage concentrated in JVM (0.19×) and
profiling (~1.0×).

### Root cause candidate: we never ask for a shared engine

`packages/coding-agent/src/runtime/embedded/codec.ts` (~line 148) calls
`._initEngineConfig()` and then **sets nothing on it**. Every field takes its
capnp default. From the generated schema
(`src/runtime/embedded/generated/engine.ts`):

- `EngineConfig.caching` — default **true** (`getBitMask(true, 0)`)
- `EngineConfig.shared` — "Whether to enable shared engine use", default
  **false** (`getBitMask(false, 1)`)
- `EngineConfig.flags` — never populated
- `EngineFlag` values: `UNKNOWN: 0`, `ENGINE_OPTIMIZED: 1`
  ("Enables the optimized engine (JIT-enabled)"), `ENGINE_ISOLATE: 2`,
  `ENGINE_EPSILON: 3` (disables GC)

So **shared engine use is off, and we are the ones leaving it off** — this is
not a WHIPLASH defect. `ENGINE_OPTIMIZED` is likewise never requested.

This is highly consistent with the measurements: with no shared engine, each
call plausibly rebuilds engine/context state, and GraalPy context init is far
more expensive than JS, so Python pays the most and shows a p95 tail.

### RESULTS (2026-08-10) — both hypotheses tested and rejected

`codec.ts` now writes `EngineConfig.shared` / `.caching` explicitly, gated by
`AURA_RUNTIME_ENGINE_SHARED` / `AURA_RUNTIME_ENGINE_CACHING` (defaults preserve
prior wire bytes). A 4-cell sweep was run against both an unmodified build and
a JIT-disabled rebuild (`1.4.3+2dbfa3d7d` → `1.4.3+6ada39daa`, native binary
415 MB → 270 MB, consistent with the Graal compiler being removed).

**1. `shared` and `caching` have no measurable effect.** In the quieter
JIT-off build, all four cells are identical within noise:

```
Warm Python startup, embedded p50:  25.12 / 25.29 / 25.13 / 25.30 ms
```

Same for every other case. Cell-to-cell variation seen in the JIT-on run was
noise. Either WHIPLASH does not honor these fields or they do not affect this
path — now the lead question in the WHIPLASH brief.

**2. Disabling JIT does not fix Python and costs JS/TS compute.** Comparing
*absolute embedded* times (ratios are unusable — `bin/elide` was rebuilt too,
so the process baseline moved):

| embedded p50 | JIT-ON | JIT-OFF | verdict |
|---|---:|---:|---|
| Warm Python startup | 26.17 ms | 25.12 ms | flat |
| Python compute | 71.92 ms | 74.86 ms | slightly worse |
| Warm JS startup | 4.49 ms | 4.18 ms | marginal gain |
| JS compute | 14.53 ms | 23.27 ms | **+60% worse** |
| TS compute | 15.77 ms | 19.38 ms | **+23% worse** |

The process adapter regressed badly too: Python startup 16.18 → 44.18 ms
(2.7× slower). **Python's apparent jump to 1.73× is baseline degradation, not
an embedded gain.** Classic JIT tradeoff — marginally faster startup, much
slower steady state. **Recommendation: JIT back ON.**

**3. The Python cost is invariant to every knob we control.** Embedded Python
holds a **~25 ms floor with a ~1.8–2.0× p95 tail** across JIT on/off,
`shared` on/off, and `caching` on/off. That is the signature of per-call
GraalPy context construction, not compilation or engine sharing.

### CLOSED (2026-08-10) — the engine fields are dead, not merely inert

The hypothesis is not just unmeasurable, it is **refuted at the source**. On the
WHIPLASH side, `EmbeddedCodec.kt` reads `engineConfig` for exactly one thing —
`directories.workingDir` — so `EngineConfig.shared`, `.caching`, and `.flags`
are never consulted on the embedded path at all. The flat 4-cell sweep above was
a correctly-measured no-op, not a benchmarking defect.

Aura-side consequence, already applied: `codec.ts` no longer writes those fields
(it leaves them at their capnp defaults, with a comment pointing back at this
section), and the `AURA_RUNTIME_ENGINE_SHARED` / `AURA_RUNTIME_ENGINE_CACHING`
experiment env vars are gone. The Elide-side follow-up — deprecate the fields in
the schema so no future integrator repeats this experiment, and document rather
than wire `ENGINE_OPTIMIZED` — is queued as **Item 2 (§2.1–2.2) in
`docs/aura/WHIPLASH_QUEUE.md`**, which is the authority on that work; do not
duplicate its detail here.

### Conclusion: go straight for persistent contexts

Nothing reachable from our side moves embedded Python, so the engine-flag path
is closed. The fix is **addressable persistent contexts** — Tier 2 in
`docs/aura/WHIPLASH_ENGINE_BRIEF.md`.

**The engine work is therefore blocked on WHIPLASH Tier 2.** The design goal is
a **drop-in replacement for today's Python and JS eval kernels**: re-point
`eval`'s backends at Elide-hosted contexts through the `ExecutorBackend` seam,
rather than reimplement kernel semantics. (The original text here said the
backends would be re-pointed at `run`; with `run` retired, the seam is
`eval/backend.ts` and the destination is an Elide `ExecutorBackend`.)

Methodology caveats for anyone re-running: the host is noisy (process Python
p50 swung 16→55 ms across cells in one run), and cold-open numbers are
confounded by ordering whenever several configurations share one process.

The `bench-engine-matrix.ts` sweep harness is **dropped** — it existed to sweep
`shared` × `caching`, and that hypothesis is dead (see CLOSED above), so there
is nothing left for it to vary. The surviving invocation for adapter latency is:

```bash
bun run bench:runtime --micro-only --micro-iterations 15 --prefix=<label> \
  --embedded-lib=out/aura-elide-linux-x64/lib/libelide_embed.so
```

Run one configuration per process, and prefer absolute embedded times over
process-relative ratios — the process baseline moves whenever `bin/elide` is
rebuilt, which is what made the JIT-off ratios unusable above.

Two preflight behaviors to expect. The runtime arm now **hard-fails** its
preflight when the runtime artifacts are unreachable, rather than quietly
measuring the bash fallback — pass `--allow-missing-runtime` to downgrade that
abort to a warning, and only when bash fallback is what you meant to measure.
The micro phase likewise requires a runtime already resolvable on the host and
never auto-downloads one (a fetched release would report numbers for a
different binary than the agent arms measure), so pass `--embedded-lib` to point
it at the packaged binary under test.

## Phase 0 — Make the runtime arm measurable (prerequisite, COMPLETE)

### 0.1 Answer to "what path do I pass to `--embedded-lib`?"

`sourceMountedRuntimePath()` (`runtime-benchmark.ts:202-208`) **requires the
artifact to be inside the repo**, because the container only bind-mounts the
repo at `/opt/omp/src`. A path under `~/.aura/...` throws
`"Runtime benchmark artifact must be inside the source-mounted repository"`.
A symlink does not work either — the target would not resolve inside the
container.

`build:runtime-bundle` already produced exactly what is needed, in-repo, at
`out/aura-elide-linux-x64/` (2.7 GB). `out/` is gitignored (`.gitignore:93`),
so **no copy is required** — use it directly:

```bash
bun run bench:runtime \
  --gateway-url=http://172.17.0.1:4000 \
  --embedded-lib=out/aura-elide-linux-x64/lib/libelide_embed.so
```

That satisfies every constraint: repo-interior (so `sourceMountedRuntimePath`
accepts it and it lands at `/opt/omp/src/out/...` in the container),
`lib/libelide_embed.so` present (21 KB), and the sibling `bin/elide` (415 MB)
that `packagedRuntimeBinaryForLibrary()` derives as `dirname(lib)/../bin/elide`.

Always point at the library inside a *complete* distribution tree — the 21 KB
embed library depends on the surrounding `lib/*.so`, `conf/`, and `bin/`.

**Pre-verified on 2026-08-10 with this exact artifact:**

- `aura runtime --json` → `available: true`, `effectiveAdapter: "embedded"`,
  ABI v1, Elide `1.4.3+2dbfa3d7d`.
- `test/runtime-integration.test.ts` + `test/runtime-embedded-integration.test.ts`
  with `AURA_RUNTIME_EMBEDDED_LIB` set → **26 pass, 0 fail** (real Python and
  JVM execution through both the embedded and process adapters).
- Container compatibility: `docker run --rm -v <repo>:/opt/omp/src:ro
  ubuntu:24.04 /opt/omp/src/out/aura-elide-linux-x64/bin/elide --version` →
  `1.4.3+2dbfa3d7d`. Host glibc 2.42 → image glibc 2.39 is fine.

So the artifacts are known-good on the host *and* in the task image; the only
thing that was ever missing is the `--embedded-lib` flag.

Gateway/broker must be up first; `--gateway-url` must be an address containers
can reach. On this host `172.17.0.1:4000` works and the default
`127.0.0.1:4000` does **not**. See `docs/auth-broker-gateway.md`.

### 0.2 Fix the silent-degradation trap (do this, or it recurs)

- **Hard-fail the runtime arm when no runtime is reachable.** Today a
  misconfigured run silently measures bash fallback and reports 100% pass.
  Add a preflight to `runtime-benchmark.ts` that probes the runtime *inside a
  task container* and aborts the run if the runtime arm cannot execute. The
  existing `smokeTypeScriptTaskVerifier` gate (line 1490) is the natural place
  to hang it, but note it must test a *non-JS* language — TypeScript passes via
  the Bun adapter even when the packaged runtime is entirely absent, which is
  precisely why this bug survived.
- **Force `runtime.autoDownload=false` in benchmark containers.** A benchmark
  should never reach for the network to acquire its subject.
- **Stop swallowing error detail.** `provision.ts:214` attaches `argv` and
  `stderr` to the `RuntimeRpcError`, but the tool result arrives at the model
  as `"details":{}` with the bare string `"Runtime archive extraction failed."`
  Neither the agent nor the operator got anything actionable. Propagate the
  detail (redacted as needed) through the tool boundary.
- ~~**Correct the `runtime-benchmark.ts` row in `docs/aura/FORK.md`.**~~
  **Done (this commit).** It claimed the benchmark "injects repository-packaged
  process and embedded runtime artifacts into source-mounted task containers"
  unconditionally; it only does so when `--embedded-lib` is supplied.
- **Optional, avoids a 3.4 GB copy:** teach the overlay generator to mount an
  external runtime dir and map it to a container path, instead of requiring the
  artifact to live inside the repo.

### 0.3 Re-baseline

With 0.1 + 0.2 in place, re-run both benchmarks and record the numbers as the
real pre-consolidation baseline. Everything in Phase 1 is judged against that,
not against the contaminated run.

## Phase 1 — Consolidate onto `run` (SUPERSEDED — historical)

> Everything in this section describes the **rejected** direction. It is kept
> because the invariants below outlived it and are still binding. See the
> superseding note at the top of this file.

### Surface then, and now

| Surface | Where | Semantics | Status |
|---|---|---|---|
| `bash` | `tools/bash.ts` | shell | unchanged — owns the shell |
| `eval` | `tools/eval.ts` | **stateful kernels**, `language: 'py'\|'js'\|'rb'\|'jl'` | unchanged — now the **only** code-execution tool |
| `run` | `tools/runtime-run.ts` (fork) | **one-shot** execution via the runtime | **RETIRED** (`0e7871de4`); file/argv/stdin returns as an `eval` mode via the Tier 2 carrier |
| `check` | fork | validation only | **RETIRED** (`0e7871de4`); `bash` + diagnostics, and it was 2.08–3.37× slower |
| `$` / `$$` | `modes/controllers/input-controller.ts` | local Python actions | now execute in the **shared CPython kernel** — the same one `eval`'s `py` backend uses (`08c50efd8`), so a `$` cell and an `eval` cell see the same names |

`eval` gates live in `tools/eval-backends.ts`: `eval.py`/`eval.js` default on,
`eval.rb`/`eval.jl` opt-in, with `PI_PY`/`PI_JS`/`PI_RB`/`PI_JL` env overrides,
and `isPythonEnabled()` acting as an umbrella that `PI_PY` can narrow but not
re-enable. The surviving seven fork tools still gate separately under `runtime.*`
and `python.enabled`/`python.embedded`/`python.shell`
(`config/settings-schema.ts`, FORK.md rows 27 and 31) — collapsing those two
hierarchies is the remaining M4 item, and it is now a *settings* problem rather
than a tool-surface one.

"Execute some code" is now reachable one way. That was the thing to collapse.

### Target (as originally written — NOT the shipped design)

1. ~~**`run` becomes the single code-execution tool.**~~ **Inverted:** `eval` is,
   and `run` is gone.
2. **Elide backs the persistent kernel.** Still the target, but as an
   `ExecutorBackend` *behind* `eval` (JS/TS first), not as a `run` rewrite.
3. ~~**Drop the duplicate surface** by removing `eval`.~~ **Inverted:** the
   duplicate surface dropped was `run`/`check`.
4. **One gate hierarchy.** Still open — but collapsing toward `eval.*`, not
   toward `runtime.*` + `python.*`.

### Invariants — do not regress these

These were written as constraints on a `run`-absorbs-`eval` merge. They read
just as well as constraints on the surface that actually survived: `eval` had to
already satisfy every one of them for the retirement to be safe, and it does.

- **`eval` is stateful; `run` is one-shot.** `eval.ts:93` — "State persists
  within a language across calls" — and it exposes `reset?` to wipe a single
  language's kernel while leaving others untouched. If `run` absorbs `eval`
  without gaining session-persistent kernel semantics and a per-language reset,
  this is a capability regression wearing a simplification costume. Design the
  persistence model *first*.
- `user_python` hooks, session history, exclusion semantics, and cancellation
  ownership must survive (FORK.md row 31).
- `PI_PY` may narrow Python but must never bypass the `python.enabled` parent.
- Disabled backends must stay absent from the wire schema, the BM25 discovery
  corpus, and tool descriptions — `eval.ts:108-110` narrows the schema per
  session today; whatever replaces it must do the same, not just reject at
  dispatch.
- `rb`/`jl` are opt-in persistent kernels. Decide explicitly whether they move
  to Elide, stay on the old path, or get dropped — do not leave this implicit.
- Keep `bash` uninterceptable for direct runtime-binary commands
  (FORK.md row 29).

### Verification

- Unit/contract tests for the merged surface, including a case pinning that a
  persistent session survives across calls and that `reset` scopes to one
  language.
- `bun run check:ts` clean and the TS suite green (the fork's merge gate).
- Re-run `bench:inherent` and `bench:runtime` against the Phase 0 baseline. The
  hypothesis to test: consolidation raises "correct runtime tool selected
  first" toward 100% and does not regress tokens on tasks where the runtime
  already wins.
- Watch `typescript-execution` specifically — it is the only task with a clean
  pre-consolidation measurement (−41.5% tokens), so it is the best regression
  canary.

## Open questions

1. ~~Does the first-tool gate failure survive Phase 0?~~ **Answered: no.** A
   working runtime fixed it (`jvm-dependencies` now calls `jvm_deps` before
   `bash`). Consolidation is efficiency/code-health work. Only
   `java-execution` still leads with `bash` — worth one trace read to see why.
2. ~~What is the persistence model for `run`?~~ **Moot — `run` is retired.** The
   live form of the question is how an Elide-backed `eval` context is addressed.
   **Decided in principle:** go straight for persistent contexts and make them a
   drop-in replacement for the current Python and JS eval kernels. The remaining
   decision is how Aura addresses a context (session id vs. implicit
   per-session-per-language), which should follow whatever WHIPLASH's Tier 2
   surface makes natural. Blocked on that.
3. Do `rb`/`jl` follow onto Elide? Evidence says do not assume: embedded is
   2–3× faster than process for JS/TS but never beats process for Python
   (~25 ms floor vs 16–18 ms). Decide per language on measured p50/p95, and
   re-measure once Tier 2 lands — a persistent context may change the Python
   answer entirely, since its cost is per-call construction.
5. ~~Is `EngineConfig.shared`/`caching` honored by WHIPLASH at all? We now send
   both explicitly and observe no effect.~~ **Answered:** dead fields — never
   read on the embedded path (`EmbeddedCodec.kt` consults `engineConfig` only
   for `directories.workingDir`); deprecate-and-document queued in
   `WHIPLASH_QUEUE.md` (Item 2, §2.1). Aura has stopped sending them.
4. Why does the JVM group lose tokens when the underlying JVM execution is 5.2×
   faster? This is the highest-value question in the plan. Candidates: verbose
   `jvm_*` tool schemas, results that need a second `bash` call to interpret
   (all four JVM tasks still call `bash` *after* the runtime tool), or output
   formatting that costs more context than `javac`/`jdeps` output would.
4. Should the task images simply gain `xz-utils`? The image genuinely lacks the
   `xz` binary, so adding it would make the auto-download path *work* — which is
   arguably the wrong outcome for a benchmark (it should use the injected
   artifact under test, not fetch one over the network mid-run). Preference:
   force `autoDownload=false` and hard-fail instead, and add `xz-utils` only if
   some non-benchmark path legitimately needs in-container provisioning.

## Reference

- Grievance data: the agent filed `report_issue` entries via `xd://report_issue`
  in the failing trials. Note `dev.autoqaPush.endpoint` ships empty
  (FORK.md row 28), so grievances queue locally *inside the container* and may
  not survive unless persisted to `artifacts/`. The trial transcripts at
  `runs/harbor/<arm>/<trial>/agent/omp.txt` (JSONL event stream) are the
  reliable source. Sam has a way to fetch the grievance DB — ask.
- Contaminated run for reference only: `runs/harbor/_bench/rtbench1786396014520-runtime-manifest.json`
  (12 tasks, 2 attempts, `openai-codex/gpt-5.6-sol`, thinking `xhigh`).
- Inherent report: `runs/harbor/_bench/inherent-smoke-inherent-capabilities.md`.
