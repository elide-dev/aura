# Runtime Prompt Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the main coding-agent system prompt and runtime/JVM tool descriptions by 25–35% without weakening their behavioral contracts.

**Architecture:** Edit static Markdown prompt templates in place. Preserve file boundaries, Handlebars branches, tool schemas, TypeScript imports, and runtime behavior; validate through rendered-prompt tests, focused tool tests, deterministic size measurements, and representative tool-selection review.

**Tech Stack:** Markdown, Handlebars templates, TypeScript/Bun test suite.

## Global Constraints

- Scope is `packages/coding-agent/src/prompts/system/system-prompt.md`, `runtime-*.md`, and `jvm-*.md`.
- No tool schema, implementation, API, or runtime behavior changes.
- Combined source-template bytes MUST fall from 28,315 by 25–35%: final range 18,405–21,236 bytes.
- Preserve every existing Handlebars branch and referenced template variable.
- Preserve all behavioral invariants in `docs/superpowers/specs/2026-07-31-runtime-prompt-reduction-design.md`.
- User-facing text MUST call Elide “the runtime.”
- Do not add shared prompt fragments or prompt-composition abstractions.
- Do not add source-grep tests or tests for exact prose.
- Do not commit unless the user explicitly asks.

---

### Task 1: Compress runtime and JVM tool descriptions

**Files:**
- Modify: `packages/coding-agent/src/prompts/tools/runtime-advice.md`
- Modify: `packages/coding-agent/src/prompts/tools/runtime-build.md`
- Modify: `packages/coding-agent/src/prompts/tools/runtime-check.md`
- Modify: `packages/coding-agent/src/prompts/tools/runtime-debug.md`
- Modify: `packages/coding-agent/src/prompts/tools/runtime-insights.md`
- Modify: `packages/coding-agent/src/prompts/tools/runtime-profile.md`
- Modify: `packages/coding-agent/src/prompts/tools/runtime-run.md`
- Modify: `packages/coding-agent/src/prompts/tools/runtime-serve.md`
- Modify: `packages/coding-agent/src/prompts/tools/jvm-deps.md`
- Modify: `packages/coding-agent/src/prompts/tools/jvm-disassemble.md`
- Modify: `packages/coding-agent/src/prompts/tools/jvm-format.md`
- Modify: `packages/coding-agent/src/prompts/tools/jvm-jar.md`
- Modify: `packages/coding-agent/src/prompts/tools/jvm-javadoc.md`
- Test: `packages/coding-agent/test/runtime-run-tool.test.ts`
- Test: `packages/coding-agent/test/runtime-advice-tool.test.ts`
- Test: `packages/coding-agent/test/runtime-check-build-tools.test.ts`
- Test: `packages/coding-agent/test/runtime-launch-tools.test.ts`
- Test: `packages/coding-agent/test/runtime-insights-profile-tools.test.ts`
- Test: `packages/coding-agent/test/jvm-tools.test.ts`

**Interfaces:**
- Consumes: existing JSON schemas and static Markdown imports in each tool implementation.
- Produces: shorter descriptions with unchanged tool names, schemas, and runtime behavior.

- [ ] **Step 1: Record the exact tool-prompt baseline**

Run:

```bash
wc -w -c packages/coding-agent/src/prompts/tools/runtime-*.md packages/coding-agent/src/prompts/tools/jvm-*.md
```

Expected total: `1,362` words and `8,771` bytes.

- [ ] **Step 2: Rewrite each prompt around decision-changing content**

Use this fixed shape where applicable:

```markdown
<One-line selection rule.>

<Input relationship or non-obvious default.>

<Output/failure shape that determines the next action.>
```

Required retained content by file:

- `runtime-run.md`: direct execution versus `bash`/`eval`; `code` XOR `path`; path preserves project-relative access; language/engine restrictions; resolved language/engine and process result; missing-runtime guidance.
- `runtime-check.md`: dependency resolution plus compilation; no artifacts; not a TypeScript typecheck substitute.
- `runtime-build.md`: artifacts versus validation; `:`-prefixed targets and interleaved options.
- `runtime-advice.md`: read-only manifest-derived guidance; use before guessing; returned CLI verbs are informational unless an innate tool exposes them.
- `runtime-insights.md`: program plus JS instrumentation; source/function hooks; observations accompany output; no one-shot close event.
- `runtime-profile.md`: tracing versus sampling; sampling preferred for longer runs; text report.
- `runtime-debug.md`: file path only; CDP versus DAP endpoint shape; starts suspended; external debugger distinction; returned hub job ownership; delayed endpoint requires logs, not failure.
- `runtime-serve.md`: static-directory purpose; returned URL plus hub job ownership; stop releases port; delayed URL requires logs, not failure.
- `jvm-disassemble.md`: compile then `javap -c`; Java/Kotlin entrypoint defaults; compile errors prevent listing.
- `jvm-format.md`: scratch formatting; returned source is not persisted.
- `jvm-deps.md`: existing artifact or source compilation modes; read-only analysis.
- `jvm-jar.md`: create/inspect split; in-project safe output; overwrite rules; entrypoint manifest.
- `jvm-javadoc.md`: Java-only docs output; dedicated safe directory; overwrite only recognized docs output.

Remove schema-visible optional-field inventories unless a relationship or default above requires prose.

- [ ] **Step 3: Measure tool-prompt reduction**

Run:

```bash
wc -w -c packages/coding-agent/src/prompts/tools/runtime-*.md packages/coding-agent/src/prompts/tools/jvm-*.md
```

Expected: below `8,771` bytes while every retained-content item remains represented. Do not force this subset to a standalone percentage; the combined target applies after Task 2.

- [ ] **Step 4: Run focused runtime/JVM tool tests**

Run:

```bash
bun test packages/coding-agent/test/runtime-run-tool.test.ts packages/coding-agent/test/runtime-advice-tool.test.ts packages/coding-agent/test/runtime-check-build-tools.test.ts packages/coding-agent/test/runtime-launch-tools.test.ts packages/coding-agent/test/runtime-insights-profile-tools.test.ts packages/coding-agent/test/jvm-tools.test.ts
```

Expected: all tests pass; no tool names, schemas, execution behavior, or lifecycle behavior changed.

---

### Task 2: Compress the main system prompt

**Files:**
- Modify: `packages/coding-agent/src/prompts/system/system-prompt.md`
- Test: `packages/coding-agent/test/system-prompt.test.ts`
- Test: `packages/coding-agent/test/system-prompt-inventory.test.ts`
- Test: `packages/coding-agent/test/system-prompt-dedup.test.ts`
- Test: `packages/coding-agent/test/system-prompt-kernel.test.ts`
- Test: `packages/coding-agent/test/system-prompt-model.test.ts`
- Test: `packages/coding-agent/test/system-prompt-personality.test.ts`

**Interfaces:**
- Consumes: the current Handlebars data contract assembled in `packages/coding-agent/src/system-prompt.ts`.
- Produces: a shorter rendered system prompt with unchanged conditional capabilities and normative behavior.

- [ ] **Step 1: Record template structure before editing**

Build a checklist from the current template and preserve these blocks:

```text
system-conventions
role and engineering principles
skills / generic-rules / domain-rules
internal URLs
tool inventory
computer-use branch
xd:// branch
tool policy
LSP / AST branches
delegation branches and gates
execution workflow
delivery, completeness, evidence, yielding
personality branch
closing critical rules
```

Record baseline:

```bash
wc -w -c packages/coding-agent/src/prompts/system/system-prompt.md
```

Expected: `2,704` words and `19,544` bytes.

- [ ] **Step 2: Consolidate repeated normative rules**

Apply these exact structural decisions:

- Keep `<system-conventions>` at the start unchanged in meaning.
- Keep role/agency principles; compress explanatory tails.
- Keep generated skill, rule, URL, inventory, computer, and xdev blocks in their existing conditional locations.
- Merge “General,” “Exploration,” and “Research Before Editing” overlap into one rule per behavior.
- Retain specialized-tool precedence as explicit tool-conditional bullets.
- Collapse delegation prose to: activation mode, scope-before-spawn, true independence, prerequisite sequencing, ownership of intent, concurrency cap, and IRC coordination.
- Collapse workflow to scope/research, decompose, implement, verify, cleanup.
- Merge delivery/evidence/yielding repetition so each invariant appears once, except the intentionally repeated closing critical rule.
- Preserve verification distinctions for investigation, UI, bug fix, and permanent API/feature changes.
- Preserve the closing `<critical>` block and every Handlebars expression verbatim unless only surrounding prose changes.

