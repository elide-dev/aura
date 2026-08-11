# Elide/Eval Collapse — Milestone 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the Aura fork's parallel Elide runtime stack onto upstream omp's `src/eval/` kernel framework and scaffold an Elide-backed JS/TS `ExecutorBackend` (default off), while queueing the Tier 2 persistent-context ABI spec for WHIPLASH.

**Architecture:** Elide becomes an *engine* behind omp's existing `eval` abstractions, not a second stack. The entire engine lands in a new fork-owned `packages/coding-agent/src/eval/elide/` directory; the only upstream `src/eval/` file touched is `js/context-manager.ts` (≤15 lines: an injected `spawnWorker` seam). The fork's bespoke embedded worker-host duplication is deleted in place (fork-owned files only). The Tier 2 ABI does not exist yet — the backend is scaffolded against a fake kernel factory so real wiring is a ≤4-file task when the batched WHIPLASH build lands.

**Tech Stack:** Bun + TypeScript (workspace), bun:test, capnp-es (untouched this milestone), GraalVM/Elide runtime artifact for gated integration tests.

## Global Constraints

- Repo root for all commands: the current worktree (`git rev-parse --show-toplevel`). Test invocation form: `bun test <repo-relative path(s)>` from the root.
- `packages/coding-agent/src/eval/` must stay pristine upstream code EXCEPT: (a) the new `src/eval/elide/` directory (fork-owned), (b) `src/eval/js/context-manager.ts` with ≤15 changed lines (Task 11 only). Reviewer check: `git diff origin/main...HEAD --stat -- packages/coding-agent/src/eval`.
- `packages/agent/**` must not be modified by any task.
- `packages/coding-agent/src/runtime/embedded/generated/**` and `src/runtime/embedded/schema.ts` must not change in this milestone. Any diff there is a review stop.
- Eval backends must NEVER derive a wall-clock timer from `idleTimeoutMs` (contract at `packages/coding-agent/src/eval/backend.ts:11-21`); cancellation is `AbortSignal`-only.
- Backend errors are values: `execute()` returns `{exitCode: 1, output: <message>}`, never throws (`tools/eval.ts` has no try/catch around it).
- Tool bridges receive the RAW caller signal, never a shielded one.
- Commit style: conventional commits scoped like existing history (`feat(coding-agent): …`, `fix(metaharness): …`, `docs(aura): …`, `test(coding-agent): …`). One logical change per commit. End commit messages with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Typecheck gate for every task: `bun run check:ts` exits 0.
- The 26 artifact-gated integration tests (Phase-2 tasks only) use the MAIN checkout's artifact: `AURA_RUNTIME_EMBEDDED_LIB=/home/sam/workspace/aura/out/aura-elide-linux-x64/lib/libelide_embed.so bun test packages/coding-agent/test/runtime-integration.test.ts packages/coding-agent/test/runtime-embedded-integration.test.ts` → expect 26 pass, 0 fail.
- Test idioms to follow (do not invent new ones): local `makeSession()` ToolSession literal as in `test/eval/kernel-owner-scoping.test.ts:11-30`; fake-at-the-seam (`MemoryTransport`/`FakeNativeLibrary` in `test/runtime-embedded-worker.test.ts:29-96`, `FakeWorker` over `globalThis.Worker` in `test/eval/js-context-manager.test.ts`); every real async wait bounded by a `withTimeout` helper; availability gates via module-scope `describe.skipIf`.
- The approved master plan (context, findings, Tier 2 spec) lives at `/home/sam/.claude/plans/please-absorb-actions-consolidate-md-and-bubbly-hollerith.md`. Tasks reference specific sections of it as source material.

---

### Task 1: Write docs/aura/WHIPLASH_QUEUE.md (the Tier 2 queue doc)

**Files:**
- Create: `docs/aura/WHIPLASH_QUEUE.md`
- Read (source material): `/home/sam/.claude/plans/please-absorb-actions-consolidate-md-and-bubbly-hollerith.md` — the sections `## Tier 2 surface spec (→ docs/aura/WHIPLASH_QUEUE.md via T0.3)` and `## NEW first-hand findings from the WHIPLASH worktree (2026-08-10)` and `## GAME-CHANGER: elide_v2_repl_*` (background)
- Read (grounding, read-only): `/home/sam/workspace/worktrees/WHIPLASH-embedded/protocol/elide/v1/embed.capnp`, `.../repl.capnp`, `/home/sam/workspace/worktrees/WHIPLASH-embedded/packages/base/main/dev/elide/runtime/EmbeddedRun.kt`, `.../embed/EmbeddedHostEntry.kt`, `.../embed/EmbeddedCodec.kt`, `/home/sam/workspace/worktrees/WHIPLASH-embedded/packages/entry/native/elide_embed.c`, `.../headers/elide_embed.h`

**Interfaces:**
- Produces: the canonical queue document other milestones and the WHIPLASH implementation agent will consume. No code.

Motivation: Sam batches Elide-side builds from `/home/sam/workspace/worktrees/WHIPLASH-embedded`; this doc is the queue. It unblocks the WHIPLASH work stream, so it goes first.

- [ ] **Step 1: Read the source sections and verify grounding.** Read the master plan's Tier 2 spec section fully. Spot-verify at least these claims against the WHIPLASH worktree before writing (cite what you find): the 7-symbol export pin in `tools/scripts/check-embedded-symbols.sh`; `EmbeddedRunSession.run()` building a fresh context per call in `EmbeddedRun.kt` (~line 361); `EmbeddedCodec.kt` reading engineConfig only for `directories.workingDir` (~line 251); ABI version constant `1u` in `elide_embed.h` (~line 26).
- [ ] **Step 2: Write `docs/aura/WHIPLASH_QUEUE.md`** with exactly this structure:
  1. **Header** — status (QUEUED, awaiting batch), target repo/worktree path, base commit `6ada39daa`, consumer (Aura coding-agent), and the batching workflow: items accumulate here; Sam triggers a batch build; the "Aura-side regeneration checklist" runs when the artifact lands.
  2. **Item 1: Tier 2 persistent execution contexts** — expand the master plan's condensed spec into full prose: the 10 decisions table, the schema additions (write out the capnp struct sketches from the spec verbatim, as ```capnp blocks — `EmbeddedContextSpec`, `EmbeddedEvalMode`, `EmbeddedContextCall`, `EmbeddedControl` + sub-structs, response payloads `EmbeddedContextOpened`/`EmbeddedEvalResult`/`EmbeddedOutputBatch`/`EmbeddedHostCall`/`EmbeddedDescription`/`EmbeddedCapabilities`, failure-code additions, and the new `guest.capnp` with `ExceptionSummary`/`StackFrame`/`SourceLocation`/`ValueKind`/`ValueSummary`), the C shim additions (2 exports, ABI 1u→2u, allowlist 7→9, the two deadlock invariants), the Kotlin file-by-file work list, the semantics contract (isolation, language scoping incl. allowThreads rejected when JS/TS present, cancellation ladder interrupt→cancel→close, reset-v1 semantics and its cost statement, errors-as-values + the poisoning taxonomy table incl. the explicit narrowing of cleanup-failure poisoning from session to context, streaming/backpressure, idle lifetime = host-owned, output limits), the WHIPLASH-side test plan, and the A–M implementation-order table with sizes — **spike A flagged as the blocking gate for Python**.
  3. **Item 2: dead-field hygiene** — deprecate-and-document `EngineConfig.shared/.caching/.flags` and `ENGINE_OPTIMIZED` (with the file:line evidence), `EmbeddedEvalMode.mainScript` as the `pythonFileBootstrap` deleter, `os.getppid()` stance.
  4. **Open questions for Elide engineering** — the 8 questions from the spec, numbered, with question 1 marked blocking (= spike A).
  5. **Aura-side regeneration checklist** — the 9-step list from the spec (ABI pin update FIRST in `scripts/sync-embedded-runtime-protocol.ts` ~line 313, sync run, abi.ts symbols, codec, worker-protocol, worker-core output pump, `eval/elide/kernel.ts` factory, test extensions, bench cases + no-regression floors: JS/TS warm 3.4×/3.0×, JS compute 2.0×, cancellation 2.9×, Java 0.19×).
  6. **Out of scope** — the list from the spec (display outputs, value rendering, bindings/inspect/parse/completion, cross-language mirroring, Ruby/Java/Wasm, SessionEvent streaming, REPL changes, multi-isolate).
- [ ] **Step 3: Cross-link.** Add a one-line pointer to the new doc in `docs/aura/ELIDE_ALIGNMENT.md`'s companion list (line ~6-8) and in `docs/aura/WHIPLASH_ENGINE_BRIEF.md`'s companion note. Do not otherwise edit those files (Task 3 owns their content).
- [ ] **Step 4: Verify and commit.** `bun run check:ts` (docs-only change; still run it). Commit: `docs(aura): queue the Tier 2 persistent-context spec for WHIPLASH`.

