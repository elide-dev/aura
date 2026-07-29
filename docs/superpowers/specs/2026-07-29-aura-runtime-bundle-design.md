# Aura relocatable runtime bundle — design

**Date:** 2026-07-29
**Status:** approved for implementation

## Goal

Produce one Linux x64/glibc `.tar.gz` that can be extracted anywhere and run without Bun, Node, a separate Elide install, runtime downloads, or manual runtime paths. Add one repeatable repository script that builds, assembles, verifies, and archives the same layout.

## Supported target

The first target is `linux-x64` on glibc. Aura uses Bun's baseline Linux x64 compile target. WHIPLASH's embedded engine is glibc-sensitive and currently verified only on Linux x64, so this script must reject other targets rather than imply portability. A true single executable is out of scope because Bun FFI must load real shared-library files.

## Inputs

The script accepts an explicit WHIPLASH distribution directory. It must contain executable `bin/elide` plus `lib/libelide_embed.so` and `lib/libelide_embed_engine.so`. The script never guesses a sibling checkout. It builds Aura through the existing release-binary builder unless a prebuilt Aura binary is explicitly supplied for tests or local reuse.

## Output layout

```text
aura-elide-linux-x64/
  bin/aura          relocatable POSIX launcher
  bin/aura.bin      compiled standalone Aura binary
  bin/elide         bundled process runtime
  lib/...           complete WHIPLASH distribution libraries
  include/...       WHIPLASH public headers when present
  etc/aura-bundle.yml
```

The entire WHIPLASH distribution is copied, not a hand-maintained subset. This preserves JVM, Python, resources, and future distribution dependencies. The launcher resolves its own parent directory, exports absolute `AURA_RUNTIME_BIN` and `AURA_RUNTIME_EMBEDDED_LIB` paths, prepends the bundle settings file to `PI_CONFIG_FILES`, and execs `aura.bin` with unchanged arguments.

The settings overlay enables runtime tools, selects adapter `auto`, and disables downloads. Eligible JavaScript, TypeScript, and Python `run` calls therefore use the embedded engine; process-only runtime operations use the bundled `bin/elide`. User auth and state remain in the normal Aura config directory.

## Script interface

Add `scripts/build-relocatable-runtime-bundle.ts` and a root package script. Required input: `--runtime-dist <directory>` (or `AURA_RUNTIME_DIST`). Optional inputs: `--output-dir`, `--aura-binary`, `--skip-smoke`, and `--no-archive`. Defaults produce `out/aura-elide-linux-x64/`, its `.tar.gz`, and a SHA-256 file.

The script validates inputs before deleting or writing output. It builds Aura with `scripts/ci-release-build-binaries.ts --targets linux-x64` when no prebuilt binary is supplied. It stages into a temporary sibling directory, verifies the staged layout, runs the relocated launcher checks, creates the archive, then atomically replaces the named output directory. Failures leave no partially accepted bundle.

## Verification

Contract tests use fake executable inputs and assert generated files, executable modes, launcher relocation, settings behavior, archive contents, and actionable missing-input errors. The real build must pass:

1. staged `aura --version`;
2. staged `aura --smoke-test`;
3. staged `aura runtime status --json`, reporting the bundled runtime and compatible embedded ABI;
4. `ldd lib/libelide_embed.so` with no missing dependency;
5. the same checks after extracting the final archive into a fresh temporary directory.

The final report prints the bundle directory, archive, checksum, size, and exact test command.
