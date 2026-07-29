# Aura embedded runtime adapter — design

**Date:** 2026-07-27
**Status:** approved design, pre-implementation
**Repos:** BREAKDANCE (Aura/OMP fork) and WHIPLASH (runtime source/build)

## Summary

Aura adds an opt-in embedded adapter for `runtime/run`. The adapter loads a
WHIPLASH-produced `libelideengine` into the Aura process, keeps one GraalVM
Native Image isolate and one Elide runtime/engine warm, and creates a fresh
guest context for every call. All other runtime methods continue through the
existing per-call process endpoint.

WHIPLASH already contains the required architecture in two forms:

- the final CLI calls the Cap'n Proto-based `elide_engine_v2_entry` ABI from a
  Rust launcher; and
- the in-process REPL keeps an isolate and engine alive through
  `elide_v2_repl_open/eval/interrupt/cancel/close`.

The implementation extends the REPL host pattern with a structured run-session
ABI. It does not introduce a second native allocation protocol, call the
one-shot CLI entry repeatedly, or treat the helper `libelideruntime` cdylib as
the guest engine.

## Goals

- Reduce repeated `runtime/run` startup cost by amortizing shared-library load,
  Native Image isolate creation, runtime component resolution, language-engine
  creation, and warmed engine code.
- Preserve the current clean-call contract: no guest globals, module cache,
  bindings, open handles, or context-local state survive into the next run.
- Preserve `RuntimeRunParams`: inline or file-backed source, language, guest
  arguments, stdin, environment, cwd, timeout/abort, stdout, stderr, and exit
  code.
- Keep tools and `RuntimeService` independent of dispatch mechanism.
- Reuse WHIPLASH's Cap'n Proto protocol, caller-owned output-buffer convention,
  isolate lifecycle, and cross-thread cancellation pattern.
- Make adapter selection observable and deterministic. Explicit embedded mode
  never silently falls back to a subprocess.

## Non-goals

- Embedding `check`, `build`, `insights`, `profile`, JVM tools, `serve`, or
  `runtime_debug` in the first version.
- Preserving guest state between calls.
- Concurrent guest execution within one embedded engine.
- Native crash isolation. A fault in the loaded runtime terminates Aura.
- Loading the currently published `libelideruntime.so`; it is a Rust/JNI helper,
  not the Native Image guest engine.
- Replacing the existing process adapter or auto-download path.

## 1. Confirmed WHIPLASH baseline

### 1.1 Native-image and CLI assembly

On Linux and most targets, `buildStage2Binary` creates a Native Image executable
and leaves `elide.o` in its temporary output. `linkStaticLibrary` archives that
object into `libelideengine.a` and renames `main` to
`elide_engine_v2_main`. The phase-three Rust build links that archive into the
final `elide` CLI.

On macOS arm64, Native Image already receives `--shared`; the build retains and
renames `elide.dylib` to `libelideengine.dylib`, and the Rust launcher loads the
dynamic engine because a static link exceeds branch-displacement limits.

Relevant sources:

- `WHIPLASH/build.mts`: `buildStage2Binary`, `linkStaticLibrary`,
  `prepareDynamicLibraryDarwin`, and final stage-one assembly.
- `WHIPLASH/tools/settings.mts`: `nativeFlagsByOsBinOnly` currently gates
  `--shared` to macOS arm64.
- `WHIPLASH/packages/entry/build.rs`: selects static or dynamic engine linkage.

Linux therefore has the source ABI and Native Image object, but no retained
`libelideengine.so` in the current checkout. Producing and staging that artifact
is required before Aura can load it.

### 1.2 One-shot engine entry

`elide_engine_v2_entry` accepts a Graal isolate thread, process arguments,
protocol version/format, tenant, and a serialized Cap'n Proto
`EngineInvocation`. It is the correct CLI boundary but the wrong reusable host
boundary:

- `Entry.kt` runs `Engine.initialize()` on entry;
- `Engine.initialize()` rejects a second initialization in one isolate;
- `RunCommand` creates a new `ElideRuntime` and Graal engine for each command;
- output is process-shaped rather than returned as a response; and
- CLI/global state is initialized around process lifetime.

Repeated calls to this entrypoint in one isolate would neither preserve its
invariants nor provide warm-engine/fresh-context semantics.

The checked-in `packages/entry/headers/elide_engine_v2.h` is also behind the
actual declarations: it omits `argc`/`argv` and the teardown, resolver, Maven,
and REPL entrypoints. Generated/staged headers must become authoritative before
external loading is supported.

### 1.3 Reusable REPL host

`ReplHostEntry.kt` and `crates/repl/src/engine/graaljs.rs` prove the desired host
shape:

