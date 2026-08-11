# Aura ↔ Elide alignment: collapse the fork's runtime onto omp's kernel architecture

Status: proposal. Written 2026-08-10 after the post-merge runtime benchmark and
two rounds of engine measurement.

Companions: `ACTIONS_CONSOLIDATE.md` (the tool-surface plan),
`WHIPLASH_ENGINE_BRIEF.md` (the Elide-side ask), `FORK.md` (fork inventory),
`WHIPLASH_QUEUE.md` (the queued Elide-side work, batched for build).

## Thesis

**omp already has the architecture the fork rebuilt.** `packages/coding-agent/src/eval/`
is a generalized, multi-language persistent-kernel framework — session-scoped
kernel ownership, owner-scoped disposal, host-callback bridges, streaming
output, rich display, cooperative cancellation, and a shared worker client —
already carrying four language families (`py`, `js`, `rb`, `jl`).

The fork's `src/runtime/` implements a parallel stack for the same concerns and
threads a bespoke ownership object (`runtimeServiceScope`) through 15+ call
sites. That is the cruft.

**Target: Elide becomes a first-class runtime *behind* omp's existing
abstractions, not a second execution stack beside them.** The fork keeps only
what omp genuinely lacks.

## What omp already provides (verified)

| Concern | omp implementation |
|---|---|
| Pluggable language backend | `eval/backend.ts` — `ExecutorBackend` (a backend is ~45 lines, see `eval/js/index.ts`) |
| Session-scoped kernel lifecycle | `eval/kernel-session-registry.ts` — `createKernelSessionRegistry<…>()`, owner-scoped session keys |
| Owner-scoped disposal | `eval/js/context-manager.ts` — `disposeVmContextsByOwner(ownerId)`, `disposeAllVmContexts()` |
| Persistent context + reset | `executeInVmContext()`, `resetVmContext(sessionKey)` |
| Shared worker client | `subprocess/worker-client.ts` — `createWorkerHandle`, `createWorkerSubprocess`, `RefCountedWorkerHandle`, `resolveWorkerSpawnCmd`, `workerEnvFromParent` |
| Canonical worker host re-entry | `workerHostEntry()` from `pi-utils` |
| Host callbacks from guest code | `eval/{agent,budget,completion,concurrency}-bridge.ts`, `eval/py/tool-bridge.ts`, `eval/js/tool-bridge.ts` |
| Streaming output mid-cell | `ExecutorBackendExecOptions.onChunk` / `onStatus` |
| Timeout control hand-off | `eval/bridge-timeout.ts` (`EVAL_TIMEOUT_PAUSE_OP` / `RESUME_OP`), `eval/idle-timeout.ts` |
| Rich display outputs | `EvalDisplayOutput`, `eval/py/display.ts` |
| Kernel ownership identity | `session.getEvalKernelOwnerId()`, `kernelOwnerId` threaded by the framework |

Note the shape collision: the fork's `runtime/embedded/{worker-core,worker-entry,worker-protocol}.ts`
mirrors omp's `eval/js/{worker-core,worker-entry,worker-protocol}.ts` file-for-file
in concept. Two solutions to one problem.

## Candidates to collapse

Verify each individually — these are equivalences to confirm, not assumed
identities.

| Fork construct | omp equivalent to adopt |
|---|---|
| `runtimeServiceScope` in `sdk.ts`, `session/agent-session*.ts`, `task/{executor,structured-subagent,persisted-revive}.ts`, `modes/controllers/{tan-command,selector}-controller.ts`, `modes/components/agent-dashboard.ts`, `commit/agentic/{agent,tools/index,tools/analyze-file}.ts`, `vibe/runtime.ts` | `session.getEvalKernelOwnerId()` + `disposeVmContextsByOwner()`; the framework carries `kernelOwnerId`, so no per-session object needs threading |
| `acquireRuntimeServiceLease` + last-release disposal | `RefCountedWorkerHandle` (`subprocess/worker-client.ts`) |
| `runtime/index.ts` selected-service cache, atomic swap/retirement | `createKernelSessionRegistry` |
| `runtime/embedded/{worker-core,worker-entry,control-worker-entry,worker-protocol}.ts` | `createWorkerHandle` / `createWorkerSubprocess` + the `eval/js` worker pattern |
| `runtime.*` and `python.{enabled,embedded,shell}` settings tree | `eval.*` gates (`eval.py`, `eval.js`, …) plus one engine-selection key |
| Fork runtime telemetry publishers | omp's eval telemetry path |
| `tools/eval-backends.ts` fork gate helpers | fold into the single `eval.*` hierarchy |

Deleting the scope plumbing alone removes fork edits from ~12 files, each of
which is a recurring merge-conflict site (this merge hit `sdk.ts`,
`agent-session.ts`, and `persisted-revive.ts` for exactly this reason).

