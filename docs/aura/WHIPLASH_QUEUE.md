# WHIPLASH queue: Elide-side work batched from Aura

**Status: QUEUED — awaiting batch.** Nothing in this document has been built.

| | |
|---|---|
| Target repo | WHIPLASH (Elide runtime) |
| Target worktree | `/home/sam/workspace/worktrees/WHIPLASH-embedded` |
| Base commit | `6ada39daa` ("fix: clang references") — the exact lineage every measurement in `WHIPLASH_ENGINE_BRIEF.md` was taken against |
| Consumer | Aura's coding-agent (`packages/coding-agent/src/runtime/embedded/**`, `src/eval/elide/**`) |
| Companions | `ELIDE_ALIGNMENT.md` (architecture), `WHIPLASH_ENGINE_BRIEF.md` (the original ask), `ACTIONS_CONSOLIDATE.md` (tool surface) |

## How this queue works

1. **Items accumulate here.** Aura discovers an Elide-side need, writes it up as
   a numbered item with decisions, schema, and a test plan. No WHIPLASH commits
   happen at discovery time.
2. **Sam triggers a batch build** from `/home/sam/workspace/worktrees/WHIPLASH-embedded`.
   An implementation agent works the items in this document in the stated order,
   in that worktree, and produces a dist artifact.
3. **The artifact lands** in Aura as `out/aura-elide-*/lib/libelide_embed.so`.
4. **The "Aura-side regeneration checklist"** (last section but one) runs. It is
   written to be executed top-to-bottom by an Aura-side agent with no further
   design work; its ABI pin step is first for a reason (checklist step 1).

Aura's side of this work is sequenced as milestone M-WHIPLASH in the
`2026-08-10-elide-eval-collapse` plan and blocks M3 ("wire the Elide backend").

### Why Tier 2 is queued rather than spiked

An earlier reading of the runtime suggested Aura could prototype persistent
contexts today against `elide_v2_repl_open/eval/interrupt/cancel/close`. **That
is not possible.** The `elide_v2_repl_*` family lives in
`libelide_embed_engine.so`, not in the `libelide_embed.so` facade Aura `dlopen`s
(`packages/coding-agent/src/runtime/embedded/resolve.ts:22-31`,
`embedded/abi.ts:382-393`). That facade's export set is pinned to **exactly
seven symbols** by `tools/scripts/check-embedded-symbols.sh:16-22`:

```
elide_embed_abi_version   elide_embed_buffer_free   elide_embed_runtime_call
elide_embed_runtime_cancel  elide_embed_runtime_close  elide_embed_runtime_open
elide_embed_schema_hash
```

The check fails the build on any *unexpected* export, not just missing ones, so
the repl ABI was never reachable from Aura. "Queue Tier 2 first, then build" is
structurally forced, not merely preferred.

The repl machinery still matters — as **semantic prior art**. `ReplHostEntry.kt`
already proves the two behaviors Tier 2 needs most: `interrupt` leaves guest
state intact (Ctrl-C semantics), and hard `cancel` is `close(true)` + rebuild a
fresh context from the same warm runtime. `protocol/elide/v1/repl.capnp` already
carries the exception/value wire structs that §1.2's `guest.capnp` promotes.

---

## Item 1: Tier 2 persistent execution contexts

**What Aura needs:** addressable, long-lived guest contexts on the embedded ABI —
open a context, evaluate into it repeatedly with globals surviving between
evals, interrupt without destroying it, reset it cheaply, and close it. This is
what makes Elide a viable backend behind omp's `ExecutorBackend` interface
instead of a one-shot process replacement.

**Why it pays:** today `EmbeddedRunSession.run()` builds a **fresh
`GuestContext` per call** — `context = newContext(request)` at
`packages/base/main/dev/elide/runtime/EmbeddedRun.kt:361`, closed in the finally
block. The session holds a persistent `ElideRuntime` (engine warm,
`maxContextPoolSize = 1`, languages pre-initialized via a throwaway context at
open), but the context itself is per-call. That per-call context construction is
the measured ~25 ms Python floor. Tier 2 pays it once per context instead of
once per eval.

### 1.1 Decisions (10)

These are settled. An implementation agent should treat deviations as requiring
a conversation, not a judgment call.