- one long-lived Native Image isolate;
- one `ElideRuntime`/Graal engine;
- a context owned by an opaque handle;
- caller-provided response buffers;
- Cap'n Proto `EvalResult` with captured stdout/stderr;
- context replacement on cancel; and
- interrupt/cancel from an attached isolate thread.

The REPL ABI is not itself a complete `runtime/run` implementation. It accepts
inline code and language only, uses REPL source semantics, and intentionally
preserves bindings between evaluations. It is suitable for the first FFI proof
but not for production routing.

## 2. Runtime artifact

WHIPLASH will expose the Native Image guest engine as a retained platform
library:

- Linux: `libelideengine.so`
- macOS: `libelideengine.dylib`
- Windows: `elideengine.dll`

The preferred build makes the shared image a first-class Native Image output and
continues deriving the static archive/final CLI from the same generated image
object. This must be proven on each linker/toolchain. If a platform cannot use
the shared-image object in the static CLI link, WHIPLASH may perform a sibling
shared-image compilation for that platform; the ABI and generated protocol must
remain identical.

Linux embedded artifacts must target the host libc/ABI Aura runs on. A static or
musl-oriented CLI image is not assumed to be `dlopen`-compatible with a glibc
Aura process. Artifact naming and distribution distinguish the embedded host
library from the portable CLI distribution.

WHIPLASH stages together:

1. the engine shared library;
2. its dependent runtime resources and native libraries;
3. the generated C header;
4. the canonical Cap'n Proto schema identity/version; and
5. build metadata identifying runtime version, target triple, and ABI version.

The CLI and embedded artifact are products of the same source revision. The
existing CLI remains supported and continues to use static linkage where that
is the better distribution shape.

## 3. Native run-session ABI

WHIPLASH adds a sibling ABI following the established REPL conventions:

```c
uint32_t elide_v2_host_abi_version(void);

int64_t elide_v2_run_open(
    graal_isolatethread_t *thread,
    const char *binpath);

int32_t elide_v2_run_call(
    graal_isolatethread_t *thread,
    int64_t handle,
    uint8_t protocol_version,
    uint8_t protocol_format,
    const uint8_t *request,
    int32_t request_len,
    uint8_t *response,
    int32_t response_cap);

int32_t elide_v2_run_interrupt(
    graal_isolatethread_t *thread,
    int64_t handle,
    int32_t timeout_ms);

int32_t elide_v2_run_cancel(
    graal_isolatethread_t *thread,
    int64_t handle);

int32_t elide_v2_run_close(
    graal_isolatethread_t *thread,
    int64_t handle);
```

The exact generated integer typedefs may vary by platform, but symbol names,
widths, ownership, and return semantics are stable.

### 3.1 Ownership and return values

- The host owns request and response memory.
- `run_call` copies/decodes request bytes before returning.
- A non-negative `run_call` return is the number of response bytes written.
- If the response buffer is too small, `run_call` returns the negative required
  capacity, matching `elide_v2_repl_eval`.
- Stable small negative values are reserved for ABI failures such as unknown
  handle, unsupported protocol, or invalid request. Ordinary guest failures are
  successful ABI calls represented in `RunResult`.
- `run_open` returns a positive opaque handle. Stable negative values identify
  initialization failures.
- `interrupt`, `cancel`, and `close` return zero on success and stable negative
  error codes otherwise.
- No native response allocator and no cross-runtime `buffer_free` API are
  introduced.

### 3.2 Compatibility

Aura resolves every required symbol before creating an isolate and checks
`elide_v2_host_abi_version()`. Every request also carries WHIPLASH's existing
protocol version and format. A mismatch fails adapter initialization or the
specific call with a typed compatibility error; it never falls back silently.

The generated header includes the Graal isolate lifecycle, one-shot entry,
run-session, and REPL entrypoints actually exported by the image. A build check
compares generated declarations with the staged header so the current header
cannot drift again.

## 4. Cap'n Proto wire contract

The canonical schema remains in WHIPLASH. Aura consumes generated TypeScript
codecs from that schema; it does not hand-roll Cap'n Proto framing or maintain a
second manually translated schema.

### 4.1 Run request

A new embedding envelope carries:

- `requestId`;
- the existing `EngineInvocation`;
- explicit working directory;
- stdin bytes; and
- reserved fields for additive evolution.

`EngineInvocation` remains the source of truth for inline/file source,
source-language hint, guest arguments, environment, run flags, and project
information. Working directory and stdin are explicit because the existing CLI
obtains them from process state and they are absent from the invocation schema.

### 4.2 Run result

The response carries:

- `requestId`;
- process-compatible exit code;
- stdout bytes;
- stderr bytes;
- an optional structured dispatch error; and
- optional duration metadata for diagnostics.

A guest syntax/runtime failure normally has a nonzero exit code and captured
output, matching subprocess behavior. A malformed request, incompatible schema,
or host initialization failure uses the structured dispatch-error branch.

## 5. WHIPLASH execution lifecycle

