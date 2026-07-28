# Aura Embedded Runtime Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Complete `2026-07-27-whiplash-embedded-runtime-library.md` first and keep its built distribution available. Execute this plan in `/home/sam/workspace/labs/BREAKDANCE`.

**Goal:** Route JavaScript, TypeScript, and Python `run` calls through WHIPLASH's in-process Cap'n Proto/C ABI so one engine is initialized per Aura CLI session, while preserving the process adapter for every existing runtime method and as the default rollout mode.

**Architecture:** `RuntimeService` remains the only tool-facing surface. A selected/composite endpoint routes eligible `runtime/run` requests to an `EmbeddedRuntimeEndpoint` and all other methods/languages to the existing `LocalRuntimeEndpoint`. The embedded endpoint speaks Cap'n Proto to a dedicated Bun execution Worker which owns `dlopen`, runtime open/call/close, response copies, and buffer frees. A second tiny control Worker loads the same absolute library solely to call `runtime_cancel`; this is required because Bun FFI calls are synchronous and the execution Worker's event loop cannot process a cancel message while blocked. Both Workers share the same process-mapped library and native runtime-handle registry; only the execution Worker owns engine lifecycle.

**Tech stack:** Bun Workers and `bun:ffi`; `capnp-es@0.0.14`; existing Aura runtime protocol/service/tool surfaces; Bun tests; metaharness deterministic microbenchmarks.

**Specs and prerequisites:**
- Approved design: `docs/superpowers/specs/2026-07-27-aura-embedded-runtime-adapter-design.md`
- WHIPLASH plan: `docs/superpowers/plans/2026-07-27-whiplash-embedded-runtime-library.md`
- Required artifact: `/home/sam/workspace/labs/WHIPLASH/.dev/artifacts/dist/current/lib/libelide_embed.so`
- Required sibling dependency: `libelide_embed_engine.so`
- ABI version: `1`

## Scope and rollout contract

- `runtime.adapter` values: `process`, `embedded`, `auto`. Default: `process` for the initial soak.
- `runtime.embeddedPath`: optional explicit shared-library path. `AURA_RUNTIME_EMBEDDED_LIB` is the environment equivalent.
- `process`: all methods use `LocalRuntimeEndpoint` exactly as today.
- `embedded`: JS/TS/Python `runtime/run` must use the library. Missing/incompatible library is a hard, clear error; never silently fall back for an eligible run. Java/Kotlin run and every non-run method delegate to the process endpoint because they are outside initial native scope.
- `auto`: use embedded only when a library resolves and passes ABI/schema validation. If no library exists, use process. If a candidate exists but fails load, ABI, schema, or open, fail loudly; do not hide a broken deployment by falling back.
- The process adapter stays available and unchanged throughout rollout.
- One native runtime opens lazily on the first eligible run and closes when the owning main Aura session disposes. Abrupt process shutdown also registers a postmortem cleanup.
- Every request gets a fresh native guest context. Tests must prove no cross-call global/module/argv/cwd/env/stdin/stdio state.
- Only one embedded run is active at a time. Queue Aura requests in endpoint order rather than exposing native `busy` during normal use; keep native busy handling as a contract guard.
- Do not expose `Elide` in user-facing settings/help/errors. Internal vendor filenames, env compatibility, and ABI symbol names may contain `elide`.

## Worker correction to the approved design

The approved design says “a dedicated Bun worker owns synchronous FFI calls.” That remains true for engine lifecycle, but one Worker alone cannot provide real cancellation: while `runtime_call` blocks, its event loop cannot receive `AbortSignal` messages. Therefore this plan adds one control Worker whose only FFI operation is `runtime_cancel`. It never opens or closes an engine and never executes guest code. This is the smallest change that simultaneously satisfies responsive TUI and cross-thread cancellation.

---

### Task 1: Generate and pin the Cap'n Proto TypeScript codec

**Files:**
- Modify: `packages/coding-agent/package.json`
- Modify: `bun.lock`
- Create: `scripts/sync-embedded-runtime-protocol.ts`
- Create generated directory: `packages/coding-agent/src/runtime/embedded/generated/`
- Create: `packages/coding-agent/src/runtime/embedded/schema.ts`
- Create: `packages/coding-agent/src/runtime/embedded/codec.ts`
- Test: `packages/coding-agent/test/runtime-embedded-codec.test.ts`
- Modify: `docs/aura/FORK.md`

Use `capnp-es@0.0.14` as a normal coding-agent dependency because generated readers/writers execute at runtime. The package also supplies the `capnpc-ts` generator. Do not add a second Cap'n Proto package.