| # | Topic | Decision |
|---|---|---|
| 1 | **Surface** | Extend `embed.capnp` + the `elide_embed_*` family. Do **not** promote the `elide_v2_repl_*` family. The context registry lives in Kotlin; `contextId` rides on capnp; no new C-side state. |
| 2 | **Language scoping** | Per-context `permittedLanguages` via `Context.newBuilder(*langs)`, plus per-context `allowCreateThread`. TypeScript is already a first-class language id on this path (`protocol/elide/v1/engine.capnp:60`, `embed/EmbeddedHostEntry.kt:375`, `runtime/GuestExecution.kt:61`) — **no host-side transpile needed**. |
| 3 | **Streaming** | `pollOutput`, served from a second host thread — the same cross-thread pattern already used by `cancelEmbeddedRequestUntilSettled`. Schema lands complete; the implementation is staged (item I). Bounded ring-buffer pipe, blocking-write backpressure, 16 MiB per-eval cap retained. |
| 4 | **Reset** | Close the context and rebuild from the *same* `ElideRuntime`. Survives a reset: engine, code cache, language pre-initialization. Cost is exactly one of today's per-call context builds — i.e. the ~25 ms Python floor, paid once on reset. Every non-reset eval avoids it entirely. |
| 5 | **Guest→host calls** | v1 = HTTP loopback bridge, which is **zero Elide work** (Aura's existing `ensurePyToolBridge` pattern; Elide's JS has `fetch`). v2 (Tier 2.2, a separate batch — item L) = a `hostCallPoll`/`hostCallResolve` pump over `ProxyExecutable`. The schema lands now and returns `unsupportedOperation` until L ships. |
| 6 | **Cancellation** | A three-rung ladder: `interrupt(timeoutMillis)` = `Context.interrupt`, context and guest state survive → escalate to `cancel` = `close(true)` + rebuild (state gone, runtime still warm) → `contextClose`. **No runtime-imposed deadlines anywhere** — the host owns all wall-clock policy. |
| 7 | **Errors as values** | A new `guest.capnp` carrying `ExceptionSummary` (typeName, message, language, `isSyntaxError`/`isHostWrapped`/`isInternal`/`isCancelled`/`isExit`+`exitStatus`, source location, stack frames, recursive `causedBy`) — **no ANSI escapes anywhere in the wire format**. Guest errors never poison a context; every result carries a `contextAlive` flag. Poisoning taxonomy in §1.5. |
| 8 | **Versioning** | ABI v2, a strict superset of v1. One-shot RUN wire bytes must remain **byte-identical** (guard with a golden-bytes test). Aura pins ABI = 2 exactly (see open question 6, which revisits exact-2 vs. `>= 1`), takes a new schema hash, and its generated closure grows 14 → 15 files (adding `guest.ts`). |
| 9 | **Concurrency** | Serialized per context (a second concurrent eval on the same context returns `busy`); concurrent *across* contexts (threads attach via `elide_embed_attach`); control ops are always concurrent with an in-flight eval. Guaranteed minimum: 1 JS/TS context + 1 Python context alive simultaneously. |
| 10 | **Hygiene** | Deprecate-and-document the dead engine fields; document rather than wire `ENGINE_OPTIMIZED`; add `EmbeddedEvalMode.mainScript`; leave `os.getppid()` unsupported. Full detail in Item 2 (§2.1–2.4). |

### 1.2 Schema additions

All additions to `embed.capnp` are **additive** — no field renumbering, no
removals, no changes to `EmbeddedOpenRequest` / `EmbeddedCallRequest` /
`EmbeddedExecutionResult` / `EmbeddedResponse`'s existing ordinals.

`embed.capnp` already imports `base.capnp`, `engine.capnp`, and
`invocation.capnp` (`:14-17`); these additions need two more:

```capnp
using Env   = import "env.capnp";     # for EnvironmentMap
using Guest = import "guest.capnp";   # new file, below
```

> **On these sketches.** They are the wire *shape* Aura will code against.
> Ordinals are mechanical; Elide owns final numbering. Where a struct is marked
> **(sketch)**, the spec named the struct and its role but not its full field
> set — finalize it Elide-side and Aura repins once (which is exactly why item B
> lands the whole schema in one commit).

#### Context specification and eval mode

```capnp
struct EmbeddedContextSpec {
  # Immutable configuration for one persistent guest context.

  languages         @0 :List(Engine.Language);
  # Permitted languages. Drives Context.newBuilder(*langs) — this is the
  # language-scoping lever from decision 2.

  primaryLanguage   @1 :Engine.Language;
  # Language pre-initialized at open, and the default for evals that omit one.

  allowThreads      @2 :Bool = false;
  # Per-context allowCreateThread. Rejected with invalidRequest when JavaScript
  # or TypeScript appears in `languages` (GraalJS single-thread constraint).

  allowPolyglot     @3 :Bool = false;
  streamOutput      @4 :Bool = false;
  hostCalls         @5 :Bool = false;
  # hostCalls = true returns unsupportedOperation until Tier 2.2 (item L).

  workingDir        @6 :Text;
  environment       @7 :Env.EnvironmentMap;
  # Same representation the one-shot path already uses (invocation.capnp:48).

  outputByteLimit   @8 :UInt64 = 16777216;   # 16 MiB, per eval
  outputChunkBytes  @9 :UInt32 = 65536;      # 64 KiB streaming chunk target

  label            @10 :Text;
  # Host-supplied diagnostic label; echoed in describe. No semantics.
}

enum EmbeddedEvalMode {
  interactive @0;   # REPL cell semantics; last-expression value available
  module      @1;   # module/script semantics
  mainScript  @2;   # entrypoint semantics: sets Python __file__, argv,
                    # sys.path[0] — the mode that lets Aura delete
                    # pythonFileBootstrap (see §2.3)
}
```

#### Eval request

```capnp
struct EmbeddedContextCall {
  protocolVersion    @0 :Base.ProtocolVersion;
  requestId          @1 :UInt64;
  contextId          @2 :UInt64;
  language           @3 :Engine.Language;

  source :union {
    code             @4 :Text;
    file             @5 :Text;
  }

  sourceName         @6 :Text;
  mode               @7 :EmbeddedEvalMode;
  args               @8 :List(Text);
  stdin              @9 :Data;

  captureResultValue @10 :Bool = false;
  # Ships false from Aura in Tier 2; value rendering is out of scope (last §).
}
```

