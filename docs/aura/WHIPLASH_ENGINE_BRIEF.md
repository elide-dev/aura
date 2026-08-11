# WHIPLASH brief: persistent execution contexts for the embedded runtime

Audience: an agent working in the WHIPLASH repository. Written 2026-08-10 from
the Aura side, updated after two rounds of measurement.

Everything measured here is against `libelide_embed.so` from Elide
`1.4.3+2dbfa3d7d` and `1.4.3+6ada39daa`. Nothing here inspects WHIPLASH source,
so treat "we believe" statements as hypotheses to confirm.

Companion docs (Aura side): `ELIDE_ALIGNMENT.md` (architecture — **read it
before scoping**), `ACTIONS_CONSOLIDATE.md` (tool surface),
`WHIPLASH_QUEUE.md` (the queued, batchable Tier 2 spec derived from this brief).

> **Scope note added after this brief was first written.** Aura's upstream
> (`omp`) already implements, host-side and generalized across four languages,
> the host-callback bridges, incremental output, rich display, timeout hand-off,
> and cancellation semantics that the "drop-in replacement" section below asks
> for. Elide therefore does **not** need to provide those. The narrowed ask is
> in `ELIDE_ALIGNMENT.md` § "Revised Elide ask": persistent addressable
> contexts, guest→host callability during a call, incremental output, externally
> driven cancellation that leaves the context alive, plus the diagnostic
> questions. Treat the detailed contract below as *the semantics Aura will drive
> through your API*, not as a list of features to build.

## TL;DR — the ask

**Add addressable, persistent execution contexts to the embedded runtime,
sufficient to serve as a drop-in replacement for Aura's existing Python
(IPython) and JavaScript (persistent VM) eval kernels.**

We already tried the cheap paths and they are closed:

- `EngineConfig.shared` / `.caching`: we now set both explicitly. **No
  measurable effect on anything.**
- Disabling JIT and rebuilding: **did not help Python, and cost 23–60% on JS/TS
  compute.** Aura recommends restoring JIT; assume JIT-on as the reference
  build unless told otherwise.

Embedded Python holds a **~25 ms floor with a ~1.8–2.0× p95 tail** that is
invariant to every knob we can reach. That is per-call context construction.
Persistent contexts are the fix, and they are also the capability Aura needs to
retire a duplicate tool surface — one change unblocks both.

## What we measured and ruled out

### Engine flags do nothing

Four-cell sweep (`shared` × `caching`) on the quieter JIT-off build:

```
Warm Python startup, embedded p50:  25.12 / 25.29 / 25.13 / 25.30 ms
```

Identical within noise, and the same for every other case. Aura *is* sending
these fields (previously `_initEngineConfig()` was called and left empty, which
we fixed). **Question 1 below asks whether they are read at all.**

### Disabling JIT is a net loss

Absolute embedded p50 — ratios are unusable because `bin/elide` was rebuilt too,
moving the process baseline (native binary 415 MB → 270 MB):

| embedded p50 | JIT-ON | JIT-OFF |
|---|---:|---:|
| Warm Python startup | 26.17 ms | 25.12 ms |
| Python compute | 71.92 ms | 74.86 ms |
| Warm JS startup | 4.49 ms | 4.18 ms |
| JS compute | 14.53 ms | **23.27 ms** |
| TS compute | 15.77 ms | **19.38 ms** |

The process adapter also regressed hard (Python startup 16.18 → 44.18 ms), so
Python's apparent improvement to "1.73×" was baseline degradation, not a gain.

### Where embedded already wins (do not regress these)

| Case | Process p50 | Embedded p50 | Speedup |
|---|---:|---:|---:|
| Warm JS startup | 15.31 ms | 4.49 ms | **3.41×** |
| Warm TS startup | 14.34 ms | 4.76 ms | **3.01×** |
| Cancellation latency | 3.38 ms | 1.17 ms | **2.88×** |
| JS compute | 28.97 ms | 14.53 ms | 1.99× |

And the deterministic micro has **Java compile + run at 0.19×** (410 → 78 ms),
so the JVM path is already excellent. The problem is narrowly short-lived
script execution, worst in Python.

## Primary ask: Tier 2 persistent contexts

### Why the current protocol cannot express this

The request root is `EngineInvocation` → `CliInvocation` with a `RUN`
subcommand and a `SourceCode`/`FileRunInvocation` payload. It is
**invocation-shaped**: every call is semantically a fresh CLI run. There is no
way to say *"evaluate this in the context I used last time"*, so a persistent
kernel cannot be expressed at all.

Aura opens one runtime handle per worker (`elide_embed_runtime_open`) and reuses
it for every `elide_embed_runtime_call`. If a fresh `Context` is constructed per
call beneath that handle, that is the ~25 ms Python floor.

### Requested surface (names illustrative)

- `contextOpen(language, config) -> contextId`
- `contextCall(contextId, source, args, …) -> result` — evaluate in that
  context; globals, imports, and definitions survive across calls
- `contextReset(contextId)` — discard user state, **keep** the context and its
  warm code cache
- `contextClose(contextId)`

One-shot `RUN` invocations must keep working unchanged (ephemeral context under
the hood), so this is purely additive.

### Semantics we need pinned down

- **Isolation.** Multiple contexts alive simultaneously, at minimum one Python
  and one JavaScript concurrently. Resetting one must not disturb another.
- **Reset preserves warmth.** `contextReset` should clear user state but retain
  compiled/cached code, otherwise it is just close+open.
- **Errors are values.** A guest exception (Python traceback, JS throw) must
  return as a result and leave the context usable — not poison it.
