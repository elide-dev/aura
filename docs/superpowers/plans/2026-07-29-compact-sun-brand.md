# Compact Sun Brand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Aura's compact `π` prompt and terminal-title brand with `☉` while preserving custom-theme compatibility.

**Architecture:** Keep the existing `icon.pi` theme key and accessor, changing only built-in symbol values, bundled overrides, terminal-title literals, and observable assertions. ASCII-only mode uses `o`; large logos remain unchanged.

**Tech Stack:** TypeScript, JSON themes, Bun tests, Aura TUI theme and terminal-title utilities.

## Global Constraints

- Preserve the `icon.pi` theme key and `theme.icon.pi` accessor.
- Unicode and Nerd presets use `☉`; ASCII uses `o`.
- Bundled Poimandres overrides use `☉`.
- Terminal-title state strings use `☉`.
- Do not change `PI_LOGO` or Aura's large logo.
- Do not commit unless explicitly requested.

---

### Task 1: Pin the new compact-brand contract

**Files:**
- Create: `packages/coding-agent/test/compact-brand-symbol.test.ts`
- Modify: `packages/coding-agent/test/terminal-title-state.test.ts`
- Modify: `packages/coding-agent/test/title-generator.test.ts`

**Interfaces:**
- Consumes: `initTheme`, `theme`, `getThemeByName`, and `buildTerminalTitleWithState`.
- Produces: behavior assertions for prompt presets, bundled overrides, and terminal-title state strings.

- [ ] Write a failing test that initializes `unicode`, `nerd`, and `ascii` presets and expects `theme.icon.pi` to equal `☉`, `☉`, and `o` respectively. Assert `dark-poimandres` and `light-poimandres` resolve `icon.pi` to `☉`.
- [ ] Update existing terminal-title expected strings and comments from `π` to `☉`.
- [ ] Run `bun test test/compact-brand-symbol.test.ts test/terminal-title-state.test.ts test/title-generator.test.ts`; expect failures showing the old `π`/private-use/`pi` values.

### Task 2: Change built-in compact-brand values

**Files:**
- Modify: `packages/coding-agent/src/modes/theme/theme.ts`
- Modify: `packages/coding-agent/src/modes/theme/defaults/dark-poimandres.json`
- Modify: `packages/coding-agent/src/modes/theme/defaults/light-poimandres.json`
- Modify: `packages/coding-agent/src/utils/title-generator.ts`
- Modify: `packages/coding-agent/src/modes/interactive-mode.ts`
- Modify: `docs/aura/FORK.md`
- Modify: `packages/coding-agent/CHANGELOG.md`

**Interfaces:**
- Consumes: Task 1 behavior assertions.
- Produces: `theme.icon.pi` built-in values and terminal titles with the approved compact sun mark.

- [ ] Change `icon.pi` values in Unicode and Nerd symbol maps to `☉`, ASCII to `o`, and both Poimandres overrides to `☉`.
- [ ] Change `DEFAULT_TERMINAL_TITLE` to `☉` and update title-layout documentation/comments plus the stale interactive shutdown comment.
- [ ] Run the focused tests and confirm they pass.
- [ ] Record newly touched upstream-owned files in `docs/aura/FORK.md`; add an `[Unreleased]` Changed entry after verification.
- [ ] Run `bun check` and the status/title focused tests.
