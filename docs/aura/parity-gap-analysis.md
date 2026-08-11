# Aura v1 parity gap analysis — BUCKSHOT `aura` → aura fork

> **HISTORICAL SNAPSHOT — do not build against the tool names in this file.**
> Written 2026-07-27, when the fork's model surface still carried `run`,
> `check`, and `jvm_run`. All three are gone: `jvm_run` folded into `run`, and
> `run`/`check` were retired outright on 2026-08-11 (`0e7871de4`) in favor of
> upstream `eval` for code execution and `bash` for the shell. The surviving fork tools are `insights`, `profile`, `serve`, and the
> four `jvm_*` analysis tools. Every recommendation below that names `run` or
> `check` — the bash-interceptor rules in §"Bash interception", the renderer
> notes at the end — is superseded by `docs/aura/ELIDE_ALIGNMENT.md` and
> `ACTIONS_CONSOLIDATE.md`. The *gap analysis itself* (what BUCKSHOT had that
> the fork lacked) is still a useful record.

**Date:** 2026-07-27
**BUCKSHOT (v1 reference):** `/home/sam/workspace/labs/BUCKSHOT` — `@buckshot/cli` → `dist/aura`, a Pi-SDK harness with the Elide runtime fused in via an extension registry.
**Fork (target):** `/home/sam/workspace/labs/BREAKDANCE` — an `oh-my-pi` fork rebranded to `aura`, with the runtime capability core merged (`packages/coding-agent/src/runtime/`, `src/tools/runtime-*.ts`, `aura runtime status`).

Reading note: BUCKSHOT's aura is *composition* (Pi + 15 extensions, several npm-patched). The fork is *ownership* — the harness is the codebase. So most BUCKSHOT extensions are not gaps: they are things the fork already does natively, usually better. The real gaps cluster tightly on the **runtime seam**: the parts of the Elide capability surface the design spec explicitly deferred, plus a handful of chrome/identity items.

Verdict counts: **9 PRESENT · 18 SUPERSEDED · 16 GAPS (1 L, 3 M, 12 S)**

---

## Summary table