`sync-embedded-runtime-protocol.ts` accepts an explicit WHIPLASH root:

```text
bun scripts/sync-embedded-runtime-protocol.ts --whiplash /path/to/WHIPLASH
```

It must:

1. collect the same sorted project-local transitive `.capnp` import closure rooted at WHIPLASH's `embed.capnp`, excluding absolute/toolchain imports;
2. invoke the locally installed `capnp-es` CLI (`bunx --bun capnp-es ... -ots:<out-dir>`) for that closure with the WHIPLASH protocol directory as `--src-prefix`; this still requires the native `capnp` compiler on `PATH`;
3. write deterministic generated `.ts` files under `src/runtime/embedded/generated/`;
4. compute the exact path/NUL/LF-normalized SHA-256 algorithm from the WHIPLASH plan over that closure and write `schema.ts` containing `EMBEDDED_RUNTIME_ABI_VERSION = 1` plus `EMBEDDED_RUNTIME_SCHEMA_SHA256`;
5. support `--check`: generate into a temporary directory and fail when generated files or the fingerprint differ from checked-in output;
6. avoid embedding the WHIPLASH absolute path in generated output.

`codec.ts` presents handwritten Aura-domain conversions over generated types:

```ts
export interface EmbeddedOpenConfig {
	languages: Array<"js" | "ts" | "python">;
}

export interface EmbeddedRunInvocation {
	source:
		| { type: "content"; code: string; name: string }
		| { type: "file"; path: string };
	language: "js" | "ts" | "python";
	args: string[];
	cwd: string;
	environment: Readonly<Record<string, string>>;
	stdin: Uint8Array;
}

export interface EmbeddedExecutionResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	killed: boolean;
}

export type EmbeddedDecodedResponse =
	| { type: "opened"; requestId: bigint }
	| { type: "completed"; requestId: bigint; result: EmbeddedExecutionResult }
	| { type: "cancelled"; requestId: bigint }
	| { type: "closed"; requestId: bigint }
	| { type: "failure"; requestId: bigint; code: EmbeddedFailureCode; message: string };

export function encodeOpenRequest(config: EmbeddedOpenConfig): Uint8Array;
export function encodeRunRequest(requestId: bigint, invocation: EmbeddedRunInvocation): Uint8Array;
export function decodeEmbeddedResponse(bytes: Uint8Array): EmbeddedDecodedResponse;
```

Mapping rules:

- `EmbeddedRuntimeEndpoint`, not the codec, validates `RuntimeRunParams`, resolves default/inferred language and absolute file/cwd paths, and snapshots environment at request time into `EmbeddedRunInvocation`.
- Inline source name is `[eval].js`, `[eval].ts`, or `[eval].py`; file source carries an absolute normalized path.
- cwd defaults to `process.cwd()` at request time, not Worker startup.
- environment is the endpoint's configured environment merged exactly as the process endpoint does, with `NO_COLOR=1`.
- args and stdin preserve bytes/order exactly.
- Convert Cap'n Proto `Data` to copied `Uint8Array`s before releasing the message arena.
- Require request id `0` for open/close responses and the exact submitted id for call/cancel responses.
- Reject response request-id mismatch, unknown unions, out-of-range exit codes, and invalid UTF-8 as `RuntimeRpcError("internal", ...)`.

- [ ] **Step 1: Add the dependency and failing codec tests**

Tests cover every response union, content/file invocations, cwd/environment/args/stdin, protocol version, request id, malformed/truncated messages, and nonzero guest exit mapping. Tests assert semantic values, not generated source text.

```bash
cd /home/sam/workspace/labs/BREAKDANCE
bun install
cd packages/coding-agent && bun test test/runtime-embedded-codec.test.ts
```

Expected: FAIL because codec/generated files do not exist.

- [ ] **Step 2: Implement the sync script and generate**

```bash
cd /home/sam/workspace/labs/BREAKDANCE
bun scripts/sync-embedded-runtime-protocol.ts --whiplash /home/sam/workspace/labs/WHIPLASH
```

- [ ] **Step 3: Implement codec conversions and rerun tests**

```bash
cd packages/coding-agent
bun test test/runtime-embedded-codec.test.ts
```

- [ ] **Step 4: Record fork files**