## What must stay fork-owned

omp's `eval` is **cell-oriented** (`execute(code, opts)`). These are genuinely
absent upstream and should remain, slimmed:

- **One-shot program execution** — `run` takes a file path, argv, stdin, cwd
  (`EmbeddedRunInvocation` in `runtime/embedded/codec.ts`). `eval` has no
  file-execution or argv concept.
- **JVM tooling** — `jvm_disassemble`, `jvm_format`, `jvm_jar`, `jvm_deps`, and
  Java/Kotlin compile+run. No upstream analogue, and the strongest measured
  Elide win (Java compile+run **0.19×**, i.e. 5.2× faster).
- **`check`** — validation-only.
- **`serve`** — hub-supervised launch.
- **`insights` / `profile`** — profiling surfaces (measured wins:
  cpu-sampling 0.810×, instrumentation 0.801×).
- The **Cap'n Proto embedded ABI** itself, plus the checked-in schema closure
  and its drift check.

## Target architecture

Three seams, from lowest to highest.

### Seam 1 — Elide as an engine, not a stack

Elide's embedded library is a *transport* that omp's kernel framework can drive,
alongside "spawn CPython" and "spawn a Bun Worker". Concretely: keep
`runtime/transport/*` and the ABI; retire the fork's bespoke worker host and
ownership cache in favor of `subprocess/worker-client.ts` +
`createKernelSessionRegistry`.

### Seam 2 — Elide languages as `ExecutorBackend`s

Persistent/REPL execution routes through omp's `eval` tool. An Elide backend is
the same ~45-line shape as `eval/js/index.ts`, and inherits bridges, streaming,
display, cancellation, and ownership for free.

**This is what makes the WHIPLASH ask much smaller** — see "Revised Elide ask".

### Seam 3 — one-shot and tooling stay as tools

`run`, `check`, JVM tools, `serve`, `insights`, `profile` remain fork tools, but
share Seam 1's transport and Seam 2's lifecycle rather than owning a parallel
cache. This also resolves the duplicate-surface problem in
`ACTIONS_CONSOLIDATE.md`: `eval` owns *stateful cells*, `run` owns *one-shot
programs*, and the overlap (py/js one-liners) collapses into `eval`.

## An honest correction to "drop-in replace Python and JS"

Our own measurements argue for doing **JS/TS first and leaving Python on
CPython for now**:

| Case | Process | Embedded Elide | |
|---|---:|---:|---|
| Warm JS startup | 15.31 ms | 4.49 ms | **3.41× faster** |
| Warm TS startup | 14.34 ms | 4.76 ms | **3.01× faster** |
| JS compute | 28.97 ms | 14.53 ms | 1.99× faster |
| Warm Python startup | 16.18 ms | 26.17 ms | **0.62× — slower** |
| Python compute | 55.61 ms | 71.92 ms | **0.77× — slower** |

Embedded Elide has never beaten a CPython subprocess on Python in any
configuration we tested (JIT on/off, `shared` on/off, `caching` on/off);
Python sits on a ~25 ms floor with a ~2× p95 tail.

### Spike: does omp's Python kernel run on GraalPy? (2026-08-10)

An earlier draft of this doc claimed omp's `py` kernel is IPython-based and that
GraalPy's IPython support was the risk. **That was wrong.** `runner.py:21` states
it explicitly: *"The runner is intentionally self-contained: no third-party
imports, no IPython."* It emulates IPython-style magics and display semantics
itself, in pure stdlib. There is no IPython dependency to break.

What the spike actually found, running against
`out/aura-elide-linux-x64/bin/elide` (GraalPy **3.12.8**):

**Good — stdlib coverage is complete.** All 30 modules `runner.py` and
`prelude.py` import (`ast`, `asyncio`, `contextvars`, `runpy`, `signal`,
`subprocess`, `threading`, `concurrent.futures`, `urllib.*`, …) import cleanly:
30/30.

**Blocker 1 (papercut): `os.getppid()` is unsupported.**
`UnsupportedOperation: Feature not supported on 'java' POSIX backend: getppid`,
raised from `_start_parent_watchdog()`. GraalPy reports `os.name == "posix"` but
lacks `getppid`, so the watchdog's existing non-POSIX early-return does not
trigger. A one-line capability guard fixes it on our side.