- **Idle lifetime.** Do contexts expire? If a context can be reclaimed, Aura
  needs an explicit "context is gone, reopen" error rather than silent
  divergence.
- **Threading.** Aura serializes calls per worker today. If a shared engine
  permits concurrent contexts on separate threads, we can relax that; if not,
  tell us the constraint is intentional.

## Drop-in replacement requires more than contexts

This is the part most likely to be missed. Aura's kernel contract is
`ExecutorBackend` in `packages/coding-agent/src/eval/backend.ts`. Persistent
state is necessary but **not sufficient**. The following are hard requirements
of the surface being replaced:

1. **Streaming output during execution.** The contract passes
   `onChunk(chunk: string)` and output streams to the UI while the cell runs.
   Today's embedded call returns complete stdout/stderr only at completion. This
   needs an incremental output channel, not just a bigger buffer.
2. **Cooperative cancellation that leaves the context alive.** Cancelling a cell
   must behave like Ctrl-C in a REPL: the cell aborts, the kernel survives with
   state intact. Aura's current `elide_embed_runtime_cancel` is per-request and
   pairs with request teardown. Note Aura's cancellation is *entirely*
   `AbortSignal`-driven and is explicitly documented not to derive a competing
   wall-clock timer, so the runtime must not impose its own cell deadline.
3. **Host callbacks from inside a cell.** Eval cells can perform host
   operations — the contract streams `EvalStatusEvent`s for `read`/`write`/
   `agent` and similar, meaning guest code calls back into Aura mid-execution
   (including spawning subagents). A persistent context must support guest→host
   calls during a cell, not only at boundaries. **This is likely the hardest
   requirement; please assess it early.**
4. **Timeout-control signalling.** Because control can leave the runtime and
   enter the host, Aura pauses its watchdog on "timeout-control" status events
   and only counts time while the runtime owns control. We need a way for the
   runtime to signal control hand-off, or an equivalent mechanism.
5. **Rich display outputs.** The result carries
   `displayOutputs: EvalDisplayOutput[]` — the IPython `display_data`
   analogue. A text-only channel is a capability regression for Python.
6. **Availability probe.** `isAvailable()` per language, cheap, used for
   fallback resolution.

If any of 1–5 cannot be met, say so early — Aura would then keep a thin stateful
surface rather than ship a regression, and the consolidation plan changes shape.

## Secondary questions

1. **Are `EngineConfig.shared` and `.caching` honored at all, and what do they
   gate?** We set both and measure nothing. If they are dead fields, we will
   stop sending them.
2. **What does a runtime handle from `elide_embed_runtime_open` map to** — an
   `Engine`, a `Context`, or a pair? Is a fresh `Context` built per
   `elide_embed_runtime_call`?
3. **Does `EngineFlag.ENGINE_OPTIMIZED` control Truffle/Graal JIT, and what is
   the default when `flags` is empty?** Aura never set it, yet disabling JIT at
   build time clearly changed behavior — so the flag is not the JIT switch, and
   we would like to know what it actually does.
4. **Is there per-language pre-initialization** (context pre-init, snapshotting)
   and is Python covered? Python's p95/p50 ≈ 2.0 vs JS's ≈ 1.2 suggests not.
5. **Can `EngineConfig.systemProperties` pass arbitrary Graal/Truffle options
   through?** If yes, Aura can run latency experiments with no WHIPLASH change.

## Constraints from the Aura side

These are pinned by tests in `packages/coding-agent/test/runtime-*.test.ts`:

- ABI version and schema hash are validated at load. The Cap'n Proto schema
  closure is **checked in** and verified byte-for-byte by
  `scripts/sync-embedded-runtime-protocol.ts --check`. **Any schema change
  requires regenerating that closure on the Aura side — coordinate; do not ship
  a protocol change silently.** (Aura's generator also post-processes generated
  TypeScript to add `override` modifiers; that step is idempotent and will carry
  new types automatically.)
- `elide_embed_*` is the sole `bun:ffi` boundary. Buffer ownership is
  test-pinned: caller frees via `elide_embed_buffer_free`. New calls must follow
  the same contract.
- Calls are serialized per worker today; cancellation races, poisoning, and
  ordered shutdown are test-pinned. A native close that fails must keep teardown
  observably failed, never silently succeed.
- Python file execution currently needs a per-call temporary bootstrap file
  because the packaged runtime evaluates Python file input without defining
  `__file__`, argv, or sibling-import roots. **Tier 2 should make that
  workaround deletable** — if you address file-mode semantics, flag it.

## Success criteria

1. Embedded Python warm startup and compute reach **at least parity** with the
   subprocess adapter (today ~25 ms vs 16–18 ms), and Python's p95/p50 ratio
   drops from ~2.0 toward the JS figure (~1.2).
2. Persistent contexts hold state across cells, support per-language reset, and
   satisfy the six drop-in requirements above — so Aura can point `eval`'s
   Python and JS backends at the runtime and delete the separate kernels.
3. **No regression** in JS/TS startup (3.41× / 3.01×), JS compute (1.99×),
   cancellation latency (2.88×), or Java compile+run (0.19×).
4. Aura's `runtime-*` suite stays green, including ABI/schema identity.

Aura verifies 1 and 3 with a model-free adapter sweep
(`bench-engine-matrix.ts`, 4-cell `shared`×`caching`, `--cell=<n>` for
uncontaminated cold-open numbers), so iteration is cheap. Caveats when
comparing: the host is noisy — prefer absolute embedded times over
process-relative ratios, since the process baseline moves whenever `bin/elide`
is rebuilt.