Use RFC-keyed fragments, typically 5–12 words per tactical bullet. Never remove a conditional branch merely because the current session does not render it.

- [ ] **Step 3: Run focused system-prompt rendering tests**

Run:

```bash
bun test packages/coding-agent/test/system-prompt.test.ts packages/coding-agent/test/system-prompt-inventory.test.ts packages/coding-agent/test/system-prompt-dedup.test.ts packages/coding-agent/test/system-prompt-kernel.test.ts packages/coding-agent/test/system-prompt-model.test.ts packages/coding-agent/test/system-prompt-personality.test.ts
```

Expected: all rendered variants pass; no missing conditional content, duplicated kernel text, or personality-placement regressions.

- [ ] **Step 4: Enforce the combined reduction target**

Run:

```bash
wc -w -c packages/coding-agent/src/prompts/system/system-prompt.md packages/coding-agent/src/prompts/tools/runtime-*.md packages/coding-agent/src/prompts/tools/jvm-*.md
```

Expected combined bytes: `18,405` through `21,236`, inclusive. If outside the range, revise prose without removing a behavioral invariant.

---

### Task 3: Verify behavior and finish fork bookkeeping

**Files:**
- Modify: `docs/aura/FORK.md`
- Modify: `packages/coding-agent/CHANGELOG.md`
- Verify: all prompt files modified in Tasks 1–2.

**Interfaces:**
- Consumes: compressed prompts from Tasks 1–2.
- Produces: verified prompt-only change with required fork and changelog records.

- [ ] **Step 1: Read fork bookkeeping before editing it**

Read `docs/aura/FORK.md`. Add rows only for scoped upstream files not already recorded. Follow its existing table and path conventions exactly.

- [ ] **Step 2: Review representative selection contracts**

For each request below, inspect the final tool descriptions and confirm the named tool remains the unambiguous choice:

```text
“Run this inline TypeScript snippet.”                    -> run
“Check whether this project still builds; no artifacts.” -> check
“Produce the project artifacts.”                         -> build
“Publish a CDP endpoint for VS Code to attach.”           -> runtime_debug
“Serve the generated static docs.”                       -> runtime_serve
“Compile this Kotlin source and package a JAR.”           -> jvm_jar
```

Also confirm `runtime_debug` and `runtime_serve` explicitly require hub-based lifecycle management.

- [ ] **Step 3: Run the complete focused prompt/tool suite**

Run:

```bash
bun test packages/coding-agent/test/system-prompt.test.ts packages/coding-agent/test/system-prompt-inventory.test.ts packages/coding-agent/test/system-prompt-dedup.test.ts packages/coding-agent/test/system-prompt-kernel.test.ts packages/coding-agent/test/system-prompt-model.test.ts packages/coding-agent/test/system-prompt-personality.test.ts packages/coding-agent/test/runtime-run-tool.test.ts packages/coding-agent/test/runtime-advice-tool.test.ts packages/coding-agent/test/runtime-check-build-tools.test.ts packages/coding-agent/test/runtime-launch-tools.test.ts packages/coding-agent/test/runtime-insights-profile-tools.test.ts packages/coding-agent/test/jvm-tools.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Run the repository type/build integrity gate**

Run:

```bash
bun check
```

Expected: success with no diagnostics attributable to the prompt changes.

- [ ] **Step 5: Add the changelog entry**

Under `packages/coding-agent/CHANGELOG.md` → `## [Unreleased]` → `### Changed`, add:

```markdown
- Reduced persistent system and runtime tool prompt text while preserving tool-selection and safety contracts.
```

Do not modify released sections.

- [ ] **Step 6: Record final measurements**

Run:

```bash
wc -w -c packages/coding-agent/src/prompts/system/system-prompt.md packages/coding-agent/src/prompts/tools/runtime-*.md packages/coding-agent/src/prompts/tools/jvm-*.md
```

Report baseline, final bytes/words, and percentage byte reduction. Confirm final bytes remain within `18,405–21,236`.

- [ ] **Step 7: Leave changes uncommitted**

Do not run `git commit`. Report modified files, focused-test result, `bun check` result, and final reduction measurement.