Add rows to `docs/aura/FORK.md` for `packages/coding-agent/package.json` and `bun.lock`. Generated/additive `src/runtime/embedded/` and the sync script belong in the fork-added section.

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/package.json bun.lock scripts/sync-embedded-runtime-protocol.ts packages/coding-agent/src/runtime/embedded packages/coding-agent/test/runtime-embedded-codec.test.ts docs/aura/FORK.md
git commit -m "feat(runtime): add embedded protocol codec"
```

---

### Task 2: Add library resolution, settings, and diagnostics

**Files:**
- Create: `packages/coding-agent/src/runtime/embedded/resolve.ts`
- Modify: `packages/coding-agent/src/runtime/index.ts`
- Modify: `packages/coding-agent/src/config/settings-schema.ts`
- Modify: `packages/coding-agent/src/runtime/protocol.ts:238-247`
- Modify: `packages/coding-agent/src/cli/runtime-cli.ts`
- Modify: `packages/coding-agent/src/cli/doctor-cli.ts:218-277`
- Modify: `docs/settings.md`
- Test: `packages/coding-agent/test/runtime-embedded-resolve.test.ts`
- Test: `packages/coding-agent/test/runtime-settings-wiring.test.ts`
- Test: `packages/coding-agent/test/runtime-cli.test.ts`
- Test: `packages/coding-agent/test/doctor-cli.test.ts`
- Modify: `docs/aura/FORK.md`

Add:

```ts
export type RuntimeAdapter = "process" | "embedded" | "auto";
export type RuntimeEmbeddedSource = "setting" | "env" | "managed" | "binary-adjacent";

export interface RuntimeSettingsValues {
	enabled: boolean;
	autoDownload: boolean;
	path: string;
	adapter: RuntimeAdapter;
	embeddedPath: string;
}
```

Settings schema:

```text
runtime.adapter      enum process|embedded|auto   default process
runtime.embeddedPath string                        default ""
```

Library resolution order:

1. nonblank `runtime.embeddedPath` (`source: "setting"`);
2. nonblank `AURA_RUNTIME_EMBEDDED_LIB` (`source: "env"`);
3. `<managed runtime version dir>/lib/<platform filename>` when already installed (`source: "managed"`);
4. `../lib/<platform filename>` relative to an explicitly resolved real runtime binary (`source: "binary-adjacent"`).

Do not scan `PATH` for shared libraries and do not hardcode a sibling WHIPLASH checkout. Dev runs set `AURA_RUNTIME_EMBEDDED_LIB` explicitly.

Platform filenames helper:

```ts
export function embeddedRuntimeLibraryName(platform: NodeJS.Platform = process.platform): string {
	switch (platform) {
		case "linux": return "libelide_embed.so";
		case "darwin": return "libelide_embed.dylib";
		case "win32": return "elide_embed.dll";
		default: throw new Error(`Unsupported embedded runtime platform: ${platform}`);
	}
}
```

Extend `RuntimeStatusResult` with optional internal-selection fields without changing existing fields:

```ts
adapter?: RuntimeAdapter;
effectiveAdapter?: "process" | "embedded";
embeddedLibraryPath?: string;
embeddedLibrarySource?: RuntimeEmbeddedSource;
embeddedAbiVersion?: number;
embeddedSchemaHash?: string;
```

User-facing diagnostics say “embedded runtime library,” “ABI,” and “schema”; never the vendor name. `aura runtime status --json` includes exact fields. Plain status and doctor add adapter/library rows and shorten home paths through existing rendering helpers.

- [ ] **Step 1: Write resolution/settings/status tests first**

Cover precedence, whitespace, missing files, wrong file type, platform names, default process adapter, JSON output, and doctor rendering.

- [ ] **Step 2: Run failing tests**

```bash
cd packages/coding-agent
bun test test/runtime-embedded-resolve.test.ts test/runtime-settings-wiring.test.ts test/runtime-cli.test.ts test/doctor-cli.test.ts
```

- [ ] **Step 3: Implement settings and resolver**

Use `Bun.file`/`node:fs/promises` per repo conventions; one read/stat attempt, no existence-check race.

- [ ] **Step 4: Update docs and fork ledger**

Add the two settings to `docs/settings.md` under the existing Runtime section. State process default and explicit-embedded no-fallback behavior. Add fork rows for every modified upstream file.

- [ ] **Step 5: Verify and commit**

```bash
cd packages/coding-agent
bun test test/runtime-embedded-resolve.test.ts test/runtime-settings-wiring.test.ts test/runtime-cli.test.ts test/doctor-cli.test.ts
cd ../..
git add packages/coding-agent/src/runtime/embedded/resolve.ts packages/coding-agent/src/runtime/index.ts packages/coding-agent/src/config/settings-schema.ts packages/coding-agent/src/runtime/protocol.ts packages/coding-agent/src/cli/runtime-cli.ts packages/coding-agent/src/cli/doctor-cli.ts packages/coding-agent/test/runtime-embedded-resolve.test.ts packages/coding-agent/test/runtime-settings-wiring.test.ts packages/coding-agent/test/runtime-cli.test.ts packages/coding-agent/test/doctor-cli.test.ts docs/settings.md docs/aura/FORK.md
git commit -m "feat(runtime): configure embedded adapter selection"
```

---

### Task 3: Implement the FFI boundary and dual-worker host

**Files:**
- Create: `packages/coding-agent/src/runtime/embedded/abi.ts`
- Create: `packages/coding-agent/src/runtime/embedded/worker-protocol.ts`
- Create: `packages/coding-agent/src/runtime/embedded/worker-core.ts`
- Create: `packages/coding-agent/src/runtime/embedded/worker-entry.ts`
- Create: `packages/coding-agent/src/runtime/embedded/control-worker-entry.ts`
- Modify: `packages/coding-agent/src/cli.ts` worker selectors/dispatch
- Test: `packages/coding-agent/test/runtime-embedded-abi.test.ts`
- Test: `packages/coding-agent/test/runtime-embedded-worker.test.ts`
- Test: existing CLI smoke-test file(s)
- Modify: `docs/aura/FORK.md`

`abi.ts` owns `bun:ffi`. No other Aura file touches raw pointers.

```ts
export interface EmbeddedNativeLibrary {
	readonly path: string;
	readonly abiVersion: number;
	readonly schemaHash: string;
	open(request: Uint8Array): { handle: bigint; response: Uint8Array };
	call(handle: bigint, request: Uint8Array): Uint8Array;
	cancel(handle: bigint, requestId: bigint): Uint8Array;
	closeRuntime(handle: bigint): Uint8Array;
	closeLibrary(): void;
}

