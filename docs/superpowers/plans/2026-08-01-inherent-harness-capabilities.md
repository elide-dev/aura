# Inherent Harness Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote runtime and universal engineering policy into the system prompt, remove their skill surfaces, and emit trustworthy per-call runtime telemetry.

**Architecture:** Static Handlebars policy in the default system prompt is conditional on registered tools. Canonical Superpowers core skills are filtered while their plugin identity is available; Aura's bundled runtime skill provider is removed. `RuntimeService.#call` wraps every runtime request with one non-throwing telemetry observer that annotates the active `execute_tool` span and publishes a bounded typed event consumed by OTLP metrics.

**Tech Stack:** TypeScript, Bun, Handlebars prompt templates, ArkType, OpenTelemetry API/metrics, existing Aura telemetry event bus, Harbor metaharness.

## Global Constraints

- Work only in `.wt/inherent-capabilities` on branch `inherent-capabilities`.
- Never expose source, paths, arguments, stdout, stderr, or error messages as telemetry dimensions.
- Keep telemetry dimensions to closed method, action, language, and outcome vocabularies.
- Runtime failures must preserve their original return/throw behavior.
- Same-named user/project skills must remain visible.
- Do not commit unless the user explicitly requests it.

---

### Task 1: Promote Inherent Prompt Policy and Remove Skill Surfaces

**Files:**
- Modify: `packages/coding-agent/src/prompts/system/system-prompt.md`
- Modify: `packages/coding-agent/src/discovery/claude-plugins.ts`
- Modify: `packages/coding-agent/test/system-prompt.test.ts`
- Modify: `packages/coding-agent/test/discovery/claude-plugins.test.ts`
- Remove: `packages/coding-agent/src/discovery/builtin-skills.ts`
- Remove: `packages/coding-agent/src/discovery/builtin-skill-sources/`
- Remove: `packages/coding-agent/test/discovery/builtin-skills.test.ts`
- Modify: `packages/coding-agent/src/discovery/index.ts`
- Modify: `packages/coding-agent/src/capability/skill.ts`
- Modify: `packages/coding-agent/src/extensibility/skills.ts`
- Modify: `packages/coding-agent/src/config/settings-schema.ts`
- Modify: `packages/coding-agent/test/skills.test.ts`

**Interfaces:**
- Produces: `CORE_SUPERPOWERS_SKILLS: ReadonlySet<string>` local to the Claude plugin provider.
- Produces: conditional `INHERENT CAPABILITIES` prompt policy driven by existing `#has tools` helpers.

- [ ] **Step 1: Add failing prompt and discovery contracts**

Add prompt assertions that a build with `run`, `eval`, `bash`, `check`, and `build` contains their selection boundaries, while a build without runtime tools omits runtime policy. Add a Claude plugin fixture named `superpowers` containing one core skill and one domain skill; assert the core skill is absent and the domain skill remains. Add a same-named non-plugin skill assertion to `skills.test.ts`.

```ts
expect(prompt).toContain("Direct program execution");
expect(prompt).toContain("Persistent exploration");
expect(promptWithoutRuntime).not.toContain("# Runtime execution");
expect(skills.map(skill => skill.name)).toEqual(["domain-specialist"]);
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run:

```bash
bun test packages/coding-agent/test/system-prompt.test.ts packages/coding-agent/test/discovery/claude-plugins.test.ts packages/coding-agent/test/skills.test.ts
```

Expected: new inherent-policy and canonical-plugin filtering assertions fail.

- [ ] **Step 3: Implement compact higher-order policy**

Insert the policy immediately after engineering principles. Use one tool guard per statement; never advertise unavailable tools. Change the skill introduction to optional domain knowledge. In `claude-plugins.ts`, skip exact core names only inside `loadSkills` when `root.plugin === "superpowers"`.

```ts
const CORE_SUPERPOWERS_SKILLS: ReadonlySet<string> = new Set([
  "using-superpowers",
  "brainstorming",
  "writing-plans",
  "executing-plans",
  "test-driven-development",
  "systematic-debugging",
  "verification-before-completion",
  "dispatching-parallel-agents",
  "subagent-driven-development",
  "using-git-worktrees",
  "requesting-code-review",
  "receiving-code-review",
  "finishing-a-development-branch",
]);
```

- [ ] **Step 4: Remove the bundled skill provider cleanly**

Delete provider files and tests. Remove the registration import, provider constant, `enableBundled` setting/type/default/destructuring/branch, and test-helper override. Leave no alias or deprecated setting.

- [ ] **Step 5: Run focused prompt and skill tests**

Run the command from Step 2. Expected: all pass.

---

### Task 2: Add Runtime Call Telemetry and OpenTelemetry Attributes

**Files:**
- Create: `packages/coding-agent/src/runtime/telemetry.ts`
- Modify: `packages/coding-agent/src/runtime/service.ts`
- Modify: `packages/coding-agent/src/telemetry/events.ts`
- Modify: `packages/coding-agent/src/telemetry/metrics.ts`
- Modify: `packages/coding-agent/src/telemetry/sink-otlp.ts`
- Modify: `packages/coding-agent/test/runtime-service.test.ts`
- Modify: `packages/coding-agent/test/telemetry-events.test.ts`
- Modify: `packages/coding-agent/test/telemetry-sink.test.ts`

**Interfaces:**
- Produces: `RuntimeCallOutcome = "ok" | "error" | "timeout" | "cancelled"`.
- Produces: `RuntimeCallCompletedTelemetry` event with method, action, language, outcome, duration, exit code, killed flag, error type, and optional session ID.
- Produces: `observeRuntimeCall<T>(method, params, call): Promise<T>`.
- Consumes: existing `RuntimeMethod`, protocol params/results, active OTel context, and telemetry event bus.

- [ ] **Step 1: Write failing service telemetry tests**

Use a fake endpoint and telemetry subscriber. Cover a successful TypeScript run, non-zero Python run, timeout `RuntimeRpcError`, aborted signal, and unexpected error. Assert exactly one event per call and no payload fields.

```ts
expect(event).toMatchObject({
  type: "runtime.call.completed",
  method: "runtime/run",
  language: "ts",
  outcome: "ok",
  exitCode: 0,
  killed: false,
});
expect(event.durationMs).toBeGreaterThanOrEqual(0);
expect(event).not.toHaveProperty("stdout");
```

- [ ] **Step 2: Run tests and confirm failure**

```bash
bun test packages/coding-agent/test/runtime-service.test.ts packages/coding-agent/test/telemetry-events.test.ts packages/coding-agent/test/telemetry-sink.test.ts
```

Expected: the event type, observer, and runtime metrics do not exist.

- [ ] **Step 3: Implement the observer**

Wrap `RuntimeService.#call`. Measure with `performance.now()`. Resolve bounded attributes from method, params, result, `RuntimeRpcError.code`, and `signal.aborted`. Publish in `finally`; annotation and publication each catch their own errors.