Acceptance: `docs/aura/WHIPLASH_QUEUE.md` exists with the 6 sections; every capnp struct from the spec appears in a code fence; spike A is marked blocking; `grep -n "WHIPLASH_QUEUE" docs/aura/ELIDE_ALIGNMENT.md docs/aura/WHIPLASH_ENGINE_BRIEF.md` hits both.

---

### Task 2: Record the dead engine-flag finding in codec.ts

**Files:**
- Modify: `packages/coding-agent/src/runtime/embedded/codec.ts` (comment only)

**Interfaces:**
- Consumes: nothing. Produces: nothing (documentation-of-record in code).

Context: an uncommitted working-tree experiment (in the MAIN checkout, never committed — this worktree does not contain it) wrote `EngineConfig.shared`/`.caching` from `AURA_RUNTIME_ENGINE_SHARED`/`_CACHING` env vars. Source-verified on the WHIPLASH side: `EmbeddedCodec.kt` reads `engineConfig` only for `directories.workingDir`; `shared`/`caching`/`flags` are never read, and a 4-cell sweep measured no effect. The experiment is concluded. This task records the finding at the code site so nobody re-runs it.

- [ ] **Step 1: Verify the worktree has no experiment residue.** `grep -rn "AURA_RUNTIME_ENGINE" packages/ scripts/` must return nothing. `grep -n "engineConfig.shared\|engineConfig.caching" packages/coding-agent/src/runtime/embedded/codec.ts` must return nothing.
- [ ] **Step 2: Add the doc comment.** In `codec.ts`, locate the `encodeRunRequest` chain that calls `._initMeta()._initEngineConfig()` and add immediately above it:
  ```ts
  // EngineConfig.shared / .caching / .flags are intentionally left at their
  // capnp defaults: the embedded runtime's codec (WHIPLASH EmbeddedCodec.kt)
  // reads engineConfig only for directories.workingDir — the other fields are
  // never consulted, and a 4-cell shared×caching sweep measured no effect
  // (2026-08-10, docs/aura/ACTIONS_CONSOLIDATE.md "Phase 0.5"). Do not wire
  // them to env/settings again without a WHIPLASH-side change that reads them.
  ```
- [ ] **Step 3: Test.** `bun test packages/coding-agent/test/runtime-embedded-codec.test.ts` → all pass (comment must not change wire bytes; the codec test pins the schema fingerprint and encoded frames).
- [ ] **Step 4: Verify types and commit.** `bun run check:ts` → clean. Commit: `docs(coding-agent): record that EngineConfig.shared/caching/flags are dead fields on the embedded path`.

Acceptance: comment present; both greps in Step 1 clean; codec tests green; check:ts clean.

---

### Task 3: Consolidate and commit the aura planning docs

**Files:**
- Move: `ACTIONS_CONSOLIDATE.md` → `docs/aura/ACTIONS_CONSOLIDATE.md` (git mv semantics: `git add` the new path, remove the old)
- Modify: `docs/aura/ACTIONS_CONSOLIDATE.md`, `docs/aura/FORK.md`, `docs/aura/ELIDE_ALIGNMENT.md` (path references only), `docs/aura/WHIPLASH_ENGINE_BRIEF.md` (commit as-is)

**Interfaces:**
- Consumes: Task 1's WHIPLASH_QUEUE.md (for cross-references). Produces: committed, internally consistent docs that later tasks (5, 14) append to.

- [ ] **Step 1: Move the file.** Move `ACTIONS_CONSOLIDATE.md` from the repo root to `docs/aura/ACTIONS_CONSOLIDATE.md`.
- [ ] **Step 2: Fix references.** Update every occurrence of the old root path: in `docs/aura/ELIDE_ALIGNMENT.md` (~line 6, companions list) and in the moved file's own self-references if any. `grep -rn "ACTIONS_CONSOLIDATE" docs/ *.md 2>/dev/null` must resolve every hit to the new path.
- [ ] **Step 3: Close Phase 0.5 in the moved doc.** In `docs/aura/ACTIONS_CONSOLIDATE.md`: (a) after the "RESULTS (2026-08-10)" subsection, add a short "CLOSED (2026-08-10)" note: fields confirmed unread by the embedded codec on the WHIPLASH side (EmbeddedCodec.kt consumes only directories.workingDir); codec.ts no longer writes them; see docs/aura/WHIPLASH_QUEUE.md Item 2. (b) Strike open question 5 ("Is EngineConfig.shared/caching honored…") by appending "**Answered:** dead fields — never read on the embedded path; deprecate-and-document queued in WHIPLASH_QUEUE.md." (c) Replace the `bench-engine-matrix.ts` sentence (~line 206) with: the script is dropped (its shared×caching hypothesis is dead); the surviving invocation for adapter latency is `bun run bench:runtime --micro-only --micro-iterations 15 --prefix=<label> --embedded-lib=out/aura-elide-linux-x64/lib/libelide_embed.so`, one config per process; prefer absolute embedded times over process-relative ratios.
- [ ] **Step 4: Fix FORK.md row 79.** In `docs/aura/FORK.md`, find the row for `packages/metaharness/src/runtime-benchmark.ts` claiming it "injects repository-packaged process and embedded runtime artifacts into source-mounted task containers". Correct it: injection happens only when `--embedded-lib` (or `--runtime-binary`) is supplied; `--embedded-lib` also derives the process binary via `packagedRuntimeBinaryForLibrary()`.
- [ ] **Step 5: Commit everything.** All four docs (the moved file, FORK.md fix, ELIDE_ALIGNMENT.md, WHIPLASH_ENGINE_BRIEF.md) in one commit: `docs(aura): consolidate runtime planning docs; close the engine-flag investigation`.

Acceptance: `git status --short` shows no untracked `*.md`; root `ACTIONS_CONSOLIDATE.md` gone; all references resolve; FORK.md row corrected; check:ts clean.

---

### Task 4: Pin the kernel-owner disposal fan-out (test-only)

**Files:**
- Create: `packages/coding-agent/test/eval/kernel-owner-disposal-coverage.test.ts`
- Read: `packages/coding-agent/src/session/eval-runner.ts` (~lines 205-219), `packages/coding-agent/src/sdk.ts` (~lines 3874-3893), `packages/coding-agent/src/eval/js/context-manager.ts` (`disposeVmContextsByOwner` ~lines 205-238), `packages/coding-agent/test/eval/kernel-owner-scoping.test.ts` (the idiom template)

**Interfaces:**
- Produces: regression gates that milestone 2's `runtimeServiceScope` deletion depends on. NO `src/` changes — `git diff --stat -- packages/coding-agent/src` must be empty for this task.

Motivation: milestone 2 deletes the fork's runtime ownership plumbing on the claim that `kernelOwnerId` disposal already covers every session path. That claim must be executable, not remembered.

