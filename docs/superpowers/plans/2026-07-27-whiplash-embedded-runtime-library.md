# WHIPLASH Embedded Runtime Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Execute this plan before the Aura adapter plan. Work in the WHIPLASH repository at `/home/sam/workspace/labs/WHIPLASH`; keep the Aura repository available for the final cross-repository probe.

**Goal:** Produce a Linux x64 shared-library distribution surface that lets Aura keep one Elide/Graal engine alive and execute isolated JavaScript, TypeScript, and Python `run` requests without launching the Elide CLI for every call.

**Architecture:** WHIPLASH builds a Native Image shared engine (`libelide_embed_engine.so`) plus a small C façade (`libelide_embed.so`). The façade owns Graal isolate attach/detach, opaque runtime handles, stable C allocation, ABI metadata, and forwarding to Kotlin `@CEntryPoint` methods. Kotlin owns one `ElideRuntime`/Graal engine per open handle and creates a fresh guest `Context` for every call. Requests and logical responses use the checked-in Cap'n Proto schema. C integer returns report only ABI/transport failure; guest/configuration failures are serialized responses.

**Tech stack:** Kotlin/JVM and GraalVM Native Image; C11 façade; Cap'n Proto; Bun/TypeScript build system and Bun FFI smoke tests.

**Spec:** `../BREAKDANCE/docs/superpowers/specs/2026-07-27-aura-embedded-runtime-adapter-design.md` (or the same absolute workspace path). This plan implements only WHIPLASH responsibilities from that approved design.

## Scope and non-negotiable contracts

- Initial platform: Linux x64/glibc. Keep filenames/helpers platform-shaped, but do not claim macOS/Windows support until their load-and-run probes pass.
- Initial operation: `run` for JavaScript, TypeScript, and Python. Build/check/insights/profile/JVM/project-advice remain process-backed in Aura.
- One open handle owns one initialized `ElideRuntime` and Graal engine. Every call creates and closes a fresh guest context. No globals, modules, bindings, argv, cwd, env, stdin, or stdio buffers survive between calls.
- One active call per handle. Concurrent calls return a serialized `busy` failure rather than racing the request-scoped context configurator.
- Cancellation is cross-thread: a control caller may invoke `elide_embed_runtime_cancel` while another thread is blocked in `elide_embed_runtime_call`.
- Never route guest stdio through process-global `System.out`/`System.err`; every call supplies byte streams to the context builder.
- Never call the CLI entrypoint or `RunCommand.run()` from the embedded path. Reuse runtime/guest primitives directly.
- Public library names: `libelide_embed.so` façade and `libelide_embed_engine.so` Native Image dependency. Do not use `libelideruntime.so`; that name already belongs to WHIPLASH's Rust/JNI runtime library.
- Public header: `packages/entry/headers/elide_embed.h`, installed as `include/elide_embed.h`.
- ABI version starts at `1`. Schema compatibility is an independent SHA-256 fingerprint.

## Stable C ABI