```ts
export async function observeRuntimeCall<T>(
  method: RuntimeMethod,
  params: unknown,
  signal: AbortSignal | undefined,
  call: () => Promise<T>,
): Promise<T>;
```

Set active span attributes `aura.runtime.method`, optional action/language, `aura.runtime.outcome`, `aura.runtime.duration_ms`, optional exit code, and killed flag. Never set source or output attributes.

- [ ] **Step 4: Add typed event and OTLP metrics**

Extend `TelemetryEvent`. Add `AuraMetricRecorder.recordRuntimeCall(event)`. Create:

```ts
meter.createCounter("aura.runtime.calls", { unit: "{call}" });
meter.createHistogram("aura.runtime.duration", { unit: "ms" });
```

Route the event in `sink-otlp.ts`, record metrics, and emit one structured completion log with only bounded attributes.

- [ ] **Step 5: Run focused telemetry tests**

Run the Step 2 command. Expected: all pass.

---

### Task 3: Align Runtime Tool Error Status with Execution Results

**Files:**
- Create: `packages/coding-agent/src/tools/runtime-result.ts`
- Modify: `packages/coding-agent/src/tools/runtime-run.ts`
- Modify: `packages/coding-agent/src/tools/runtime-check.ts`
- Modify: `packages/coding-agent/src/tools/runtime-build.ts`
- Modify: `packages/coding-agent/src/tools/runtime-insights.ts`
- Modify: `packages/coding-agent/src/tools/runtime-profile.ts`
- Modify: `packages/coding-agent/src/tools/runtime-advice.ts`
- Modify: `packages/coding-agent/src/tools/jvm-common.ts`
- Modify: `packages/coding-agent/src/tools/jvm-deps.ts`
- Modify: `packages/coding-agent/src/tools/jvm-disassemble.ts`
- Modify: `packages/coding-agent/src/tools/jvm-format.ts`
- Modify: `packages/coding-agent/src/tools/jvm-jar.ts`
- Modify: `packages/coding-agent/src/tools/jvm-javadoc.ts`
- Modify: `packages/coding-agent/test/runtime-run-tool.test.ts`
- Modify: `packages/coding-agent/test/runtime-check-build-tools.test.ts`
- Modify: `packages/coding-agent/test/runtime-insights-profile-tools.test.ts`
- Modify: `packages/coding-agent/test/runtime-advice-tool.test.ts`
- Modify: `packages/coding-agent/test/jvm-tools.test.ts`
- Modify: `packages/agent/test/otel.test.ts`

**Interfaces:**
- Produces: `isRuntimeExecError(result: RuntimeExecResult): boolean`.
- Produces: `runtimeExecToolResult<T extends RuntimeExecResult>(result: T, text: string): AgentToolResult<T>`.
- Consumes: generic agent-loop `result.isError` handling; no agent-core special case.

- [ ] **Step 1: Add failing non-zero and killed contracts**

For each runtime tool family, fake a result with `exitCode: 1` or `killed: true`; assert the returned tool result has `isError: true`. Add an OTel integration assertion that a runtime tool result marked this way produces `aura.tool.status=error` and `error.type=tool_error`.

