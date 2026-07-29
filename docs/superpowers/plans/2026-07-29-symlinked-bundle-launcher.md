# Symlinked Bundle Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the relocatable Aura bundle launch correctly when `bin/aura` is installed through absolute, relative, or chained symlinks.

**Architecture:** Keep bundle discovery in the generated POSIX shell launcher. Resolve the launcher symlink chain before deriving the physical bundle root; leave all runtime environment setup and argument forwarding unchanged.

**Tech Stack:** Bun, TypeScript, `bun:test`, POSIX-compatible shell utilities on Linux.

## Global Constraints

- Direct invocation and invocation through one or more filesystem symlinks MUST locate the original bundle.
- Installation symlinks MAY be absolute or relative.
- Preserve `AURA_RUNTIME_BIN`, `AURA_RUNTIME_EMBEDDED_LIB`, `PI_CONFIG_FILES`, argument forwarding, and `aura.bin` exit behavior.
- The relocatable bundle remains Linux-only.
- Do not change installer modes, archive layout, binary names, runtime selection, or update behavior.
- Do not commit unless the user explicitly requests it.

---

### Task 1: Make the bundle launcher symlink-aware

**Files:**
- Modify: `scripts/build-relocatable-runtime-bundle.test.ts:67-110`
- Modify: `scripts/build-relocatable-runtime-bundle.ts:14-29`
- Modify: `docs/aura/FORK.md:189-193`
- Modify: `packages/coding-agent/CHANGELOG.md:14-17`

**Interfaces:**
- Consumes: generated bundle layout containing `bin/aura`, `bin/aura.bin`, `bin/elide`, `lib/libelide_embed.so`, and `etc/aura-bundle.yml`.
- Produces: a `bin/aura` launcher whose `ROOT` points at the original bundle through absolute, relative, and chained symlinks.

- [ ] **Step 1: Add the failing behavioral regression test**

Add this case inside `describe("relocatable Aura runtime bundle", ...)`, after the existing direct-launch contract:

```typescript
	test("launches through relative and absolute installation symlinks", async () => {
		const root = await temporaryDirectory();
		const { runtimeDist, auraBinary } = await createInputs(root);
		const outputDir = path.join(root, "output");
		const result = await runBuilder([
			"--runtime-dist",
			runtimeDist,
			"--aura-binary",
			auraBinary,
			"--output-dir",
			outputDir,
			"--skip-smoke",
			"--no-archive",
		]);
		expect(result.exitCode, result.stderr).toBe(0);

		const bundle = path.join(outputDir, bundleName);
		const absoluteLink = path.join(root, "current-aura");
		await fs.symlink(path.join(bundle, "bin", "aura"), absoluteLink);
		const installDir = path.join(root, "install", "bin");
		await fs.mkdir(installDir, { recursive: true });
		const installedAura = path.join(installDir, "aura");
		await fs.symlink(path.relative(installDir, absoluteLink), installedAura);

		const launch = Bun.spawn([installedAura, "hello", "world"], {
			env: { ...process.env, PI_CONFIG_FILES: "/user/override.yml" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [launchCode, stdout, stderr] = await Promise.all([
			launch.exited,
			new Response(launch.stdout).text(),
			new Response(launch.stderr).text(),
		]);
		expect(launchCode, stderr).toBe(0);
		expect(stdout).toContain(`runtime=${path.join(bundle, "bin", "elide")}`);
		expect(stdout).toContain(`embedded=${path.join(bundle, "lib", "libelide_embed.so")}`);
		expect(stdout).toContain(`config=${path.join(bundle, "etc", "aura-bundle.yml")}:/user/override.yml`);
		expect(stdout).toContain("args=hello world");
	});
```

- [ ] **Step 2: Run the focused test and confirm the current failure**

Run:

```bash
bun test scripts/build-relocatable-runtime-bundle.test.ts
```

Expected: the new case fails with exit code `127`; stderr reports that `install/bin/aura.bin` is missing. Existing cases remain green.

- [ ] **Step 3: Resolve the launcher symlink chain before deriving `ROOT`**

Replace the current `ROOT=$(...)` line in `BUNDLE_LAUNCHER` with:

```sh
LAUNCHER=$0
while [ -L "$LAUNCHER" ]; do
    LAUNCHER_DIR=$(CDPATH= cd -P -- "$(dirname -- "$LAUNCHER")" && pwd)
    LINK_TARGET=$(readlink -- "$LAUNCHER")
    case "$LINK_TARGET" in
        /*) LAUNCHER="$LINK_TARGET" ;;
        *)  LAUNCHER="$LAUNCHER_DIR/$LINK_TARGET" ;;
    esac
done
ROOT=$(CDPATH= cd -P -- "$(dirname -- "$LAUNCHER")/.." && pwd)
```

Keep every export, `PI_CONFIG_FILES` branch, and the final `exec "$ROOT/bin/aura.bin" "$@"` byte-for-byte unchanged.

- [ ] **Step 4: Run the focused bundle contract test**

Run:

```bash
bun test scripts/build-relocatable-runtime-bundle.test.ts
```

Expected: all cases pass, including direct launch, symlink-chain launch, runtime-distribution dereferencing, archive layout, and smoke isolation.

- [ ] **Step 5: Record the fork-owned launcher behavior**

Expand the `scripts/build-relocatable-runtime-bundle.ts` / test entry in `docs/aura/FORK.md` to state that the launcher resolves relative, absolute, and chained installation symlinks before deriving its bundle root.

Under `packages/coding-agent/CHANGELOG.md` → `## [Unreleased]` → `### Fixed`, add:

```markdown
- Fixed relocatable Aura bundles failing to launch when `bin/aura` is installed through a filesystem symlink.
```

- [ ] **Step 6: Run final project verification**

Run the focused contract again after documentation cleanup:

```bash
bun test scripts/build-relocatable-runtime-bundle.test.ts
```

Then validate the project without producing artifacts using the managed project check. Expected: focused tests pass and project validation reports no compile errors.