### 5.1 Open

`run_open` performs isolate-local initialization once and creates a host session
containing one `ElideRuntime` and its Graal engine. It enables the installed
languages needed by `runtime/run` but creates no persistent guest context.
Global setup currently embedded in the CLI entry path is split so reusable host
initialization is idempotent and independent of process argv/stdout/cwd.

### 5.2 Call

Runs are serialized per handle. For each request, `run_call`:

1. validates and decodes the envelope;
2. resolves file or inline source through the same implementation as
   `elide run`;
3. binds guest arguments, environment, stdin, cwd, filesystem access, and
   output streams through context/runtime configuration rather than
   process-global mutation;
4. creates a fresh context on the session's existing engine;
5. evaluates through the shared `RunCommand` execution core;
6. waits for the same completion semantics as the CLI path;
7. flushes buffered guest streams, including GraalPy;
8. closes the context and clears the session's current-context reference; and
9. serializes `RunResult` into the caller buffer.

The implementation extracts reusable execution logic from `RunCommand`. It does
not copy the evaluator or invoke `Command.parseAndRun`, because the latter owns
CLI/process initialization and constructs a new engine.

No per-run setting mutates JVM process globals. A field that cannot be safely
made context/session-local is either fixed at `run_open` or rejected as
unsupported by the embedded adapter.

### 5.3 Interrupt and cancel

The session exposes its current context through a concurrency-safe reference.

- `interrupt` requests Graal cooperative interruption with the supplied grace
  period.
- `cancel` closes the current context with cancellation and unblocks
  `run_call`.
- The next call always creates a new context; cancel does not need to construct
  one on the control thread.

Both functions are safe from a thread attached to the same Native Image isolate,
following the existing REPL implementation.

### 5.4 Close

`run_close` rejects new calls, cancels an active context if necessary, closes
runtime components and the shared engine, and removes the handle. Aura then
tears down the isolate. Server, Maven, and other modes capable of leaving
long-lived transport threads are outside this adapter, keeping teardown aligned
with the already-working REPL host lifecycle.

## 6. Aura architecture

### 6.1 Endpoint routing

`RuntimeService` remains the only tool-facing API. A routed endpoint delegates:

- `runtime/run` -> `EmbeddedRunEndpoint` when configured;
- every other method -> existing `LocalRuntimeEndpoint`.

The `run` tool, protocol types, renderers, approval behavior, and tool registry do
not branch on adapter type.

### 6.2 Worker topology

Bun FFI calls are synchronous. Aura uses two dedicated workers:

```text
RuntimeService
  -> RoutedRuntimeEndpoint
       -> EmbeddedRunEndpoint
            |-- engine worker
            |     dlopen -> create isolate -> run_open
            |     serialized run_call requests
            |     run_close -> tear down isolate
            |
            `-- control worker
                  dlopen same image
                  attach to isolate
                  interrupt/cancel
                  detach from isolate
```

The engine worker publishes the isolate pointer and run handle as process-local
opaque integer values to the control worker. They are never persisted or exposed
to model/tool output. The engine worker owns normal calls and final teardown.
The control worker exists because a worker blocked inside synchronous
`run_call` cannot process an abort message.

The implementation follows the repository's worker-host rule: both worker kinds
receive hidden `cli.ts` selectors and retain direct-module fallbacks for tests or
SDK embedding. New selectors are added to the central CLI dispatch table and
covered by the compiled-binary smoke probe.

### 6.3 Adapter interface

FFI mechanics stay behind an internal bridge so endpoint tests can use a fake
bridge without loading native code. The bridge is responsible for:

- library loading and symbol validation;
- isolate creation/attachment/detachment/teardown;
- request/response buffer growth;
- Cap'n Proto encoding/decoding;
- serialization of calls;
- abort escalation; and
- worker failure mapping.

A worker exit, malformed native result, symbol mismatch, or failed isolate
operation becomes a typed `RuntimeRpcError`; raw native details are logged, not
written into the TUI unsanitized.

## 7. Configuration and resolution

Initial settings:

```yaml
runtime:
  adapter: process       # process | embedded
  embeddedPath: /absolute/path/to/libelideengine.so
