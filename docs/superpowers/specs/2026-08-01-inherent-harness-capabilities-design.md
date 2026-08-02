# Inherent Harness Capabilities Design

## Goal

Treat Aura-owned runtime execution and the universal Superpowers engineering method as inherent harness behavior, not optional skills. Remove their skill UI and skill-invocation telemetry footprint while preserving domain-specific authored skills.

The change must also emit per-call runtime telemetry with reliable success/error classification, resolved language where applicable, and wall-clock duration through Aura telemetry and OpenTelemetry.

## Current state

Aura registers five bundled runtime skills (`runtime`, `insights`, `profiling`, `jvm`, and `stateful-debugger`). The provider materializes their Markdown into the agent directory, advertises them in the system prompt, and exposes them through `skill://` and `/skill:*`. The model must load a skill before using a capability already represented by a registered tool and its tool prompt.

Canonical Superpowers core workflow skills are similarly advertised as optional domain knowledge even though design-before-editing, debugging, testing, delegation, verification, and completion are universal harness policy. This adds prompt catalog tokens, visible UI entries, skill-load round trips, and skill-use events without adding optional behavior.

All agent tools already receive generic `execute_tool` spans. Those spans carry tool name, terminal tool status, and intrinsic span duration, but runtime results are not consistently classified as tool errors on non-zero exit. Runtime-specific language and call duration are not available as indexed attributes or metric dimensions.

## Scope

### In scope

- Promote compact runtime selection policy into the main system prompt.
- Promote the universal Superpowers engineering method into the main system prompt.
- Remove Aura's bundled runtime skill provider, materialization, setting, commands, and tests.
- Exclude only canonical Superpowers core workflow skills from Claude marketplace discovery; preserve every domain-specific Superpowers skill and every same-named user/project skill.
- Add runtime call telemetry at the `RuntimeService` boundary.
- Classify non-zero, killed, cancelled, timed-out, and thrown runtime calls correctly in generic tool spans.
- Add the smallest repeatable behavior benchmark that exercises runtime selection and verification.
- Keep `run` and `check` essential; move high-cost runtime capabilities behind tool discovery.
- Collapse Java/Kotlin execution into `run`, retain four distinct JVM artifact/analysis tools, and remove redundant build, project-advice, and Javadoc runtime tools.

### Out of scope

- Changing runtime execution, adapter selection, or lifecycle behavior beyond deleting obsolete protocol methods.
- Hiding domain-specific skills.
- Adding a general prompt-fragment discovery framework.
- Replacing the compact broad runtime effectiveness suite.

## Prompt architecture

### Inherent capability position

The default system prompt gains an `INHERENT CAPABILITIES` section immediately after role and engineering principles, before authored skills and rules.

The runtime subsection renders only when at least one runtime tool is registered. It contains decision policy, not schemas:

- direct JS/TS/Python/Java/Kotlin execution uses `run`;
- persistent incremental exploration uses `eval`;
- shell commands and installed CLIs use `bash`;
- validation without artifacts uses `check`;
- project artifact production uses declared external build commands;
- instrumentation, profiling, externally attachable debugging, serving, and four JVM artifact/analysis operations use their registered named tools;
- the runtime binary is never invoked through `bash`.

Each statement is guarded by actual tool availability so the prompt never advertises an unavailable capability. Tool prompt Markdown remains the sole argument and failure-shape reference.

The engineering-method subsection is unconditional and compact:

- understand intent and choose a design before behavioral edits;
- reproduce bugs before changing code;
- test observable contracts before implementation where a regression boundary exists;
- delegate only independent work;
- verify the changed behavior before completion.

These rules replace the need to load universal Superpowers workflow skills. They do not impose UI ceremony or require user approval for routine, already-specified work.

### Authored skill contract

The `<skills>` catalog is redefined as optional domain knowledge and workflows. It no longer contains Aura runtime capabilities or canonical Superpowers core workflow skills.

Canonical Superpowers filtering occurs in the Claude marketplace provider while the provider still has plugin identity. The filter applies only when the plugin name is `superpowers` and only to the agreed core names:

- `using-superpowers`
- `brainstorming`
- `writing-plans`
- `executing-plans`
- `test-driven-development`
- `systematic-debugging`
- `verification-before-completion`
- `dispatching-parallel-agents`
- `subagent-driven-development`
- `using-git-worktrees`
- `requesting-code-review`
- `receiving-code-review`
- `finishing-a-development-branch`

A project or user skill with the same name remains loadable because it comes from another provider. Other Superpowers skills remain ordinary discoverable skills.

## Runtime telemetry

### Instrumentation boundary

`RuntimeService.#call` is the single instrumentation boundary for every remaining runtime protocol request. It records exactly one completion event for success, protocol error, cancellation, timeout, or unexpected failure. This avoids per-tool drift and covers `run`, `check`, `insights`, `profile`, four JVM actions, debug/serve launch composition, and status probes.

The event contains:

- session ID when attributable;
- runtime method and JVM/spawn action where applicable;
- resolved language when applicable;
- outcome: `ok`, `error`, `timeout`, or `cancelled`;
- wall-clock `durationMs` measured around the complete request;
- exit code and killed flag for execution results;
- bounded error type/code, never source or program output.