- [ ] **Step 1: Write the failing/pinning tests.** Following `kernel-owner-scoping.test.ts` idioms (`makeSession()` literal, `vi.spyOn`, `withTimeout`), cover:
  1. `EvalRunner.disposeKernels()` invokes exactly the four per-language disposers (`disposeKernelSessionsByOwner`, `disposeRubyKernelSessionsByOwner`, `disposeJuliaKernelSessionsByOwner`, `disposeVmContextsByOwner`) with the runner's own `kernelOwnerId`. Spy on the four module exports; assert call args and count.
  2. A rejection from one disposer still lets the others run, and the failure surfaces as an `AggregateError` (per eval-runner's fan-out ~lines 216-218).
  3. The `createAgentSession` startup-failure cleanup path (`sdk.ts` ~3874-3893) registers the same disposer set — assert by the label strings used there (`"eval kernels"`, `"Ruby kernels"`, `"Julia kernels"`, `"JS VM contexts"`, `"computer sessions"`), so a future backend that forgets to register is caught by a label-list diff.
  4. Last-owner-out rule, against the real `disposeVmContextsByOwner` with a real inline-worker JS context (as `kernel-owner-scoping.test.ts` does for reset-forking): two owners attached to one live context → first `disposeVmContextsByOwner(ownerA)` only deregisters A (context still alive — prove by executing another cell); second `disposeVmContextsByOwner(ownerB)` kills it. Bound every wait with `withTimeout`; `afterEach` runs `disposeAllVmContexts()`.
- [ ] **Step 2: Run to green.** `bun test packages/coding-agent/test/eval/kernel-owner-disposal-coverage.test.ts` — these are pins on existing behavior, so they should pass once correctly written; a failure means the pin found a real gap → report it, do not "fix" src.
- [ ] **Step 3: Verify no src changes and commit.** `git diff --stat -- packages/coding-agent/src` empty; `bun run check:ts` clean. Commit: `test(coding-agent): pin the four-way kernel-owner disposal fan-out`.

Acceptance: new test file passes; zero `src/` diff; check:ts clean.

---

### Task 5: Pin owner identity across session paths + record the equivalence matrix

**Files:**
- Create: `packages/coding-agent/test/eval/kernel-owner-session-paths.test.ts`
- Modify: `docs/aura/ELIDE_ALIGNMENT.md` (append one section)
- Read: `packages/coding-agent/src/session/agent-session.ts` (~983-986 owner minting), `src/sdk.ts` (~1688, 1748-1751), `src/task/structured-subagent.ts` (~447), `src/vibe/runtime.ts` (~1447), `src/commit/agentic/agent.ts` (~43-84)

**Interfaces:**
- Consumes: Task 4's helpers if any are exportable (else duplicate the small `makeSession` literal — do not create a shared helper module for two files).
- Produces: the "Equivalence matrix (verified)" section in ELIDE_ALIGNMENT.md that gates milestone 2.

- [ ] **Step 1: Write the pinning tests.**
  1. A child session created with `parentEvalSessionId` shares the eval session id but mints a fresh `evalKernelOwnerId` (one kernel, N owners). Construct via the cheapest real path available (AgentSession config or `createAgentSession` with spies) — follow how existing tests in `test/` construct sessions; do NOT stand up a full SDK if a config-level assertion suffices.
  2. `shareEvalSession === false` (structured-subagent path) omits `parentEvalSessionId` → fully separate kernel session id.
  3. The vibe worker path propagates `parentEvalSessionId` from the parent session.
  4. The commit agent constructs its session with `toolNames: ["__none__"]` + custom tools only → no eval tool is registered, so its minted owner id has zero kernels and disposal is a no-op. Pin that the eval tool is absent from its session.
- [ ] **Step 2: Run to green.** `bun test packages/coding-agent/test/eval/kernel-owner-session-paths.test.ts`. Same rule as Task 4: a failing pin is a FINDING (record verbatim in your report; mark the corresponding matrix row `equivalent + gap`), not a license to edit src.
- [ ] **Step 3: Append the matrix.** In `docs/aura/ELIDE_ALIGNMENT.md`, under the "Sequencing" section's step 1, append `### Equivalence matrix (verified 2026-08-10)`: a table with one row per fork construct from the "Candidates to collapse" table (~lines 50-58): columns = fork construct | omp equivalent | verdict (`equivalent` / `equivalent + gap: <what>` / `fork-owned, stays`) | pinning test. Rows: `runtimeServiceScope` threading → `kernelOwnerId` + owner-scoped disposal (tests from Tasks 4+5); `acquireRuntimeServiceLease` → last-owner-out disposal (Task 4 test 4); selected-service cache → `createKernelSessionRegistry` (verdict: equivalent for kernel lifecycles; the runtime SERVICE cache is orthogonal until milestone 2 — mark as such); embedded worker host → worker-client (verdict: fork-owned worker_threads variant stays; duplication deleted in Tasks 6-8); settings trees → eval.* + engine key (deferred to milestone 2/4); telemetry (fork-owned, stays); `tools/eval-backends.ts` gates (fork edit stays).
- [ ] **Step 4: Commit.** `git diff --stat -- packages/coding-agent/src` empty; check:ts clean. Commit: `test(coding-agent): pin eval owner identity across subagent/vibe/commit paths; record equivalence matrix`.

Acceptance: tests green (or findings recorded + matrix rows marked `equivalent + gap`); matrix section present; zero `src/` diff; check:ts clean.

---

### Task 6: One parentPort worker transport helper (embedded)

**Files:**
- Create: `packages/coding-agent/src/runtime/embedded/worker-transport.ts`
- Modify: `packages/coding-agent/src/runtime/embedded/worker-entry.ts`, `packages/coding-agent/src/runtime/embedded/control-worker-entry.ts`
- Test: extend `packages/coding-agent/test/runtime-embedded-worker.test.ts`

**Interfaces:**
- Produces: `createParentPortWorkerTransport<Inbound, Outbound>(port: { postMessage(msg: unknown, transfer?: unknown[]): void; on(ev: string, h: (m: unknown) => void): void; off?(ev: string, h: (m: unknown) => void): void; close(): void }, label: string): EmbeddedWorkerTransport<Inbound, Outbound>` — consumed by both entry files now and by nothing else.

Motivation: `worker-entry.ts` and `control-worker-entry.ts` carry byte-near-identical `parentPort` + `consumeWorkerInbox()` transport boilerplate (also near-identical to `eval/js/worker-entry.ts:13-21`). One helper, two ≤20-line entry files.

- [ ] **Step 1: Write the failing tests.** In `test/runtime-embedded-worker.test.ts`, add a `describe("createParentPortWorkerTransport")` block with a `FakePort` (records `postMessage(msg, transfer)` calls; exposes `emit(msg)`; tracks listener add/remove). Cases: (a) messages buffered in the worker inbox (`installWorkerInbox`/`consumeWorkerInbox` path) are delivered to the first `onMessage` subscriber before new port messages; (b) with no inbox, the direct listener path delivers; (c) the unsubscribe function removes the listener (emit after unsubscribe → not delivered); (d) `send(msg, transfer)` forwards the transfer list to `postMessage` verbatim on both paths, and `send(msg)` passes an empty transfer list; (e) `close()` closes the port.
- [ ] **Step 2: Run tests, verify they fail** (module does not exist yet).
- [ ] **Step 3: Implement** `worker-transport.ts` by extracting the existing pattern verbatim from `worker-entry.ts` (inbox-first, fallback listener), typed against `EmbeddedWorkerTransport` from `worker-protocol.ts`. Then reduce both entry files to: `parentPort` null-check → `createParentPortWorkerTransport(parentPort, "<label>")` → `new ExecutionWorkerCore(transport)` / `new ControlWorkerCore(transport)`. Keep the two `EMBEDDED_DIRECT_*_WORKER_ARG` `import.meta.main` guards exactly as they are.
- [ ] **Step 4: Run to green.** `bun test packages/coding-agent/test/runtime-embedded-worker.test.ts packages/coding-agent/test/runtime-embedded-endpoint.test.ts` → all pass. Both entry files ≤20 lines (`wc -l`).
- [ ] **Step 5: Commit.** check:ts clean. Commit: `refactor(coding-agent): extract the shared parentPort transport for embedded workers`.

Acceptance: new tests pass; entry files ≤20 lines each; endpoint suite untouched-green; check:ts clean.

---

### Task 7: One embedded worker spawn helper

**Files:**
- Modify: `packages/coding-agent/src/runtime/embedded/worker-core.ts` (~lines 428-448)
- Test: extend `packages/coding-agent/test/runtime-embedded-worker.test.ts`

**Interfaces:**
- Consumes: Task 6's entry files (URLs unchanged).
- Produces: internal `spawnEmbeddedWorker<Req, Res>(hostArg: string, directArg: string, entryUrl: URL): EmbeddedWorkerHandle<Req, Res>`; the existing exported names `spawnEmbeddedExecutionWorker` / `spawnEmbeddedControlWorker` remain, as one-line delegations — `cli.ts` and `transport/embedded.ts` are NOT touched.

Motivation: the two spawn functions differ only in three constants (host selector arg, direct selector arg, entry URL).

- [ ] **Step 1: Write the failing test.** Add one case asserting both exported spawn functions return a handle exposing all five `EmbeddedWorkerHandle` members (`send`, `onMessage`, `onError`, `onExit`, `terminate` — check the actual interface in `worker-protocol.ts` and assert its exact member set). Use the existing worker-factory injection seam if real Worker spawning is too heavy; if a real `new Worker` is needed, bound with `withTimeout` and terminate in `finally`.
- [ ] **Step 2: Implement the collapse.** Single generic `spawnEmbeddedWorker` wrapping the `workerHostEntry() ? new Worker(hostEntry, {argv:[hostArg]}) : new Worker(entryUrl.href, {argv:[directArg]})` branch plus `wrapWorker`. Keep `wrapWorker` itself — it is the worker_threads analogue of upstream `createWorkerHandle` with no upstream equivalent.
- [ ] **Step 3: Run to green.** `bun test packages/coding-agent/test/runtime-embedded-worker.test.ts packages/coding-agent/test/runtime-embedded-endpoint.test.ts` → pass; `worker-core.ts` line count drops by ≥12.
- [ ] **Step 4: Commit.** check:ts clean. Commit: `refactor(coding-agent): collapse the embedded worker spawn functions`.

Acceptance: exported names unchanged (grep `spawnEmbeddedExecutionWorker\|spawnEmbeddedControlWorker` in `cli.ts`, `transport/embedded.ts`, tests — all call sites compile untouched); suites green; check:ts clean.

---

### Task 8: Extract WorkerRequestChannel from EmbeddedWorkerHost

**Files:**
- Modify: `packages/coding-agent/src/runtime/embedded/worker-core.ts` (the `EmbeddedWorkerHost` class, ~lines 493-936)
- Test: extend `packages/coding-agent/test/runtime-embedded-worker.test.ts`

**Interfaces:**
- Produces: internal `class WorkerRequestChannel<Req extends {id:number}, Res extends {id:number}>` — holds one `EmbeddedWorkerHandle`, its pending map, `send(msg, transfer?): Promise<Res>`, `settle(msg): void`, `failAll(error): void`, `dispose(): void`. `EmbeddedWorkerHost` holds two instances (execution + control) and keeps a SHARED `#nextId` counter (request ids must stay globally unique across both workers).

**FROZEN BEHAVIORS — this is a pure extraction; these five must not change:**
1. Ordered shutdown: drain in-flight → cancel active → close control → close runtime (pinned at `runtime-embedded-worker.test.ts` ~:694, :752).
2. `#callTail` serialization of native ops.
3. `#expectedControlExit` handling (expected control-worker exit ≠ crash).
4. `#accepting`/`#failure` gating of new requests.
5. The `cancelEmbeddedRequestUntilSettled` race (~:456-486) — cancel from the control worker while the execution thread is blocked in synchronous FFI, with the `REQUEST_NOT_ACTIVE` retry loop.

Escape hatch: if the extraction cannot preserve all five cleanly, STOP, report BLOCKED with what broke — the fallback (decided in the plan) is to land Tasks 6+7 and drop this task.

- [ ] **Step 1: Write the new failing tests first** (against current behavior; they must pass before AND after the refactor — write them, confirm green on the current code, then refactor):
  (a) a pending request rejects with the restored `RuntimeRpcError` when its worker faults;
  (b) an error fan-out reaches BOTH channels' pending requests;
  (c) an expected control-worker exit does not fault execution-channel requests.
- [ ] **Step 2: Refactor.** Introduce `WorkerRequestChannel`; replace `#executionPending`/`#controlPending`, `#settleExecution`/`#settleControl`, `#sendExecution`/`#sendControl`, and the duplicated error/exit subscriptions. The five frozen behaviors stay in `EmbeddedWorkerHost` unchanged.
- [ ] **Step 3: Run the full local gate.**
  `bun test packages/coding-agent/test/runtime-embedded-worker.test.ts packages/coding-agent/test/runtime-embedded-endpoint.test.ts packages/coding-agent/test/runtime-embedded-abi.test.ts` → pass.
  Then the artifact gate: `AURA_RUNTIME_EMBEDDED_LIB=/home/sam/workspace/aura/out/aura-elide-linux-x64/lib/libelide_embed.so bun test packages/coding-agent/test/runtime-integration.test.ts packages/coding-agent/test/runtime-embedded-integration.test.ts` → 26 pass, 0 fail.
- [ ] **Step 4: Commit.** check:ts clean. Commit: `refactor(coding-agent): extract the duplicated request/response channel in the embedded worker host`.

Acceptance: all three hermetic suites + the 26 artifact-gated tests green; `worker-core.ts` shrinks by ~100-150 lines; check:ts clean.

---

### Task 9: Setting eval.jsEngine + env override

**Files:**
- Modify: `packages/coding-agent/src/config/settings-schema.ts` (insert after the `eval.js` entry, ~line 3670-3679)
- Create: `packages/coding-agent/src/eval/elide/settings.ts`
- Modify: `docs/settings.md` (one row, near the eval.* entries ~line 620)
- Test: create `packages/coding-agent/test/eval/js-engine-setting.test.ts`

**Interfaces:**
- Produces: `resolveJsEvalEngine(session: Pick<ToolSession, "settings">): "bun" | "elide"` from `src/eval/elide/settings.ts` — consumed by Tasks 12 and 13. Setting key: `"eval.jsEngine"`, enum `["bun","elide"]`, default `"bun"`. Env override: `AURA_EVAL_JS_ENGINE` (validated; unknown value THROWS with the value in the message; empty/whitespace ignored).

- [ ] **Step 1: Write the failing tests.** In `test/eval/js-engine-setting.test.ts`: (a) bare `Settings.isolated()` → `"bun"`; (b) setting `eval.jsEngine = "elide"` → `"elide"`; (c) `AURA_EVAL_JS_ENGINE=elide` overrides a `"bun"` setting; (d) `AURA_EVAL_JS_ENGINE=nope` throws, message contains `nope`; (e) empty/whitespace env ignored. Save/restore env exactly as `test/tools/eval-fallback.test.ts` (~lines 44-62) does.
- [ ] **Step 2: Run tests, verify failure** (module missing).
- [ ] **Step 3: Implement.** Schema entry mirroring the `runtime.adapter` enum entry shape (`settings-schema.ts` ~479-503): `type: "enum"`, values `["bun","elide"]`, default `"bun"`, ui tab `shell`, group `Eval & Runtimes`, label `JavaScript Eval Engine`. `settings.ts` reads the setting, applies the validated env override (mirror `runtimeAdapterFromEnvironment`, `src/runtime/index.ts` ~220-231). Add the `docs/settings.md` row.
- [ ] **Step 4: Run to green.** `bun test packages/coding-agent/test/eval/js-engine-setting.test.ts packages/coding-agent/test/runtime-settings.test.ts` → pass.
- [ ] **Step 5: Commit.** check:ts clean. Commit: `feat(coding-agent): add the eval.jsEngine setting (bun|elide, default bun)`.

Acceptance: tests green; `docs/settings.md` row present; check:ts clean; no other schema entries reordered.

---

### Task 10: ElideJsKernel seam + fake kernel + WorkerHandle adapter

**Files:**
- Create: `packages/coding-agent/src/eval/elide/kernel.ts`, `packages/coding-agent/src/eval/elide/worker.ts`
- Create (test-only): `packages/coding-agent/test/eval/elide/fake-kernel.ts`, `packages/coding-agent/test/eval/elide/elide-worker.test.ts`

**Interfaces:**
- Consumes: `WorkerInbound`, `WorkerOutbound` from `src/eval/js/worker-protocol.ts` (the EXISTING protocol — no new protocol). `WorkerHandle` type: until Task 11 exports it from context-manager, declare the structural type locally in `worker.ts` with a `// TODO(Task 11): import from ../js/context-manager` marker — it is structurally identical: `{ mode; send(msg: WorkerInbound): void; onMessage(h): () => void; onError(h): () => void; close(): Promise<boolean>; terminate(): Promise<void> }`.
- Produces (consumed by Tasks 11-13 and by milestone 3's real wiring):
  ```ts
  export interface ElideJsKernelSession {
    send(msg: WorkerInbound): void;
    onMessage(h: (msg: WorkerOutbound) => void): () => void;
    onError(h: (e: Error) => void): () => void;
    interrupt(): Promise<void>;   // abort current cell, context + state survive
    reset(): Promise<void>;       // discard user state, keep engine warmth
    close(): Promise<void>;
  }
  export interface ElideJsKernelFactory {
    open(opts: { cwd: string; sessionId: string }): Promise<ElideJsKernelSession>;
  }
  export function setElideJsKernelFactory(f: ElideJsKernelFactory | undefined): ElideJsKernelFactory | undefined; // returns previous
  export function getElideJsKernelFactory(): ElideJsKernelFactory | undefined;
  ```
  and from `worker.ts`: `export function spawnElideWorker(factory: ElideJsKernelFactory, opts: { cwd: string; sessionId: string; label?: string }): WorkerHandle` with `mode: "elide"`.
- The factory slot is EMPTY in production this milestone — that is the correct scaffold state (`isAvailable()` false).

Contracts the adapter must honor (each is a test):
- Errors are values: `send` never throws; kernel faults surface via the `onError` fan-out.
- `close()` resolves `true` only after a `{type:"closed"}` outbound arrives, bounded by a module close-timeout (default 1000 ms, test-overridable via an exported `setElideWorkerCloseTimeoutMsForTests` mirroring the js context-manager seam); on timeout it resolves `false`.
- `terminate()` is unconditional and idempotent; it calls the kernel session's `close()` best-effort and never rejects.
- NO wall-clock timer derived from any execution budget — cancellation belongs to the host stack above.

- [ ] **Step 1: Write the fake kernel.** `test/eval/elide/fake-kernel.ts`: `createFakeElideJsKernelFactory(options?)` implementing `ElideJsKernelFactory` by constructing the REAL `WorkerCore` from `src/eval/js/worker-core.ts` over an in-memory transport — copy the `spawnInlineWorker` wiring pattern from `src/eval/js/context-manager.ts` (~816-872) (microtask-queue transport, `mode: "inline"`). Knobs: `failOpen?: boolean` (open() rejects), `dropClosed?: boolean` (swallow the `closed` outbound so close() times out), `onInterrupt`/`onReset` counters exposed on the factory for assertions.
- [ ] **Step 2: Write the failing adapter tests** in `elide-worker.test.ts`: (a) handle shape (`mode === "elide"`, all six members present); (b) init/run round-trip: send `{type:"init"}` → `ready` outbound; run a trivial cell → `result` outbound with `ok: true`; (c) `onError` fires when the factory's `open` rejected (spawn path) and when the kernel errors mid-run; (d) `close()` → `true` normally, `false` with `dropClosed` + tiny test timeout; (e) `terminate()` twice → no throw; (f) `send` after `close` → no throw.
- [ ] **Step 3: Implement** `kernel.ts` (types + module-level factory slot) and `worker.ts` (the adapter: lazily opens the kernel session on first `send` — or eagerly in `spawnElideWorker` if simpler, but then `onError` must still deliver async open failures to late subscribers; buffer outbound messages that arrive before the first `onMessage` subscriber exactly like the inline worker does).
- [ ] **Step 4: Run to green.** `bun test packages/coding-agent/test/eval/elide/` → pass, every wait `withTimeout`-bounded.
- [ ] **Step 5: Verify isolation and commit.** `git diff --stat -- packages/coding-agent/src/eval` shows ONLY `src/eval/elide/*` (Task 11 owns the context-manager edit). check:ts clean. Commit: `feat(coding-agent): scaffold the Elide JS kernel seam and worker adapter`.

Acceptance: `test/eval/elide/` green; src/eval diff = elide/ only; check:ts clean.

---

### Task 11: Inject spawnWorker into the JS context manager

**Files:**
- Modify: `packages/coding-agent/src/eval/js/context-manager.ts` ONLY — ≤15 changed lines total
- Modify: `packages/coding-agent/src/eval/elide/worker.ts` (swap the local WorkerHandle type for the newly exported one — this file is fork-owned, doesn't count against the 15)
- Test: extend `packages/coding-agent/test/eval/js-context-manager.test.ts`

**Interfaces:**
- Produces: `export interface WorkerHandle` (was private, ~line 36) with `mode: "process" | "worker" | "inline" | "elide"`; `executeInVmContext` options (~127-140) gain `spawnWorker?: () => WorkerHandle`; `acquireSession` threads it and uses `(spawnWorker ?? spawnJsWorker)()` at the spawn site (~line 362).

**CRITICAL requirement (source-verified gap):** the init-failure ladder at ~lines 384-397 replaces a failed worker with `spawnBunWorker()` / `spawnInlineWorker()`. When `spawnWorker` is INJECTED, init failure must RETHROW — never enter the Bun ladder. Otherwise an Elide session failing init silently runs cells on Bun. Engine-level graceful fallback lives only in `resolveBackend` (Task 12). Implementation shape (counts within the 15 lines): thread a `customSpawn` boolean (or check `spawnWorker !== undefined`) and in the catch branch, `if (customSpawn) throw error;` before the existing ladder logic.

- [ ] **Step 1: Write the failing tests** in `js-context-manager.test.ts`: (a) an injected `spawnWorker` factory is invoked for a fresh session key and the returned handle receives `init`; (b) a second `executeInVmContext` with the same key reuses the live session — factory NOT called again; (c) omitting `spawnWorker` preserves the three-rung ladder (existing `setJsEvalWorkerThreadForTests` cases must remain untouched and green); (d) an injected factory whose worker fails init → the error surfaces to the caller AND no Bun/inline rung was spawned (assert via the fallback-spy seams or a `globalThis.Worker` guard that throws if constructed).
- [ ] **Step 2: Implement the seam.** Export `WorkerHandle`, add `"elide"` to the mode union, add the optional `spawnWorker` option, thread to `acquireSession`, use at the spawn site, add the custom-spawn rethrow in the init-failure catch. One short comment block: injected factories must honor the close/terminate contract; engine separation is by sessionKey prefix, not by this parameter.
- [ ] **Step 3: Run to green.** `bun test packages/coding-agent/test/eval/js-context-manager.test.ts packages/coding-agent/test/eval/kernel-owner-scoping.test.ts packages/coding-agent/test/eval/worker-core.test.ts` → pass.
- [ ] **Step 4: Verify the diff budget.** `git diff --stat -- packages/coding-agent/src/eval/js/context-manager.ts` ≤15 changed lines; total src/eval diff = that file + elide/.
- [ ] **Step 5: Commit.** check:ts clean. Commit: `feat(coding-agent): allow injecting a custom worker factory into the JS eval context manager`.

Acceptance: all listed suites green including the no-ladder-on-injected-failure case; diff budget held; check:ts clean.

---

### Task 12: Elide backend + resolveBackend branch

**Files:**
- Create: `packages/coding-agent/src/eval/elide/executor.ts`, `packages/coding-agent/src/eval/elide/index.ts`
- Modify: `packages/coding-agent/src/tools/eval.ts` (the trailing js branch of `resolveBackend`, ~lines 270-272, plus nothing else)
- Test: create `packages/coding-agent/test/eval/elide/elide-backend-dispatch.test.ts`

**Interfaces:**
- Consumes: `resolveJsEvalEngine` (Task 9), `spawnElideWorker` + `getElideJsKernelFactory` (Task 10), the context-manager seam (Task 11), `ResolvedBackend.notice` (`tools/eval.ts` ~195-198, surfaced via `detailsNotice` ~213-218).
- Produces: `eval/elide/index.ts` default-exports an `ExecutorBackend` with `id: "js"` (NOT a new language), `label: "JavaScript (Elide)"`, `highlightLang: "javascript"`, session prefix `"js-elide:"` via the same `namespaceSessionId` helper the js backend uses, `isAvailable(session) === (resolveJsEvalEngine(session) === "elide" && getElideJsKernelFactory() !== undefined)` — false in production today.
- `executor.ts`: `executeElideJs(code, options)` — near-copy of `src/eval/js/executor.ts` (~77-178) differing ONLY by passing `spawnWorker: () => spawnElideWorker(getElideJsKernelFactory()!, {cwd, sessionId})` into `executeInVmContext`. Same OutputSink wiring, same `isEvalTimeoutControlEvent` filtering (pause/resume reach `onStatus`, never `displayOutputs`), same errors-as-values catch shape (abort → `{exitCode: undefined, cancelled: true}`; other → `{exitCode: 1}`). Do NOT edit `js/executor.ts` — if sharing is tempting, prefer a small local helper inside `eval/elide/`.
- `tools/eval.ts` branch: in the trailing js path, keep `if (!allowJs) throw` unchanged; then when `resolveJsEvalEngine(session) === "elide"`, lazily `await import("../eval/elide")` (lazy = default module graph unchanged) and return `{ backend: elideBackend }` if `await elideBackend.isAvailable(session)`, else `{ backend: jsBackend, notice: "Elide JS engine unavailable; ran on the Bun engine." }`. Do NOT add the elide backend to the `src/eval/index.ts` barrel.

- [ ] **Step 1: Write the failing dispatch tests** in `elide-backend-dispatch.test.ts` (mock/spy on `jsBackend.execute` and the elide backend's execute; use the fake factory from Task 10): (a) default settings → js path, elide never imported/called; (b) `eval.jsEngine="elide"`, no factory installed → jsBackend used AND the exact notice string appears in the tool result details (drive through `EvalTool` like `eval-fallback.test.ts` does); (c) `eval.jsEngine="elide"` + fake factory installed via `setElideJsKernelFactory` → elide backend executes; details language is `js`; (d) `eval.js=false` still throws the same disabled `ToolError` regardless of engine. Restore the factory slot and env in `afterEach`.
- [ ] **Step 2: Implement** executor.ts, index.ts, and the resolveBackend branch.
- [ ] **Step 3: Run to green — including the unmodified upstream suites:** `bun test packages/coding-agent/test/eval/elide/ packages/coding-agent/test/tools/eval-fallback.test.ts packages/coding-agent/test/tools/eval-description.test.ts packages/coding-agent/test/tools/eval-timeout.test.ts` — `eval-description.test.ts` MUST pass without a single edit (proves the engine-not-language design).
- [ ] **Step 4: Commit.** check:ts clean. Commit: `feat(coding-agent): route eval js cells to the Elide backend behind eval.jsEngine`.

Acceptance: all four suites green with zero edits to the three upstream test files; `src/eval/index.ts` untouched; `tools/eval.ts` diff confined to the js branch; check:ts clean.

---

### Task 13: Elide engine parity suite

**Files:**
- Create: `packages/coding-agent/test/eval/elide/elide-engine-parity.test.ts`

**Interfaces:**
- Consumes: `executeElideJs` (Task 12), fake factory (Task 10), `disposeVmContextsByOwner`/`disposeAllVmContexts` from `src/eval/js/context-manager.ts`, owner-scoping helpers from `src/eval/executor-base.ts`.
- Produces: the behavior contract that milestone 3's real-ABI wiring must keep green by swapping ONE line (the factory).

Mirror `test/eval/kernel-owner-scoping.test.ts` idioms. All waits `withTimeout`-bounded. `afterEach`: `disposeAllVmContexts()`, restore factory slot.

- [ ] **Step 1: Write the suite** (these pin behavior that exists after Tasks 10-12; run-to-green, report any failure as a finding):
  1. **State persists** across two `executeElideJs` calls on one sessionId (define a global in cell 1, read it in cell 2).
  2. **reset:true wipes state** (cell 3 with reset → the global is gone).
  3. **Owner-scoped reset forks:** two owners on one `js-elide:` context; `reset` from the non-exclusive owner produces a forked private kernel (`\0fork\0<ownerId>` key behavior: original context keeps its state for the other owner — prove by reading the global as owner A after owner B's reset).
  4. **Disposal is free:** `disposeVmContextsByOwner(ownerId)` — imported from `eval/js/context-manager`, NOT from anything under `eval/elide/` — tears down the elide session (next execute cold-starts: prove via the factory's open-call counter). Also assert `src/eval/elide/` exports NO `dispose*ByOwner` function (read the module's export names in the test).
  5. **Signal-only cancellation:** an aborted `signal` settles the cell `{cancelled: true}` and the fake records terminate/interrupt; AND with a tiny `idleTimeoutMs` (e.g. 5) plus a never-aborting signal, a cell that takes longer than that budget still completes — no self-cancel timer.
  6. **Bridge status routing:** an `EVAL_TIMEOUT_PAUSE_OP` status emitted during the cell reaches `onStatus` but is absent from the result's `displayOutputs`.
  7. **Tool bridge round-trip:** a cell that issues a `tool-call` outbound reaches `callSessionTool` (register a fake tool on the session literal via `getToolByName`) and the reply returns to the guest; the fake tool observes the RAW signal object identity.
  8. **Errors as values:** a throwing cell returns `{exitCode: 1}` with the message in output; nothing throws out of `executeElideJs`.
- [ ] **Step 2: Run to green.** `bun test packages/coding-agent/test/eval/elide/elide-engine-parity.test.ts`.
- [ ] **Step 3: Commit.** `git diff --stat -- packages/coding-agent/src` empty for this task; check:ts clean. Commit: `test(coding-agent): pin Elide engine parity with the Bun eval stack`.

Acceptance: suite green; zero src diff; check:ts clean.

---

### Task 14: Record the ABI-wiring checklist

**Files:**
- Modify: `docs/aura/ELIDE_ALIGNMENT.md` (new section), `packages/coding-agent/src/eval/elide/kernel.ts` (header comment only)

**Interfaces:**
- Consumes: everything Tasks 9-13 landed; the Tier 2 spec in `docs/aura/WHIPLASH_QUEUE.md` (Task 1).

- [ ] **Step 1: Write the section** `### Wiring checklist (when Tier 2 lands)` in ELIDE_ALIGNMENT.md:
  - **Changes (≤4 production files):** (1) new `src/eval/elide/kernel-embedded.ts` (or similar) implementing `ElideJsKernelFactory` over the embedded transport per the WHIPLASH_QUEUE regeneration checklist; (2) one `setElideJsKernelFactory(...)` call at runtime-service construction; (3) guest-side bootstrap that evaluates the WorkerCore+prelude bundle once per persistent context (or the HTTP-loopback tool-bridge variant — record both options with the loopback as v1 per the queue doc's guest→host decision); (4) `docs/settings.md` note that `elide` is functional.
  - **Does not change:** `tools/eval.ts` beyond Task 12; wire schema; eval-render; disposal wiring; the parity suite (must pass by swapping one factory line).
  - **Method↔ask map:** `open`→contextOpen(spec), `send(run)`→contextCall, `onMessage(text/display)`→pollOutput pump, `interrupt`→interrupt op, `reset`→reset op, `close`→contextClose; tool-calls → HTTP loopback (v1) / hostCallPoll (v2).
  - **Known gaps:** `prompts/tools/eval.md` line ~7 promises Bun globals (`Bun.file`, `Bun.$`, `Buffer`) — must become engine-aware or Elide must document a shim subset before the engine defaults on; Python-only concerns (threads spike, getppid) tracked in WHIPLASH_QUEUE.md.
- [ ] **Step 2: Mirror in code.** Add a short header comment in `kernel.ts` pointing at the checklist section.
- [ ] **Step 3: Commit.** check:ts clean. Commit: `docs(aura): record the Tier 2 wiring checklist for the Elide eval backend`.

Acceptance: `grep -n "Wiring checklist" docs/aura/ELIDE_ALIGNMENT.md` hits; checklist enumerates ≤4 production files; kernel.ts header updated; check:ts clean.

---

### Task 15: Benchmark runtime-arm preflight (hard-fail on missing runtime)

**Files:**
- Modify: `packages/metaharness/src/runtime-benchmark-suite.ts` (new probe beside `smokeTypeScriptTaskVerifier`, ~lines 289-322)
- Modify: `packages/metaharness/src/runtime-benchmark.ts` (call site ~line 1490; CLI parsing ~1380-1460)
- Test: extend `packages/metaharness/src/runtime-benchmark.test.ts`

**Interfaces:**
- Produces: `smokeRuntimeArmExecution(opts: { taskRoot: string; runtimeBinary?: string; embeddedLib?: string; runDocker: (args: string[]) => Promise<{exitCode: number; stdout: string; stderr: string}> })` — builds the same task image and executes a NON-JS language (a Python one-liner via the packaged runtime is the default probe) with the injected artifacts mounted at their `sourceMountedRuntimePath` container paths. Non-zero exit or unexpected stdout → throw with a message naming the missing/failing artifact path. New CLI flag `--allow-missing-runtime` downgrades the throw to a stderr warning.

Motivation: a misconfigured run previously measured bash fallback and reported 100% pass. TypeScript cannot be the probe: it passes via the Bun adapter even with the packaged runtime absent (pinned at `runtime-embedded-endpoint.test.ts` ~:387).

- [ ] **Step 1: Write the failing decision-logic tests** (pure functions, injected `runDocker` stub — docker is NEVER invoked in tests): (a) probe skipped entirely when neither `--embedded-lib` nor `--runtime-binary` is set; (b) probe runs when `--embedded-lib` is set; (c) stub exit 1 → throws, message contains the artifact path; (d) unexpected stdout → throws; (e) `--allow-missing-runtime` → warning, no throw; (f) a test asserting the probe's language is not JS/TS (inspect the generated probe command for `python` and assert absence of `ts`/`typescript`/`bun`).
- [ ] **Step 2: Implement** the probe + the `main()` call immediately after `smokeTypeScriptTaskVerifier` (~:1490), gated on artifact injection; wire the CLI flag through `parseRuntimeBenchmarkCli`.
- [ ] **Step 3: Run to green.** `bun --cwd=packages/metaharness test src/runtime-benchmark.test.ts src/runtime-benchmark-suite.test.ts` → pass.
- [ ] **Step 4: Commit.** check:ts clean. Commit: `feat(metaharness): hard-fail the runtime benchmark arm when the runtime is unreachable`.

Acceptance: suite green; probe provably non-JS; flag documented in the CLI help/usage block if one exists; check:ts clean.

---

### Task 16: Force autoDownload off in benchmark containers

**Files:**
- Modify: `packages/metaharness/src/runtime-benchmark.ts` (`buildArmLaunches`, ~lines 237-247)
- Test: extend `packages/metaharness/src/runtime-benchmark.test.ts`

**Interfaces:**
- Consumes: Task 15's changes in the same region (sequence after it).

Motivation: a benchmark must never fetch its own subject mid-run (the auto-download then failed on missing `xz` in ubuntu:24.04 and cost 163 errored calls on one task).

- [ ] **Step 1: Write the failing tests** in the existing arm-construction blocks: when artifacts are injected, the runtime arm's launch args include the auto-download-off override; the baseline arm's args do NOT.
- [ ] **Step 2: Implement.** In the same `if (opts.runtimeBinary || opts.embeddedLib)` block that pushes `AURA_RUNTIME_BIN`/`AURA_RUNTIME_EMBEDDED_LIB`/`AURA_RUNTIME_ADAPTER=auto`, add the settings override that disables `runtime.autoDownload` inside the container. Use the existing mechanism the runner already supports for settings/env injection — check how `AURA_RUNTIME_ADAPTER` reaches settings (`sdk.ts` `readRuntimeSettingsValues` env handling) and mirror it; if only env is viable, add a validated env read next to `runtimeAdapterFromEnvironment` in `src/runtime/index.ts` (~220-231) — do NOT invent a second config channel.
- [ ] **Step 3: Run to green.** `bun --cwd=packages/metaharness test src/runtime-benchmark.test.ts` → pass. If `src/runtime/index.ts` gained an env read, also `bun test packages/coding-agent/test/runtime-settings.test.ts`.
- [ ] **Step 4: Commit.** check:ts clean. Commit: `feat(metaharness): force runtime.autoDownload off inside benchmark containers`.

Acceptance: arm-construction tests green both directions; check:ts clean.

---

### Task 17: Propagate RuntimeRpcError detail through the tool boundary

**Files:**
- Modify: `packages/coding-agent/src/runtime/format.ts` (new `formatRuntimeRpcError`)
- Modify: `packages/coding-agent/src/tools/runtime-run.ts` (~88-105) and the sibling tools sharing the catch shape: `runtime-check.ts`, `runtime-insights.ts`, `runtime-profile.ts`, `jvm-common.ts` or the four `jvm-*.ts` (locate the shared catch; prefer one helper call per tool)
- Test: create `packages/coding-agent/test/runtime-error-details.test.ts`

**Interfaces:**
- Produces: `formatRuntimeRpcError(error: RuntimeRpcError): { text: string; details: Record<string, unknown> }` — renders `code`, `message`, and a REDACTED projection of `error.data`: `argv` joined with spaces; `stderr` tail-capped at 2 KiB; drop absolute paths outside the repo root; never emit env vars.
- Behavior change: runtime tools catch `RuntimeRpcError` and RETURN a failed tool result (`{ content: [{type:"text", text}], details, isError: true }`-shaped per the tool's existing result type) instead of rethrowing. Root cause (verified): `packages/agent/src/agent-loop.ts` ~2540-2546 flattens thrown tool errors to `details:{}` — the fix is fork-local; `packages/agent` MUST NOT be edited.
- Preserved behavior: the retire-on-`internal` branch in `runtime-run.ts` (~92-99, `disposeCachedRuntimeService`) still fires before returning. Non-`RuntimeRpcError` throws are left alone (still thrown).

- [ ] **Step 1: Write the failing tests** in `runtime-error-details.test.ts` with a stub `RuntimeService` throwing `RuntimeRpcError`s: (a) an error with `argv` + `stderr` yields a tool result whose text contains both and whose `details` is non-empty; (b) a 10 KiB stderr is tail-capped at 2 KiB (assert length and that it keeps the TAIL); (c) an error with no `data` still produces a non-empty message; (d) the `internal`-code path still calls the retire function (spy); (e) a non-RuntimeRpcError throw still propagates as a throw.
- [ ] **Step 2: Implement** the formatter + the per-tool catch conversion.
- [ ] **Step 3: Run to green.** `bun test packages/coding-agent/test/runtime-error-details.test.ts packages/coding-agent/test/runtime-run-tool.test.ts packages/coding-agent/test/runtime-check-tool.test.ts packages/coding-agent/test/runtime-insights-profile-tools.test.ts packages/coding-agent/test/runtime-tool-renderers.test.ts` → pass. `git diff --stat -- packages/agent` → empty.
- [ ] **Step 4: Commit.** check:ts clean. Commit: `fix(coding-agent): return runtime RPC failures as detailed tool results instead of bare throws`.

Acceptance: all five suites green; packages/agent untouched; redaction cases pass; check:ts clean.

---

## Milestone merge gate (after Task 17)

```
bun run check:ts
bun run test:ts
AURA_RUNTIME_EMBEDDED_LIB=/home/sam/workspace/aura/out/aura-elide-linux-x64/lib/libelide_embed.so \
  bun test packages/coding-agent/test/runtime-integration.test.ts \
           packages/coding-agent/test/runtime-embedded-integration.test.ts   # 26 pass
bun run bench:runtime --micro-only --micro-iterations 15 --prefix=m1-post \
  --embedded-lib=/home/sam/workspace/aura/out/aura-elide-linux-x64/lib/libelide_embed.so  # record numbers
```

No task touches `src/runtime/embedded/generated/**` or `schema.ts` — any diff there is a review stop.

---

# Addendum (2026-08-11, Sam's directive): retire `run` and `check` immediately

Direction: **prefer OMP's semantics.** The model-facing execution surface is upstream's `eval` (py/js cells) + `bash`. The fork's `run` and `check` tools are retired NOW — not kept as slim tools, not deferred to M4. The runtime service/transport layer STAYS (it backs `insights`, `profile`, `jvm_*`, `serve`, the CLI, and the benchmarks); only the two model-facing tools and their wiring die. Consequence accepted by Sam: JVM compile+run leaves the model surface until a java/kotlin ExecutorBackend lands (M3/M4).

### Task 18: Retire the `run` and `check` tools from the model surface

**Files (locate precisely by symbol; expected set):**
- Delete: `packages/coding-agent/src/tools/runtime-run.ts`, `src/tools/runtime-check.ts`, their entries in `src/tools/index.ts` registration, `src/tools/builtin-names.ts`, `src/tools/essential-tools.ts`, the run/check renderer specs in `src/tools/runtime-renderer.ts` (+ `renderers.ts` spread if per-tool), run/check gallery fixtures, `docs/tools/run.md` + `docs/tools/check.md` (and the docs-coverage test list `test/internal-urls/docs-tool-coverage.test.ts` follows BUILTIN_TOOL_NAMES automatically — verify), any prompt text advertising them.
- Modify: `src/session/agent-session.ts` `executePythonShell` (~:7290-7343) — the `$`/`$$` shell must STOP depending on `getToolByName("run")`. Revert to upstream semantics: route through the upstream CPython kernel path (`#eval`/`executePython`-style, as the non-embedded branch already does). Delete the run-tool executor branch and the `RuntimeRunTool` import; simplify `modes/controllers/{input,command}-controller.ts` gating if the embedded branch's absence makes `isEmbeddedPythonEnabled` checks dead THERE (do not delete the settings keys themselves — `insights`/`profile` still read them; settings collapse is M2/M4).
- Modify: `packages/metaharness` — `ESSENTIAL_RUNTIME_TOOLS` loses `run`/`check` (execution tasks' runtime arm now differentiates on the surviving discoverable tools; the benchmark MEANING shifts — that is intended and gets re-baselined later); update arm-construction tests pinning tool lists. The Task 15 preflight and Task 16 autoDownload work are tool-agnostic — untouched.
- Tests: delete `test/runtime-run-tool.test.ts`, `test/runtime-check-tool.test.ts`; prune run/check cases from `test/runtime-tool-registry.test.ts`, `test/runtime-tool-renderers.test.ts`, `test/runtime-workdir.test.ts`, `test/runtime-error-details.test.ts` (KEEP the formatter/callRuntime coverage — surviving tools use them; re-point the tool-boundary cases at `insights` or `check`→`jvm_*`), re-point `test/agent-session-user-shortcut-hooks.test.ts`'s `$`-python cases at the upstream kernel path, and re-point/drop the run-TOOL-specific cases in `test/runtime-integration.test.ts` (service/endpoint-level cases stay — the 26-test artifact gate must still pass, possibly with a lower count; document the new count).
- MUST NOT change: `src/runtime/{service,protocol}.ts` (service.run stays — benchmarks and insights/profile call it), `src/runtime/transport/**`, `src/runtime/embedded/**`, `packages/agent/**`, `src/eval/**` beyond nothing at all.

**Steps:** locate all references (`grep -rn '"run"' '"check"' RuntimeRunTool RuntimeCheckTool` across src/test/docs/prompts/metaharness); write the failing re-pointed tests first where behavior changes ($-python via upstream kernel); delete/retire; run the full gate: the pruned suites + `bun test packages/coding-agent/test/eval/` + artifact-gated integration (document new count) + `bun --cwd=packages/metaharness test` + `bun run check:ts`. Commit (one or two logical commits, conventional, trailer).

**Acceptance:** `grep -rn '\"run\"\|\"check\"' packages/coding-agent/src/tools/builtin-names.ts packages/coding-agent/src/tools/essential-tools.ts` → no hits; no tool named run/check registered (registry test proves); `$ python` cells execute via the upstream CPython kernel (test proves); all gates green; `git diff --stat -- packages/agent packages/coding-agent/src/eval` empty (except nothing).

### Task 19: Truth-up the handoff docs (retirement + parked residuals)

**Files:** `docs/aura/ELIDE_ALIGNMENT.md`, `docs/aura/ACTIONS_CONSOLIDATE.md`, `docs/aura/FORK.md`, `docs/aura/WHIPLASH_QUEUE.md` (one line), `docs/tools/` index if any.

**Changes:** (1) ELIDE_ALIGNMENT "What must stay fork-owned": remove `run` and `check`; state OMP's eval owns execution semantics; note JVM one-shots return via a java/kotlin ExecutorBackend (M3/M4) and that Tier 2's file+args+stdin+mainScript carrier is the path for file execution through eval; fix Seam 3 text accordingly. (2) Apply the four PARKED residuals from the final review (ledger: wiring-checklist row 4 falsified by the fallback clause — rewrite the row to include deleting the clause when a kernel lands; matrix cell hop-3 mechanism gloss corrected to the pre-construction-window rationale, nested inheritance flows through hop 2; :3490→:3491; lede "two"→"three"). (3) ACTIONS_CONSOLIDATE: mark Phase 1's `run`-consolidation direction SUPERSEDED by the retirement (eval is the single code surface as of this commit; note what remains for M4: settings collapse, rb/jl, Python engine, JVM eval backend). (4) FORK.md: drop/shrink the rows for runtime-run/runtime-check/essential-tools/$-shell embedded routing; keep transport/service rows. (5) WHIPLASH_QUEUE: raise task J's priority note (mainScript now load-bearing for eval file execution). 

**Acceptance:** no doc instructs using or building against the `run`/`check` tools; the four parked findings are closed (cite each fix); check:ts clean; commit with trailer.

**Audit additions (2026-08-11, from the OMP alignment audit — all doc-layer, fold into this task):**
- Fix `docs/telemetry.md:5` + the tier-5 table row: the built-in destination is `https://aura.elide.events` with only an `x-aura-install-id` header, NO Authorization credential (verify against `packages/coding-agent/src/telemetry/init.ts:113-126` before writing). This is a privacy-decision doc; it must match the code exactly.
- Delete `docs/tools/jvm_run.md` (documents a nonexistent tool, advertised to the model via omp://). Extend `test/internal-urls/docs-tool-coverage.test.ts` with the converse assertion: every `docs/tools/*.md` maps to a BUILTIN_TOOL_NAMES entry.
- Branding sweep in user-facing docs: `~/.omp/agent` → `~/.aura/agent`, `<cwd>/.omp` → `<cwd>/.aura` in `docs/settings.md` (:17,:19-20,:24 + YAML examples) and `docs/environment-variables.md`, keeping one explicit "legacy `.omp` is still read, never written" note per file. Also fix `modes/controllers/omfg-controller.ts:35-36` picker labels to template `CONFIG_DIR_NAME` (this is the one CODE edit — two label strings whose paths currently lie to the user).
- FORK.md completeness: add fork-added rows for `src/cloud/` (+test/cloud), `src/telemetry/` (directory row), `packages/utils/src/sqlite-hardening.ts`, `docs/telemetry.md`; add modified-upstream rows for the behavior-bearing unrowed edits (export/share.ts collab-relay default removal, darwin-x64 matrix drop, agent-storage hardening, worker-client import discipline, config-file content signature, ci-test-ts bun workarounds) + one consolidated CI/bazel-migration row; rewrite the ten rows still describing run/check as live (:30,:33,:34,:274, renderer count :25, tool count :86 — reconcile "nine"/"ten" to seven); pin `docs/settings.md:518`'s "All nine tools" to the new count.
- ELIDE_ALIGNMENT/ACTIONS updates from the audit where they intersect this task's existing items (fork-owned table already in scope; note the JVM-tool consolidation direction: one `jvm` tool with an action union, jar-inspect folds into `read`).

### Task 20: Alignment bug wave (guards, gates, naming, help stragglers)

Four small, unambiguous fixes from the alignment audit + Task 19's find. Files/changes:
1. **Plan-mode guard on JVM writes:** `src/tools/jvm-jar.ts` (create path) and `src/tools/jvm-deps.ts` call `enforcePlanModeWrite(session, <output path>)` (from `src/tools/plan-mode-guard.ts:134`) before dispatching, exactly as write/edit do. Tests: plan-mode-active session → both tools' write actions throw the guard error; normal session unaffected.
2. **`launch.enabled` gate on serve:** `RuntimeServeTool.createIf` additionally requires `settings.get("launch.enabled")`; `hubToolAvailable` (`src/tools/runtime-launch.ts:227`) becomes `(session.isToolActive?.("hub") ?? true) && session.settings.get("launch.enabled")` (mirror `bash.ts:593`). Tests: launch.enabled=false → serve absent from registry AND no hub-guidance strings emitted.
3. **`eval.jsEngine` value rename `"elide"` → `"runtime"`** (naming rule: Elide never user-facing; noun is "the runtime"): settings-schema enum/label/description, `JsEvalEngine` type, `AURA_EVAL_JS_ENGINE` validator + message, resolveBackend branch + notice string, elide-backend `isAvailable`, docs/settings.md + docs/environment-variables.md rows, all affected tests (js-engine-setting, elide-backend-dispatch, parity docblocks). The internal directory/file names (`src/eval/elide/`) STAY — code-internal naming is not user-facing.
4. **`--help` straggler:** `src/cli/help-extra.ts:75` drop `run` from the advertised tool list (and audit the surrounding list against `builtin-names.ts`); update the FORK.md:45 note Task 19 left.
Gate: affected suites + `bun run check:ts`. Conventional commits + trailer.

### Task 21: Delete the dead Bun one-shot arm

With `run` retired nothing reaches `engine:"bun"`. Delete: `src/runtime/bun-run-entry.ts`, `src/runtime/transport/bun.ts`, `test/runtime-bun-endpoint.test.ts`, the `BUN_RUN_WORKER_ARG` import + dispatch branch in `src/cli.ts`, the `smokeTestBunRunWorker()` call in the smoke test, the `#bun` field + `engine === "bun"` short-circuit in `src/runtime/transport/selected.ts`, and the `RunEngine`/`LANGUAGE_ENGINES` bun arms in `src/runtime/protocol.ts` IF no survivor references them (verify: insights/profile/jvm paths — if protocol types are shared with checked-in generated schema mappings, leave protocol types and only dead-code the transport; document which). Update runtime-protocol/selected/endpoint tests. VERIFY FIRST with grep + the endpoint adapter-matrix tests which arms die; the JS/TS→Bun-before-adapter-selection routing in `selected.ts` is exactly the behavior being deleted — make sure eval covers those languages' cells (it does — that was the retirement's point) and that `insights`/`profile` for ts/js still route to elide adapters correctly afterward. Gate: runtime suites + 26 artifact tests + check:ts.

### Task 22: Consolidate the JVM tool family

One `jvm` tool with `action: "disassemble"|"format"|"jar"|"deps"` mirroring `RuntimeJvmParams` (protocol already models this — `src/runtime/protocol.ts:110-120`), folding the four tools' params into one flat optional bag; `jar` loses its `inspect` action (upstream `read` owns jar inspection — read-archive already lists/paginates `.jar`); one prompt `prompts/tools/jvm.md` pointing inspection at `read`; one renderer spec; one `docs/tools/jvm.md`; registry/builtin-names/essential updates (7 tools → 4: bash-adjacent count updates in FORK.md + docs). Plan-mode guard from Task 20 carries over into the merged tool. Tests: consolidate the four suites into one action-matrix suite; registry count pins; docs-coverage stays green. Gate: runtime suites + artifact tests + check:ts.

### Task 23: Doctor gate derivation + runtime as a SetupComponent

1. Replace `SETTINGS_GATED_TOOLS`/`SESSION_GATED_TOOL_NAMES` transcription (`src/cli/doctor-cli.ts:642-698`) with empirical derivation: call `BUILTIN_TOOLS[name](stubSession)` (pattern proven by `test/doctor-tool-gate-drift.test.ts`) and report null-returns as gated, keeping the human-readable reason strings as a small optional annotation map that the drift test verifies stays a SUBSET of actual gates (no more full transcription).
2. Register `runtime` as a `SetupComponent` in `src/cli/setup-cli.ts` (`--check` probes adapter/ABI/schema; install path drives `runtime.autoDownload` provisioning — the missing CLI surface). Keep `aura runtime status` as an alias or fold it (implementer judgment, document choice). Update docs/environment-variables + settings docs rows if flags change. Gate: doctor + setup + runtime-cli suites + check:ts.