- [ ] **Step 2: Run focused tests and confirm failure**

```bash
bun test packages/coding-agent/test/runtime-run-tool.test.ts packages/coding-agent/test/runtime-check-build-tools.test.ts packages/coding-agent/test/runtime-insights-profile-tools.test.ts packages/coding-agent/test/runtime-advice-tool.test.ts packages/coding-agent/test/jvm-tools.test.ts packages/agent/test/otel.test.ts
```

Expected: existing tools return no `isError` flag for non-zero results.

- [ ] **Step 3: Implement one shared classifier**

```ts
export function isRuntimeExecError(result: RuntimeExecResult): boolean {
  return result.exitCode !== 0 || result.killed;
}

export function runtimeExecToolResult<T extends RuntimeExecResult>(result: T, text: string): AgentToolResult<T> {
  return {
    content: [{ type: "text", text }],
    details: result,
    ...(isRuntimeExecError(result) ? { isError: true } : {}),
  };
}
```

Use it in every execution-style runtime and JVM tool. Keep payload rendering unchanged.

- [ ] **Step 4: Run focused runtime and OTel tests**

Run the Step 2 command. Expected: all pass.

---

### Task 4: Add the Minimal Inherent-Capability Benchmark Mode

**Files:**
- Modify: `packages/metaharness/src/runtime-benchmark.ts`
- Modify: `packages/metaharness/src/runtime-benchmark.test.ts`
- Modify: `packages/metaharness/package.json`
- Modify: root `package.json`

**Interfaces:**
- Produces: `--inherent-smoke`, selecting `typescript-execution` and `runtime-debugging`, agent-only mode, current runtime arm only, and one attempt unless explicitly overridden.
- Produces: `bench:inherent` package and root scripts.

- [ ] **Step 1: Add failing option and launch-contract tests**

Assert parsing `--inherent-smoke` selects exactly two tasks and emits no baseline or historical launch. Assert explicit `--attempts 3` overrides the smoke default.

```ts
expect(opts.taskIds).toEqual(["typescript-execution", "runtime-debugging"]);
expect(launches.every(launch => launch.arm === "runtime")).toBe(true);
```

- [ ] **Step 2: Run benchmark unit tests and confirm failure**

```bash
bun test packages/metaharness/src/runtime-benchmark.test.ts
```

Expected: unknown `--inherent-smoke` option or launch mismatch.

- [ ] **Step 3: Implement the focused mode**

Add a current-arm launch mode without duplicating runner, fixture, measurement, or report code. The report gate requires both tasks passing and runtime adoption on every completed trial. Preserve the full existing benchmark defaults.

- [ ] **Step 4: Add one-command scripts and run unit tests**

```json
"bench:inherent": "bun src/runtime-benchmark.ts --inherent-smoke"
```

Run the Step 2 command. Expected: all pass.

---

### Task 5: Verify Behavior and Complete Fork Cleanup

**Files:**
- Modify: `docs/settings.md`
- Modify: `docs/aura/FORK.md`
- Modify: `packages/coding-agent/CHANGELOG.md`

**Interfaces:**
- Consumes: completed prompt, skill, telemetry, and benchmark contracts.
- Produces: updated fork inventory and Unreleased changelog entry.

- [ ] **Step 1: Run focused prompt, skill, runtime, telemetry, and benchmark tests**

```bash
bun test packages/coding-agent/test/system-prompt.test.ts packages/coding-agent/test/discovery/claude-plugins.test.ts packages/coding-agent/test/skills.test.ts packages/coding-agent/test/runtime-service.test.ts packages/coding-agent/test/runtime-run-tool.test.ts packages/coding-agent/test/runtime-check-build-tools.test.ts packages/coding-agent/test/runtime-insights-profile-tools.test.ts packages/coding-agent/test/runtime-advice-tool.test.ts packages/coding-agent/test/jvm-tools.test.ts packages/coding-agent/test/telemetry-events.test.ts packages/coding-agent/test/telemetry-sink.test.ts packages/agent/test/otel.test.ts packages/metaharness/src/runtime-benchmark.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run the inherent benchmark smoke**

```bash
bun run bench:inherent
```

Expected: both deterministic tasks pass, both invoke a runtime tool, and telemetry contains language/outcome/duration. If provider credentials or container infrastructure are unavailable, preserve the exact blocker output and still complete deterministic tests.

- [ ] **Step 3: Run project checks**

```bash
bun run check:ts
```

Expected: exit 0.

- [ ] **Step 4: Update cleanup artifacts**

Remove the bundled runtime skills setting documentation. Rewrite fork inventory rows to describe inherent prompt policy, canonical Superpowers filtering, runtime telemetry, and benchmark mode. Add a coding-agent Unreleased entry under `Changed` and `Added`/`Fixed` as appropriate. Never edit released changelog sections.

- [ ] **Step 5: Re-run affected documentation and configuration tests**

Run the focused suite from Step 1 and any documentation/settings tests reported by `check:ts`. Expected: all pass.