| # | Capability | BUCKSHOT behavior | Fork status | Verdict | Size |
|---|---|---|---|---|---|
| 1 | `run` — exec Python/JS/TS | inline `code` XOR `path`; `args`/`cwd`/`stdin`/`timeoutMs`; `--error-format=plain --no-color`; `-l <lang>` | `RuntimeRunTool` (`src/tools/runtime-run.ts`), same param set, plus `language` inference from extension; `essential` load mode | **PRESENT** (better) | — |
| 2 | `insights` — instrumented run | guest inline/path × insight inline/path (4 combos) | `RuntimeInsightsTool`, all 4 combos, `--insights=<file>` | **PRESENT** | — |
| 3 | `profile` — CPU sampler/tracer | `mode: cpusampling\|cputracing` | `RuntimeProfileTool`, same two modes | **PRESENT** | — |
| 4 | — (no BUCKSHOT equivalent) | — | `check` (validation build) + `build` (targets) — fork-only superset | **PRESENT+** | — |
| 5 | Missing-runtime guidance instead of crash | `ELIDE_MISSING_MESSAGE`, tools stay registered | `runtime-missing` error code with equivalent guidance string; tools gate on `runtime.enabled` | **PRESENT** | — |
| 6 | Runtime binary resolution | `--elide` / `ELIDE_BIN` → staged `dist/elide/bin/elide` → peer → `node_modules/.bin` (shim-resolved) → PATH; staged at build time | `resolve.ts`: `runtime.path` → `AURA_RUNTIME_BIN`/`ELIDE_BIN` → managed `~/.aura/runtime/<ver>` → PATH; **plus** auto-provision with sha256 verify + atomic rename (`provision.ts`) | **PRESENT** (better — no build-time staging, verified download) | — |
| 7 | Runtime readiness probe | `elideStatus()` inside `aura doctor` | `aura runtime status [--json]` — version/binary/source/protocol, never provisions, vendor-name-free | **PRESENT** (better, narrower) | — |
| 8 | `aura` dark theme from `@elide/tokens` | `assets/aura.json` seeded into `~/.aura/agent/themes/`, made default only if `settings.json` exists w/o theme | Built-in `aura` theme (`modes/theme/aura.json`, registered in `BUILTIN_THEMES`), `theme.dark` default = `aura` | **PRESENT** (better — no seeding dance) | — |
| 9 | `aura` name / config dir / bin identity | `piConfig` white-label via two mechanisms (bun patch + `dist/package.json`) | `APP_NAME="aura"`, `CONFIG_DIR_NAME=".aura"` in `packages/utils/src/dirs.ts`; `aura` + `omp` bins | **PRESENT** (better — no patches) | — |
| 10 | oh-my-pi orchestrator extension | third-party npm extension, patched for binary-mode skill paths | native `task/` (executor, parallel, spawn-policy, worktree, isolation), `agents` registry, `packages/swarm-extension` | **SUPERSEDED** | — |
| 11 | `pi-smart-compact` (patched dep) | verification-oriented compaction at ~60% | native compaction: `compaction.strategy` ∈ {context-full, handoff, shake, snapcompact, off}, default `snapcompact`; `/compact`, `/shake`, `/handoff` | **SUPERSEDED** | — |
| 12 | `pi-cache-optimizer` (patched dep) | stable prompt ordering, `PI_CACHE_RETENTION` | upstream owns prompt-cache behavior in-tree; no fork-owned work implied | **SUPERSEDED** | — |
| 13 | `context-mode` — 9 `ctx_*` tools (index/search/process files out of context) | staged runtime shim routing JS/TS through Elide, Node for MCP; `CONTEXT_MODE_DATA_DIR` redirect | native `grep`/`glob`/`ast_grep`/`ast_edit`/`read`/`write`, memory suite (`retain`/`recall`/`reflect`/`memory_edit`), and `xdev` (`xd://`) for out-of-context tool devices | **SUPERSEDED** | — |
| 14 | `pi_natives` search (137 MB staged `.node`, dlopen'd) | ripgrep engine as a `search` tool | first-party `crates/pi-natives` → `@oh-my-pi/pi-natives`; `grep`/`glob`/`ast_grep` tools; `omp grep` CLI | **SUPERSEDED** (better — first-party crate, no staging) | — |
| 15 | `aura-slim` — global output budget + spill for every tool result | 50 KB / 2000 lines cap, head/tail by tool, spill to shared temp dir | `tools/output-meta.ts`, `session/artifacts.ts` spill, `truncateToVisualLines`, per-tool head/tail (see `tools/bash.ts`) | **SUPERSEDED** (but see gap #23 — runtime tools are not wired to it) | — |
| 16 | `aura-context-diet` — prune superseded `read` results per call | threshold-gated (20k tok) to protect cache prefix | `packages/agent/src/compaction/pruning.ts` + non-compaction retry policy | **SUPERSEDED** | — |
| 17 | `pi-observational-memory` (opt-in) | session memory + recall tool | native memory backends (`memory-backend/`, `mnemopi/`), `/memory` with `diagnose`/`stats` | **SUPERSEDED** | — |
| 18 | Built-in extension registry (`BUILTIN_EXTENSIONS`) + `AURA_DISABLE` / `AURA_ENABLE` | 15 entries with `defaultEnabled`/`keepInVanilla`/`order`/`setup` | the harness *is* the code; gating via `--tools` allowlist, `--no-tools`, `discovery/disabled-extensions`, plugin manager, per-agent `tools:` | **SUPERSEDED** | — |
| 19 | `--vanilla` — drop orchestrator, keep `elide_run` | argv flag, stripped before Pi | concept dissolves (orchestration is core); nearest equivalents `--tools run,check,build,read,edit,bash`, `--no-tools`, `tools.xdev` demotion | **SUPERSEDED** | — |
| 20 | `AURA_SYSTEM_PROMPT` + `AURA_SYSTEM_PROMPT_MODE` (replace/prepend/append) | `before_agent_start` extension wired last so it composes over the orchestrator's prompt | `--system-prompt` (replace), `--append-system-prompt`, file discovery `SYSTEM.md` / `APPEND_SYSTEM.md` (project `.aura/` then global), `NULL_PROMPT=true` | **SUPERSEDED** (delta: no `prepend` — gap #31) | — |
| 21 | Terminal title `aura — <session> — <cwd>` + braille spinner prefix | `ctx.ui.setTitle` on a 80 ms interval | `utils/title-generator.ts` sets OSC 0, LLM-generated titles, `setTitle()` for extensions, `PI_NO_TITLE` / `OMP_UPDATE_TITLE` | **SUPERSEDED** (better) | — |
| 22 | Working indicator (pulsing gradient dot) | `ctx.ui.setWorkingIndicator` | theme-driven spinner frames used across `bash`/`hub`/`todo`/`write`/`edit` | **SUPERSEDED** | — |
| 23 | ≥30 s OS notification (OSC 777 / kitty 99), `AURA_NO_NOTIFY=1` | fires on `agent_end` when the turn ran ≥30 s | `packages/tui/src/terminal-capabilities.ts` OSC 99 → OSC 9 fallback; `desktop-notify.ts` freedesktop/D-Bus; opt-outs `PI_NOTIFICATIONS=off`, `PI_NO_DESKTOP_NOTIFY=1`; settings `completion.notify`, `error.notify`, `ask.notify` | **SUPERSEDED** (better; OSC 777 deliberately unused) | — |
| 24 | Background/managed process registry (`managedBackgrounds` map, opaque `runtime-<uuid>` IDs, SIGTERM→SIGKILL, `finishedBackgrounds` LRU) | only `stopRuntimeProcess()` can stop a registered ID; PIDs never exposed as the handle | `tools/hub/` — `start`/`list`/`logs`/`wait`/`send`/`stop`/`restart`/`describe`, session-owned jobs, cross-instance observable; plus `bash async` auto-backgrounding | **SUPERSEDED** — the substrate is strictly better; what's missing is *routing runtime launches through it* (gap #26) | — |
| 25 | First-party Rust N-API addon (`aura_native.<tag>.node`) reported by doctor | version + target triple | `crates/` workspace incl. `pi-natives`, in-tree | **SUPERSEDED** | — |
| 26 | Elide binary staging + `trustedDependencies` postinstall dance | `stageElideRuntime` copies `bin/`+`lib/`; `ELIDE_SKIP_DOWNLOAD`/`ELIDE_DIST_BASE_URL` escape hatches | replaced by `provision.ts` (pinned `ELIDE_VERSION`, per-platform sha256, staged extract + atomic rename, in-flight dedupe) | **SUPERSEDED** | — |
| 27 | `PI_CODING_AGENT_DIR` set to aura's dir so ecosystem extensions don't leak to `~/.pi` | workaround for third-party extensions | N/A — fork owns the whole tree | **SUPERSEDED** (dissolved) | — |
| **28** | **JVM tool suite: `jvm_run`, `jvm_disassemble`, `jvm_format`, `jvm_jar`, `jvm_deps`, `jvm_javadoc`** | compile-then-run in a shared workdir; `deriveJvmMainClass`; `--release 17` bytecode floor; javap `-c`; Google Java Format `-i` / ktfmt with `--allow-write`; jar create (main-class + `.class` glob / `-C out .`) and inspect; jdeps over source-or-artifact; javadoc → `apidocs` copied to `output`; **create/javadoc refuse overwrite without `overwrite: true`** | `RuntimeLanguage = "js" \| "ts" \| "python"`. Zero JVM surface anywhere in `packages/` | **GAP** | **L** |
| **29** | Shared temp workdir (`withElideWorkdir`) + toolchain env hygiene (`elideEnv` strips `JAVA_HOME`/`JDK_HOME`) | one dir per tool call, multiple runtime invocations bound to it (compile → run → javap) | `withGuestFile` mkdtemps **per protocol request** and `rm -rf` in `finally`; endpoint env is pass-through + `NO_COLOR=1` | **GAP** (hard prereq of #28) | **S** |
| **30** | `project_advice` — `elide project advice` in the real cwd, read-only | ANSI-stripped, spill-capped report | absent (single grep hit is the spec's deferral line) | **GAP** | **S** |
| **31** | Managed `debug` (CDP/DAP) + `serve` (static HTTP) + `stop_runtime_process` | `launchElideBackground` scrapes startup output for `ws://…` / `listening on …` / `Serving static files on …` within a wait window, returns opaque `processId` + endpoint; `proc.unref()`; temp workdir cleaned on exit | no background/detached execution in the protocol at all; `RuntimeExecResult.killed` is the only lifecycle signal | **GAP** | **M** |
| **32** | Runtime shell policy — block direct `elide` invocation in `bash`/`interactive_bash`, route to innate tools; opt out with `--allow-elide-shell` / `AURA_ALLOW_ELIDE_SHELL=1` | own shell-word tokenizer handling assignments, `env`, `command`/`exec`/`sudo`, `bunx`/`npx`/`yarn`, nested `sh -c`, `;`/`\|`/`&` segmentation | absent. **But the seam exists**: `tools/bash-interceptor.ts` + `bashInterceptor.patterns` setting (10 default rules, `{pattern, tool, message}`, skipped when `tool` not in `availableTools`, blocks with a reason) | **GAP** | **S** |
| **33** | `aura doctor` + `aura --check` | doctor: version + protocol, runtime found/path/version, native addon version/target, config dir, per-extension on/off table, full equipped-tool list. `--check`: one-line clean-env boot probe, no model/network | no top-level `doctor`/`--check`. Nearest: `aura runtime status` (runtime only), `omp plugin doctor [--fix]`, `/memory diagnose`, `/debug` (`src/debug/system-info.ts`, `terminal-info.ts`, `report-bundle.ts`) | **GAP** | **M** |
| **34** | Runtime output spill: `capWithSpill` / `formatRun` append `[full output: <path>]` to a shared per-process spill dir | oversized stdout/stderr and single-blob reports both spill | `src/runtime/format.ts` only: `MAX_OUTPUT_CHARS = 60_000` per stream, `… output truncated (N chars total)`; **no** `output-meta.ts`, no `session/artifacts.ts` spill. Full text survives only in structured `details` | **GAP** | **S** |
| **35** | `--elide=<path>` CLI flag (delivered via `ELIDE_BIN`), stripped from the delegated argv | one-invocation binary override | `runtime.path` setting + `AURA_RUNTIME_BIN`/`ELIDE_BIN` env; the `--runtime` flag is referenced in a `resolve.ts` comment but **not implemented** | **GAP** | **S** |
| **36** | `aura-light.json` — token-derived light theme, seeded alongside dark | light counterpart of the brand theme | `theme.light` default unchanged (upstream); 38 generic `light-*` themes ship, none is `aura-light` | **GAP** | **S** |
| **37** | Boot banner — gradient block-letter ASCII (`assets/banner.txt`), narrow-terminal wordmark fallback, `colorMode()` degradation (truecolor/256/plain), keybinding hints line; also printed on `--version` / `doctor` / `--help` | replaces Pi's header via `ctx.ui.setHeader` | no ASCII banner; `startup-splash.ts` (`shouldShowStartupSplash`) is the opt-in seam | **GAP** | **S** |
| **38** | Editor chrome — `❯ ` prompt glyph + per-column gradient top/bottom rules, `paddingX ≥ 2` clamp, border-color-aware gradient start | `AuraEditor extends CustomEditor`, pure `decorateEditorLines` | upstream editor, unmodified | **GAP** (cosmetic) | **S** |
| **39** | Built-in runtime skills — `elide.md`, `insights.md`, `jvm.md`, `profiling.md`, `stateful-debugger.md` from `@buckshot/skills`, declared to the resource loader in every mode | teaches the model that native code execution exists and how to use each tool well | fork has the skills machinery (`manage_skill`, `learn`, `autolearn/`) and per-tool prompt docs (`src/prompts/tools/runtime-*.md`, `docs/tools/*.md`) but **no runtime skill content** | **GAP** | **M** |
| **40** | House-style tool renderers for runtime results | Pi renders `content`/`details` | the five `Runtime*Tool` classes implement **no** `renderCall`/`renderResult` — the design spec asked for them | **GAP** | **S** |
| **41** | `fast-start` — first prompt of a fresh interactive session at thinking `low`, restored on `agent_end`, disarmed by any manual change, TUI-only | quicker time-to-first-response | no equivalent found | **GAP** (optional) | **S** |
| **42** | System-prompt `prepend` mode | `AURA_SYSTEM_PROMPT_MODE=prepend` | fork has replace + append only | **GAP** | **S** |
| **43** | `--version` prints `aura vX (protocol vY)` under the banner | version + wire-protocol identity | `--version` from the shared CLI runner (`VERSION` from `package.json`); no protocol/runtime identity line | **GAP** (trivial) | **S** |

---

## Per-gap porting notes

Ordered by the sequence I'd actually execute. Every note is shaped as a **core integration on the runtime seam** — a protocol method plus a tool, or a rule in an existing upstream registry — never a bolt-on extension.

### #28 + #29 — JVM tool suite and the shared workdir (L + S) — do these together

The workdir is the reason the JVM tools are one L-sized job rather than six S-sized ones: every JVM tool is a **multi-invocation flow over one directory** (`javac` → `java`; `javac` → `javap -c`; `javac` → `jar --create` → `jar --list`). The current endpoint cannot express that — `withGuestFile` mkdtemps and destroys per request.

Fork-native shape:

1. **Protocol** (`src/runtime/protocol.ts`): add `RuntimeLanguage` members `"java" | "kotlin"` and one new method rather than six. Proposal: `runtime/jvm` with `{ action: "run"|"disassemble"|"format"|"jar"|"deps"|"javadoc", language?, code?, mainClass?, output?, overwrite?, jar?, path? }`. Bump `RUNTIME_PROTOCOL_VERSION` to 2 — `aura runtime status` already prints it, and the spec's "stdio broker / inproc endpoint are later drop-ins" promise depends on the version being honest.
2. **Session workdir** (`transport/local.ts`): introduce a `RuntimeWorkdir` abstraction — `mkdtemp` once, hand the request handler a `run(args, opts)` closure bound to it, `rm -rf` in `finally`. This is `withElideWorkdir` transposed to the endpoint, and it is where the multi-step JVM flows live. Keep it endpoint-internal so `RuntimeService`/tool code never sees a path.
3. **Env hygiene**: strip `JAVA_HOME`/`JDK_HOME` from the spawn env for JVM actions (BUCKSHOT's `elideEnv`). Without this, hosts with an older PATH `java` die with `UnsupportedClassVersionError`, because the runtime's `java` honors `JAVA_HOME` while its `javac` always uses the embedded JDK. BUCKSHOT also pins `javac --release 17` for the same reason — port both belts.
4. **Tools**: one `RuntimeJvmTool` per user-facing verb (`jvm_run`, `jvm_disassemble`, `jvm_format`, `jvm_jar`, `jvm_deps`, `jvm_javadoc`), all `loadMode: "discoverable"`, all `createIf(session)` gated on `runtime.enabled`, all mapping to `runtime/jvm` actions. Register in `tools/index.ts`, append to `BUILTIN_TOOL_NAMES`, and add one `docs/tools/<name>.md` each — `test/internal-urls/docs-tool-coverage.test.ts` fails otherwise.
5. **Port `deriveJvmMainClass` verbatim** (`public class X` → first `class X` → `Main`; Kotlin → `MainKt`) — it is small, well-tested logic and the failure mode without it is confusing.
6. **Keep the overwrite guards.** `jvm_jar action=create` and `jvm_javadoc` must refuse to clobber an existing `output` without `overwrite: true`. These are the only runtime tools that write into the user's project; the guard is the reason they are safe to expose.

Naming: the tools are `jvm_*`, not `elide_jvm_*`. Descriptions say "the embedded JVM", never Elide.

### #33 — `aura doctor` / `--check` (M)

The highest-leverage non-runtime gap, because it is the one surface that answers "is my install healthy" in one shot. The fork's diagnostics are real but scattered across four places (`aura runtime status`, `omp plugin doctor`, `/memory diagnose`, `/debug`).

Fork-native shape: a new `src/commands/doctor.ts` + `src/cli/doctor-cli.ts` that **aggregates existing probes** rather than reimplementing them. Keep BUCKSHOT's discipline: pure report builder (`buildDoctorReport(input)`) separated from gathering, and **no model, no network, no provisioning**. Sections:

- identity — `APP_NAME`, `VERSION`, `MIN_BUN_VERSION` vs running Bun, config dir (`.aura`, and whether a legacy `.omp` fallback is being read)
- runtime — reuse `resolveStatusEndpointOptions` + `formatRuntimeStatus` unchanged (`autoDownload: false`)
- natives — `@oh-my-pi/pi-natives` load status + target
- tools — active vs available names (`session.getActiveToolNames()` / `getAllToolNames()`), which is BUCKSHOT's "fused tools" line
- plugins — delegate to `manager.doctor({ fix: false })`
- terminal — reuse `src/debug/terminal-info.ts` (color mode, OSC 99 support) since notification/theme behavior keys off it
- memory backend — the optional `diagnose`/`stats` hooks if a backend is configured

`--json` for all of it, mirroring `runtime status --json`. Then `aura --check` is the same gatherer at one line, for clean-env CI probes. Exit non-zero only on hard failures (Bun too old, runtime unavailable *and* enabled), warn on optional misses.

### #31 — managed `debug` / `serve` / stop (M)

Do **not** port `managedBackgrounds`. The fork's `hub` tool is a strictly better registry than BUCKSHOT's in-process map: session-owned jobs, cross-instance observability, `logs`/`wait`/`send`/`restart`/`describe`, and a `stop` that already takes a name. Porting BUCKSHOT's map would create a second, worse process registry — the exact bolt-on shape to avoid.

Fork-native shape:

1. Protocol: `runtime/spawn` returning `{ argv, cwd, env, endpointPattern }` — a **launch descriptor**, not a process. The endpoint resolves the binary and composes the argv (`run --debugger=cdp|dap …`, `serve <dir> --no-tui --port --host`); it does not own the lifecycle.
2. Tools `debug` and `serve` take that descriptor and start it **through hub** (`op: "start"`). The returned handle is hub's job name — which means `hub stop`, `hub logs`, and `/jobs` all work on runtime processes for free, and `stop_runtime_process` is **not needed as a separate tool**. That is the parity-with-better outcome: BUCKSHOT's opaque-ID-not-PID invariant is preserved by hub's naming, and agents get log tailing BUCKSHOT never had.
3. Endpoint scraping (`ws://…`, `listening on <x>`, `Serving static files on <x>`) belongs in the `debug`/`serve` tools, reading hub's log stream with a wait window — port the regexes and the "did not report an endpoint within the wait window, here is the startup output" fallback, which is what makes the tool debuggable when the runtime changes its startup banner.
4. Note the resolution subtlety BUCKSHOT hit: an npm `.bin` shim spawns the real binary as a **child**, so killing the shim orphans the server and leaks the port. The fork's managed install resolves to a real binary, so this is mostly moot — but `Bun.which("elide")` (source `"path"`) can still be a shim. Worth a guard.

### #39 — runtime skills (M)

Port the five BUCKSHOT skills (`elide.md`, `insights.md`, `jvm.md`, `profiling.md`, `stateful-debugger.md`) as fork-native skill content, rewritten under the naming rule (no "Elide"; "the runtime"). These carry the *judgment* the tool descriptions can't: when `cputracing` beats `cpusampling`, what an insight script's `source`/`enter`/`return` hooks can hook, why one-shot runs never emit `close`, that path mode preserves project imports. `docs/tools/*.md` and `src/prompts/tools/runtime-*.md` already cover the mechanical surface; skills cover the strategy. Gate the `jvm.md` and `stateful-debugger.md` skills on #28/#31 landing.

### #32 — runtime shell policy (S)

`tools/bash-interceptor.ts` **is** the natural seam, and it is a better one than BUCKSHOT's: rules are settings-driven (`bashInterceptor.patterns`), block with a `message`, and self-disable when the replacement `tool` isn't in `availableTools` — so a rule pointing at `run` silently stands down whenever `runtime.enabled = false`. That last property is exactly right and BUCKSHOT had to hand-roll nothing equivalent.

Fork-native shape: append rules to `DEFAULT_BASH_INTERCEPTOR_RULES` in `config/settings-schema.ts` — `elide` → `run`, and the `bunx elide` / `npx @elide-dev/elide` forms. Message: name the innate tools (`run`, `insights`, `profile`, `debug`, `jvm_*`) and state the opt-out.

The delta to accept: the interceptor is **regex over the trimmed command**, where BUCKSHOT had a real tokenizer handling `FOO=1 sudo -E elide …`, `sh -c "… elide …"`, and `;`/`\|`/`&` segmentation. Two options: (a) accept regex coverage — this is *routing enforcement, not an adversarial sandbox*, which is BUCKSHOT's own framing, so a good-enough regex is defensible; or (b) port `containsDirectElideInvocation` as an extra rule *kind* (`{ matcher: "runtime-invocation", tool: "run" }`) so the engine gains a programmatic predicate alongside regex. Prefer (a) for v1, (b) if false negatives show up in practice.

Opt-out: honor `AURA_ALLOW_ELIDE_SHELL=1` (keep the name — it is documented muscle memory) plus a `runtime.allowShell` setting, checked where the rule set is assembled. A `--allow-elide-shell` flag is optional given the env var.

Known residual after P5: `hub start application:"elide" …` reaches the binary without passing through the bash interceptor, since `hub` is its own tool rather than a shell command. Out of P5's scope and low-priority — the legitimate managed-launch path is already owned by `serve`/`runtime_debug`, which compose the argv through `runtime/spawn` and hand it to `hub` themselves.

### #34 — runtime output spill (S)

`src/runtime/format.ts` is a private 60k-char clamp that drops the overflow on the floor. Replace it with the machinery `tools/bash.ts` already uses: `tools/output-meta.ts` for truncation metadata and `session/artifacts.ts` to spill the full text, so the model gets a readable handle instead of `… output truncated (N chars total)`. Keep BUCKSHOT's two-shape distinction: stream results (stdout/stderr, tail-biased) vs single-blob reports (`profile`, `jvm_disassemble`, `jvm_deps`, `project_advice`) which cap-and-spill as one unit. Drop the per-stream 60k in favor of the repo-wide budget so runtime tools and `bash` behave identically. Note BUCKSHOT's anti-double-truncation lesson: its global `aura-slim` middleware explicitly *skips* the runtime tools because they already spilled — if the fork's runtime tools start spilling at the source, verify nothing downstream re-caps them.

### #30 — `project_advice` (S)

`runtime/advice` method → `elide project advice --error-format=plain --no-color` in the **real cwd** (not a workdir — it detects `elide.pkl` and package manifests), read-only, ANSI-stripped, cap-and-spill as a single blob. One `RuntimeAdviceTool`, `discoverable`, empty params. Name it `project_advice` (BUCKSHOT's name) — describe it as "the runtime's build/run/test/install guidance for this project". Caveat carried over from BUCKSHOT's notes: `elide project advice` crashed on 1.4.0-nightly.20260712, so the live test may need a skip guard; verify against the pinned `1.4.1+20260718`.

### #35 — `--runtime=<path>` flag (S)

`resolve.ts` already documents a `--runtime` flag that does not exist, and `source: "flag"` is already a value `runtime status` prints. Add the flag to `cli/flag-tables.ts`, thread it into `resolveRuntimeEndpointOptions` as `explicitPath` (which correctly suppresses auto-download). Also worth adding `runtime.version` — the spec called for it and only the hardcoded `ELIDE_VERSION` pin exists, so users cannot pin or roll back a runtime.

### #36 — `aura-light` theme (S)

Generate the light counterpart from the same Elide tokens that produced `aura.json`, add `modes/theme/aura-light.json`, register it in `BUILTIN_THEMES`, and set `theme.light` default to `aura-light` in `settings-schema.ts` (the fork already moved `theme.dark` to `aura` and left `theme.light` alone). The payoff is disproportionate to the size: the fork already does terminal-background detection and DEC 2031 appearance notifications with `setAutoThemeMapping`, so a branded light theme means auto light/dark **stays on-brand in both directions** — something BUCKSHOT could not do.

### #37 + #38 — banner and editor chrome (S + S)

`startup-splash.ts` (`shouldShowStartupSplash`) is the seam for the banner. Port `assets/banner.txt` and the render path: gradient block letters, one-line wordmark fallback below `ART_WIDTH`, `colorMode()` degradation (COLORTERM → TERM_PROGRAM → TERM: truecolor / 256 / plain). Drop BUCKSHOT's keybinding-hints line — it existed only because aura's header *replaced* Pi's, which owned the hints; the fork's header is not being replaced, so re-adding hints would duplicate them. Also print the wordmark on `--version` / `doctor`.

Editor chrome (#38) is pure cosmetics and touches an upstream file on the merge path (`decorateEditorLines` over `super.render()`); defer until the functional gaps are closed, and if it lands, keep the decoration as a pure function over rendered lines so the upstream editor stays unforked.

### #40 — runtime tool renderers (S)

The five `Runtime*Tool` classes implement no `renderCall`/`renderResult`, which the design plan called for. Follow `tools/bash.ts` / `hub/` renderer conventions: `run` shows language + inline-vs-path + exit code; `check`/`build` show target counts and pass/fail; `profile` shows mode. Small, self-contained, and it is what makes the runtime feel innate rather than bolted on.

### #42 + #43 + #41 — small deltas

- **#42 `prepend` mode (S).** `system-prompt.ts` supports replace + append. Add prepend — the composition is one branch, and prepend is the mode that matters when you want to front-load posture *above* the harness prompt rather than trail it. Surface as `--prepend-system-prompt` + a `PREPEND_SYSTEM.md` discovery file, matching the existing pair's conventions rather than introducing an `AURA_SYSTEM_PROMPT` env var (the fork's file-and-flag convention is better than BUCKSHOT's env-only one).
- **#43 identity line (S).** Have `--version` print the runtime protocol version alongside `VERSION`, matching `aura runtime status`. Trivial, and it makes bug reports answerable.
- **#41 `fast-start` (S, optional).** No fork equivalent. Judgment call, not parity-critical: it was motivated by GPT reasoning latency and the fork's model posture may differ. If ported, keep BUCKSHOT's stand-down conditions (resumed/forked sessions untouched, manual level change disarms, TUI-only) and the visible status line — without that, the footer's level silently dipping on turn one reads as a bug.

---

## Things deliberately *not* gaps

Recording these so they aren't re-litigated:

- **`--vanilla`.** It existed to drop a third-party orchestrator extension. Orchestration is native here; `--tools` is the honest equivalent. An alias could be added for muscle memory, but there is no capability behind it.
- **`AURA_DISABLE` / `AURA_ENABLE`.** Consequences of an extension registry the fork doesn't have and shouldn't grow.
- **The bun-patch branding pipeline** (`patchedDependencies`, version-exact keys, `dist/package.json`, `patch -p1` vs `git apply`). Roughly a third of BUCKSHOT's CLAUDE.md is hazard notes for this machinery. The fork owns `dirs.ts` and deletes all of it. Do not reintroduce patches.
- **`pi_natives` staging** (137 MB peer `.node`, x64 baseline/modern CPU variants, `~/.omp` download fallback avoidance). First-party crate now.
- **`context-mode`'s shim** (routing JS/TS through Elide, Node on PATH for the MCP server, `CONTEXT_MODE_DATA_DIR`). Native tools + `xdev` replace it.
- **OSC 777.** The fork's `desktop-notify.ts` explicitly notes it is unused in favor of OSC 99 → OSC 9 → D-Bus. Broader coverage, not narrower.
- **`AURA_NO_NOTIFY`.** `PI_NOTIFICATIONS=off` / `PI_NO_DESKTOP_NOTIFY=1` already cover it. Adding a third name is churn; if the aura brand wants its own, alias it rather than fork the logic.

## Cross-cutting observations

**One protocol bump covers most of the runtime work.** #28 (JVM), #30 (advice), and #31 (spawn) all add methods. Land them as a single `RUNTIME_PROTOCOL_VERSION = 2` step with the workdir abstraction (#29) underneath, and the spec's promise that a stdio-broker or in-process endpoint is "a later drop-in with zero tool changes" survives intact. Doing them piecemeal means three version bumps and three chances to leak endpoint details into tool code.

**Two seams are better than BUCKSHOT's and should be used rather than replaced**: `hub` for #31, and `bash-interceptor.ts` for #32. In both cases the temptation is to port BUCKSHOT's self-contained implementation because it is known-good; in both cases that produces a duplicate registry or a duplicate policy layer. The fork's versions are the integration points.

**Naming discipline is a live risk in every gap.** BUCKSHOT's surface is littered with `elide_*`, `ELIDE_MISSING_MESSAGE`, `--allow-elide-shell`, `AURA_ALLOW_ELIDE_SHELL`. Per the naming rule, ported user-facing text says "the runtime". The fork already gets this right — `formatRuntimeStatus`/`parseVersion` are written to never leak the vendor name. Two deliberate exceptions worth keeping for compatibility: the `ELIDE_BIN` env var (already honored in `resolve.ts`) and `AURA_ALLOW_ELIDE_SHELL`.

**Suggested order:** #29+#28 (JVM + workdir, the one L) → #33 (doctor) → #31 (debug/serve on hub) → #32 (shell policy) → #34 (spill) → #30 (advice) → #39 (skills) → #35/#36/#40/#42/#43 (small) → #37/#38/#41 (chrome, optional).