export function openEmbeddedNativeLibrary(path: string): EmbeddedNativeLibrary;
```

FFI safety rules:

- `realpath` the library before `dlopen`; execution/control Workers must load the byte-identical absolute path so they share one mapped native registry.
- Declare all seven `elide_embed_*` symbols with exact pointer/u64/usize/i32 return types. Use top-level imports only.
- Validate `abiVersion === EMBEDDED_RUNTIME_ABI_VERSION` and exact schema hash before any open.
- Allocate `BigUint64Array(1)` for the runtime out parameter and a pointer-sized out slot for `elide_embed_buffer_t*`.
- Read façade buffer fields with Bun FFI pointer readers, copy payload bytes into a new `Uint8Array`, then call `buffer_free` in `finally`.
- Reject null pointers, impossible lengths, nonzero C statuses, and payloads above the existing runtime output safety ceiling before allocation/copy.
- `closeRuntime` is idempotent in Aura state even though the native ABI reports stale handles.
- Call `dlclose` only after every runtime is closed and no call is in flight.
- Tests inject an `EmbeddedNativeLibrary` interface. Never `mock.module("bun:ffi")`.

Worker protocol:

```ts
type ExecutionWorkerRequest =
	| { type: "probe"; id: number }
	| { type: "open"; id: number; libraryPath: string; request: Uint8Array }
	| { type: "call"; id: number; handle: bigint; request: Uint8Array }
	| { type: "close"; id: number; handle: bigint };

type ControlWorkerRequest =
	| { type: "probe"; id: number }
	| { type: "init"; id: number; libraryPath: string; handle: bigint }
	| { type: "cancel"; id: number; requestId: bigint }
	| { type: "shutdown"; id: number };