```

Rules:

- `process` remains the default until embedded mode passes cross-platform soak
  and benchmark gates.
- `embedded` requires a compatible shared library and resources. Initialization
  failure is explicit.
- `runtime.path` continues to identify the CLI used by the process adapter.
- The embedded artifact is not inferred from the current public runtime install,
  whose distribution does not yet stage this engine library.
- `runtime/status` reports the selected adapter, resolved library, ABI/protocol
  versions, and readiness without exposing the internal Elide name in ordinary
  user-facing prose.
- An environment override may be added for development, following the existing
  `AURA_RUNTIME_*` naming convention; the setting remains canonical.

No automatic adapter fallback is allowed in explicit embedded mode, especially
in benchmarks.

## 8. Concurrency, isolation, and safety

- One embedded endpoint executes one run at a time. Additional calls queue in
  arrival order.
- Each call receives a fresh Graal context but shares the engine and isolate.
- Context closure is mandatory on success, guest failure, timeout, cancellation,
  serialization failure, and worker shutdown.
- Per-call cwd/environment/stdin/output are context-local. Aura's process cwd,
  environment, stdout, stderr, and signal handlers are not replaced.
- The embedded runtime has Aura's OS privileges. Existing Elide guest capability
  controls still apply, but embedding is not a stronger sandbox.
- A guest or native bug that crashes the engine can crash Aura. This is an
  accepted opt-in tradeoff and must be stated in settings/help.
- If a cancelled context cannot be closed or the isolate becomes unhealthy, the
  endpoint marks itself failed and recreates the worker pair/isolate before a
  later call; it does not reuse questionable native state.

## 9. Delivery sequence

### Phase A — WHIPLASH FFI proof

1. Retain a Linux x64 shared engine artifact and complete the generated header.
2. Load it from a small Bun FFI probe.
3. Exercise existing `elide_v2_repl_open/eval/cancel/eval/close`.
4. Verify the second evaluation has fresh bindings after cancel and lower warm
   latency than a new process.
5. Exercise interrupt from a separately attached control thread/worker.

This is a proof only; Aura does not route production `runtime/run` through REPL
semantics.

### Phase B — WHIPLASH run host

1. Add request/result schema and generated codecs/header.
2. Extract the reusable execution core from `RunCommand`.
3. Add `elide_v2_run_*` with persistent engine/fresh context behavior.
4. Verify inline/file JS, TS, and Python; cwd; sibling imports; args; stdin; env;
   stdout/stderr; nonzero exits; repeated isolation; timeout; cancel; and close.
5. Stage the shared artifact and metadata.

### Phase C — Aura adapter

1. Add FFI bridge and engine/control worker selectors.
2. Add `EmbeddedRunEndpoint` and routing.
3. Add settings/status reporting and explicit compatibility errors.
4. Run the same `RuntimeService.run` contract suite against process and embedded
   endpoints.
5. Add a compiled-Aura smoke that loads the shared artifact and performs two
   isolated calls plus cancellation.

### Phase D — benchmark and rollout

1. Run deterministic runtime microbenchmarks for process cold calls, embedded
   first call, and embedded warm calls.
2. Run matched metaharness process-vs-embedded arms with identical model,
   prompts, task order, and attempts.
3. Compare success, runtime-tool use, latency, failures, tokens, and cost.
4. Keep embedded mode opt-in until Linux soak is clean; then add macOS and
   Windows artifacts before considering `auto` selection.

## 10. Verification gates

WHIPLASH gates:

- exported-symbol/header parity;
- ABI/protocol mismatch rejection;
- persistent engine with a fresh context per call;
- no binding/module-state leakage across calls;
- exact cwd/env/stdin/args behavior;
- captured output and exit-code parity with CLI execution;
- cooperative interrupt and forced cancel from an attached thread;
- context cleanup on every terminal path;
- repeated open/run/close and isolate teardown; and
- final CLI still links and behaves normally from the static artifact.

Aura gates:

- routed endpoint sends only `runtime/run` to embedded mode;
- all other methods remain on the process endpoint;
- explicit embedded mode never falls back;
- worker startup, crash, timeout, abort, and shutdown map to typed errors;
- live and rebuilt TUI paths render sanitized results identically;
- source, compiled binary, and install smoke paths can start both workers; and
- process and embedded adapters satisfy the same observable run contract.

Benchmark acceptance is not raw speed alone. Embedded mode must preserve
correctness and materially reduce warm-call overhead without increasing agent
failure rate. Exact thresholds are set after Phase A establishes realistic
Linux measurements.

## 11. Principal risks

- **Shared/static image divergence:** deriving both artifacts from one Native
  Image object may not work on every linker. Gate the preferred one-build path;
  use a sibling shared compilation where necessary.
- **Process-global state:** CLI initialization currently assumes one process per
  call. The run host must make per-call data context-local rather than resetting
  globals after the fact.
- **Cancellation races:** control calls can race normal completion. Session state
  transitions must make close/cancel idempotent and prevent a stale control
  request from cancelling the next run.
- **Native teardown:** a leaked transport or guest thread can stall isolate
  teardown. The run host excludes long-lived command modes and must fail closed
  after an unhealthy cancellation.
- **Wire drift:** two repositories consume one schema. Generated codecs, schema
  identity, ABI metadata, and compatibility tests are required; handwritten
  mirrors are prohibited.
- **Crash blast radius:** in-process speed trades away subprocess crash
  isolation. The process adapter remains available and default during rollout.
