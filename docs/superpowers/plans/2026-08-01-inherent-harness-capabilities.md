# Inherent Harness Capabilities Implementation Plan

**Goal:** Make runtime execution and the universal engineering method inherent system behavior, remove their implicit skill/UI footprint, keep the common tool surface compact, and prove selection with a minimal benchmark.

**Architecture:** Static Handlebars policy in the default system prompt is conditional on registered tools. Canonical Superpowers core skills are filtered only inside the canonical plugin provider. `run` and `check` stay essential; expensive analysis, profiling, debug, serving, and JVM operations stay discoverable. `RuntimeService.#call` provides one bounded telemetry boundary for the remaining runtime protocol.

**Constraints:**

- Work only in `.wt/inherent-capabilities`.
- Preserve same-named user/project skills and all domain skills.
- Never expose source, paths, arguments, output, or exception messages as telemetry dimensions.
- Keep the process adapter default and preserve existing runtime lifecycle behavior.
- Remove obsolete tools and protocol methods cleanly; no aliases or compatibility shims.
- Do not commit unless explicitly requested.

## Task 1: Promote inherent policy and remove skill surfaces

**Change**

- Add compact engineering-method and runtime-selection policy to `src/prompts/system/system-prompt.md`.
- Remove the bundled runtime skill provider, setting, materialization, command, and provider-specific tests.
- Filter only the canonical Superpowers workflow names inside `src/discovery/claude-plugins.ts`.
- Preserve domain skills and same-named skills from every other provider.

**Contract**

- The prompt advertises only tools actually registered.
- Runtime and core workflow skills do not appear in the skill catalog or slash-command UI.
- No skill load is needed before an inherent runtime/tool action.

## Task 2: Add runtime telemetry and status classification

**Change**

- Observe every remaining runtime protocol call once in `src/runtime/telemetry.ts`.
- Publish bounded `runtime.call.completed` events and OTLP counter/histogram data.
- Annotate the active tool span with method, action, language, outcome, duration, exit code, and killed state where available.
- Mark non-zero or killed execution results as tool errors through the shared classifier in `src/runtime/format.ts`.

**Contract**

- Success, process failure, timeout, cancellation, and protocol failure produce distinct bounded outcomes.
- Telemetry failures never alter runtime results.
- Generic tool status and runtime-specific status agree.

## Task 3: Compact the runtime tool surface

**Change**

- Keep `run` and `check` essential.
- Keep `insights`, `profile`, `serve`, `jvm_disassemble`, `jvm_format`, `jvm_jar`, and `jvm_deps` discoverable.
- Route standalone Java/Kotlin through `run`; retain only four specialized JVM artifact/analysis tools.
- Remove `build`, `project_advice`, `runtime_debug` and its CDP/DAP launch mode, `jvm_javadoc`, and the `jvm_run` alias from tool registration, protocol, service, endpoint routing, telemetry, renderers, fixtures, docs, settings copy, and tests.
- Keep project artifact production on declared external build commands.
- Trim remaining tool prompts and schemas to decision-relevant guidance.

**Contract**

- Runtime-enabled default requests carry only the `run` and `check` schemas.
- Discoverable tools remain invocable through `xd://` or explicit `--tools`.
- The runtime service exposes no dead protocol methods.
- Provider payload tests cap the essential pair and the full discoverable family.

## Task 4: Tighten JVM dependency workflows

**Change**

- Let `jvm_deps` accept either an existing `.java`/`.kt`/`.class`/`.jar`/class directory path or inline language plus source.
- Compile source in scratch space; analyze artifacts directly without redundant compilation.
- Allow an optional guarded cwd-relative report output, requiring `overwrite: true` to replace a file.
- Refuse directories and any real or symlinked destination outside the working directory.

**Contract**

- Source-path and inline-source calls report dependencies without modifying project files unless `output` is supplied.
- Artifact mode invokes `jdeps` directly.
- Output containment survives parent and leaf symlinks.

## Task 5: Keep benchmarks minimal and task-specific

**Change**

- Keep the focused smoke to two tasks: `typescript-execution` and `jvm-dependencies`.
- Give each task six baseline file/shell tools, `run`/`check`, and only its required specialist.
- Retain the broader suite for regression coverage; the focused smoke remains the optimization loop.
- Hash the exact prompt, tool prompt, registration, and skill-filter inputs used by the inherent treatment.

**Smoke command**

```bash
bun run bench:inherent --prefix inherent-compact-smoke
```

**Smoke gates**

- Both tasks pass.
- Every trial uses a runtime tool.
- `run` is selected before `bash`.
- No promoted runtime/core workflow skill is loaded.
- Telemetry preflight distinguishes success and intentional failure.

**Comparison command**

```bash
AURA_LEGACY_BINARY=/absolute/path/to/legacy-aura bun run bench:inherent \
  --attempts 3 --prefix inherent-compact-comparison
```

**Comparison gates**

- All smoke gates pass.
- Median paired tool calls do not increase.
- Median paired input tokens do not increase.

## Task 6: Verify and clean up

1. Run focused prompt, registry, runtime, endpoint, renderer, JVM, benchmark, settings, doctor, and docs-coverage tests.
2. Run `bun check` in `packages/coding-agent` and `packages/metaharness`.
3. Run root `bun run check:ts`.
4. Run the inherent smoke against the source-mounted coding agent.
5. Update `docs/settings.md`, `docs/aura/FORK.md`, `packages/metaharness/README.md`, and the coding-agent Unreleased changelog.