Language resolution uses the returned `RuntimeRunResult.language` for `run`; request language or the existing runtime target resolver for instrumentation/profile/JVM calls. Check, spawn, and status omit the dimension rather than emitting `unknown`.

### OpenTelemetry spans

Runtime calls made by agent tools execute inside the existing `execute_tool` active span. The service adds indexed attributes to that span:

- `aura.runtime.method`
- `aura.runtime.action` when applicable
- `aura.runtime.language` when applicable
- `aura.runtime.outcome`
- `aura.runtime.duration_ms`
- `aura.runtime.exit_code` when applicable
- `aura.runtime.killed` when applicable

Generic `gen_ai` tool attributes remain authoritative for tool name and call ID. Generic `aura.tool.status` and `error.type` remain authoritative for success/error classification.

Every execution-style runtime tool returns `isError: true` for non-zero exit or killed execution. Thrown runtime errors continue through the agent loop's existing exception path. This makes generic spans, aggregate run summaries, and tool metrics agree with runtime-specific attributes.

### Aura telemetry and metrics

Add a typed `runtime.call.completed` event to the coding-agent telemetry bus. The OTLP sink records:

- `aura.runtime.calls` counter by method, action, language, and outcome;
- `aura.runtime.duration` histogram in milliseconds with the same bounded dimensions.

The event bus remains a no-op without subscribers. Telemetry failures never alter runtime results. No code, paths, arguments, stdout, stderr, or exception messages become metric attributes.

## UI and settings cleanup

Remove:

- the `builtin-skills` capability provider and provider constant;
- bundled skill materialization and manifest files;
- `skills.enableBundled` from settings and settings types;
- bundled runtime entries from slash-command and skill UI surfaces;
- provider-specific tests that assert the five runtime skills exist.

Update general skill tests to stop carrying the removed toggle. Remove obsolete files rather than leaving aliases or deprecated settings.

The final runtime tool surface is deliberately asymmetric:

- Essential on every runtime-enabled request: `run`, `check`.
- Discoverable through `xd://`: `insights`, `profile`, `serve`, `jvm_disassemble`, `jvm_format`, `jvm_jar`, `jvm_deps`.
- Removed entirely: `build`, `project_advice`, `runtime_debug` and its CDP/DAP launch protocol, `jvm_javadoc`, and the `jvm_run` alias.

The remaining provider schemas must stay compact. `run` owns standalone language execution; specialized JVM tools own only bytecode, formatting, JAR, and dependency workflows. Project-declared builds remain external toolchain commands.

## Minimal benchmark

Reuse the existing deterministic metaharness fixtures, runner, measurements, and report primitives in a focused two-task orchestrator rather than creating a second benchmark framework.

The default inherent-capability smoke runs:

1. `typescript-execution` — validates direct runtime selection and successful execution.
2. `jvm-dependencies` — validates selection of `jvm_deps` over generic execution or shell commands.

Run one attempt for a smoke gate and three alternating attempts when comparing revisions. Record existing pass, duration, token, tool-call, and runtime-adoption measurements plus the new runtime telemetry.

Smoke gate:

- both tasks pass;
- every completed task invokes a runtime tool;
- each task selects its expected capability (`run` or `jvm_deps`) before `bash`;
- success and intentional failure probes produce distinct telemetry outcomes;
- no runtime or core-workflow skill is loaded because those capabilities are absent from the skill catalog.

The compact ten-task suite remains the broader regression run. The two-task mode is the optimization loop, not evidence of general model quality.

## Verification

1. System-prompt rendering tests cover runtime tools present and absent, and prove promoted names are absent from `<skills>`.
2. Claude plugin discovery tests prove only canonical core Superpowers skills are filtered.
3. Runtime service tests cover success, non-zero exit, timeout/cancellation, thrown protocol errors, language resolution, and duration.
4. Tool tests prove non-zero and killed results set `isError`.
5. Telemetry event and OTLP metric tests prove method, outcome, language, and duration propagation without payload leakage.
6. OpenTelemetry tests prove runtime attributes coexist with generic tool status/error attributes.
7. Run the two-task inherent-capability benchmark.
8. Run focused coding-agent and agent tests, then repository type checks.

## Risks and controls

- Prompt duplication can increase context. Control: remove bundled skill descriptions and keep inherent policy shorter than the removed catalog entries.
- Filtering by skill name alone could hide user behavior. Control: filter only inside the canonical Superpowers plugin provider branch.
- Runtime results can disagree with tool status. Control: one shared execution-result classifier used by all runtime tools.
- Metric cardinality can grow from free-form values. Control: method, action, language, and outcome are closed vocabularies; errors use protocol/status classes only.
- Instrumentation can alter failures. Control: telemetry publication and span annotation are non-throwing and never replace the runtime result.

## Work isolation

Implementation occurs in `.wt/inherent-capabilities` on branch `inherent-capabilities`, isolated from the ongoing Bazel RBE work in the primary checkout.