```

Transfer request/response `ArrayBuffer`s rather than copying through structured clone. Keep bigint ids as bigint.

Worker-host rules:

- Execution Worker opens the native runtime lazily and serializes calls.
- After open succeeds, parent initializes the control Worker with path+handle.
- Control Worker validates ABI/schema independently, calls cancel, decodes the cancel response, frees its buffer, and stays ready.
- On shutdown: stop accepting calls, cancel active request, await execution completion, stop control Worker, close native runtime on execution Worker, `dlclose`, then terminate both Workers.
- If a Worker exits mid-request, reject every pending call with a stable `RuntimeRpcError("internal", ...)` and discard the handle. Never retry a run automatically; guest code may have side effects.
- A `probe` message imports the complete Worker module graph but does not require a library. Add both selectors to `cli.ts` and to `runSmokeTest()` so source/npm/compiled-binary worker routing is exercised.
- Follow the repo Worker rule: CLI host re-entry via `workerHostEntry()` with a direct-module fallback outside CLI.

- [ ] **Step 1: Write ABI state/ownership tests first**

Use a fake binding that records open/call/cancel/close/free ordering. Assert payload copy occurs before free, close waits for call completion, failure never retries, and stale responses cannot settle a later request.

- [ ] **Step 2: Write worker protocol tests**

Exercise probe, request ordering, transferable buffers, control cancel routing, Worker death, and idempotent shutdown. Use injected worker factories or the existing worker test seam; do not require WHIPLASH here.

- [ ] **Step 3: Run failing tests**

```bash
cd packages/coding-agent
bun test test/runtime-embedded-abi.test.ts test/runtime-embedded-worker.test.ts
```

- [ ] **Step 4: Implement ABI and Workers**

Use ES `#private` members; no `private` keywords. Use `Promise.withResolvers()` for pending calls. All logs use the centralized logger.

- [ ] **Step 5: Add CLI worker dispatch and smoke probe**

Add selectors such as:

```text
__omp_worker_runtime_embed
__omp_worker_runtime_embed_control
```

Run:

```bash
bun packages/coding-agent/src/cli.ts --smoke-test
```

Expected: both probe workers respond and exit cleanly; the standard smoke test still prints success.

- [ ] **Step 6: Record fork rows and commit**

```bash
git add packages/coding-agent/src/runtime/embedded packages/coding-agent/src/cli.ts packages/coding-agent/test/runtime-embedded-abi.test.ts packages/coding-agent/test/runtime-embedded-worker.test.ts docs/aura/FORK.md
git commit -m "feat(runtime): host embedded ABI in workers"
```

---

### Task 4: Add the embedded/composite endpoint and service lifecycle

**Files:**
- Create: `packages/coding-agent/src/runtime/transport/embedded.ts`
- Create: `packages/coding-agent/src/runtime/transport/selected.ts`
- Modify: `packages/coding-agent/src/runtime/service.ts`
- Modify: `packages/coding-agent/src/runtime/index.ts`
- Modify: `packages/coding-agent/src/sdk.ts:1616-1670,3100+`
- Modify: `packages/coding-agent/src/session/agent-session-types.ts`
- Modify: `packages/coding-agent/src/session/agent-session.ts:3503-3568`
- Test: `packages/coding-agent/test/runtime-embedded-endpoint.test.ts`
- Test: `packages/coding-agent/test/runtime-service.test.ts`
- Test: `packages/coding-agent/test/runtime-singleton.test.ts`
- Create: `packages/coding-agent/test/runtime-session-lifecycle.test.ts`
- Modify: `docs/aura/FORK.md`

Extend endpoint lifecycle without changing tool callsites:

```ts
export interface RuntimeEndpoint {
	request(req: RuntimeRpcRequest, signal?: AbortSignal): Promise<RuntimeRpcResponse>;
	close?(): Promise<void>;
}

export class RuntimeService {
	// existing methods unchanged
	close(): Promise<void>;
}
```

`RuntimeService.close` is idempotent and waits for the endpoint. New calls after close return a runtime internal error. `LocalRuntimeEndpoint.close` may be omitted/no-op.

`EmbeddedRuntimeEndpoint` behavior:

- status probes resolution + ABI/schema through Worker `probe/load`, but does not open the engine;
- first eligible run opens native runtime with enabled languages and reuses the handle;
- validates code/path, language, cwd, configured environment, args, and stdin before entering the Worker queue;
- removes an aborted queued request without entering native code; timeout accounting begins only when that request reaches the queue head, matching the process adapter's execution-time timeout rather than charging time spent behind another run;
- uses a monotonic `bigint` native request id independent of JSON-RPC request ids;
- when active, starts one timer from `params.timeoutMs`; timeout asks the control Worker to cancel. A matched cancel makes the call result `killed = true`; if cancellation loses the completion race (`requestNotActive`), return the already-completed result unchanged.
- external AbortSignal asks the control Worker to cancel when active, waits for native call settlement, then returns `errorResponse(...cancelled...)`, matching `LocalRuntimeEndpoint`;
- maps serialized guest results to `RuntimeExecResult` with measured wall duration; never trusts a guest-supplied duration;
- queue remains usable after guest failure or cancellation;
- host/ABI/Worker failure poisons the endpoint and requires a new service; no same-request retry.

`SelectedRuntimeEndpoint` routing matrix:

| Adapter | JS/TS/Python run | Java/Kotlin run | Other methods |
|---|---|---|---|
| process | process | process | process |
| embedded | embedded, hard fail if unavailable/incompatible | process | process |
| auto, no library | process | process | process |
| auto, valid library | embedded | process | process |
| auto, broken candidate | hard fail | process | process |

Status reports the selected adapter and embedded metadata. For composite status, preserve process binary fields when available. Explicit embedded may report available for run even when the process binary is absent; process-only methods then surface the existing runtime-missing error when called.

Service factory/lifecycle:

- Expand cache key to adapter, embedded path, executable path, and auto-download.
- Settings changes atomically swap in a fresh selected endpoint, then close the retired service asynchronously and log cleanup failure; never reuse an endpoint with different configuration.
- `disposeCachedRuntimeService()` first atomically clears the matching cache entry, then awaits `RuntimeService.close()`. A later Aura session must construct a new service rather than receive a previously closed singleton.
- Add an optional `disposeRuntimeService` callback to `AgentSessionConfig`; only the main/root session created in `sdk.ts` receives it. Subagents share but never close the main runtime.
- Main `AgentSession.#doDispose` includes the callback in bounded parallel teardown. Abrupt exits retain a `postmortem` fallback registered by the embedded host.
- Startup failure cleanup in `createAgentSession` clears/closes any runtime service created during that startup.

- [ ] **Step 1: Write routing and fallback tests first**

Cover the full matrix, including explicit embedded no-fallback and auto broken-candidate no-fallback. Spy on endpoint objects; do not mock modules.

- [ ] **Step 2: Write cancellation and isolation-facing endpoint tests**

With fake Workers/native host, assert queue order, queued abort removal, timeout starts at queue head, matched and late timeout cancellation, AbortSignal cancellation, post-cancel reuse, no retry after uncertain failure, and close order.

- [ ] **Step 3: Write main-vs-subagent disposal and cache-eviction tests**

Assert only the main session invokes runtime cleanup, cleanup is idempotent, the cache clears before asynchronous close, and a later session receives a fresh service.

- [ ] **Step 4: Run failing tests**

```bash
cd packages/coding-agent
bun test test/runtime-embedded-endpoint.test.ts test/runtime-service.test.ts test/runtime-singleton.test.ts test/runtime-session-lifecycle.test.ts
```

Keep the lifecycle case in the fork-added runtime test; do not modify an unrelated upstream AgentSession test file.

- [ ] **Step 5: Implement endpoint/factory/lifecycle**

Keep `RuntimeService.run/check/build/...` signatures unchanged. Update `sdk.ts` settings mapping with `runtime.adapter` and `runtime.embeddedPath`.

- [ ] **Step 6: Verify and commit**

```bash
cd packages/coding-agent
bun test test/runtime-embedded-endpoint.test.ts test/runtime-service.test.ts test/runtime-singleton.test.ts test/runtime-session-lifecycle.test.ts
cd ../..
bun run check:ts
git add packages/coding-agent/src/runtime packages/coding-agent/src/sdk.ts packages/coding-agent/src/session/agent-session-types.ts packages/coding-agent/src/session/agent-session.ts packages/coding-agent/test/runtime-embedded-endpoint.test.ts packages/coding-agent/test/runtime-service.test.ts packages/coding-agent/test/runtime-singleton.test.ts packages/coding-agent/test/runtime-session-lifecycle.test.ts docs/aura/FORK.md
git commit -m "feat(runtime): route run through embedded adapter"
```

Stage only tests touched by this task; do not use a broad `git add packages/coding-agent/test` if unrelated work exists.

---

### Task 5: Prove the real library end to end

**Files:**
- Modify: `packages/coding-agent/test/runtime-integration.test.ts`
- Create: `packages/coding-agent/test/runtime-embedded-integration.test.ts`
- Modify: CLI smoke tests as needed

Gate real tests on:

```ts
const embeddedLib = process.env.AURA_RUNTIME_EMBEDDED_LIB;
```

Skip only when absent. When set but invalid, fail rather than skip.

Required real tests:

1. Status reports `adapter: "embedded"`, ABI 1, matching schema hash, and resolved absolute library path.
2. Inline JS, inline TS, and inline Python execute with exact stdout.
3. File-backed TS imports a sibling module from a cwd different from the entry directory.
4. argv, cwd, env, stdin, stdout, and stderr match process-adapter behavior.
5. Two sequential calls prove global/module/context isolation.
6. Guest syntax/runtime errors return nonzero exit and stable stderr without poisoning the next call.
7. Abort a long-running JS call, observe cancellation within a bounded window, then successfully run another call.
8. Dispose closes Workers and native runtime; no Worker/job keeps Bun alive.
9. Explicit embedded with a missing path returns embedded-library guidance and does not spawn the process binary.
10. Java/Kotlin run and `check` still route to the process adapter while embedded is selected.