Add this public shape to `packages/entry/headers/elide_embed.h` (copyright header omitted here; use the repository's existing header):

```c
#ifndef ELIDE_EMBED_H
#define ELIDE_EMBED_H

#include <stddef.h>
#include <stdint.h>

#ifdef _WIN32
#define ELIDE_EMBED_EXPORT __declspec(dllexport)
#else
#define ELIDE_EMBED_EXPORT __attribute__((visibility("default")))
#endif

#define ELIDE_EMBED_ABI_VERSION 1u

typedef uint64_t elide_embed_runtime_t;

typedef struct elide_embed_buffer {
  const uint8_t *data;
  size_t len;
} elide_embed_buffer_t;

typedef enum elide_embed_status {
  ELIDE_EMBED_OK = 0,
  ELIDE_EMBED_INVALID_ARGUMENT = 1,
  ELIDE_EMBED_ISOLATE_ERROR = 2,
  ELIDE_EMBED_UNKNOWN_RUNTIME = 3,
  ELIDE_EMBED_INTERNAL_ERROR = 4
} elide_embed_status_t;

ELIDE_EMBED_EXPORT uint32_t elide_embed_abi_version(void);
ELIDE_EMBED_EXPORT const char *elide_embed_schema_hash(void);

ELIDE_EMBED_EXPORT int32_t elide_embed_runtime_open(
    const uint8_t *request,
    size_t request_len,
    elide_embed_runtime_t *runtime,
    elide_embed_buffer_t **response);

ELIDE_EMBED_EXPORT int32_t elide_embed_runtime_call(
    elide_embed_runtime_t runtime,
    const uint8_t *request,
    size_t request_len,
    elide_embed_buffer_t **response);

ELIDE_EMBED_EXPORT int32_t elide_embed_runtime_cancel(
    elide_embed_runtime_t runtime,
    uint64_t request_id,
    elide_embed_buffer_t **response);

ELIDE_EMBED_EXPORT int32_t elide_embed_runtime_close(
    elide_embed_runtime_t runtime,
    elide_embed_buffer_t **response);

ELIDE_EMBED_EXPORT void elide_embed_buffer_free(elide_embed_buffer_t *buffer);

#endif
```

Ownership and status rules:

- `request` is borrowed for the duration of the call.
- On `ELIDE_EMBED_OK`, `*response` is non-null and owns one Cap'n Proto message. The caller must call `elide_embed_buffer_free` exactly once, including for serialized logical failures.
- `runtime_open` writes a nonzero handle only after isolate creation and Kotlin session initialization succeed. On failure it writes `0`.
- A nonzero C status means the façade could not produce a protocol response (bad pointer, isolate attach failure, unknown handle, allocation failure). It must leave `*response == NULL`.
- `runtime_close` atomically marks the handle closing so new calls/cancels are rejected, asks the Kotlin session to cancel and drain an active call, waits for every façade record reference to be released, then removes the handle and tears down the isolate. Repeated close/call/cancel returns `ELIDE_EMBED_UNKNOWN_RUNTIME`. The close response must be copied into façade-owned `malloc` memory before isolate teardown.
- `buffer_free(NULL)` is a no-op.

## Cap'n Proto wire contract

Create `protocol/elide/v1/embed.capnp`. Import the actual existing `base.capnp`, `engine.capnp`, and `invocation.capnp` definitions. Reuse `Base.ProtocolVersion`, `Engine.Language`, and `Invocation.EngineInvocation`; define only the embedded result envelope because the current schema has no reusable process-execution result.

```capnp
@0xd2a7f4e8c3b6d912;

using Base = import "base.capnp";
using Engine = import "engine.capnp";
using Invocation = import "invocation.capnp";

struct EmbeddedOpenRequest {
  protocolVersion @0 :Base.ProtocolVersion;
  languages @1 :List(Engine.Language);
}

struct EmbeddedCallRequest {
  protocolVersion @0 :Base.ProtocolVersion;
  requestId @1 :UInt64;
  invocation @2 :Invocation.EngineInvocation;
  stdin @3 :Data;
}

struct EmbeddedExecutionResult {
  exitCode @0 :Int32;
  stdout @1 :Data;
  stderr @2 :Data;
  killed @3 :Bool;
}

enum EmbeddedFailureCode {
  invalidRequest @0;
  incompatibleProtocol @1;
  unsupportedLanguage @2;
  busy @3;
  requestNotActive @4;
  closed @5;
  internal @6;
}

struct EmbeddedFailure {
  code @0 :EmbeddedFailureCode;
  message @1 :Text;
}

struct EmbeddedResponse {
  protocolVersion @0 :Base.ProtocolVersion;
  requestId @1 :UInt64;
  union {
    opened @2 :Void;
    completed @3 :EmbeddedExecutionResult;
    cancelled @4 :Void;
    closed @5 :Void;
    failure @6 :EmbeddedFailure;
  }
}
```

Use the next available `protocolVersion` value in `base.capnp`; do not repurpose the existing `v1` ordinal. Keep field ordinals immutable after merge.

Schema fingerprint algorithm (shared with Aura): start at `protocol/elide/v1/embed.capnp`, recursively resolve every project-local relative `.capnp` import under `protocol/elide/v1`, and exclude absolute/toolchain imports such as `/capnp/java.capnp`. Sort the normalized repo-relative paths lexicographically. For each file hash its UTF-8 repo-relative path, one NUL byte, its UTF-8 contents normalized to LF, then one NUL byte. Render lowercase SHA-256 hex. Hashing the transitive closure ensures a change to `Invocation.EngineInvocation` or any imported wire type invalidates the ABI handshake.

---

### Task 1: Add the schema, generated bindings, and fingerprint

**Files:**
- Create: `protocol/elide/v1/embed.capnp`
- Modify: `protocol/elide/v1/base.capnp`
- Modify: `Makefile:249-277` protocol generator input list
- Create: `tools/codegen/embed-schema-hash.mts`
- Modify: `build.mts` codegen registration near `runCodegens`
- Generated: `packages/generated/main/dev/elide/proto/v1/EmbedProtocol.java` (actual capnpc class name is authoritative)
- Generated: `packages/generated/main/dev/elide/proto/v1/EmbeddedSchema.kt`
- Test: `tools/codegen/embed-schema-hash.test.mts`

- [ ] **Step 1: Write the fingerprint test first**

Test a temporary import graph containing `embed.capnp`, direct imports, a nested transitive import, an ignored absolute `/capnp/...` import, and an unrelated schema. CRLF/LF variants must produce identical lowercase 64-character hashes; changing a transitive imported schema must change the hash; changing the unrelated schema must not. Test exported pure functions; do not source-grep generated files.
- [ ] **Step 2: Run the focused failing test**

```bash
cd /home/sam/workspace/labs/WHIPLASH
bun test tools/codegen/embed-schema-hash.test.mts
```

Expected: FAIL because the generator does not exist.

- [ ] **Step 3: Add `embed.capnp` and protocol version**

Use the wire contract above. Add only a new enum value to `ProtocolVersion`; do not reorder existing values.

- [ ] **Step 4: Implement deterministic fingerprint generation**

`tools/codegen/embed-schema-hash.mts` must export:

```ts
export async function collectEmbeddedSchemaFiles(root: string): Promise<string[]>;
export async function computeEmbeddedSchemaHash(root: string): Promise<string>;
export async function writeEmbeddedSchemaHash(root: string): Promise<void>;
```

`collectEmbeddedSchemaFiles` performs the recursive import walk, rejects imports escaping the protocol root, detects missing local imports, deduplicates cycles, and returns sorted repo-relative paths. `writeEmbeddedSchemaHash` writes `packages/generated/main/dev/elide/proto/v1/EmbeddedSchema.kt` with one `internal const val SHA256`, and `packages/entry/headers/elide_embed_schema_hash.h` with one `#define ELIDE_EMBED_SCHEMA_SHA256 "..."`. Use Bun file/hash APIs; do not shell out to `sha256sum`.

- [ ] **Step 5: Register codegen and generate Java/Kotlin artifacts**

Add `embed.capnp` to the existing Java capnpc invocation in `Makefile`. Register the fingerprint writer in `runCodegens` before Kotlin compilation.

```bash
make generate
bun test tools/codegen/embed-schema-hash.test.mts
```

Expected: generated binding exists; fingerprint test passes.

- [ ] **Step 6: Commit**

```bash
git add protocol/elide/v1/base.capnp protocol/elide/v1/embed.capnp Makefile build.mts tools/codegen/embed-schema-hash.mts tools/codegen/embed-schema-hash.test.mts packages/generated/main/dev/elide/proto/v1 packages/entry/headers/elide_embed_schema_hash.h
git commit -m "feat(runtime): define embedded run protocol"
```

---

### Task 2: Extract a reusable isolated guest-run core

**Files:**
- Create: `packages/base/main/dev/elide/runtime/EmbeddedRun.kt`
- Modify: `packages/base/main/dev/elide/lang/javascript/globals/ProcessGlobal.java:615-627`
- Modify: `packages/base/main/dev/elide/lang/javascript/node/worker_threads/NodeWorkers.kt:210-214`
- Test: `packages/base/test/dev/elide/runtime/EmbeddedRunTest.kt`
- Test: existing worker/process argv tests located by LSP/references before rename

`EmbeddedRun` is not an FFI class. It is a normal Kotlin runtime service with testable byte-array inputs:

```kotlin
internal data class EmbeddedRunInput(
  val requestId: ULong,
  val language: String,
  val source: EmbeddedSource,
  val args: List<String>,
  val cwd: Path,
  val environment: Map<String, String>,
  val stdin: ByteArray,
)

internal sealed interface EmbeddedSource {
  data class File(val path: Path) : EmbeddedSource
  data class Inline(val code: String, val name: String) : EmbeddedSource
}

internal data class EmbeddedRunOutput(
  val exitCode: Int,
  val stdout: ByteArray,
  val stderr: ByteArray,
  val cancelled: Boolean,
)

internal class EmbeddedRunSession : AutoCloseable {
  fun run(input: EmbeddedRunInput): EmbeddedRunOutput
  fun cancel(requestId: ULong): Boolean
  override fun close()
}
```

Implementation invariants:

1. Constructor/global initialization follows `ReplHostEntry.open`: initialize localization and `ElideEngine` once, build one `ElideRuntime` from `HardWiredComponentResolver`, and preinitialize enabled languages.
2. Install a runtime context configurator that reads a request-local holder only while `newContext()` runs. It configures cwd, environment, stdin, stdout, stderr, and language arguments. Clear the holder in `finally`.
3. Each `run` allocates new input/output streams and calls `runtime.newContext()`. Always close the context. Never reuse it.
4. For JS/TS, seed `process.argv` directly on the newly created realm before evaluation. Rename `ProcessGlobal.seedWorkerArgv` to `seedArgv`; update the worker-thread caller. The entry is the absolute path for file input and `[eval]` for inline input.
5. Build file sources through `GuestExecution.sourceFromPath`; build inline sources with `Source.newBuilder`, UTF-8, uncached, and the same MIME/language mapping as `RunCommand.resolveInlineSourceType`.
6. Evaluate with `runGuest(raw = true)`, flush Python streams, drain the JS event loop, apply `ProcessLifecycle` exit-code precedence, and emit `exit` once. Factor a small runtime-level helper from `RunCommand` if necessary; do not call `Errors.asExit`, because embedded errors must go to the captured response rather than the terminal.
7. Guard the session with an explicit state machine: `Idle`, `Preparing(requestId)`, `Running(requestId, context)`, `Closing`, `Closed`. `cancel` marks `Preparing` cancelled or calls `context.close(true)` for `Running`. A second concurrent `run` returns a typed busy failure.
8. Guest exceptions become `EmbeddedRunOutput(exitCode = 1, stderr = plain machine-readable error bytes)` using the same plain renderer semantics as CLI `--error-format=plain`.

- [ ] **Step 1: Write lifecycle tests first**

One test per externally observable invariant:

- two sequential JS calls both see a fresh global (`globalThis.marker` from call one is absent in call two);
- `process.argv`, cwd, env, and stdin match each request and do not bleed into the next;
- stdout and stderr are captured separately;
- a thrown guest error returns exit code 1 and a plain `Name: message` header;
- a long JS loop cancelled from a second host thread terminates and marks the result cancelled;
- two concurrent `run` calls make one return busy;
- closing is idempotent and future calls return closed.

- [ ] **Step 2: Run the focused tests and confirm failure**

```bash
make test-jvm TEST=EmbeddedRunTest
```

- [ ] **Step 3: Generalize `seedWorkerArgv` with a symbol-aware rename**

Rename it to `seedArgv`, update `NodeWorkers.kt`, then run the existing JS worker tests plus `EmbeddedRunTest`. Do not leave an alias.

- [ ] **Step 4: Implement the isolated runner**

Keep all request-dependent values out of `ElideRuntime` fields except the short-lived context configuration holder. Ensure `close()` waits for/cancels any active context before closing the runtime.

- [ ] **Step 5: Verify JVM behavior**

```bash
make test-jvm TEST=EmbeddedRunTest
make test-jvm TEST=ProcessGlobal
make test-jvm TEST=NodeWorkers
```

Use the repository's actual matching test names if the latter two filters differ.

- [ ] **Step 6: Commit**

```bash
git add packages/base/main/dev/elide/runtime/EmbeddedRun.kt packages/base/main/dev/elide/lang/javascript/globals/ProcessGlobal.java packages/base/main/dev/elide/lang/javascript/node/worker_threads/NodeWorkers.kt packages/base/test/dev/elide/runtime/EmbeddedRunTest.kt
git commit -m "feat(runtime): execute isolated runs on a shared engine"
```

---

### Task 3: Implement Cap'n Proto host dispatch and native entrypoints

**Files:**
- Create: `packages/base/main/dev/elide/runtime/embed/EmbeddedHostEntry.kt`
- Create: `packages/base/main/dev/elide/runtime/embed/EmbeddedCodec.kt`
- Test: `packages/base/test/dev/elide/runtime/embed/EmbeddedCodecTest.kt`
- Test: `packages/base/test/dev/elide/runtime/embed/EmbeddedHostEntryTest.kt`

`EmbeddedHostEntry` owns a map from an internal Kotlin session id to `EmbeddedRunSession`; the C façade owns the public opaque handle/isolate. Internal native entrypoints use names that cannot be mistaken for the public ABI:

```text
elide_embed_internal_open
elide_embed_internal_call
elide_embed_internal_cancel
elide_embed_internal_close
elide_embed_internal_free
```

Each internal method accepts the Graal `IsolateThread`. Request methods accept a request pointer/length and write a length-prefixed unmanaged response blob. Use one internal response layout: eight-byte little-endian payload length followed by Cap'n Proto bytes. `elide_embed_internal_free` releases that unmanaged allocation.

Dispatch rules:

- Decode with generated Cap'n Proto readers under traversal/nesting limits.
- Validate protocol version before touching runtime state.
- `open` validates requested languages are installed, creates `EmbeddedRunSession`, and returns `opened` plus an internal session id to the C façade through an out parameter.
- `call` maps `EngineInvocation.invocation.cli.command.run.sourceCode`, `scriptArgs`, `meta.engineConfig.directories.workingDir`, `env`, and request stdin into `EmbeddedRunInput`; reject any non-CLI/non-run union.
- Ordinary and nonzero guest exits return `EmbeddedResponse.completed`. A call interrupted by cancellation also completes with `killed = true`, preserving captured output and a stable cancellation exit code.
- `open` and `close` responses use request id `0`; `call` and `cancel` responses echo the call/cancel request id exactly.
- Malformed input, incompatible version, unsupported language, busy, closed session, and host failures return `EmbeddedResponse.failure` with the corresponding code; no stack trace crosses the ABI.
- `cancel` is safe on a thread attached after the call began. It returns `cancelled` only when the request id matched an active/preparing call, otherwise `failure.requestNotActive`.
- `close` removes the Kotlin session before closing it. It is idempotent at the Kotlin layer; the façade determines unknown public handles.

- [ ] **Step 1: Write codec fixtures and failure tests**

Round-trip every union arm and verify malformed/truncated Cap'n Proto input produces `invalidRequest`, not an uncaught exception.

- [ ] **Step 2: Write host lifecycle tests**

Call byte-array test seams rather than raw pointers. Open once, run JS twice, run TS once, run Python when enabled, cancel a long-running JS call, close, and assert the second call's globals are fresh.

- [ ] **Step 3: Run failing tests**

```bash
make test-jvm TEST=EmbeddedCodecTest
make test-jvm TEST=EmbeddedHostEntryTest
```

- [ ] **Step 4: Implement codec and entrypoints**

Keep pointer copying in tiny boundary helpers. All business behavior remains in byte-array methods used by tests.

- [ ] **Step 5: Verify**

```bash
make test-jvm TEST=EmbeddedCodecTest
make test-jvm TEST=EmbeddedHostEntryTest
```

- [ ] **Step 6: Commit**

```bash
git add packages/base/main/dev/elide/runtime/embed packages/base/test/dev/elide/runtime/embed
git commit -m "feat(runtime): expose embedded run dispatch entrypoints"
```

---

### Task 4: Build the Native Image engine and C façade

**Files:**
- Create: `packages/entry/native/elide_embed.c`
- Create: `packages/entry/headers/elide_embed.h`
- Modify: `tools/flags.ts` (or the current build-flag declaration file found by symbol lookup)
- Modify: `tools/settings.mts`
- Modify: `tools/jvm/native-image.mts` only if a library-kind option is cleaner than passing `--shared`
- Modify: `build.mts:1074-1366,3500-3628`
- Modify: `Makefile` to map `EMBEDDED=yes` to `--embedded-library`
- Test: `tools/test/embed-build.test.mts`

Build design:

1. Add `--embedded-library`; `EMBEDDED=yes` passes it from Make. Do not build the second image in ordinary developer builds.
2. Extract the shared Native Image argument construction from `buildStage2Binary` into a helper so the executable and embedded image share language modules, component metadata, resources, reflection configuration, engine mode, locales, and native dependencies.
3. The embedded image adds `--shared`, outputs `libelide_embed_engine.so`, and omits executable-only/static flags (`--static`, `--static-nolibc`, `RunMainInNewThread`, main-symbol rewrite, final executable strip/sign steps).
4. Compile `packages/entry/native/elide_embed.c` after Native Image emits its generated isolate/entrypoint headers. Link it as `libelide_embed.so` against `libelide_embed_engine.so` with `$ORIGIN` rpath. Export only `elide_embed_*`; use a linker version script on Linux.
5. The C façade keeps a mutex/condition-variable-protected map of public `uint64_t` handles to ref-counted `{graal_isolate_t*, state}` records. Never use the raw pointer value as the public handle; use a monotonic nonzero id to reject stale handles.
6. `runtime_call` acquires a record reference and marks one active call before releasing the map lock. `runtime_cancel` takes a transient reference. `runtime_close` atomically marks `Closing`, invokes internal close so Kotlin cancels/drains the active context, waits until call/cancel references are released, removes the map entry, and only then tears down the isolate. New operations after `Closing` begins return unknown-runtime. Never hold the map mutex while entering Kotlin or waiting on guest execution.
7. Every operation obtains the current isolate thread (`graal_get_current_thread`); attach if absent and detach only when this operation attached it. This is what makes control-worker cancellation safe.
8. The façade copies the internal Kotlin length-prefixed result into one `malloc`-allocated `elide_embed_buffer_t + payload`, frees the Kotlin buffer while still attached, then returns. `elide_embed_buffer_free` calls the matching C `free` and requires no live isolate.
9. `runtime_close` copies its response before the ref-count drain and isolate teardown; teardown cannot begin while any FFI operation still owns a record reference.

- [ ] **Step 1: Write build-shape tests**

Test pure helpers for platform filenames and link arguments. The test must exercise helper return values; do not source-grep `build.mts`.

- [ ] **Step 2: Add build flag and shared-image compilation**

```bash
bun test tools/test/embed-build.test.mts
bun run ./tools/entry.ts build --help
```

Expected help includes `--embedded-library`.

- [ ] **Step 3: Implement and compile the C façade**

Build on Linux x64:

```bash
bun run ./tools/entry.ts build --embedded-library
```

Expected artifacts under `.dev/artifacts/native/elide/`:

```text
libelide_embed.so
libelide_embed_engine.so
elide_embed.h
```

- [ ] **Step 4: Inspect symbols and dependencies**

```bash
nm -D --defined-only .dev/artifacts/native/elide/libelide_embed.so
ldd .dev/artifacts/native/elide/libelide_embed.so
```

Expected: all seven public `elide_embed_*` symbols; dependency on sibling `libelide_embed_engine.so`; no unresolved project symbols; `$ORIGIN` resolves after copying both libraries to a temp directory.

- [ ] **Step 5: Run build tests**

```bash
bun test tools/test/embed-build.test.mts
make check-symbols
```

- [ ] **Step 6: Commit**

```bash
git add packages/entry/native/elide_embed.c packages/entry/headers/elide_embed.h tools/flags.ts tools/settings.mts tools/jvm/native-image.mts build.mts Makefile tools/test/embed-build.test.mts
git commit -m "build(runtime): produce embedded shared library"
```

Adjust the `git add` list to the actual flag declaration file; never add unrelated generated/build artifacts.

---

### Task 5: Add real-library ABI and isolation smoke tests

**Files:**
- Create: `tools/test/smoke/embed-library.test.mts`
- Modify: `tools/test/smoke/index.test.mts`
- Optional fixture: `tools/smoketests/embed-import-sibling.ts`

The smoke test uses `bun:ffi` against `.dev/artifacts/native/elide/libelide_embed.so`. It implements only a test-local generated Cap'n Proto client or imports the generated Aura codec after Task 1 of the Aura plan; do not invent JSON ABI shortcuts.

Required cases:

1. ABI version and schema hash match compile-time expectations.
2. Open once; run `console.log("one")`; run a second program that asserts the first call's global is absent.
3. File-backed TypeScript resolves a sibling import from the entry file directory while `process.cwd()` remains the requested cwd.
4. Python prints a value and receives stdin/argv when Python is enabled; otherwise the response is `unsupportedLanguage`, not a crash.
5. Guest exception returns a completed result with nonzero exit and captured plain stderr.
6. Cancellation from a second Bun Worker terminates `while (true) {}`, the blocked call returns `completed.killed = true`, and the library remains usable for a subsequent call.
7. On a second handle, invoke `runtime_close` concurrently with an infinite call and assert close cancels/drains without use-after-free or deadlock.
8. After close, stale call/cancel/close return `ELIDE_EMBED_UNKNOWN_RUNTIME`.
9. Copy both `.so` files to a temp directory and repeat the version/open/call probe to prove rpath relocation.

- [ ] **Step 1: Write the smoke test and register it in `index.test.mts`**

- [ ] **Step 2: Run against the built artifact**

```bash
PYTHON=yes bun test --timeout 120000 tools/test/smoke/embed-library.test.mts
```

- [ ] **Step 3: Run the focused runtime tests**

```bash
make test-jvm TEST=Embedded
bun test tools/codegen/embed-schema-hash.test.mts tools/test/embed-build.test.mts
```

- [ ] **Step 4: Commit**

```bash
git add tools/test/smoke/embed-library.test.mts tools/test/smoke/index.test.mts tools/smoketests
git commit -m "test(runtime): verify embedded library ABI"
```

---

### Task 6: Package the library and document the embedding contract

**Files:**
- Modify: `build.mts:2137-2300` distribution assembly
- Modify: `.github/workflows/job.build.yml:466-480` Linux release invocation
- Modify: `project/packaging/README.txt`
- Test: extend `tools/test/embed-build.test.mts`

Distribution layout:

```text
<dist>/bin/elide
<dist>/lib/libelide_embed.so
<dist>/lib/libelide_embed_engine.so
<dist>/include/elide_embed.h
```

- [ ] **Step 1: Add failing dist-layout assertions**

Test the pure distribution-copy manifest includes both libraries and the public header when embedded artifacts are enabled.

- [ ] **Step 2: Update assembly and Linux release build**

`assembleDist` copies both shared libraries from `.dev/artifacts/native/<output>/`, not from the Cargo `target` directory. Set `EMBEDDED=yes` only for Linux release legs initially. Do not modify macOS/Windows release jobs in this task.

- [ ] **Step 3: Document ABI use and lifecycle**

Append a concise `Embedded C API` section to `project/packaging/README.txt`: artifact names, header, open/call/cancel/close order, Cap'n Proto requirement, buffer ownership, one-active-call rule, and ABI/schema checks. This is API documentation requested by the feature, not a general architecture essay.

- [ ] **Step 4: Build a distribution and inspect it**

```bash
make EMBEDDED=yes DIST=yes build
bun test tools/test/embed-build.test.mts
```

Confirm the three installed files exist under `.dev/artifacts/dist/current` and rerun the relocated smoke test against `current/lib/libelide_embed.so`.

- [ ] **Step 5: Run repository gates**

```bash
make test-jvm TEST=Embedded
PYTHON=yes bun test --timeout 120000 tools/test/smoke/embed-library.test.mts
make check
```

Do not run broad smoke suites until these focused checks pass. Then run the exact native smoke shard used by `job.build.yml` if local dependencies permit.

- [ ] **Step 6: Commit**

```bash
git add build.mts .github/workflows/job.build.yml project/packaging/README.txt tools/test/embed-build.test.mts
git commit -m "build(runtime): package embedded runtime library"
```

---

## WHIPLASH completion gate

Before starting the Aura adapter:

```bash
cd /home/sam/workspace/labs/WHIPLASH
make test-jvm TEST=Embedded
bun test tools/codegen/embed-schema-hash.test.mts tools/test/embed-build.test.mts
PYTHON=yes bun test --timeout 120000 tools/test/smoke/embed-library.test.mts
make EMBEDDED=yes DIST=yes build
```

Record these exact values for the Aura plan:

```text
library: /home/sam/workspace/labs/WHIPLASH/.dev/artifacts/dist/current/lib/libelide_embed.so
ABI version: 1
schema SHA-256: <elide_embed_schema_hash()>
```

Do not proceed if any of these hold:

- the façade requires symbols from the executable;
- the library only works in its build directory but not a copied temp directory;
- cancellation cannot interrupt a blocking call from another worker/thread;
- call two observes globals/modules/argv/env/stdout from call one;
- logical guest failures escape as C transport errors;
- the close response becomes invalid after isolate teardown.
