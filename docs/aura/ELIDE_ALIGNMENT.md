# Aura ↔ Elide alignment: collapse the fork's runtime onto omp's kernel architecture

Status: proposal. Written 2026-08-10 after the post-merge runtime benchmark and
two rounds of engine measurement. Amended 2026-08-11: `run` and `check` are
**retired** from the model surface (`0e7871de4`, `3dbf7bca6`), so "What must
stay fork-owned", Seam 3, and the M4 outline now describe a seven-tool fork
surface with `eval` as the single code-execution tool.

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

**Code execution is not on this list.** `run` and `check` were retired from the
model surface (commits `0e7871de4`, `3dbf7bca6`); upstream `eval` owns code
execution semantics and `bash` owns the shell. Earlier drafts of this section
argued the opposite — that `run`'s one-shot/file/argv shape was genuinely absent
upstream and had to stay — and that argument is superseded twice over:

- **`check` was never a measured win.** Its analogue is `bash` plus the
  diagnostics tools, and project validation measured **2.08–3.37× slower** than
  direct invocation in both micro sweeps.
- **`run`'s file+argv shape is a Tier 2 gap, not a permanent one.**
  `EmbeddedContextCall` carries `source :union { code | file }`, `args`,
  `stdin`, and an `EmbeddedEvalMode.mainScript` entrypoint mode
  (`WHIPLASH_QUEUE.md:156-174`, item J). That carrier is **the** path for file
  execution through `eval`; it is what makes a separate one-shot tool
  unnecessary rather than merely undesirable. (The fork's own
  `EmbeddedRunInvocation` in `runtime/embedded/codec.ts` carries the same
  four fields and stays as the transport-level shape behind the surviving
  tools.)

What genuinely has no upstream analogue, and stays:

- **JVM tooling** — `jvm_disassemble`, `jvm_format`, `jvm_jar`, `jvm_deps`.
- **`serve`** — hub-supervised launch.
- **`insights` / `profile`** — profiling surfaces (measured wins:
  cpu-sampling 0.810×, instrumentation 0.801×; `insights` pending re-baseline
  after a 3.71× overhead reading in the noisy m1-post micro).
- The **Cap'n Proto embedded ABI** itself, plus the checked-in schema closure
  and its drift check.

That is **seven** built-in tools (`BUILTIN_TOOL_NAMES` in
`packages/coding-agent/src/tools/builtin-names.ts`), all `discoverable`, all on
the `runtime.enabled` gate.

Two directions of travel for that list, neither of them this milestone's work:

- **JVM one-shots come back through `eval`, not through a tool.** Java/Kotlin
  compile+run is the strongest measured Elide win (**0.19×**, i.e. 5.2× faster)
  and it left the model surface with `run`. It returns as a `java`/`kotlin`
  `ExecutorBackend` on Elide contexts — the same ~45-line shape as
  `eval/js/index.ts` — so the win is recovered inside `eval` rather than by
  reviving a second execution tool.
- **The four JVM analysis tools consolidate toward one `jvm` tool** with an
  action union (`disassemble` | `format` | `jar` | `deps`), and jar *inspection*
  folds into `read`. Direction only: the consolidation is a later task, and
  nothing here should be built as though it had already happened.

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

### Seam 3 — tooling stays as tools; execution does not

The four JVM analysis tools, `serve`, `insights`, and `profile` remain fork
tools, but share Seam 1's transport and Seam 2's lifecycle rather than owning a
parallel cache.

