# Runtime Prompt Reduction Design

## Goal

Reduce persistent prompt context consumed by the Aura coding agent without weakening tool selection, safety, lifecycle, completion, or verification behavior.

Scope:

- `packages/coding-agent/src/prompts/system/system-prompt.md`
- `packages/coding-agent/src/prompts/tools/runtime-*.md`
- `packages/coding-agent/src/prompts/tools/jvm-*.md`

No tool schema, implementation, API, or runtime behavior changes.

## Baseline and target

Current scoped text totals 28,315 bytes and 4,066 words:

- Main system prompt: 19,544 bytes, 2,704 words.
- Runtime/JVM tool prompts: 8,771 bytes, 1,362 words.

Target: reduce combined bytes by 25–35%, measured on source templates. Reduction is a constraint, not permission to remove behavioral contracts.

## Compression rules

### Main system prompt

Preserve:

- RFC 2119 and injected-tag authority semantics.
- Skills/rules discovery requirements.
- Internal URL and conditional tool inventory behavior.
- Specialized-tool precedence and LSP/AST constraints.
- Destructive-action safety.
- Delegation mode branches and concurrency semantics.
- End-to-end completion, evidence, verification, and blocking contracts.
- Critical rules at the beginning and end.
- Every Handlebars branch and referenced template variable.

Reduce by:

- Merging repeated completion, evidence, and yielding requirements.
- Collapsing overlapping delegation guidance while retaining each distinct gate.
- Converting explanatory prose into imperative, RFC-keyed bullets.
- Removing motivation already implied by an adjacent normative rule.
- Removing restatements across tool policy, workflow, and delivery sections.

### Runtime and JVM tool descriptions

Preserve only details that change an agent decision:

- When to select the tool instead of adjacent tools.
- Required input relationships not obvious from isolated fields, such as `code` XOR `path`.
- Non-obvious defaults and engine/language restrictions.
- Output or failure shapes that determine the next action.
- Supervised-job ownership: `hub logs`, `hub stop`, and delayed endpoint handling.
- Distinctions such as runtime validation versus TypeScript typechecking.

Reduce by:

- Removing parameter inventories duplicated by JSON schemas.
- Removing implementation mechanics invisible to callers.
- Replacing repeated cross-tool explanations with short comparisons.
- Using fragments and compact notation where ambiguity does not increase.

## Behavioral invariants

1. The agent still chooses `run` for direct program execution and `bash` for shell commands.
2. The agent still uses `check` only as runtime build-integrity validation, not as a TypeScript typecheck substitute.
3. The agent still uses `build` when artifacts are required.
4. The agent still distinguishes externally attachable `runtime_debug` from interactive `debug`.
5. The agent still manages `runtime_debug` and `runtime_serve` through their returned hub job names.
6. The agent still treats delayed debug/server endpoints as running jobs requiring log inspection, not immediate failure.
7. JVM descriptions retain compilation, entrypoint, overwrite, output-path, and artifact-safety constraints where applicable.
8. System-prompt rendering remains valid for conditional tool, skill, rule, delegation, security, xdev, and personality branches.
9. No user-facing reference uses “Elide”; the noun remains “the runtime.”

## Implementation shape

Edit prompt Markdown in place. Do not introduce shared prompt fragments or runtime composition logic: abstraction would add indirection for static text and complicate token accounting.

Preserve existing file boundaries so each tool continues importing one static description. Do not alter TypeScript unless verification exposes a template-rendering defect.

## Verification

1. Recalculate source bytes and words; require 25–35% combined byte reduction.
2. Render representative main-prompt configurations covering conditional branches and verify no template errors or missing section boundaries.
3. Run existing focused system-prompt and runtime/JVM tool tests.
4. Run `bun check` for the coding-agent package or repository-prescribed scope.
5. Smoke-test representative tool-selection scenarios:
   - execute inline TypeScript;
   - validate without producing artifacts;
   - build an artifact;
   - publish a debug endpoint;
   - serve static output;
   - compile/run and package JVM source.
6. Compare rendered descriptions against the behavioral invariants above.

## Cleanup

After behavioral verification:

- Add the required coding-agent changelog entry under `Unreleased`.
- Update `docs/aura/FORK.md` for newly touched upstream files.
- Remove no files and add no compatibility aliases.

## Risks and controls

- Over-compression can erase a selection boundary. Control: invariant-driven review and smoke scenarios.
- Schema reliance can hide cross-field relationships. Control: retain relationships and non-obvious defaults in prose.
- Handlebars edits can break rare configurations. Control: render representative conditional variants.
- Raw source reduction may not equal provider token reduction. Control: record byte and word deltas as deterministic proxies; use tokenizer measurements if an existing repository utility supports them.
