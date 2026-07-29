# Symlinked Bundle Launcher Design

## Problem

The relocatable Linux bundle contains `bin/aura`, a shell launcher that derives the bundle root from `dirname "$0"`. When a user installs Aura by symlinking that launcher into a directory on `PATH`, `$0` identifies the installation symlink rather than the launcher inside the bundle. The launcher consequently searches beside the symlink for `aura.bin` and fails with exit code 127.

Observed failure:

```text
/home/sam/bin/aura: 15: exec: /home/sam/bin/aura.bin: not found
```

## Required behavior

Invoking `bin/aura` directly or through one or more filesystem symlinks MUST locate the original relocatable bundle. The launcher MUST continue to:

- set `AURA_RUNTIME_BIN` to the bundled process runtime;
- set `AURA_RUNTIME_EMBEDDED_LIB` to the bundled shared library;
- prepend the bundled configuration to `PI_CONFIG_FILES`;
- forward every argument and exit through `aura.bin`.

Installation symlinks MAY be absolute or relative. The bundle remains Linux-only, matching the existing bundle target.

## Design

Before deriving `ROOT`, the shell launcher follows the symlink chain beginning at `$0`:

1. Keep the current path in a launcher-path variable.
2. While that path is a symlink, read its target.
3. Preserve absolute targets as written.
4. Resolve relative targets against the directory containing the current symlink.
5. Derive `ROOT` from the final launcher path's physical parent directory.

The remaining environment setup and `exec` call stay unchanged. This fixes path discovery at its source without copying bundle files into each installation directory or moving bundle-awareness into the compiled CLI.

## Error handling

The launcher retains `set -eu`. An unreadable symlink, missing target, or inaccessible parent directory therefore fails immediately rather than constructing runtime paths from an invalid location. Existing failures from missing bundle artifacts remain unchanged.

## Verification

Extend the relocatable-bundle behavioral tests to build the existing fixture bundle, create an installation symlink outside that bundle, and invoke the symlink. The assertion verifies successful execution plus the exact bundled runtime, embedded-library, and configuration paths. This test fails against the current launcher with exit code 127 and protects the user-visible installation contract.

Run the focused bundle contract test after implementation. The existing direct-launch case must remain green, proving that symlink support does not regress normal extracted-bundle execution.

## Scope

Change only the generated launcher template, its behavioral contract test, the Aura fork inventory, and the coding-agent Unreleased changelog. No installer mode, archive layout, binary name, runtime selection, or update behavior changes.