- [ ] **Step 1: Add tests and run against WHIPLASH**

```bash
cd /home/sam/workspace/labs/BREAKDANCE/packages/coding-agent
AURA_RUNTIME_EMBEDDED_LIB=/home/sam/workspace/labs/WHIPLASH/.dev/artifacts/dist/current/lib/libelide_embed.so \
  bun test --timeout 120000 test/runtime-embedded-integration.test.ts test/runtime-integration.test.ts
```

- [ ] **Step 2: Run the actual CLI path**

Use a temporary settings file/profile with `runtime.adapter: embedded` and the explicit library path, then invoke the source CLI's `run` tool through the existing smoke harness. Do not invoke the runtime binary directly as the proof.

- [ ] **Step 3: Run compiled-worker smoke**

Build the coding-agent package using the project build command, run `aura --smoke-test`, then repeat one embedded JS run from that built entrypoint. This verifies worker-host re-entry and bundle module inclusion.

- [ ] **Step 4: Commit**

```bash
git add packages/coding-agent/test/runtime-embedded-integration.test.ts packages/coding-agent/test/runtime-integration.test.ts
git commit -m "test(runtime): cover embedded adapter end to end"
```

---

### Task 6: Add process-vs-embedded latency measurement

**Files:**
- Modify: `packages/metaharness/src/runtime-benchmark.ts`
- Modify: `packages/metaharness/src/runtime-benchmark.test.ts`
- Modify: `packages/metaharness/README.md`
- Modify: `docs/aura/FORK.md`

Keep the existing capability A/B benchmark intact. Add a separate adapter microbenchmark table; do not overload `BenchmarkArm`.

```ts
export interface AdapterMicroResult {
	name: string;
	processMs: number;
	embeddedMs: number;
	speedup: number; // processMs / embeddedMs
}
```

Measure:

- embedded cold open + first JS call (reported, not compared to per-call process median);
- warm JS startup;
- warm TS startup;
- warm Python startup;
- JS compute;
- TS compute;
- Python compute;
- cancellation latency.

Measurement rules:

- Construct independent `RuntimeService` instances over process and embedded endpoints; do not use the global singleton.
- Warm each operation once before collecting samples. The embedded engine opens before warm-call samples.
- Alternate process/embedded sample order by iteration to reduce thermal/order bias.
- Verify exact output on every sample before recording duration.
- Use at least 30 iterations for a decision run; report p50 and p95 if the benchmark's result type is extended.
- Close both services in `finally`.
- CLI flag `--embedded-lib=<path>` overrides the env var for the benchmark only.
- If no library is supplied, retain today's report and state that adapter comparison was skipped.

Report section:

```markdown
## Runtime adapter microbenchmarks

| Case | Process runtime | Embedded runtime | Speedup |
|---|---:|---:|---:|
```

Decision gate before changing rollout default in any later work:

- correctness/isolation/cancellation tests all pass;
- warm JS and TS p50 are at least 2.0x faster than process;
- warm Python p50 is at least 1.5x faster than process;
- no warm case is slower at p95;
- engine/session memory is measured and documented separately before `auto` becomes default.

This plan does **not** change the default from `process`, even if results exceed the gate.

- [ ] **Step 1: Write formatter/measurement tests first**

Use deterministic fake operations. Assert alternating order, output validation before sample acceptance, speedup math, and report headings.

- [ ] **Step 2: Implement benchmark additions**

- [ ] **Step 3: Run tests**

```bash
cd packages/metaharness
bun test src/runtime-benchmark.test.ts
```

- [ ] **Step 4: Run the real decision benchmark**

```bash
cd /home/sam/workspace/labs/BREAKDANCE
bun run bench:runtime --micro-only --micro-iterations 30 \
  --embedded-lib=/home/sam/workspace/labs/WHIPLASH/.dev/artifacts/dist/current/lib/libelide_embed.so \
  --prefix=runtime-embedded-decision
```

Inspect the generated report under `runs/harbor/_bench/`. Preserve it as run output; do not commit benchmark artifacts unless explicitly requested.

- [ ] **Step 5: Document usage and fork ledger, then commit**

