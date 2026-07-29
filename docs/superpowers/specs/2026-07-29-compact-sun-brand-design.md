# Compact sun brand — design

**Date:** 2026-07-29
**Status:** approved design, pre-implementation

## Summary

Replace Aura's compact `π` brand mark with `☉` across the interactive prompt and terminal-title surfaces. Preserve the existing `icon.pi` theme key so custom themes remain compatible. The large Aura logo and retained upstream-only `PI_LOGO` are outside this compact-symbol change.

## Behavior

- Built-in Unicode prompt prefix: `☉`.
- Built-in Nerd-symbol prompt prefix: `☉`, ensuring the Aura brand does not depend on an unrelated private-use glyph.
- Explicit ASCII-only prompt prefix: `o`.
- Bundled dark/light Poimandres prompt prefix overrides: `☉`.
- Terminal title default and state forms use `☉`, including `☉ > label`, `☉ ⠋ label`, `☉ ! label`, and Windows `☉ : label`.
- Custom themes that override `icon.pi` continue to control their own compact symbol.

## Compatibility

The internal `icon.pi` key and `theme.icon.pi` accessor remain unchanged. Renaming them would break user-authored theme files for no behavioral benefit. Only built-in values and compact-title literals change.

## Verification

Update terminal-title behavior assertions from `π` to `☉`. Add or update theme assertions proving Unicode and Nerd modes resolve `theme.icon.pi` to `☉`, ASCII mode resolves it to `o`, and bundled Poimandres themes resolve it to `☉`. Run the focused title/theme tests, `bun check`, and the TUI smoke or gallery path that renders the status-line prefix.

## Fork tracking

Record newly touched upstream-owned files in `docs/aura/FORK.md`. Add a coding-agent `[Unreleased]` Changed entry only after behavior verification. Do not commit unless explicitly requested.