**Blocker 2 (the real wall): guest threads are blocked by JS sharing the
context.** `elide run` denies thread creation by default
(`IllegalStateException: Creating threads is not allowed`). Elide *does* have
`--allow-threads` ("Permit guest code to create host threads … Needed by guest
features that spawn real threads"), and with it the sandbox check passes — but
then:

```
IllegalStateException: Multi threaded access requested by thread
Thread[#95,Polyglot-python-0,…] but is not allowed for language(s) js.
```

The context is polyglot with JavaScript resident, and GraalJS is
single-threaded, so Python's threads are refused. omp's runner is
fundamentally threaded — a stdin reader thread, a stdout capture-drain thread,
and the parent watchdog, on top of an asyncio loop — so this is not
avoidable by minor edits.

Note the failure is a **Java** `IllegalStateException`, not a Python exception:
guest code cannot catch or degrade around it, and it terminates the run.

There is no CLI way to get a Python-only context — `-l/--language` is documented
for inline snippets only, and no flag scopes the languages of a file run.

**Conclusion.** The obstacle is not CPython compatibility, which looks good. It
is that Elide's context is polyglot-with-JS and therefore single-threaded. This
maps directly onto the Tier 2 ask: **language-scoped contexts would let a Python
context permit threads.** Until that exists, omp's Python kernel cannot run on
Elide, which independently confirms the recommendation to keep CPython for `py`
and lead with JS/TS.

**Recommendation:** make the engine a per-language choice with a config key.
Ship Elide as the JS/TS engine (clear 3× win, and it removes a Bun-Worker
dependency), keep CPython for `py`, and re-evaluate Python only if Tier 2
persistent contexts move that ~25 ms floor. Design the seam so flipping Python
later is a settings change, not a rewrite.

## Revised Elide ask (supersedes most of WHIPLASH_ENGINE_BRIEF.md)

Because omp's framework already owns bridges, streaming, display, timeout
hand-off, and cancellation semantics on the *host* side, Elide does **not** need
to provide them. The ask narrows to:

1. **Persistent, addressable, LANGUAGE-SCOPED contexts** — open / call /
   reset-preserving-warmth / close, several alive concurrently, errors returned
   as values without poisoning the context. **Language scoping is load-bearing,
   not cosmetic:** a Python context that also has JavaScript resident inherits
   GraalJS's single-threaded constraint and cannot create threads, which is what
   blocks omp's Python kernel today (see the spike above). A Python-only context
   must be able to permit host threads.
1b. **Thread creation for embedded contexts.** The CLI has `--allow-threads`;
   the embedded ABI needs the equivalent, expressed per context. Also note the
   denial surfaces as a Java `IllegalStateException`, which guest code cannot
   catch — a Python-level error would let kernels degrade gracefully.
1c. **`os.getppid()` on the `java` POSIX backend** — either support it, or
   confirm it will stay unsupported so we guard it host-side. GraalPy currently
   reports `os.name == "posix"` while lacking it, which defeats the usual
   capability check.
2. **Guest→host callability during a call**, so omp's existing tool-bridge can
   be wired in. Aura supplies the bridge; Elide must permit the call-out.
3. **Incremental output** during a call, so `onChunk` can be satisfied without
   buffering to completion.
4. **Cancellation that aborts the current call and leaves the context alive**
   (Ctrl-C semantics), driven externally — Elide must not impose its own cell
   deadline.
5. Answers to: are `EngineConfig.shared`/`.caching` honored at all; what does a
   runtime handle map to; what does `ENGINE_OPTIMIZED` actually do.

Dropped from the earlier ask: rich-display transport and timeout-control
signalling as *Elide* features — omp already implements both host-side.

## Sequencing

1. **Verify the equivalences** in the collapse table (spike, no deletion yet).
   The riskiest is `runtimeServiceScope` → `kernelOwnerId`: confirm owner-scoped
   disposal covers subagents, vibe workers, and the commit agent, which are why
   the fork threaded a scope object in the first place.
2. **Adopt `subprocess/worker-client.ts`** in the embedded host; delete the
   fork's bespoke worker plumbing. Self-contained, immediately reduces merge
   surface.
3. **Add an Elide `ExecutorBackend` for JS/TS**, behind a settings key,
   defaulting off. Measure against the Bun-Worker path.
4. **Retire `runtimeServiceScope`** once 1–3 hold; drop the fork edits from the
   ~12 threading sites and update `FORK.md`.
5. **Collapse the settings tree** into `eval.*` + one engine key.
6. **Revisit Python** only against Tier 2 numbers.

Gate every step on `bun run check:ts` + the TS suite (the fork's merge gate),
and re-run the model-free adapter sweep for 2–3.

### Equivalence matrix (verified 2026-08-10)

Step 1's output. Every verdict below is backed by a pinning test that fails when
the claim stops being true — not by reading the code. Verdicts:

- **`equivalent`** — the omp construct demonstrably does the fork construct's job
  on every path the fork threads its own object through.
- **`equivalent + gap: …`** — equivalent for the named scope, with the residue
  spelled out.
- **`fork-owned, stays`** — nothing upstream to collapse onto.
- **`deferred`** — out of scope for step 1; no pin yet, so no verdict claimed.

Pinning tests (paths relative to the repo root):

- **[A]** `packages/coding-agent/test/eval/kernel-owner-disposal-coverage.test.ts`
- **[B]** `packages/coding-agent/test/eval/kernel-owner-session-paths.test.ts`

| Fork construct | omp equivalent | Verdict | Pinning test |
|---|---|---|---|
| `runtimeServiceScope` threaded through `sdk.ts`, `session/agent-session*.ts`, `task/*`, `modes/**`, `commit/agentic/*`, `vibe/runtime.ts` | `session.getEvalKernelOwnerId()` + owner-scoped disposal; the framework carries `kernelOwnerId` | `equivalent` — ownership resolves from the owner id alone on every threading path: an inherited `parentEvalSessionId` shares one kernel session while each session mints its own `agent-session:<snowflake>` owner (one kernel, N owners), and every disposer is called with exactly that owner and nothing else | [B] (identity across child sessions, structured subagents, vibe workers, the commit agent) + [A] (`EvalRunner.disposeKernels` fan-out, exact arity, no global sweeps) |
| `acquireRuntimeServiceLease` + last-release disposal | Owner registration in `eval/js/context-manager.ts`; `RefCountedWorkerHandle` (`subprocess/worker-client.ts`) | `equivalent` — a co-owned context survives every owner but the last, which is the whole semantic the lease provides | [A] "keeps a co-owned context alive until its last owner is disposed" (real JS worker, no mocks) |
| `runtime/index.ts` selected-service cache, atomic swap/retirement | `createKernelSessionRegistry` | `equivalent + gap: kernel lifecycles only.` The owner-keyed session registry covers per-session kernel creation/reuse/disposal. The runtime **service** cache (selecting and atomically retiring an engine) is an orthogonal concern these pins say nothing about; it is in scope at milestone 2, not here | [A] + [B] cover the kernel-lifecycle half; the service cache has **no pin yet** |
| `runtime/embedded/{worker-core,worker-entry,control-worker-entry,worker-protocol}.ts` | `createWorkerHandle` / `createWorkerSubprocess` + the `eval/js` worker pattern | `fork-owned, stays` — the `worker_threads` embedded host is a genuine variant of the shared client, not a duplicate of it. What collapses is the duplicated plumbing around it, deleted in Tasks 6–8 | n/a — behavior change, gated by the embedded suites |
| `runtime.*` and `python.{enabled,embedded,shell}` settings tree | `eval.*` gates plus one engine-selection key | `deferred` to milestone 2/4 — a settings collapse is a user-visible migration, sequenced after the backend lands | none |
| Fork runtime telemetry publishers | omp's eval telemetry path | `fork-owned, stays` | n/a |
| `tools/eval-backends.ts` fork gate helpers | fold into the single `eval.*` hierarchy | `fork-owned, stays` — the fork edit stays until the settings collapse above happens | n/a |

Two findings of record from the pinning work, both narrower than the obvious
reading of row 1:

1. **The startup-failure disposer set is a *superset* of `EvalRunner`'s fan-out,
   not the same set.** `createAgentSession`'s startup-failure cleanup also calls
   `releaseComputerSessionsForOwner(evalKernelOwnerId)`, which
   `EvalRunner.disposeKernels()` does not — normal teardown reaps computer
   sessions through `AgentSession`'s `#releaseOwnedComputerSessions` instead.
   [A] pins **containment** in the direction the deletion needs (every
   `disposeKernels` backend is also registered on the startup-failure path), not
   set equality. Milestone 2 must not assume the two lists are interchangeable.
2. **The commit agent's owner id is inert.** It builds its session with
   `toolNames: ["__none__"]` and custom tools only, so no built-in `eval` tool is
   ever constructed and the `agent-session:*` owner it mints never owns a kernel
   — owner-scoped disposal is a no-op for it. (`eval` is not among the built-ins
   `createTools` force-includes into an explicit whitelist, so this holds under
   any settings; under default settings the whitelist yields no built-ins at
   all, but `autolearn.enabled` would add `manage_skill` — never `eval`.) It
   appears in the `runtimeServiceScope` threading list only because the fork's
   scope object is also the runtime-service handle; on the `kernelOwnerId` side
   there is nothing to carry. Pinned in [B] both as the constructed config and
   as the resulting tool set (with an `["eval"]` control arm proving the absence
   is real, not an environment artifact).

## Why this is worth doing beyond tidiness

The JVM tasks lost 1.07–1.57× on tokens while Elide's JVM execution is 5.2×
*faster* — the cost is interaction, not capability. Collapsing onto one
execution surface with one set of gates and one telemetry path is the most
direct attack on that gap, and it shrinks `FORK.md` by ~15 rows of
merge-conflict surface at the same time.