```bash
git add packages/metaharness/src/runtime-benchmark.ts packages/metaharness/src/runtime-benchmark.test.ts packages/metaharness/README.md docs/aura/FORK.md
git commit -m "bench(runtime): compare process and embedded adapters"
```

---

### Task 7: Cleanup, changelog, and final gates

**Files:**
- Modify: `packages/coding-agent/CHANGELOG.md`
- Modify: `docs/aura/FORK.md` for any upstream files missed above
- Modify generated protocol only by rerunning the sync script if WHIPLASH schema changed

This task starts only after the real end-to-end smoke test and benchmark run succeed.

- [ ] **Step 1: Remove scaffolding and debug-only paths**

Delete temporary fixture switches, unconditional test paths, or duplicate conversion helpers. Keep the Worker `probe` operation because compiled-package smoke uses it. Do not leave process aliases or fallback shims beyond the intentional adapter modes.

- [ ] **Step 2: Add changelog and fork-ledger entries**

Under `packages/coding-agent/CHANGELOG.md` → `## [Unreleased]` → `### Added`:

```markdown
- Added an opt-in embedded runtime adapter for JavaScript, TypeScript, and Python `run` calls, reusing one isolated engine per Aura session while retaining the process adapter as the default.
```

Add `packages/coding-agent/CHANGELOG.md` to the upstream-files table in `docs/aura/FORK.md` if it has no existing row. Confirm the Task 4 rows cover both AgentSession files; do not leave “missed file” cleanup implicit.

- [ ] **Step 3: Prove checked-in protocol output matches WHIPLASH**

```bash
bun scripts/sync-embedded-runtime-protocol.ts --check --whiplash /home/sam/workspace/labs/WHIPLASH
```

Expected: exit 0 with no generated drift. On failure, rerun without `--check`, then rerun codec and integration tests.

- [ ] **Step 4: Run focused package gates**

```bash
cd packages/coding-agent
bun test \
  test/runtime-embedded-codec.test.ts \
  test/runtime-embedded-resolve.test.ts \
  test/runtime-embedded-abi.test.ts \
  test/runtime-embedded-worker.test.ts \
  test/runtime-embedded-endpoint.test.ts \
  test/runtime-service.test.ts \
  test/runtime-singleton.test.ts \
  test/runtime-session-lifecycle.test.ts

AURA_RUNTIME_EMBEDDED_LIB=/home/sam/workspace/labs/WHIPLASH/.dev/artifacts/dist/current/lib/libelide_embed.so \
  bun test --timeout 120000 test/runtime-embedded-integration.test.ts test/runtime-integration.test.ts
```

- [ ] **Step 5: Run smoke and type/format gates**

```bash
cd /home/sam/workspace/labs/BREAKDANCE
bun packages/coding-agent/src/cli.ts --smoke-test
bun run check:ts
bun --cwd packages/metaharness run check
```

Use `bun check`, never `tsc`/`npx tsc`.

- [ ] **Step 6: Run the real CLI smoke once more**

Launch the source CLI with an isolated profile configured for `runtime.adapter: embedded`, invoke one JS run, one Python run, cancellation, then session shutdown. Verify the process exits and no runtime Worker remains.

- [ ] **Step 7: Request code review**

Use `requesting-code-review`. Review priorities: ABI ownership, cancellation races, stale response/request ids, schema mismatch behavior, explicit embedded fallback prohibition, session teardown, and context isolation.

- [ ] **Step 8: Commit cleanup**

```bash
git add packages/coding-agent/CHANGELOG.md docs/aura/FORK.md
git commit -m "docs(runtime): document embedded adapter rollout"
```

---

## Aura completion gate

The adapter is complete only when all are directly observed:

- WHIPLASH's relocated distribution library loads through Bun FFI.
- ABI and schema mismatch fail before runtime open.
- JS/TS/Python inline and file runs match process output/argv/cwd/env/stdin behavior.
- A second run cannot see any state from the first.
- Cancellation interrupts a blocked guest while the TUI/main event loop remains responsive.
- The same native runtime remains usable after guest failure and cancellation.
- Main session disposal closes runtime, frees responses, `dlclose`s, and terminates both Workers.
- Explicit embedded mode never silently runs the eligible request through a process.
- Java/Kotlin and all non-run methods remain process-backed.
- Source and compiled CLI worker smoke tests pass.
- The 30-iteration process-vs-embedded benchmark report is generated and reviewed.
- `bun run check:ts` and metaharness check pass.
- Process remains the default adapter until a later, separately approved rollout change.