#### Control operations

```capnp
struct EmbeddedContextOpen    { spec @0 :EmbeddedContextSpec; }
struct EmbeddedContextInterrupt { timeoutMillis @0 :UInt32 = 2000; }

struct EmbeddedContextReset {
  preserveWarmth  @0 :Bool = true;   # rebuild from the same ElideRuntime
  reinitPrimary   @1 :Bool = true;   # re-run primary-language preinit
}

struct EmbeddedPollOutput {
  waitMillis @0 :UInt32;   # clamped to <= 1000 Kotlin-side (see §1.3)
  maxBytes   @1 :UInt32;
}

struct EmbeddedHostCallResolve {                        # (sketch — Tier 2.2)
  callId  @0 :UInt64;
  outcome :union {
    value @1 :Data;
    error @2 :Guest.ExceptionSummary;
  }
}

struct EmbeddedControl {
  protocolVersion @0 :Base.ProtocolVersion;
  requestId       @1 :UInt64;
  contextId       @2 :UInt64;   # ignored for `open`

  op :union {
    open            @3 :EmbeddedContextOpen;
    close           @4 :Void;
    interrupt       @5 :EmbeddedContextInterrupt;
    cancel          @6 :Void;
    reset           @7 :EmbeddedContextReset;
    pollOutput      @8 :EmbeddedPollOutput;
    hostCallPoll    @9 :Void;                    # unsupportedOperation until L
    hostCallResolve @10 :EmbeddedHostCallResolve; # unsupportedOperation until L
    describe        @11 :Void;
  }
}
```

#### Response payloads

