# Aura fork inventory

This repository is a fork of [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)
(`upstream` remote). `main` is aura's mainline; upstream is merged regularly.

**Merge gate:** `bun run check:ts` and the TS test suite must be green before
and after every upstream merge.

## Upstream files modified by the fork

| File | Why |
|---|---|
| `packages/utils/src/dirs.ts` | brand constants: APP_NAME=aura, CONFIG_DIR_NAME=.aura, LEGACY_CONFIG_DIR_NAME=.omp (read-only compat for pre-rebrand project dirs); profile env resolution/precedence AURA_PROFILE → OMP_PROFILE → PI_PROFILE; `readInheritedProfileFromEnvSafe` (was `readPiProfileFromEnvSafe`) scans all three profile vars in that precedence for the pre-profile `PI_CODING_AGENT_DIR` snapshot, since `setProfile` writes all three |
| `packages/coding-agent/src/cli.ts` | env-profile bootstrap reads AURA_PROFILE (canonical) alongside legacy OMP_PROFILE/PI_PROFILE; handles the top-level `--check` flag (one-line clean-env health probe, no model/network/provisioning) and the top-level `--version`/`-v` (identity block: the runner's `<bin>/<version>` line unchanged, plus a `runtime protocol v<N>` line) before delegating; dispatches the embedded runtime execution/control Worker selectors through the canonical worker-host re-entry path (dynamic imports — upstream's startup-laziness tests forbid dotenv/native-addon loads in the entry graph, and `worker-core` pulls both), dispatches the isolated Bun run selector, and exercises all three runtime worker graphs in `--smoke-test` |
| `packages/coding-agent/src/task/discovery.ts` | `TASK_AGENT_CONFIG_SOURCES` derives from CONFIG_DIR_NAME + LEGACY_CONFIG_DIR_NAME (was a single hardcoded `".omp"`; stale value filtered out all project/user agent dirs after rebrand). Project agent dirs are consumed in priority order so `.aura/agents` beats legacy `.omp/agents` on a name collision, and `projectAgentsDir` only ever reports a writable base |
| `packages/coding-agent/package.json` | bin: aura alias alongside omp; runtime dependency `capnp-es@0.0.14` for checked-in embedded-protocol readers/writers, plus package-local `typescript@5.9.3` dev peer so that capnp-es codegen does not resolve the workspace's incompatible native-preview TypeScript 7 package |
| `packages/coding-agent/CHANGELOG.md` | records the opt-in embedded JavaScript/TypeScript/Python `run` adapter, inherent runtime/Superpowers policy, compact tool surface, Java/Kotlin routing, and runtime telemetry under Unreleased while preserving the process adapter as the default |
| `packages/coding-agent/src/modes/theme/theme.ts` | register built-in `aura` and `aura-light` themes in `BUILTIN_THEMES` (imports + entries), mirroring `dark`/`light` |
| `packages/coding-agent/src/utils/title-generator.ts`, `src/modes/interactive-mode.ts`, `src/modes/theme/defaults/{dark,light}-poimandres.json`, `test/terminal-title-state.test.ts`, `test/title-generator.test.ts` | replace upstream's compact `π` prompt/title brand with Aura's `☉`; preserve `icon.pi` as the compatible custom-theme key, use `o` only for the explicit ASCII preset, and keep title-state behavior unchanged apart from the mark |
| `packages/coding-agent/src/modes/setup-wizard/scenes/theme.ts` | the wizard is a SECOND source of theme defaults and the path most users actually take, so it is aligned to the brand: the "Match terminal" curated option commits `theme.dark: aura` / `theme.light: aura-light` (was `titanium`/`light`) via the `BRAND_DARK_THEME`/`BRAND_LIGHT_THEME` constants, which must stay equal to the `settings-schema.ts` defaults — a schema default the wizard overwrites is not a default. Its description names the pair; `Titanium`/`Light` remain as named non-default choices (redescribed "Neutral dark/light theme" since they no longer are the defaults) |
| `packages/coding-agent/src/modes/components/welcome.ts` | brand chrome, expressed on upstream's own animated-logo mechanism rather than a ported banner asset. Adds `AURA_LOGO` — a five-row half-block "a u r a" wordmark framed by a thin upper/lower rule, same height as `PI_LOGO` so no consumer's layout moves — and `AURA_LOGO_WIDTH`, which now supplies the welcome box's `minLeftCol` (was a hardcoded `12`, the π mark's width). `GRADIENT_STOPS` became the exported `BRAND_GRADIENT_STOPS` and holds aura's hues: the theme's own `purple`/`violet`/`magenta` vars from `modes/theme/aura.json` plus two tints so the sweep ends bright; `GRADIENT_RAMP_256` is the same walk in xterm indices for the non-truecolor fallback. `introLogoFrame`/`REST_FRAME` feed `AURA_LOGO`. `gradientLogo`/`gradientEscape` and the whole phase+shine animation are upstream's, untouched — only the letters and the hues are the fork's. `PI_LOGO` is retained verbatim (unused) so an upstream edit to it merges cleanly |
| `packages/coding-agent/src/modes/setup-wizard/scenes/splash.ts` | the splash hero renders the aura wordmark: `LARGE_LOGO` doubles `AURA_LOGO` (was `PI_LOGO`), the compact fallback picks `AURA_LOGO`, and the wordmark caption is `SPACED_APP_NAME` (`[...APP_NAME].join(" ")`, i.e. `a u r a`) instead of the literal `"O h   M y   P i"` |
| `packages/coding-agent/src/modes/setup-wizard/scenes/outro.ts` | one symbol: the outro's fading logo sweep renders `AURA_LOGO` |
| `packages/coding-agent/src/modes/setup-wizard/wizard-overlay.ts` | one symbol: the wizard scene header renders `AURA_LOGO` |
| `packages/coding-agent/src/tools/renderers.ts` | one import + one `...runtimeToolRenderers` spread at the head of `toolRenderers`, registering the nine runtime tool renderers. The spread is first so a future upstream entry with the same key would win rather than be silently shadowed; all renderer logic lives in the fork-owned `tools/runtime-renderer.ts`, so this row stays a two-line change through any merge |
| `packages/coding-agent/src/cli/gallery-fixtures/index.ts` | one import + one `...runtimeFixtures` spread, adding the runtime tool family's `omp gallery` sample data (the fixtures themselves are the fork-owned sibling module `gallery-fixtures/runtime.ts`). Without it the coverage test still passes — unfixtured tools fall back to a generic sample — but the runtime rows render as placeholder args |
| `packages/coding-agent/src/config/settings-schema.ts` | `theme.dark` default = `aura` (was `titanium`) and `theme.light` default = `aura-light` (was `light`), so the fork's terminal-background auto light/dark switching stays on-brand in both directions; `runtime.*` settings (`runtime.enabled`, `runtime.adapter` with process default and explicit-embedded no-fallback, `runtime.autoDownload`, `runtime.path`, `runtime.version`, `runtime.embeddedPath`) added to the `tools` tab; `DEFAULT_BASH_INTERCEPTOR_RULES` retains only the ordinary user-controlled dedicated-tool nudges |
| `packages/coding-agent/src/tools/report-tool-issue.ts`, `src/cli/grievances-cli.ts`, `test/tools/report-tool-issue.test.ts` | default Auto-QA collector copy points at Aura's Elide-operated `qa.elide.dev` endpoint; tests pin the fork default and preserve explicit setting / `PI_AUTO_QA_PUSH_URL` precedence. Keep upstream batching, consent, local retention, and push behavior unchanged when resolving merges |
| `packages/coding-agent/src/tools/bash.ts` | selects configured rules through `activeBashInterceptorRules(getBashInterceptorRules(), settings.get("bashInterceptor.enabled"))`; the toggle gates every rule, and direct runtime-binary commands are not intercepted |
| `packages/coding-agent/src/tools/index.ts` | `ToolSession.getRuntimeService?: () => RuntimeService \| undefined` accessor added beside `getMnemopiSessionState`, plus the root-owned `runtimeServiceScope` propagated into every subagent executor; registers engine-aware `run` and validation-only `check` as essential, `insights`/`profile` plus four specialized JVM tools (`jvm_disassemble`, `jvm_format`, `jvm_jar`, `jvm_deps`) and hub-supervised `serve` as discoverable, all on the `runtime.enabled` gate |
| `packages/coding-agent/src/tools/render-utils.ts` | keeps the upstream TUI renderer dependency graph free of the fork's runtime/worker path-boundary helper; runtime diagnostics import the fork-added dependency-light `utils/display-path.ts` directly |
| `packages/coding-agent/src/tools/builtin-names.ts` | appended the nine runtime names `run`, `check`, `insights`, `profile`, `jvm_disassemble`, `jvm_format`, `jvm_jar`, `jvm_deps`, and `serve` to `BUILTIN_TOOL_NAMES`; Java/Kotlin execution is part of `run`, with no `jvm_run` alias or shim |
| `packages/coding-agent/src/tools/essential-tools.ts` | added `run` and `check` to `ESSENTIAL_BUILTIN_TOOL_NAMES` so they stay top-level and a re-register cannot demote them (issue #5764 guard); analysis, profiling, JVM, and serve tools stay discoverable |
| `packages/coding-agent/src/config/settings.ts` | project config resolves to `<cwd>/${CONFIG_DIR_NAME}/config.yml` (was a hardcoded `.omp`): `#projectConfigPath()` is the sole write target, `#loadProjectConfigYaml()` falls back to `<cwd>/.omp/config.yml` for reads (narrowed to the `modelRoles` slice at the `#loadProjectSettings` call site) and seeds the first branded write so legacy keys carry forward. Still required after the legacy-base work — it is the only path that reads a legacy `config.yml` at all. Adapted to upstream's quarantine loader: branded reads go through `#loadYamlIfPresentForStartup`/`#loadYamlIfPresentForWriteLocked` (invalid branded files are moved aside), while legacy `.omp` reads use `#loadLegacyYamlIfPresent` — invalid legacy files error WITHOUT being quarantined, because nothing is ever written into `.omp`, not even a move-aside |
| `packages/coding-agent/src/discovery/omp-extension-roots.ts` | project extension roots read `<cwd>/${CONFIG_DIR_NAME}/settings.json` (was a hardcoded `.omp`) with a `.omp` read fallback via `readProjectSettingsExtensions`; `scopeDirs` folded into the call site. Still required after the legacy-base work: the legacy base contributes no settings documents, so this `extensions` slice remains the only `.omp/settings.json` compat |
| `packages/coding-agent/src/config.ts` | `priorityList` entries are typed `ConfigBase` and carry `legacy?`; `.omp` added as a READ-ONLY project base directly below `.aura`. User level excludes it, and pre-rebrand user state under `~/.omp/agent` is consequently on NO read path — `PI_CONFIG_DIR=.omp` is the workaround, proper adoption belongs in a future `config migrate`. `ConfigDirEntry` gained `writable`, which every write path must honor |
| `packages/coding-agent/src/discovery/builtin.ts` | native provider reads the legacy `.omp` project dir alongside the branded one: `getConfigDirs` returns `{dir, level, legacy?}`; `findNearestProjectConfigDir` became `findNearestProjectConfigFile`, which probes branded-FILE-then-legacy-FILE at the nearest ancestor owning a native config dir (AGENTS.md/RULES.md/SYSTEM.md) — a directory-level probe let any unrelated `.aura/` content mask a legacy `.omp/AGENTS.md`; skills walk both bases; project MCP paths include `.omp/{mcp,.mcp}.json`. **The legacy base is read-only in the sense that nothing is WRITTEN there, not in the sense that its content is inert:** it contributes the same EXECUTABLE surfaces as the branded dir — `hooks/pre/*` and `hooks/post/*` (auto-fire around tool calls, no approval prompt), `tools/*`, `extensions/` + `extensions:` modules, TS/JS-backed `commands/*`, and MCP servers. That is deliberate (`.omp` is the user's own pre-rebrand dir, same trust as `.aura` and as the `.claude`/`.codex`/`.gemini` bases whose hooks/tools the sibling providers already load) and is pinned by a test. The single exception is settings documents: `loadSettings` SKIPS legacy dirs, so no legacy `config.yml`/`settings.json` is ever loaded wholesale |
| `packages/coding-agent/src/modes/components/agent-dashboard.ts` | `#saveGeneratedAgent` picks the highest-priority *writable* config dir instead of `dirs[0]` (legacy `.omp` must never receive a new agent file); agent-creation architect sessions inherit the caller's root runtime scope rather than creating or disposing a competing cache |
| `packages/coding-agent/src/modes/rpc/rpc-frame.ts` | re-exports the RPC frame ceilings from the fork-added dependency-light `rpc-limits.ts`, preserving existing callers while letting the embedded ABI share the logical-response ceiling without importing the full agent RPC type graph |
| `packages/coding-agent/src/secrets/index.ts` | project secrets read `<cwd>/${CONFIG_DIR_NAME}/secrets.yml` (was a hardcoded `.omp`) with a `.omp` read fallback via `loadProjectSecretsFile` |
| `packages/coding-agent/src/cli/agents-cli.ts` | `agents unpack --project` targets `<projectDir>/${CONFIG_DIR_NAME}/agents` (was a hardcoded `.omp`); discovery reads both dirs, so the write side is branded-only |
| `packages/coding-agent/src/advisor/watchdog.ts` | `collectConfigCandidates` probes `NATIVE_CONFIG_DIR_NAMES` (branded + legacy `.omp`) per ancestor instead of only `.omp`, and the owner-dir/level classification keys off that list |
| `packages/coding-agent/src/cli/args.ts` | `Args.prependSystemPrompt`; `Args.runtime` (the `--runtime <path>` flag); `getExtraHelpText` documents `AURA_PROFILE` first with `OMP_PROFILE` marked legacy; `agents unpack` examples use `${APP_NAME}` and `${CONFIG_DIR_NAME}` |
| `packages/coding-agent/src/system-prompt.ts` | `prependSystemPrompt` / `resolvedPrependSystemPrompt` on `BuildSystemPromptOptions`, resolved through the same `withDeadline` prep as the append pair and `unshift`ed as its own leading block (a template slot could not sit above a custom prompt that replaced block 0); the resolved text also joins the customization/always-apply-rule dedupe sources |
| `packages/coding-agent/src/cli/flag-tables.ts` | `--prepend-system-prompt <text-or-file>` and `--runtime <path>` added to `STRING_SETTERS` (the single source of truth for string-valued launch flags, so the profile bootstrap and subcommand resolver pick it up automatically) |
| `packages/coding-agent/src/main.ts` | `discoverPrependSystemPromptFile` (`PREPEND_SYSTEM.md`, project then global, mirroring `discoverAppendSystemPromptFile`), resolved in `buildSessionOptions` and applied through a fourth `applyResolvedSystemPromptInputs` parameter; `--prepend-system-prompt` also joins the fork-cache-shape check; the `--version` launch-flag path prints `RUNTIME_PROTOCOL_LINE` under `VERSION`, matching the top-level interception in `cli.ts`; `--runtime <path>` applied as an ephemeral `Settings.override("runtime.path", …)` alongside the other CLI-flag overrides, so every `settings.get("runtime.path")` site (innate-tool endpoint resolution included) observes it |
| `packages/coding-agent/src/commands/launch.ts` | `prepend-system-prompt: Flags.string(...)` and `runtime: Flags.string(...)` declared for oclif's generated `--help`; the real parse lives in `cli/args.ts` (same pattern as `--auto-approve` / `--approval-mode`) |
| `packages/coding-agent/src/cli-commands.ts` | register runtime and doctor commands |
| `packages/coding-agent/src/sdk.ts` | `CreateAgentSessionOptions.prependSystemPrompt`, forwarded to `buildSystemPrompt` as `resolvedPrependSystemPrompt` and included in the fork-cache-shape check; wires selected/composite runtime settings onto the lazy `toolSession.getRuntimeService` accessor; creates a root-owned runtime cache/config scope, exposes the canonical settings snapshot reader for private top-level session factories, and propagates that scope into every descendant; every top-level session sharing that scope acquires an idempotent lease while subagents never acquire or release one; startup failure releases the lease; last release asynchronously evicts/closes only that scope |
| `packages/coding-agent/src/prompts/system/system-prompt.md`, `src/discovery/claude-plugins.ts` | promotes runtime selection and the universal engineering method into the inherent system layer; routes standalone Java/Kotlin through runtime/JVM tools and project builds through declared project commands; canonical Superpowers workflow skills are filtered only within the canonical plugin provider, while domain skills and same-named user/project skills remain discoverable |
| `packages/coding-agent/src/telemetry/{events,metrics,sink-otlp}.ts` | adds bounded `runtime.call.completed` events, `aura.runtime.calls` and `aura.runtime.duration` instruments, and structured OTLP logs without source, arguments, output, paths, or exception messages |
| `packages/ai/src/providers/cowork-fetch.ts`, `src/providers/openai-codex-responses.ts` | keeps provider source compatible when a workspace consumer enables `lib.dom`: explicitly bridges Node's `Readable.toWeb()` declaration to the WHATWG response stream, avoids Bun's DOM-aware `MessageEvent` constructor/instance inference bug at the WebSocket boundary, and narrows zstd bytes to an `ArrayBuffer`-backed `Uint8Array` without changing the transmitted body shape |
| `packages/coding-agent/src/session/agent-session-types.ts` | adds the optional root-owned `disposeRuntimeService` lifecycle callback and inherited `runtimeServiceScope` to `AgentSessionConfig` |
| `packages/coding-agent/src/session/agent-session.ts` | retains the inherited runtime scope for descendant creation and accepts the runtime disposal callback only for main sessions; disposal first performs the bounded owned-`AsyncJobManager` drain/cancel so active descendants settle before final runtime release, then runs that release once with the remaining bounded parallel teardown |
| `packages/coding-agent/src/commit/agentic/agent.ts` | creates or accepts one explicit root runtime scope for the private commit-agent session and passes the identical object to both the root SDK session and commit-tool factory |
| `packages/coding-agent/src/commit/agentic/tools/index.ts` | carries the commit agent's explicit runtime scope into its analyze-files tool instead of allowing manual child sessions to create private scopes |
| `packages/coding-agent/src/commit/agentic/tools/analyze-file.ts` | pins the root runtime scope onto the hand-built `ToolSession` used by parallel sonic file-analysis children, preserving root-only ownership and last-release disposal |
| `packages/coding-agent/src/task/executor.ts` | carries the root runtime scope through `ExecutorOptions` into each direct subagent SDK session despite its isolated settings overlay |
| `packages/coding-agent/src/task/structured-subagent.ts` | passes the parent session's root runtime scope into direct and nested task executors |
| `packages/coding-agent/src/task/persisted-revive.ts` | passes the live root runtime scope into sessions recreated from persisted subagent state |
| `packages/coding-agent/src/modes/controllers/tan-command-controller.ts` | passes the parent session's root runtime scope into `/tan` subagent sessions |
| `packages/coding-agent/src/main.ts` | passes the active top-level session's root runtime scope into persisted-subagent revival so revived descendants cannot create an unowned competing cache |
| `packages/coding-agent/src/modes/controllers/selector-controller.ts` | passes the active session's root runtime scope into the agent dashboard's auxiliary session factory |
| `packages/coding-agent/src/vibe/runtime.ts`, `packages/coding-agent/test/vibe/vibe-runtime.test.ts` | carries the originating top-level session's root runtime scope through background vibe worker spawns and pins exact scope identity so workers cannot create or dispose a competing runtime cache |
| `packages/coding-agent/test/runtime-integration.test.ts` | when `AURA_RUNTIME_EMBEDDED_LIB` names a packaged shared library, derives the sibling packaged process binary so the same real-library command also exercises the existing process-adapter/JVM integration suite |
| `packages/coding-agent/src/runtime/python.ts` | supplies CPython-compatible file-mode globals, argv, and sibling-import roots for Python path execution because the packaged runtime currently evaluates Python file input without defining `__file__` |
| `packages/coding-agent/src/runtime/transport/local.ts` | runs Python path requests through the shared file-mode bootstrap; implements the compact runtime/JVM protocol, including Java/Kotlin source-path dependency analysis, guarded dependency-report output, and symlink-safe project write boundaries |
| `packages/coding-agent/src/runtime/transport/embedded.ts` | runs Python path requests through a per-call temporary bootstrap file, cleaned after success, failure, timeout, or cancellation, so the embedded adapter preserves `__file__`, argv, and sibling imports without mutating user source |
| `packages/coding-agent/test/runtime-embedded-integration.test.ts` | verifies real process and embedded adapters expose the original absolute `__file__` for Python path execution |
| `packages/metaharness/agent/omp_local.py` | Harbor's local-agent adapter stages generated gateway routing and benchmark config under both branded `~/.aura/agent` and vanilla `~/.omp/agent` directories, allowing current Aura and pinned upstream OMP binaries to share the host gateway without credentials entering task containers |
| `packages/metaharness/src/runner.ts` | accepts `--path` for deterministic local Harbor capability tasks, installs source dependencies as the host uid/gid so the cache remains reusable, and strips host-only `PI_CONFIG_FILES` paths at both Harbor and task-container boundaries |
| `packages/metaharness/src/runner.test.ts` | covers Aura's local Harbor `--path` launch contract alongside registry dataset launches |
| `packages/metaharness/src/server.ts` | discovers externally launched CLI benchmark jobs during periodic sync and `/api/runs` reads, so completed runtime benchmark arms appear without restarting the dashboard |
| `packages/metaharness/src/manager.test.ts` | covers periodic discovery of benchmark jobs launched outside the dashboard process |
| `packages/metaharness/src/runtime-benchmark-suite.ts` | defines and materializes Aura's deterministic 10-task Harbor runtime capability suite, copies the exact orchestrator Bun into every task image for fair TypeScript execution, generates Bun-based verifiers, and provides a model-free Docker smoke covering Node imports, TypeScript syntax, top-level await, and sorted BFS output |
| `packages/metaharness/src/runtime-benchmark-suite.test.ts` | verifies the compact runtime task catalog, generated Harbor task structure, task-owned executable Bun, Bun-only TypeScript verifier contract, and deterministic smoke-source feature coverage |
| `packages/metaharness/src/runtime-benchmark.ts` | orchestrates balanced matched agent arms with production-essential `run`/`check` plus task-specific discoverable tools, injects repository-packaged process and embedded runtime artifacts into source-mounted task containers, blocks model launches on the deterministic TypeScript verifier smoke, resumes interrupted frozen campaigns without rerunning completed Harbor jobs, reconstructs full arm elapsed time, aggregates paired effectiveness/latency/token/adoption evidence, and freezes the verifier Bun version/SHA-256 beside per-task tools and hashes |
| `packages/metaharness/src/runtime-benchmark.test.ts` | covers matched and historical arm construction, the compact task-specific runtime surface, packaged runtime path injection, resumable arm selection and persisted elapsed-time reconstruction, canonical per-trial measurements and tool-call counting, paired confidence/gate logic, manifest identity including verifier Bun metadata, report metrics, adapter sample ordering/output acceptance, percentile and speedup math, option precedence, and service cleanup |
| `packages/metaharness/package.json` | exposes `bench:runtime` for the broad runtime suite and `bench:inherent` for the focused two-task legacy-skills-vs-inherent-prompt comparison |
| `packages/metaharness/README.md` | documents the broad compact-surface runtime benchmark, pinned vanilla OMP historical controls, the focused inherent-capability comparison and gates, resumable frozen campaigns, report outputs, focused run modes, and opt-in process-vs-embedded decision run |
| `package.json` | exposes root `bench:runtime` and `bench:inherent` commands for the broad runtime suite and focused prompt comparison, plus `build:runtime-bundle` for the relocatable Aura + runtime archive; includes its contract test in `test:scripts` |
| `docs/settings.md`, `docs/environment-variables.md` | documents `runtime.enabled` / `runtime.adapter` / `runtime.autoDownload` / `runtime.path` / `runtime.version` / `runtime.embeddedPath`, including process-default adapter selection, the validated per-process `AURA_RUNTIME_ADAPTER` override, explicit-embedded no-fallback behavior, embedded-library resolution precedence, off-pin managed-version verification limits, and the compact ten-tool runtime surface |
| `packages/coding-agent/src/cli/update-cli.ts` | distribution coordinates come from `pi-utils/distribution` (`DIST_*`) instead of upstream's can1357/npm constants; `getLatestRelease` is channel-aware (GitHub `releases/latest` on the fork repo, token-aware via `GITHUB_TOKEN`/`GH_TOKEN`, npm branch retained for a future publish) and exported with a `timeoutMs` param for the startup check; `resolveReleaseBinaryAsset` additionally returns the API asset URL and `updateViaBinaryAt` downloads through it with `Accept: application/octet-stream` + bearer auth when a token is present (the browser download URL 404s while the repo is private); the reinstall hint points at `DIST_INSTALL_URL` |
| `packages/coding-agent/src/main.ts` (version check) | `checkForNewVersion` delegates to `getLatestRelease(5_000)` from update-cli so the startup notification and `aura update` consult the same channel; any check failure stays silent |
| `packages/coding-agent/src/modes/utils/ui-helpers.ts` | the "Update Available" box advises `${APP_NAME} update` (was hardcoded `omp update`) |
| `packages/coding-agent/src/config/settings-schema.ts` (startup.checkUpdate) | description templated with `APP_NAME` |
| CLI advisory strings (many files) | user-facing `omp <subcommand>` hints, usage/examples, and `~/.omp` path mentions are templated with `APP_NAME`/`CONFIG_DIR_NAME`: `cli-commands.ts` misuse hints, `main.ts` resume hints, `cli/{ssh,models,plugin,auth-gateway,auth-broker,usage,bench,gallery-screenshot}*-cli.ts`, `commands/*` (incl. all `renderCommandHelp(APP_NAME, …)` call sites), `modes/components/plugin-settings.ts`, `modes/controllers/ssh-command-controller.ts`, web login hints (`web/kagi.ts`, `web/parallel.ts`, `web/search/providers/*`), `packages/ai/src/auth-broker/remote-store.ts`, and the prompt docs `prompts/system/autolearn-guidance.md` + `prompts/tools/hub.md`. Resolve upstream conflicts by taking upstream's wording and re-substituting the constants. NOT rebranded by design: `omp://` scheme, `@oh-my-pi/*` package names, env vars, `__omp_worker_*` selectors, temp-file prefixes, wire/telemetry identities |
| `packages/coding-agent/src/cli/commands/init-xdg.ts` | removed the local `APP_NAME = "omp"` shadow; XDG dirs and hint text use the branded constant from pi-utils |
| `packages/coding-agent/src/cli/profile-alias.ts` | alias command, fish conf.d filename, `--wraps`, and rc-file block markers all derive from `APP_NAME` (imported from the `/dirs` subpath to avoid eager env load) |
| Display name "Oh My Pi" → "Aura" | `packages/tui/src/desktop-notify.ts`, `tui/src/terminal-capabilities.ts` (CMUX + OSC-99 titles), `modes/controllers/event-controller.ts`, `debug/index.ts`, `tools/ask.ts`, `dap/session.ts` (clientName), `modes/acp/acp-agent.ts`, `commands/acp.ts`, `prompts/system/system-prompt.md` ("Aura coding harness"), `live/prompts/live-instructions.md` ("Aura Live"), `session/agent-session.ts` power reason, `packages/ai/src/registry/oauth/oauth.html`, and Rust `crates/pi-natives/src/{power,crash_handler,lib}.rs` (crash logs land under `.aura`) |
| Windows Terminal / WSL / tmux rendering (`packages/tui/src/terminal-capabilities.ts`, `packages/coding-agent/src/modes/{interactive-mode.ts,theme/theme.ts}`, `packages/coding-agent/src/config/settings-schema.ts`) | aura hardening for the common WSL setup: `detectTerminalId` treats `WT_SESSION` as truecolor (Windows Terminal never emits `COLORTERM`; WSLENV forwards only `WT_SESSION`), `tui.scrollbackRebuild` defaults on for ConPTY hosts, and a new `TERMINAL.italic` capability (`shouldEnableItalicByDefault` / `italicUserOverride`, `PI_FORCE_ITALIC`/`PI_NO_ITALIC`) suppresses SGR 3 under screen-family terminfo (no `sitm`) so tmux/screen no longer paint italic as reverse-video blocks. `theme.italic` and the HUD-note marker in `interactive-mode.ts` gate on it |
| Release pipeline | `scripts/ci-release-build-binaries.ts` outfiles templated `${APP_NAME}-<os>-<arch>`; `.github/workflows/ci.yml` matrix/codesign paths and `release_brew` (elide-dev/homebrew-tap, `Formula/aura.rb`); `scripts/ci-update-brew-formula.ts` (repo `elide-dev/BREAKDANCE`, class `Aura`, installs `aura`); `scripts/install.sh` + `scripts/install.ps1` (fork repo, `aura-*` assets, installs `aura`); `packages/metaharness/src/launch-args.ts` prebuilt names. Asset basenames must stay equal to update-cli's `getBinaryName()` output |
| `AGENTS.md` | appended the `## Aura fork conventions` section (points contributors at this file, states the runtime naming rule, locates specs/plans) |
| `biome.json` | excludes checked-in `capnp-es` runtime protocol bindings from source formatting/lint; generated output is verified byte-for-byte by `scripts/sync-embedded-runtime-protocol.ts --check` instead |
| `bun.lock` | `aura` bin entry plus the exact `capnp-es@0.0.14` runtime dependency and coding-agent-local `typescript@5.9.3` generator peer. Regenerate with `bun install` rather than resolving a merge conflict by hand |

### Upstream tests de-hardcoded for the rebrand

One mechanical class of change, applied to every upstream test that baked the
brand into a literal: `".omp"` → `CONFIG_DIR_NAME` and `"omp"` → `APP_NAME`
(imported from `@oh-my-pi/pi-utils` / `@oh-my-pi/pi-utils/dirs`). No upstream
expectation was weakened — only the path/name literals moved behind the
constants that `packages/utils/src/dirs.ts` now brands. Prefer resolving an
upstream merge conflict in these by taking upstream's assertion and
re-substituting the constant.

`packages/coding-agent/test/`: `acp-mcp-isolation`, `cli-max-time-flag`,
`cli/completions`, `debug/dap-config`, `debug/report-bundle-logs`,
`discovery/builtin-rules-md`, `discovery/disabled-extensions`,
`discovery/omp-plugins`, `discovery/pi-config-dir`,
`extension-dashboard-mcp-parity`, `gc-cli`,
`issue-4197-plugin-resolution-cache`, `main-interactive-input`,
`marketplace/manager`, `marketplace/project-scope`, `model-hub`,
`modes/controllers/omfg-controller`, `sdk-skills`,
`selector-settings-side-effects`, `settings-reload-cwd`,
`system-prompt-dedup`, `task/discovery`, `tools/gh`, `update-cli`.

`settings-reload-cwd` and `discovery/omp-plugins` additionally carry fork-added
cases pinning the project-config brand split (branded path canonical, `.omp`
read fallback, writes never legacy); keep those alongside upstream's.
`discovery/pi-config-dir` expects the fork's `writable` field on
`ConfigDirEntry`.

`packages/utils/test/`: `dirs-cache`, `dirs-python-gateway`, `profiles`.

Also de-hardcoded for the rebrand: `packages/coding-agent/test/`
`profile-alias`, `install-command`, `plugin-verb-launch-leak`,
`modes/components/plugin-list-marketplace`, `main-session-resolution-error`;
`packages/tui/test/` `desktop-notify`, `notifications` (OSC-99 pins carry the
brand base64-encoded — `QXVyYQ==` is "Aura"); `packages/coding-agent/test/`
`acp-initialize-conformance`, `hook-selector-overflow`; root `scripts/`
`ci-release-build-binaries.test.ts`, `musl-release.test.ts`,
`ci-update-brew-formula.test.ts`.

`settings-manager` carries the project-config write-path cases on
`CONFIG_DIR_NAME`; the "both configs malformed" case exercises the branded
project dir (legacy invalid files error without quarantine — pinned in
`legacy-omp-compat-paths`). `update-cli` asserts brew/mise/repo coordinates
via the `DIST_*` constants. `export-html-template` re-pins template
bytes/sha because the fork's `tool-views.generated.js` carries the runtime
tool renderers — recompute those three constants whenever an upstream merge
changes the template sources.


## Fork-added files and directories (additive, no merge risk)

- `packages/utils/src/distribution.ts` — single source of truth for aura's
  distribution coordinates (release repo `elide-dev/BREAKDANCE`, update channel
  `github`, install URL, brew/mise/npm coordinates), re-exported from the
  pi-utils index; consumed by update-cli, the startup version check, and the
  CI release scripts

- `packages/coding-agent/src/modes/rpc/rpc-limits.ts` — dependency-light canonical
  RPC frame ceilings shared by the upstream RPC transport and embedded ABI
- `packages/coding-agent/src/runtime/` — runtime capability core; `index.ts` owns the
  selected-service cache key, atomic swap/retirement/disposal ordering, and
  `RuntimeSettingsValues` adapter/library mapping; `service.ts` owns the idempotent
  endpoint-awaiting close boundary and observes every protocol request exactly once
  through `telemetry.ts`, which emits bounded outcomes and annotates the active tool
  span without changing results or failures; `transport/selected.ts` implements the
  engine-aware process/embedded/Bun routing and composed status matrix, including
  optimistic embedded Java/Kotlin dispatch with process fallback on unsupported
  language; `transport/bun.ts` owns isolated JavaScript/TypeScript child execution
  through the CLI worker-host re-entry path in `bun-run-entry.ts`; `transport/local.ts`
  owns process execution, adjacent bundled Kotlin classpaths, Java/Kotlin source-path
  dependency analysis, and guarded project output writes; `transport/embedded.ts`
  owns validation, lazy open/reuse, serial execution, cancellation races, poisoning,
  teardown, and postmortem fallback; `resolve.ts` owns regular-file validation shared
  by binary and library resolution; and `src/runtime/embedded/` contains the
  exact-precedence shared-library resolver, handwritten embedded wire adapter, schema
  identity constants, the sole `bun:ffi` ABI owner, and the typed
  load-only-probe/serialized-execution/independent-control dual-Worker host and entries,
  validates serialized native close responses before teardown succeeds, and includes
  checked-in TypeScript generated from WHIPLASH's canonical Cap'n Proto closure
- `scripts/sync-embedded-runtime-protocol.ts` — canonical WHIPLASH schema-closure
  generation, fingerprinting, and checked-in drift verification
- `packages/coding-agent/src/utils/display-path.ts` — dependency-light path display
  boundary for worker/loader diagnostics: sanitizes control/ANSI content,
  home-shortens, expands tabs, and escapes line breaks without importing the TUI or
  native addon graph
- `packages/coding-agent/src/cli/runtime-cli.ts`, `src/commands/runtime.ts` — runtime
  status command routed through the selected/composite endpoint and explicitly closed
  after probing, including exact JSON selection/ABI/schema fields and sanitized,
  home-shortened, single-line adapter/library paths in plain output
- `packages/coding-agent/src/cli/doctor-cli.ts`, `src/commands/doctor.ts` — aggregate
  diagnostics, including requested/effective adapter and embedded runtime library
  selection with sanitized, home-shortened, single-line paths; status-only runtime
  services are closed without masking a primary probe failure
- `packages/coding-agent/src/cli/version-identity.ts` — `--version` identity line
  (`<app>/<version>` + runtime protocol version)
- `scripts/build-relocatable-runtime-bundle.ts`,
  `scripts/build-relocatable-runtime-bundle.test.ts` — fork-owned Linux x64/glibc
  packager and behavioral contract tests for a relocatable standalone Aura binary,
  complete Elide distribution, embedded-library sidecars, runtime overlay, launcher,
  archive, checksum, and post-extraction verification; the launcher resolves relative, absolute, and chained installation symlinks before deriving its bundle root
- `packages/metaharness/src/inherent-capability-benchmark.ts`,
  `src/inherent-capability-benchmark.test.ts`, and
  `packages/coding-agent/scripts/runtime-telemetry-preflight.ts` — focused current
  smoke and matched comparison of legacy skill-mediated prompts against inherent
  capability policy on TypeScript execution and edit-plus-verification tasks, with
  identical tools, per-attempt AB/BA pairing, treatment hashes, a deterministic
  success/failure telemetry preflight, and gates for task success, runtime adoption,
  first execution choice, promoted-skill loads, tool calls, and input tokens
- `packages/coding-agent/src/tools/runtime-*.ts` (including `runtime-launch.ts`, which
  starts runtime launch descriptors through the upstream `hub` supervisor rather than
  keeping a process registry of its own), `src/prompts/tools/runtime-*.md`,
  `src/prompts/tools/jvm-*.md`
- `packages/coding-agent/src/tools/runtime-renderer.ts` — TUI renderers for the whole
  runtime tool family. One factory over declarative per-tool `describeCall` /
  `describeResult` specs, in the `glob`/`hub` house style (status line + short output
  preview, `inline`, `mergeCallAndResult`). It adds no truncation of its own: the
  central spill in `tools/output-meta.ts` stays the sole authority, and the renderer
  only strips the notices (`(exit code N)`, the spill's own footer) that the header
  restates. `src/cli/gallery-fixtures/runtime.ts` is its `omp gallery` sample data
- `packages/coding-agent/src/modes/theme/aura.json`, `src/modes/theme/aura-light.json` —
  the `aura` / `aura-light` built-in themes registered by the `theme.ts` row above.
  `aura-light` is the brand light counterpart: same `vars` brand palette (magenta /
  violet / purple), deepened `*Deep` variants where the brand hue is used as text on a
  near-white surface, and a `colors` sub-key set held equal to `light.json`'s by
  `test/aura-light-theme.test.ts`
- `packages/coding-agent/test/compact-brand-symbol.test.ts` — pins Aura's compact
  prompt mark across Unicode, Nerd, ASCII, and bundled Poimandres symbol presets
- `packages/coding-agent/test/runtime-*.test.ts`, `test/doctor-cli.test.ts`,
  `test/doctor-command-registration.test.ts`, `test/doctor-tool-gate-drift.test.ts`,
  `test/aura-bin.test.ts`,
  `test/aura-theme.test.ts`, `test/aura-light-theme.test.ts`,
  `test/runtime-tool-renderers.test.ts`, `packages/utils/test/branding.test.ts` — fork-owned
  tests, including embedded library precedence/file-type contracts, ABI copy/free/state
  ownership, dual-Worker protocol/death/ordered-shutdown and native-close-failure
  behavior, real-library source-tool execution and process-parity/reuse/cancellation/
  timeout/FIFO isolation coverage, runtime cache/session ownership and status-only
  disposal, runtime status/doctor selection diagnostics, and LF/tab path row-forging
  regressions; safe to keep verbatim through any upstream merge
- `packages/coding-agent/test/discovery/legacy-omp-project-base.test.ts`,
  `test/legacy-omp-compat-paths.test.ts`, `test/cli-help-profile-env.test.ts` —
  legacy `.omp` compat contract: file surfaces load, `.aura` wins conflicts, a
  non-empty `.aura/` never masks a legacy single-file surface, the legacy
  executable surfaces (`hooks/`, `tools/`) DO load by design, legacy settings
  documents never become live, writes stay branded
- `docs/tools/{run,check,insights,profile,serve,jvm_disassemble,jvm_format,jvm_jar,jvm_deps}.md` — root docs pages required by the `omp://` docs-coverage guard (`test/internal-urls/docs-tool-coverage.test.ts` asserts one `docs/tools/<name>.md` per entry in `BUILTIN_TOOL_NAMES`)
- `docs/aura/`, `docs/superpowers/`

## Naming rule

Elide is never user-facing; the noun is "the runtime". See
`docs/superpowers/specs/2026-07-25-aura-omp-fork-design.md`.