The duplicate-surface problem in `ACTIONS_CONSOLIDATE.md` is resolved by
**deletion, not division**. The earlier answer was "`eval` owns stateful cells,
`run` owns one-shot programs, and the py/js overlap collapses into `eval`" — two
tools with a boundary the model had to learn. The shipped answer is one tool:
`eval` owns code execution, `bash` owns the shell, and the surviving fork tools
are analysis and supervision surfaces that never execute user-supplied programs.
File execution reaches `eval` through the Tier 2 carrier (see "What must stay
fork-owned"), so the one-shot case is a *mode* of the execution tool rather than
a second tool.

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

Step 1's output. Every `equivalent` verdict below is backed by a pinning test
that fails when the claim stops being true — not by reading the code; rows with
an empty pin column carry no verified claim, and any residue inside an
`equivalent` row is named in its own verdict cell. Verdicts:

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
| `runtimeServiceScope` threaded through `sdk.ts`, `session/agent-session*.ts`, `task/*`, `modes/**`, `commit/agentic/*`, `vibe/runtime.ts` | `session.getEvalKernelOwnerId()` + owner-scoped disposal; the framework carries `kernelOwnerId` | `equivalent + gap: the three intermediate forwarding hops are read-verified, not pinned.` Ownership resolves from the owner id alone at both ends of every threading path: an inherited `parentEvalSessionId` shares one kernel session while each session mints its own `agent-session:<snowflake>` owner (one kernel, N owners), and every disposer is called with exactly that owner and nothing else. [B] pins the **producers** (`structured-subagent.ts`, `vibe/runtime.ts` → `ExecutorOptions`) and the **consumer** (`AgentSession` config → shared kernel + fresh owner); it does **not** pin the wire between them — (1) `task/executor.ts:3073`'s forward of `parentEvalSessionId` into the child `createAgentSession`, (2) `sdk.ts:3491`'s forward of it into the `AgentSession` config, and (3) `sdk.ts:1750-1751`'s `getEvalSessionId: () => session?.getEvalSessionId() ?? options.parentEvalSessionId ?? defaultEvalSessionId(...)` fallback. **Nested inheritance flows through hop 2, not hop 3.** Hop 3's middle arm is unreachable once the session exists: `AgentSession.getEvalSessionId()` delegates to `EvalRunner.getSessionId()` (`session/eval-runner.ts:155-161`), which returns `#parentSessionId` when set and otherwise a `defaultEvalSessionId(...)` string — it never returns null, so `??` never falls through to `options.parentEvalSessionId`. A nested subagent inherits the parent kernel because hop 2 put `parentEvalSessionId` into its own `AgentSession` config (`session/agent-session.ts:981` → `EvalRunner`'s `parentSessionId`). Hop 3's real exposure is the **pre-construction window**: `toolSession` is built at `sdk.ts:1750` and `session` is not assigned until `sdk.ts:3397`, so any consumer that reads `toolSession.getEvalSessionId` in between gets the `options.parentEvalSessionId` arm — that is the arm's only live caller, and it is why deleting it is not obviously safe. Nothing in the repo pins any of the three. Deleting any one leaves every pin green while subagents and vibe workers silently stop sharing the parent's kernel, so milestone 2 must review those three lines by hand | [B] (identity across child sessions, structured subagents, vibe workers, the commit agent) + [A] (`EvalRunner.disposeKernels` fan-out, exact arity, no global sweeps) |
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

## Wiring checklist (when Tier 2 lands)

Sequencing step 3 has landed its **scaffold** (the measurement half waits on a
real kernel): `eval/elide/` carries the backend, the executor, the
`WorkerHandle` adapter, the engine setting, and an EMPTY kernel-factory slot,
with the whole surface pinned by
`packages/coding-agent/test/eval/elide/{elide-engine-parity,elide-worker,elide-backend-dispatch}.test.ts`.
`getElideJsKernelFactory() === undefined` is the correct production state today,
and it is what holds the backend's `isAvailable()` false
(`packages/coding-agent/src/eval/elide/index.ts:48-50`).

This section exists so filling that slot is a **small, unambiguous task**: what
changes, what must not, which seam method maps to which embedded-ABI op, and
what is known to still be broken. Run it alongside the **Aura-side regeneration
checklist** in `WHIPLASH_QUEUE.md:708-762` — that checklist's step 7 ("implement
the factory over the embedded transport … then flip the parity suite from the
fake factory to the real one") *is* this section. Do steps 1–6 there first — the
ABI pin, the schema sync, the
`packages/coding-agent/src/runtime/embedded/worker-protocol.ts` control/execution
split (`ExecutionWorkerRequest:8` / `ControlWorkerRequest:16` — **not**
`src/eval/js/worker-protocol.ts`, which has no execution/control split and is
upstream code this milestone does not edit), and the new-op routing plus
output-pump loop in `src/runtime/embedded/worker-core.ts` (step 6) are
prerequisites, not part of this seam and not counted against its four files.

Code paths below are `packages/coding-agent`-relative unless fully qualified;
sibling docs live in `docs/aura/`.

### Changes — five files, four of them code

| # | File | Change |
|---|---|---|
| 1 | `src/eval/elide/kernel-embedded.ts` (**new**; name proposed) | The real `ElideJsKernelFactory` over the embedded transport, per the method↔ask map below. This and row 3 are the only *new* code; row 2 is a call site and row 4 is a deletion in two files. |
| 2 | Install site for **one** `setElideJsKernelFactory(...)` — **DESIGN CALL, unresolved; see the note below.** Candidate: `src/runtime/index.ts` `getOrCreateRuntimeService` (`:58`) | Wherever it lands, import lazily — `src/eval/elide/*` is deliberately outside the `eval` barrel so a default session never loads it (`src/eval/elide/index.ts:15-17`). |
| 3 | `src/eval/elide/guest-entry.ts` (**new**; name proposed) — the guest-side analogue of `src/eval/js/worker-entry.ts` | Evaluate the `WorkerCore` + prelude bundle **once per persistent context**, right after `contextOpen`, so the context speaks `WorkerInbound`/`WorkerOutbound` from its first cell. Same 37-line shape as `worker-entry.ts`: build a `Transport` over the ABI in place of `parentPort`, then `new WorkerCore(transport, { mode: "isolated" })`. Its `Transport` is where guest→host tool calls resolve, and there are two shapes — take the first. **(v1) HTTP-loopback tool bridge**: zero Elide work, Aura's existing `ensurePyToolBridge` pattern (`src/eval/py/tool-bridge.ts:156`), Elide's JS has `fetch` (`WHIPLASH_QUEUE.md:85`, decision 5). **(v2) in-guest host-call pump** over `hostCallPoll`/`hostCallResolve`: the ops ship in the ABI but return `unsupportedOperation` until Tier 2.2 (item L, `WHIPLASH_QUEUE.md:585`). Writing v1 behind the `Transport` keeps the v2 switch inside this one file. |
| 4 | `docs/settings.md:624` (doc) **and** `src/config/settings-schema.ts:3696` (code) | Both currently tell the user that selecting `elide` does nothing: the `eval.jsEngine` docs row and the schema's `elide` option description each carry the clause *"(no kernel ships yet; falls back to Bun with a notice)"*. **When a kernel lands, delete that clause from both** — the schema string is what `/settings` renders, so leaving it would keep the UI advertising a fallback that no longer happens. An earlier revision of this row claimed the schema was engine-neutral and needed no change; it is not, and the row costs two edits, one of them code. |

Nothing else is in scope. Once queue steps 1–6 have landed, a diff that touches a
file outside these five means something in the scaffold was wrong and should be
fixed rather than worked around.

#### Row 2 is an unresolved design call, not a prescription

**No test pins the install site today, and the obvious one does not typecheck as
a semantic.** The factory slot is **process-wide** — `let kernelFactory` is a
module-level binding in `src/eval/elide/kernel.ts:64` — while
`getOrCreateRuntimeService` is **per-scope**: it keys its state on a `scope`
object (`src/runtime/index.ts:58-73`), and `sdk.ts:1307` mints a fresh
`RuntimeServiceScope` per session, handing it in at `:1767`. Installing a
process-wide slot from a per-scope hook has three concrete failure modes:

1. **Last install wins.** Two live sessions → two scopes → two services, one
   slot. The second session's factory silently serves the first session's evals.
2. **Any one retirement clears the shared slot.** `retireRuntimeService` fires on
   settings change (`:71`), scope disposal (`drainRuntimeServiceScope`, `:189`),
   and test reset (`resetRuntimeServiceForTests`, `:257`). A clear-on-retire hook
   flips `isAvailable()` false for a *healthy sibling session* that never asked
   for anything.
3. **A settings rekey can clear the slot the replacement just filled.** At `:71`
   the retire is `void`-async and runs *after* `onCreate` has already published
   the replacement, so the retirement's clear lands on the new factory.

The wiring task must therefore pick one of three, deliberately:

- make the factory slot **scope-aware** (keyed the way the service cache is), or
- **install once, process-wide, idempotently** — no clear-on-retire at all, or
- pick a **process-lifetime install site** instead of a per-scope hook.

Whichever is chosen, land a test with it: nothing in the repo constrains this
today, which is exactly how the wrong shape would ship green.

### `open()` contract — the one thing a real kernel can get silently wrong

**Every `factory.open()` call must return a fresh, isolated context, even for
byte-identical options.** `sessionId` is a diagnostic **label**, not a dedup key.

Owner-scoped reset forks a second context under the *same* kernel-facing session
id: the fork key lives in host-side bookkeeping
(`resolveOwnerScopedSessionKey`, `packages/coding-agent/src/eval/executor-base.ts`)
and never reaches the factory, because `spawnElideWorker` passes only
`{cwd, sessionId}` (`packages/coding-agent/src/eval/elide/worker.ts:112`). A
kernel that keyed its context registry by `sessionId` would therefore hand a
subagent's forked context back to the parent and silently merge two sessions'
guest state — a privacy bug, not a performance one.

This is pinned, not merely documented: the fork-privacy case asserts both opens
carry one `sessionId`
(`packages/coding-agent/test/eval/elide/elide-engine-parity.test.ts:299`) while
the surrounding state assertions require the two contexts to stay private, so a
dedup-by-`sessionId` kernel fails the suite loudly. The contract is also stated
at the seam itself, on `ElideJsKernelFactory.open`.

### Method↔ask map

`ElideJsKernelSession` (`packages/coding-agent/src/eval/elide/kernel.ts`) is the
existing JS worker protocol plus three lifecycle asks. Each maps to one Tier 2 op:

| Seam method | Embedded-ABI op | Notes |
|---|---|---|
| `factory.open(opts)` | `contextOpen(EmbeddedContextSpec)` | `languages = [js, ts]`, `primaryLanguage = js`, `allowThreads = false` (rejected for JS/TS anyway — `WHIPLASH_QUEUE.md:125-127`), `streamOutput = true`, `workingDir = opts.cwd`, `label = opts.sessionId`. `hostCalls = false` for v1 — it returns `unsupportedOperation` until Tier 2.2, so the loopback bridge does not depend on it. Fresh context per call — see the contract above. |
| `send(msg)` for a `{type:"run"}` worker message (not the retired `run` tool) | `contextCall` | Execution worker. Serialized per context; a second concurrent eval returns `busy` (decision 9). |
| `onMessage(text/display)` | `pollOutput` pump | Control worker, driven as a loop; the transport's incremental chunks become the `text`/`display` outbounds `OutputSink` already consumes. |
| `interrupt()` | `interrupt(timeoutMillis)` | Rung 1 of the cancellation ladder: context and guest state survive. |
| `reset()` | `reset` (close + rebuild from the same `ElideRuntime`) | Guest state gone, engine warmth kept — costs exactly one of today's per-call context builds (decision 4). |
| *(none)* | `cancel` | No seam method. Rung 2 of the ladder (`close(true)` + rebuild) is **host policy**, and today the host escalates by terminating the worker instead — leave it unwired unless a caller appears. |
| `close()` | `contextClose` | Must resolve only after the context is deregistered; a `pollOutput` parked at close is woken and returns `closed` (`WHIPLASH_QUEUE.md:431`). |
| Tool calls (guest→host) | HTTP loopback (v1) / `hostCallPoll` + `hostCallResolve` (v2) | Decision 5. v2's ops return `unsupportedOperation` until Tier 2.2. |

The three asks beyond the worker protocol (`interrupt`/`reset`/`close`) have no
host caller today — the stack cancels by terminating the worker and resets by
cold-starting a context. The parity suite exercises them directly against the
documented contract instead, so they are specified before they are used.

### Cost of the swap: one factory line plus a counting decorator

The parity suite is the acceptance gate, and it was written to survive this. Each
case drives the production entry point (`executeElideJs`) over the shared eval
stack, so swapping engines means changing the factory installed in `beforeEach` —
**one line** — plus a thin counting wrapper around the real factory that exposes
the fake's counter surface (`opens` / `closes` / `interrupts` / `resets` /
`sessions`), which roughly 30 assertions read. Nothing in the suite's *assertions*
should need editing; if one does, treat it as a real behavior difference and
resolve it deliberately rather than relaxing the assertion.

Two `TODO(m3)` markers are test **strengthenings** to land with the wiring —
neither is a bug, and both only become possible once the guest has its own realm
and a genuinely interruptible cell:

1. `elide-engine-parity.test.ts:88` — revert the per-context state carrier from
   the `__omp_helpers__.env` bag back to a plain `var shared = 41`, matching
   `test/eval/kernel-owner-scoping.test.ts`. That observes the whole guest global
   scope instead of one bag inside it, so it tests strictly more.
2. `elide-engine-parity.test.ts:536` — re-point the interrupt case at a cell that
   is actually in flight (park it with `createParkTool`, interrupt, assert the
   cell settles *and* the context survives) instead of interrupting between
   cells. The inline fake cannot be interrupted mid-cell; a real kernel can.

### Does not change

Naming these so the wiring diff stays reviewable:

- **`packages/coding-agent/src/tools/eval.ts`** — final as of the env-error
  boundary work. A malformed `AURA_EVAL_JS_ENGINE` surfaces as a `ToolError` at
  `resolveBackend` (`:274-284`), and an engine request with no kernel installed
  falls back to Bun with the "Elide JS engine unavailable" notice (`:285-292`).
  A real factory changes which branch is taken at runtime, not the code.
- **The wire schema and eval-render** — the Elide backend's `id` is `"js"`, so
  the tool schema, details payload, and every renderer keep saying "js"
  whichever engine ran the cell (`src/eval/elide/index.ts:37-40`).
- **Disposal wiring** — owner-scoped teardown is engine-agnostic;
  `disposeVmContextsByOwner` already reaps Elide contexts with no Elide-aware
  code in the caller, and the parity suite pins it.
- **The Bun executor** (`src/eval/js/executor.ts`) — the default path for every
  user, deliberately untouched.
- **The parity suite's assertions** — see above.

### Known gaps to close before the engine defaults on

1. **The tool prompt promises Bun globals.**
   `packages/coding-agent/src/prompts/tools/eval.md:7` tells the model *"JS runs
   under **Bun**: globals (`Bun.file`, `Bun.write`, `Bun.$`, `fetch`, `Buffer`)
   available"*. On Elide that is at best partly true. Either make the line
   engine-aware (the template already branches on `{{#if js}}`, so an `engine`
   flag is the natural shape), or get Elide to document the shim subset it
   guarantees. Shipping the current text on an Elide default would make the model
   write cells that cannot run.
2. **Python is not in scope and must not be quietly added.** The blockers are
   GraalPy-side, not ours: guest threads are refused while JavaScript shares the
   context (see the spike above), and `os.getppid()` is unsupported on the `java`
   POSIX backend — recorded as deliberately staying unsupported in
   `WHIPLASH_QUEUE.md:651-656`, since in-process execution has no parent to
   orphan. Both are tracked there; revisit Python only against spike A's answer
   and Tier 2 numbers.
3. **Guest→host v1 is a loopback HTTP bridge**, which means the guest needs a
   reachable bridge URL and a shared secret per context. That is Aura-side work
   with no Elide dependency, but it is real work — do not assume the existing
   in-process JS tool bridge transfers unchanged.

## Why this is worth doing beyond tidiness

The JVM tasks lost 1.07–1.57× on tokens while Elide's JVM execution is 5.2×
*faster* — the cost is interaction, not capability. Collapsing onto one
execution surface with one set of gates and one telemetry path is the most
direct attack on that gap, and it shrinks `FORK.md` by ~15 rows of
merge-conflict surface at the same time.