> **(sketch — the response envelope is Elide's to choose.)** The payloads below
> carry no `protocolVersion`/`requestId` of their own, and the source spec does
> not say whether they attach as new arms on the existing `EmbeddedResponse`
> (`embed.capnp:56-66`, which already carries both) or ride a new response root.
> That choice is deliberately left open here rather than invented. Whatever is
> chosen must (a) preserve `requestId` correlation for every payload, and
> (b) provide a carrier for the `contextAlive` signal on an
> `outputLimitExceeded` outcome — see **open question 9**, which item B must
> settle before the schema lands.

```capnp
struct EmbeddedContextOpened {
  contextId    @0 :UInt64;
  languages    @1 :List(Engine.Language);
  capabilities @2 :EmbeddedCapabilities;
}

struct EmbeddedEvalResult {
  outcome :union {
    ok            @0 :Void;
    error         @1 :Guest.ExceptionSummary;
    cancelled     @2 :Void;
    interrupted   @3 :Void;
  }

  exitCode      @4 :Int32;
  stdout        @5 :Data;   # empty when streamOutput = true
  stderr        @6 :Data;   # empty when streamOutput = true
  outputSeq     @7 :UInt64; # high-water mark of chunks emitted for this eval
  durationNanos @8 :UInt64;

  contextAlive  @9 :Bool;
  # False only when the context was poisoned or closed by this eval. A guest
  # error alone NEVER clears it (decision 7).

  value        @10 :Guest.ValueSummary;   # only when captureResultValue = true
}

struct EmbeddedOutputChunk {                            # (sketch)
  stream @0 :UInt8;   # 0 = stdout, 1 = stderr
  data   @1 :Data;
  seq    @2 :UInt64;
}

struct EmbeddedOutputBatch {
  chunks   @0 :List(EmbeddedOutputChunk);
  seq      @1 :UInt64;   # sequence of the last chunk in this batch
  complete @2 :Bool;     # true once the eval that produced this output settled
}

struct EmbeddedHostCall {                               # (sketch — Tier 2.2)
  callId    @0 :UInt64;
  contextId @1 :UInt64;
  target    @2 :Text;
  args      @3 :List(Data);
}

struct EmbeddedDescription {                            # (sketch)
  contextId    @0 :UInt64;
  state        @1 :Text;   # registry state machine name (§1.4)
  languages    @2 :List(Engine.Language);
  label        @3 :Text;
  capabilities @4 :EmbeddedCapabilities;
  evalCount    @5 :UInt64;
  resetCount   @6 :UInt64;
}

struct EmbeddedCapabilities {                           # (sketch)
  # Feature-flag matrix. Its purpose is that any op the build does not yet
  # implement answers `unsupportedOperation`, never `internal` — so Aura can
  # feature-detect a staged rollout instead of pattern-matching error strings.
  #
  # The spec fixes the ROLE but not the field set; the flags below are a
  # first cut. This is the sketch most worth Elide review, because Aura
  # feature-detects against it — every flag here becomes a branch host-side.

  streaming          @0 :Bool;
  hostCalls          @1 :Bool;
  reset              @2 :Bool;
  interrupt          @3 :Bool;
  mainScriptMode     @4 :Bool;
  captureResultValue @5 :Bool;
  threadedContexts   @6 :Bool;   # set by spike A's outcome (§1.7)
  maxContexts        @7 :UInt32;
  maxOutputBytes     @8 :UInt64;
}
```

#### Failure-code additions

Appended to the existing `EmbeddedFailureCode` enum
(`protocol/elide/v1/embed.capnp:41-49`, which ends at `internal @6`):

```capnp
enum EmbeddedFailureCode {
  invalidRequest        @0;   # existing
  incompatibleProtocol  @1;   # existing
  unsupportedLanguage   @2;   # existing
  busy                  @3;   # existing — also: second eval on a live context
  requestNotActive      @4;   # existing
  closed                @5;   # existing
  internal              @6;   # existing

  unknownContext        @7;   # contextId not in the registry
  unsupportedOperation  @8;   # op valid but not implemented in this build
  contextPoisoned       @9;   # context unusable; host must reset or close
  outputLimitExceeded  @10;   # eval exceeded outputByteLimit
  hostCallRejected     @11;   # host declined / resolve for an unknown callId
  interruptTimedOut    @12;   # interrupt did not land within timeoutMillis
  contextLimitExceeded @13;   # too many live contexts on this session
}
```

#### New file: `protocol/elide/v1/guest.capnp`

`guest.capnp` is a **promotion of structs that already exist in
`repl.capnp:41-91`** (`ValueKind`, `ValueSummary`, `SourceLocation`,
`StackFrame`, `ExceptionSummary`), extended with the flags decision 7 requires.
It is a new top-level schema file so both the embed and repl protocols can
depend on it without either depending on the other; item M later migrates
`repl.capnp` onto it and deletes the duplicates.

```capnp
# New file id; standard Elide proprietary header; then:
using Java   = import "/capnp/java.capnp";
using Engine = import "engine.capnp";

$Java.package("dev.elide.proto.v1");
$Java.outerClassname("GuestProtocol");

enum ValueKind {
  nullValue @0;  boolean @1;  number   @2;  string  @3;
  array     @4;  object  @5;  function @6;  bytes   @7;  foreign @8;
}

struct ValueSummary {
  # Depth-limited representation of a PolyglotValue. No ANSI escapes.
  kind      @0 :ValueKind;
  typeName  @1 :Text;
  preview   @2 :Text;    # single-line, <= 160 chars
  expanded  @3 :Text;    # multi-line pretty-print; empty if none
  truncated @4 :Bool;
}

struct SourceLocation {
  file    @0 :Text;
  line    @1 :UInt32;
  col     @2 :UInt32;
  endLine @3 :UInt32;
  endCol  @4 :UInt32;
}

struct StackFrame {
  function @0 :Text;
  file     @1 :Text;
  line     @2 :UInt32;
  isGuest  @3 :Bool;
  language @4 :Engine.Language;
}

struct ExceptionSummary {
  # Guest/host exception wire representation with a full recursive cause chain.
  # NO ANSI escapes: the host renders. Aura's eval framework formats these
  # itself and must not receive pre-colored text.

  typeName       @0 :Text;    # NEW vs repl.capnp: guest class/type name
  message        @1 :Text;
  language       @2 :Engine.Language;

  isSyntaxError  @3 :Bool;
  isHostWrapped  @4 :Bool;
  isInternal     @5 :Bool;    # NEW: an Elide-internal fault, not guest code
  isCancelled    @6 :Bool;    # NEW: raised by interrupt/cancel
  isExit         @7 :Bool;    # NEW: guest called exit()
  exitStatus     @8 :Int32;   # NEW: meaningful only when isExit

  sourceLocation @9 :SourceLocation;
  stack         @10 :List(StackFrame);
  causedBy      @11 :ExceptionSummary;
}
```

### 1.3 C shim additions

Two new exports in `packages/entry/native/elide_embed.c` (522 lines today), both
near-copies of the existing `elide_embed_runtime_call`:

```c
int32_t elide_embed_context_call(elide_embed_runtime_t runtime,
                                 const uint8_t *request, size_t len,
                                 elide_embed_buffer_t **response);

int32_t elide_embed_context_control(elide_embed_runtime_t runtime,
                                    const uint8_t *request, size_t len,
                                    elide_embed_buffer_t **response);
```

Both keep the caller-frees contract unchanged (`elide_embed_buffer_free`).

- **ABI bump:** `#define ELIDE_EMBED_ABI_VERSION 1u` → `2u` at
  `packages/entry/headers/elide_embed.h:26`.
- **Symbol allowlist:** `tools/scripts/check-embedded-symbols.sh` 7 → 9 symbols
  (the heredoc at `:15-23`). The script `cmp`s expected against actual, so it
  fails on unexpected exports too — the allowlist must be updated in the *same*
  commit as the new exports.

**Two deadlock invariants** — both must be covered by a test, not just asserted:

1. **Session close must wake parked pollers.** A `pollOutput` blocked in its
   wait must return (with `closed`) when the session shuts down. This is
   structurally available today: `elide_embed.c` calls
   `elide_embed_internal_close` at `:457` *before* `elide_embed_wait_and_remove`
   at `:468`. Preserve that ordering.
2. **`waitMillis` is clamped to ≤ 1000 ms Kotlin-side.** A hostile or buggy host
   must not be able to park an isolate thread indefinitely. Clamp on decode, not
   on the C side, so the bound is testable without native code.

### 1.4 Kotlin work, file by file

**New files** (all under `packages/base/main/dev/elide/runtime/`):

| File | Responsibility |
|---|---|
| `embed/EmbeddedContextRegistry.kt` | Context id allocation + per-context state machine: `Idle → Preparing → Running → Resetting → Closing → Closed`, plus `Poisoned`. Owns the "serialized per context, concurrent across contexts" rule (decision 9). |
| `embed/EmbeddedOutputPipe.kt` | Bounded ring-buffer stdout/stderr pipe with blocking-write backpressure; serves `pollOutput`; enforces `outputByteLimit`/`outputChunkBytes`. |
| `embed/EmbeddedErrors.kt` | `PolyglotException` → `guest.capnp` `ExceptionSummary`, including the recursive `causedBy` chain and the `isInternal`/`isCancelled`/`isExit` classification. |
| `embed/EmbeddedHostBridge.kt` | Tier 2.2 only (item L). `ProxyExecutable`-backed host-call pump. |

**Modified files:**

| File | Change |
|---|---|
| `ElideRuntime.kt` | Add `ContextSpec { permittedLanguages, allowCreateThread, allowPolyglotAccess }` and a `newContext(spec)` overload. Today `newContextLocked` hardcodes `.allowCreateThread(false)` and `.allowPolyglotAccess(PolyglotAccess.NONE)` at **`:333-334`**. Capability overrides must be applied **after** the component configurator chain runs, or a component will stomp them. |
| `EmbeddedRun.kt` | Extract `EmbeddedRuntimeHost` — runtime construction, language pre-initialization, and the cleanup discipline — so it is shared by both the one-shot `run()` path and the new context path. Extend the cleanup-step injection seam. **Preserve every existing cleanup path**; this file's finally-block discipline is why the one-shot path is reliable. |
| `EmbeddedCodec.kt` | Decode `EmbeddedContextCall` / `EmbeddedControl`; encode the new response payloads. 475 lines today. |
| `EmbeddedHostEntry.kt` | `contextCall` / `contextControl` dispatch into the registry, plus the two new `@CEntryPoint`s. 591 lines today; the existing session-map pattern is the model to follow. |

### 1.5 Semantics contract

This is what Aura will drive through the API. Behaviors here are load-bearing
for omp's `ExecutorBackend` contract.

**Isolation.** A context is a unit of guest state. Globals, imported modules,
and open guest handles persist across evals in the same context and are
invisible to every other context. Two contexts on one session share only the
`ElideRuntime` (engine, code cache, preinit).

**Language scoping.** `EmbeddedContextSpec.languages` maps directly to
`Context.newBuilder(*langs)`. This is the fix for today's situation, where
contexts are built with `ElideRuntime.newBuilder(*GuestExecution.languages)` —
all languages resident, JS always present, which is what imposes GraalJS's
single-threaded constraint on GraalPy. **`allowThreads = true` is rejected with
`invalidRequest` whenever `languages` contains JavaScript or TypeScript.** It is
not silently downgraded: a host asking for threads in a JS-bearing context has a
bug, and a silent downgrade would hide it behind a mysterious runtime hang.
Whether a JS-free Python context actually *gets* threads is spike A (§1.7).

**Cancellation ladder.** Three rungs, each strictly more destructive:

| Rung | Mechanism | Guest state | Context after |
|---|---|---|---|
| `interrupt(timeoutMillis)` | `Context.interrupt` | **preserved** | alive; `contextAlive = true`; eval returns `interrupted` |
| `cancel` | `close(true)` + rebuild from the same runtime | discarded | alive and warm; `contextAlive = true` |
| `contextClose` | close + deregister | discarded | gone; `unknownContext` thereafter |

If `interrupt` does not land within `timeoutMillis`, it returns
`interruptTimedOut` and the context stays `Running` — the host decides whether
to escalate. **The runtime imposes no deadlines of its own at any rung.** This
matches omp's `ExecutorBackend`, where the `AbortSignal` is the sole
cancellation channel and `idleTimeoutMs` never becomes a wall-clock timer.

**Reset (v1 semantics).** `reset` closes the context and rebuilds it from the
same `ElideRuntime`. **Survives:** the engine, the code cache, language
pre-initialization. **Does not survive:** all guest state. **Cost: exactly one
of today's per-call context builds** — the same ~25 ms Python figure the
benchmarks already measure, now paid once per reset instead of once per eval.
That cost statement is the whole economic argument for Tier 2 and should be
verified by benchmark in item K, not assumed.

**Errors as values.** A guest exception is a *result*, not a transport failure:
it comes back as `EmbeddedEvalResult.outcome.error` with a
`Guest.ExceptionSummary`, `exitCode` set, and `contextAlive = true`. It is never
an `EmbeddedFailure`. Aura's eval framework has the same contract on its side —
backends return `{exitCode: 1, output}` and never throw — so this alignment is
what makes the backend adapter thin. No ANSI escapes appear anywhere in the wire
format; the host renders.

**Poisoning taxonomy.** What survives what:

| Trigger | Poisons | Notes |
|---|---|---|
| Guest error / guest `exit()` | **nothing** | `contextAlive = true`; next eval proceeds normally |
| Output limit exceeded | the **eval** | `outputLimitExceeded`; context stays usable |
| Cleanup failure | the **context** | **Behavior change — see below** |
| Engine / isolate failure | the **session** | unchanged from today |

> **Explicit behavior change.** Today a cleanup failure poisons the **whole
> session**: `EmbeddedRun.kt:596` (`if (poisoned) state = State.Closed`) closes
> the session state machine outright. Under Tier 2 a cleanup failure must be
> narrowed to poison **only the affected context** — that context transitions to
> `Poisoned` and answers `contextPoisoned` until reset or closed, while sibling
> contexts and the session keep running. This is a deliberate narrowing, not a
> refactor artifact, and **it must have its own test** (§1.6). Engine- and
> isolate-level failures still poison the session; only cleanup failures narrow.

**Streaming and backpressure.** With `streamOutput = true`, `stdout`/`stderr` on
`EmbeddedEvalResult` come back empty and output is drained via `pollOutput` from
a second host thread — the same cross-thread pattern
`cancelEmbeddedRequestUntilSettled` already uses. The pipe is a bounded ring
buffer with **blocking-write backpressure**: a guest that outruns the host's
poll loop is slowed down, never silently truncated. Chunks carry a monotonic
`seq` so the host can assert ordering; `EmbeddedOutputBatch.complete` marks the
end of an eval's output. The 16 MiB per-eval cap is retained.

**Idle lifetime is host-owned.** The runtime never reaps an idle context, never
starts a timer, and never closes a context the host did not ask it to close. A
context lives until `contextClose`, session close, or an engine/isolate failure.

**Output limits.** `outputByteLimit` defaults to 16 MiB per eval and
`outputChunkBytes` to 64 KiB. Exceeding the limit fails the *eval* with
`outputLimitExceeded` and leaves the context alive. (Whether the per-context
limit should be raisable above 16 MiB is open question 8.)

### 1.6 WHIPLASH-side test plan

| Area | Test |
|---|---|
| Persistence | Two evals in one context; a global set by the first is visible to the second. |
| Isolation | Two contexts on one session; a global in one is invisible in the other. |
| Language scoping | A Python-only context does not expose JS bindings; `allowThreads = true` with JS/TS in `languages` returns `invalidRequest`. |
| Interrupt | A long-running guest loop, interrupted, returns `interrupted` with `contextAlive = true`; a follow-up eval sees prior globals intact. |
| Interrupt timeout | An uncooperative guest returns `interruptTimedOut` and the context remains `Running`. |
| Cancel vs. interrupt | `cancel` discards globals but the next eval still runs (warm rebuild), distinguishing it from `contextClose`. |
| Reset | Globals gone, engine warmth retained; measure the rebuild cost (feeds item K). |
| Errors as values | Syntax error, runtime error, and `exit(3)` each return `outcome.error` / exit status with `contextAlive = true`; `causedBy` chain populated for a nested throw. |
| **Poisoning narrowing** | Inject a cleanup failure; assert the **context** is `Poisoned` and answers `contextPoisoned`, while a sibling context and the session both stay usable. This is the regression test for the §1.5 behavior change. |
| Concurrency | A second eval on a busy context returns `busy`; concurrent evals on two contexts both complete; control ops succeed while an eval is in flight. |
| Streaming order | Chunk `seq` is strictly monotonic; concatenated chunks equal the buffered-mode bytes for the same program. |
| Backpressure | A guest producing faster than the poller consumes blocks rather than dropping or truncating. |
| **Close while parked** | A thread parked in `pollOutput` is woken by session close and returns `closed` — the §1.3 deadlock invariant. |
| `waitMillis` clamp | A request with `waitMillis` far above 1000 is clamped on decode. |
| Capabilities | Every op the build does not implement returns `unsupportedOperation` and the matching `EmbeddedCapabilities` flag is false. Never `internal`. |
| `mainScript` mode | Python `__file__`, `sys.argv`, and `sys.path[0]` match subprocess-CPython semantics. |
| **Golden bytes** | One-shot RUN request/response wire bytes are byte-identical to v1. This is the guard on decision 8's "strict superset" claim. |
| Native smoke + sanitizer | The two new C exports under ASan/UBSan; buffer ownership unchanged. |
| Benchmarks (item K) | Warm eval, reset cost, streaming throughput, interrupt latency. |

### 1.7 Implementation order (A–M)

| | Item | Size | Notes |
|---|---|---|---|
| **A** | **Spike: Python-only context on a shared engine with `allowCreateThread` — does GraalPy get threads?** | **S** | **🚩 BLOCKING GATE for Python Tier 2.** Nothing about Python scope can be decided before this lands. If the answer is no, the fallback is a separate engine per Python context, which changes the warmth story (and therefore the reset cost) materially. JS/TS work (B–K) is *not* blocked by A. |
| B | `guest.capnp` + `embed.capnp` + Makefile capnpc list + regen + fingerprint | S | **Land the whole schema in ONE commit** so Aura repins exactly once. A partial schema costs Aura a full regeneration cycle per landing. **Prerequisite: answer open question 9** (response-envelope shape + the `outputLimitExceeded`/`contextAlive` carrier) — the schema cannot land whole until it is settled. |
| C | `ElideRuntime.ContextSpec` | S | Overrides applied after the component chain (§1.4). |
| D | `EmbeddedRuntimeHost` extraction + context registry + errors | **L (2–3 d)** | The big one. Preserve every existing cleanup path. |
| E | `EmbeddedCodec.kt` decode/encode | M | |
| F | Host dispatch + the two `@CEntryPoint`s | S | |
| G | C shim + ABI 1u→2u + allowlist 7→9 | S | All three in one commit (§1.3). |
| H | Tests, buffered path | M | Everything in §1.6 except streaming rows. |
| I | `EmbeddedOutputPipe` + `pollOutput` + close-while-parked test | M | |
| J | `mainScript` eval mode | S | Unblocks Aura deleting `pythonFileBootstrap` (§2.3). |
| K | Native smoke + sanitizer + benchmark numbers | S | Warm eval, reset cost, streaming throughput, interrupt latency. These numbers are what the regeneration checklist's no-regression floors get checked against. |
| L | **Tier 2.2** host-call bridge | L | **Separate batch.** Schema already landed in B; ops return `unsupportedOperation` until this ships. |
| M | Migrate `repl.capnp` onto `guest.capnp` | M | **Deferred.** Pure de-duplication; touches the Rust CLI REPL, so it should not ride the same batch as the ABI bump. |

A minimum shippable batch is **B–K** (with A's answer determining whether Python
contexts are in or out of that batch's scope).

---

## Item 2: Dead-field hygiene

Small, independent, and worth batching alongside Item 1 because each one lets
Aura delete code.

### 2.1 `EngineConfig.shared` / `.caching` / `.flags` — deprecate and document

**Evidence:** `packages/base/main/dev/elide/runtime/embed/EmbeddedCodec.kt` reads
`engineConfig` for exactly one thing — `directories.workingDir`, the accessor
chain at **`:247-256`** (`?.meta` → `?.engineConfig` → `?.directories` →
`?.workingDir`). Nothing on the embedded path reads `shared`, `caching`, or
`flags`. Even on the CLI path, `EngineFlag` handling is a **when-block with
empty branches**: `packages/base/main/dev/elide/Entry.kt:294-296` has
`ENGINE_EPSILON -> {}`, `ENGINE_ISOLATE -> {}`, `ENGINE_OPTIMIZED -> {}`.

**Why it matters to Aura:** this explains a flat 4-cell engine-configuration
benchmark sweep that looked like a measurement bug and was actually a
correctly-measured no-op.

**Ask:** mark the fields deprecated in the schema with a comment saying they are
unread on the embedded path, so no future integrator repeats the experiment.

**Aura-side consequence (no Elide work): done.** The `AURA_RUNTIME_ENGINE_*`
experiment env vars are gone and the working-tree `codec.ts` change that plumbed
them was reverted; `packages/coding-agent/src/runtime/embedded/codec.ts:148-153`
now leaves `shared`/`caching`/`flags` at their capnp defaults with the finding
recorded at the code site (commit `a3459bc58`). Nothing further is owed here
unless WHIPLASH starts reading the fields.

### 2.2 `ENGINE_OPTIMIZED` — document, do not wire

JIT/optimizing mode on this path is decided in
`EmbeddedRunSession.initializeHost()` via
`ElideEngine.ensureInitialized(EngineConfig(optimizing = ImageInfo.inImageRuntimeCode()))`
— i.e. by image kind — and is overridable only by the
`elide.runtime.engine.default` system property. The protocol flag is not a
control surface.

**Ask:** document that. Do **not** wire the flag; a host-controllable JIT toggle
is not something Aura wants or needs.

### 2.3 `EmbeddedEvalMode.mainScript` — the `pythonFileBootstrap` deleter

Covered as item J in §1.7 and specified in §1.2. Calling it out separately here
because its *value* is Aura-side: Aura currently prepends a bootstrap preamble
to Python files to fix `__file__`, `sys.argv`, and `sys.path[0]`. A real
entrypoint mode makes `pythonFileBootstrap` deletable outright rather than
merely smaller.

### 2.4 `os.getppid()` — stays unsupported

No change requested. Recording the stance so it is not re-litigated: Elide-backed
Python will not carry `runner.py`'s orphan guard, because there is no child
process to orphan — execution is in-process. `os.getppid()` remaining
unsupported on the Elide path is correct, not a gap.

---

## Open questions for Elide engineering

1. **[BLOCKING — this is spike A]** For a language-restricted context on a
   **shared** engine: does GraalPy escape the JS single-thread constraint when
   JavaScript is absent from `permittedLanguages`? Everything about Python Tier 2
   scope depends on the answer. If no, the fallback is a separate engine per
   Python context, which changes the warmth and reset-cost story.
2. Does the component configurator chain set language options that a
   *restricted* context will reject at `build()`? (I.e. can a Python-only
   context even be built through the existing component chain unmodified?)
3. **Tier 2.2:** does `Context.interrupt` reach a thread parked inside a
   `ProxyExecutable` host call, or is a `TruffleSafepoint` required? There is no
   `TruffleSafepoint` usage in the codebase today, which makes this the single
   biggest unknown in the host-call design.
4. Is `EventLoop.submitFromExternal` the sanctioned path for resolving a guest
   promise from a foreign thread?
5. Does `getBindings(lang)` work under `PolyglotAccess.NONE`?
6. **ABI pin policy:** should Aura pin exact-2 or `>= 1`? Exact-2 is recommended
   (it turns an ABI drift into a loud startup failure rather than a subtle
   behavioral one).
7. `guest.capnp` canonicalization: canonicalize now, or stage it? Staged is
   recommended — canonicalizing while `repl.capnp` still carries duplicate
   definitions (item M is deferred) invites a fingerprint churn Aura has to
   absorb twice.
8. Should the per-context `outputByteLimit` be exposable above 16 MiB, within a
   64 MiB envelope cap? (Aura has no current need; asking before the schema
   ossifies.)
9. **[Must be settled by item B]** **Response envelope for the new payloads.**
   The source spec names the response payloads but not how they reach the host.
   Two sub-questions, both of which change what Aura's codec decodes:
   - **(a) Envelope shape.** Do `EmbeddedContextOpened` / `EmbeddedEvalResult` /
     `EmbeddedOutputBatch` / `EmbeddedHostCall` / `EmbeddedDescription` attach
     as new arms on the existing `EmbeddedResponse` (`embed.capnp:56-66`,
     inheriting its `protocolVersion` + `requestId`), or ride a new response
     root that carries its own? Either is fine for Aura; what is *not* fine is
     leaving it implicit — §1.7 item B ("land the whole schema in ONE commit so
     Aura repins exactly once") and regeneration checklist step 4 ("encode/decode
     the new roots") are both unexecutable until this is answered.
   - **(b) The `outputLimitExceeded` carrier.** §1.5 promises that an eval which
     blows `outputByteLimit` fails the *eval* and leaves the context alive. But
     `EmbeddedEvalResult.outcome` has no arm for it, so as sketched that outcome
     would travel as an `EmbeddedFailure` — which carries no `contextAlive`. The
     prose promise currently has no wire carrier. Fix it either by adding an
     outcome arm, or by giving the failure path a `contextAlive` signal; Elide
     picks, but one of the two is required for §1.5 to be implementable.

---

## Aura-side regeneration checklist

Run this **in order** when the batched build lands. It is Aura-side work only —
no WHIPLASH changes — and it is written to be executable without further design
decisions.

1. **ABI pin FIRST.** `scripts/sync-embedded-runtime-protocol.ts:313-315` —
   `schemaConstants()` hardcodes `EMBEDDED_RUNTIME_ABI_VERSION = 1` (the literal
   is on `:314` as of this writing). Change it to `2` **before** running the
   sync. Doing it after produces a silent pin disagreement: generated files
   regenerate cleanly while the constant still claims v1.
2. **Run the sync.**
   `bun scripts/sync-embedded-runtime-protocol.ts --whiplash /home/sam/workspace/worktrees/WHIPLASH-embedded`
   — the generated closure grows 14 → 15 files (new: `guest.ts`), and
   `schema.ts` is rewritten with the new sha256.
3. **`embedded/abi.ts:46-54`** — add the two new symbols to `EMBEDDED_SYMBOLS`
   with the *same* signature shape as `elide_embed_runtime_call`
   (`args: ["u64", "ptr", "usize", "ptr"], returns: "i32"`), routed through
   `consumeResponse`. The caller-frees buffer contract is unchanged.
4. **`embedded/codec.ts`** — encode/decode the new roots
   (`EmbeddedContextCall`, `EmbeddedControl`, and the response payloads) plus
   the seven new failure codes. **Read the shipped schema, not this doc, for the
   response envelope** — whether the payloads arrive as `EmbeddedResponse` arms
   or under a new root is open question 9, resolved Elide-side in item B.
5. **`eval/js/worker-protocol.ts`** — context-*call* goes on the execution
   worker; context-open/close/interrupt/cancel/reset/poll-output go on the
   **control** worker. This split is what makes control ops concurrent with an
   in-flight eval (decision 9).
6. **`embedded/worker-core.ts`** — route the new ops and add the output-pump
   loop in the control worker.
7. **`eval/elide/kernel.ts`** — implement the factory over the embedded
   transport (the ≤ 4 production files scoped in T3.6), then flip the parity
   suite from the fake factory to the real one.
8. **Tests** — extend `runtime-embedded-{abi,codec,worker,integration}` with:
   state persistence across evals, reset, interrupt-vs-cancel, streaming order,
   and two live contexts.
9. **Benchmarks** — new cases: warm persistent-context eval vs. per-call vs.
   process; Python vs. CPython subprocess (target 16–18 ms); reset cost;
   first-chunk latency; interrupt latency.

   **No-regression floors** (the one-shot path is untouched by Tier 2, so these
   must not move):

   | Case | Floor |
   |---|---|
   | JS warm | 3.4× |
   | TS warm | 3.0× |
   | JS compute | 2.0× |
   | Cancellation | 2.9× |
   | Java | 0.19× |

---

## Out of scope (Tier 2)

Explicitly **not** in this queue item. Listed so an implementation agent does not
scope-creep into them, and so a future reader knows they were considered:

- **Rich display outputs.** Tier 3. `EvalDisplayOutput` stays host-side in omp.
- **Value rendering for Aura.** `captureResultValue` ships `false`; the schema
  field exists so Tier 3 does not need another ABI bump.
- **`bindings` / `inspect` / `parse` / `completion` ops.** These exist in
  `repl.capnp` and are deliberately not promoted.
- **Cross-language binding mirroring.** Contexts are language-scoped by design
  (decision 2); mirroring works against that.
- **Ruby, Java, and Wasm contexts.** JS/TS first, Python gated on spike A.
- **`SessionEvent` async streaming.** Tier 2 streaming is host-polled
  (`pollOutput`), not pushed.
- **REPL-protocol changes.** `repl.capnp` and the Rust CLI REPL are untouched
  until item M, which is deferred.
- **Multi-isolate migration.** One isolate, threads attach via
  `elide_embed_attach`.
