# Aura Runtime Core Implementation Plan (spec phases 1–4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Aura inside this OMP fork: aura branding plus five innate runtime capabilities (`run`, `check`, `build`, `insights`, `profile`) executed on the Elide runtime through an aura-defined JSON-RPC seam.

**Architecture:** Core integration (mnemopi house pattern): a new `packages/coding-agent/src/runtime/` layer (protocol → service → local endpoint that shells the Elide CLI per call), five built-in tools gated by `runtime.enabled`, settings in the schema, and an `aura runtime status` CLI command. The JSON-RPC protocol is the seam so subprocess-broker or in-process endpoints are later drop-ins with zero tool changes.

**Tech Stack:** Bun 1.3.14 workspaces, TypeScript, arktype (tool schemas), `bun:test`, Biome, oclif-style CLI (`@oh-my-pi/pi-utils/cli`).

**Spec:** `docs/superpowers/specs/2026-07-25-aura-omp-fork-design.md`. Packaging, bench, and the upstream-merge drill (spec phases 5–7) are separate follow-on plans.

## Global Constraints

- **Naming rule:** Elide is never user-facing. Every surface says "runtime": tools, settings `runtime.*`, RPC methods `runtime/*`, CLI `aura runtime status`, env `AURA_RUNTIME_BIN` (compat alias `ELIDE_BIN`). "Elide"/"elide" identifiers are allowed ONLY in `provision.ts` (distribution pins) and comments explaining internals.
- **Elide pin:** version `1.4.1+20260718`, downloads from `https://github.com/elide-dev/elide/releases/download/<urlencoded-version>/`, sha256s as listed in Task 6. Requires Elide ≥ 1.4.
- **`check` semantics (decided):** Elide 1.4 has no `check` verb. `runtime/check` maps to a plain validation `elide build` (resolve deps + compile sourcesets, no artifacts/targets requested). It stays a distinct protocol method so it can diverge later.
- **Diff discipline:** new code goes in new files; upstream files edited in this plan are ONLY: `packages/utils/src/dirs.ts`, `packages/coding-agent/package.json`, `packages/coding-agent/src/tools/{index,builtin-names,essential-tools}.ts`, `packages/coding-agent/src/config/settings-schema.ts`, `packages/coding-agent/src/sdk.ts`, `packages/coding-agent/src/cli-commands.ts`, theme registration files. Every touched upstream file gets a line in `docs/aura/FORK.md`.
- **Tests:** `bun test <file>` from the owning package directory. Type/lint gate: `bun run check:ts` from repo root (Biome + per-workspace `tsgo --noEmit`). Both must pass before every commit.
- **Inline code execution facts (from BUCKSHOT, verified):** stdin `-` source mode does not work — inline code is written to a temp file; file-backed Python runs GraalPy 3.12; run argv shape is `elide run --error-format=plain --no-color -l <lang> <file> -- <args...>`.

---

### Task 1: Fork hygiene baseline

**Files:**
- Create: `docs/aura/FORK.md`

**Interfaces:**
- Produces: a verified-green baseline and the fork inventory doc every later task appends to.

- [ ] **Step 1: Verify the toolchain and baseline**

Run from repo root:
```bash
bun install
bun run check:ts
```
Expected: install completes; `check:ts` exits 0. If `check:ts` fails on a clean upstream checkout, STOP and report — the baseline must be green before any fork work.

- [ ] **Step 2: Run the utils and a slice of coding-agent tests to sample the baseline**

```bash
cd packages/utils && bun test
cd ../coding-agent && bun test test/essential-tools.test.ts
```
Expected: PASS (all).

- [ ] **Step 3: Write the fork inventory doc**

Create `docs/aura/FORK.md`:
```markdown
# Aura fork inventory

This repository is a fork of [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)
(`upstream` remote). `main` is aura's mainline; upstream is merged regularly.

**Merge gate:** `bun run check:ts` and the TS test suite must be green before
and after every upstream merge.

## Upstream files modified by the fork

| File | Why |
|---|---|
| (appended by each task that edits an upstream file) | |

## Fork-added directories (additive, no merge risk)

- `packages/coding-agent/src/runtime/` — runtime capability core
- `packages/coding-agent/src/cli/runtime-cli.ts`, `src/commands/runtime.ts`
- `packages/coding-agent/src/tools/runtime-*.ts`, `src/prompts/tools/runtime-*.md`
- `docs/aura/`, `docs/superpowers/`

## Naming rule

Elide is never user-facing; the noun is "the runtime". See
`docs/superpowers/specs/2026-07-25-aura-omp-fork-design.md`.
```

- [ ] **Step 4: Commit**

```bash
git add docs/aura/FORK.md
git commit -m "docs: fork inventory and merge-gate conventions"
```

---

### Task 2: Branding constants (aura / .aura)

**Files:**
- Modify: `packages/utils/src/dirs.ts:20-23` (APP_NAME, CONFIG_DIR_NAME) and `:35` (PROFILE_ENV_KEYS)
- Test: `packages/utils/test/branding.test.ts`

**Interfaces:**
- Produces: `APP_NAME === "aura"`, `CONFIG_DIR_NAME === ".aura"` from `@oh-my-pi/pi-utils` (`dirs.ts`); profile env order `AURA_PROFILE` → `OMP_PROFILE` → `PI_PROFILE`. All later tasks import these constants rather than hardcoding.

- [ ] **Step 1: Write the failing test**

Create `packages/utils/test/branding.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { APP_NAME, CONFIG_DIR_NAME } from "../src/dirs";

describe("aura branding", () => {
	test("app name is aura", () => {
		expect(APP_NAME).toBe("aura");
	});
	test("config dir is .aura", () => {
		expect(CONFIG_DIR_NAME).toBe(".aura");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/utils && bun test test/branding.test.ts
```
Expected: FAIL — received `"omp"` / `".omp"`.

- [ ] **Step 3: Edit the constants**

In `packages/utils/src/dirs.ts` change:
```ts
/** App name (e.g. "aura") */
export const APP_NAME: string = "aura";

/** Config directory name (e.g. ".aura") */
export const CONFIG_DIR_NAME: string = ".aura";
```
and change the profile env list (keep legacy fallbacks, aura first):
```ts
const PROFILE_ENV_KEYS = ["AURA_PROFILE", "OMP_PROFILE", "PI_PROFILE"] as const;
```

- [ ] **Step 4: Run the branding test, then triage literal assertions upstream**

```bash
cd packages/utils && bun test
```
Then hunt tests that assert the old brand literals:
```bash
grep -rln '"\.omp"\|"omp"' packages/utils/test packages/coding-agent/test | head -40
```
For each hit that asserts identity (not e.g. an unrelated string), rewrite the expectation to import and use `APP_NAME`/`CONFIG_DIR_NAME` from `@oh-my-pi/pi-utils` (or the relative `../src/dirs`) instead of the literal. Do NOT weaken tests that intentionally check legacy compat paths (e.g. `PI_CONFIG_DIR` behavior) — those still pass because env overrides are untouched.

- [ ] **Step 5: Run the full utils + coding-agent type gate**

```bash
cd packages/utils && bun test
cd ../.. && bun run check:ts
```
Expected: PASS / exit 0. If coding-agent tests reference the literals heavily, fix them the same way (constants, not literals) before proceeding.

- [ ] **Step 6: Record in FORK.md and commit**

Append to the table in `docs/aura/FORK.md`:
```markdown
| `packages/utils/src/dirs.ts` | brand constants: APP_NAME=aura, CONFIG_DIR_NAME=.aura, AURA_PROFILE env |
```
```bash
git add -A
git commit -m "feat: aura brand constants in dirs.ts with guard tests"
```

---

### Task 3: `aura` bin entry

**Files:**
- Modify: `packages/coding-agent/package.json` (`bin` map)
- Test: `packages/coding-agent/test/aura-bin.test.ts`

**Interfaces:**
- Produces: `aura` as a bin name resolving to `src/cli.ts` (same target as `omp`, which stays as a compat alias).

- [ ] **Step 1: Write the failing test**

Create `packages/coding-agent/test/aura-bin.test.ts`:
```ts
import { expect, test } from "bun:test";
import pkg from "../package.json" with { type: "json" };

test("aura bin entry exists and matches omp's target", () => {
	const bin = pkg.bin as Record<string, string>;
	expect(bin.aura).toBeDefined();
	expect(bin.aura).toBe(bin.omp);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/coding-agent && bun test test/aura-bin.test.ts
```
Expected: FAIL — `bin.aura` undefined.

- [ ] **Step 3: Add the bin entry**

In `packages/coding-agent/package.json`, in the existing `"bin"` object, add an `"aura"` key with the exact same value as the existing `"omp"` key (keep `"omp"`).

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/coding-agent && bun test test/aura-bin.test.ts && cd ../.. && bun install
```
Expected: PASS; `bun install` refreshes workspace bin links so `bunx aura --version`-style invocation works in dev.

- [ ] **Step 5: Record in FORK.md and commit**

Append: `| packages/coding-agent/package.json | bin: aura alias alongside omp |`
```bash
git add -A && git commit -m "feat: aura bin entry"
```

---

### Task 4: Aura theme

**Files:**
- Create: `packages/coding-agent/src/modes/theme/aura.json`
- Modify: whichever file registers `dark.json`/`light.json` (locate in Step 1), and the `"theme"` default in `packages/coding-agent/src/config/settings-schema.ts`
- Test: `packages/coding-agent/test/aura-theme.test.ts`

**Interfaces:**
- Consumes: reference values from `~/workspace/labs/BUCKSHOT/packages/cli/assets/aura.json` (Pi theme format, generated from `@elide/tokens`).
- Produces: a registered `aura` theme, set as the default theme setting.

- [ ] **Step 1: Locate the theme registry**

```bash
grep -rn "dark.json\|light.json" packages/coding-agent/src --include="*.ts" | head
grep -n '"theme"' packages/coding-agent/src/config/settings-schema.ts
```
Note the import/registration site(s) — the same wiring must be replicated for `aura.json`.

- [ ] **Step 2: Write the failing structural test**

Create `packages/coding-agent/test/aura-theme.test.ts`:
```ts
import { expect, test } from "bun:test";
import dark from "../src/modes/theme/dark.json" with { type: "json" };
import aura from "../src/modes/theme/aura.json" with { type: "json" };

test("aura theme declares the same key set as the built-in dark theme", () => {
	expect(Object.keys(aura as object).sort()).toEqual(Object.keys(dark as object).sort());
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd packages/coding-agent && bun test test/aura-theme.test.ts
```
Expected: FAIL — `aura.json` does not exist.

- [ ] **Step 4: Build aura.json from the BUCKSHOT reference**

Copy `~/workspace/labs/BUCKSHOT/packages/cli/assets/aura.json` to `packages/coding-agent/src/modes/theme/aura.json`, then reconcile mechanically against `dark.json` until the key-set test passes: keep aura's color values for keys both formats share; for keys present only in OMP's `dark.json`, copy the `dark.json` value as a placeholder-of-record and adjust hue toward aura's palette where obvious; delete keys OMP's format doesn't have. The test is the driver — iterate until green.

- [ ] **Step 5: Register the theme and set it as default**

At the registration site found in Step 1, add `aura.json` exactly the way `dark.json` is wired. In `settings-schema.ts`, change the `"theme"` entry's `default` to `"aura"`.

- [ ] **Step 6: Run theme tests and the full check**

```bash
cd packages/coding-agent && bun test test/aura-theme.test.ts && bun test test/ -t theme
cd ../.. && bun run check:ts
```
Expected: PASS / exit 0. If existing theme tests assert the default theme name, update them via the settings schema default rather than literals where practical.

- [ ] **Step 7: Record in FORK.md and commit**

Append rows for the theme registration file(s) and `settings-schema.ts` (`theme default = aura`).
```bash
git add -A && git commit -m "feat: aura theme from @elide/tokens palette, set as default"
```

---

### Task 5: Runtime protocol (`protocol.ts`)

**Files:**
- Create: `packages/coding-agent/src/runtime/protocol.ts`
- Test: `packages/coding-agent/test/runtime-protocol.test.ts`

**Interfaces:**
- Produces (exact, used by every later task):
  - `RUNTIME_PROTOCOL_VERSION: 1`
  - `type RuntimeMethod = "runtime/run" | "runtime/check" | "runtime/build" | "runtime/insights" | "runtime/profile" | "runtime/status"`
  - `type RuntimeLanguage = "js" | "ts" | "python"`
  - `interface RuntimeRunParams { code?: string; path?: string; language?: RuntimeLanguage; args?: string[]; stdin?: string; timeoutMs?: number; cwd?: string }`
  - `interface RuntimeInsightsParams extends RuntimeRunParams { insight?: string; insightPath?: string }`
  - `interface RuntimeProfileParams extends RuntimeRunParams { mode: "cputracing" | "cpusampling" }`
  - `interface RuntimeBuildParams { targets?: string[]; cwd?: string; timeoutMs?: number }`; `type RuntimeCheckParams = RuntimeBuildParams`
  - `interface RuntimeExecResult { exitCode: number; stdout: string; stderr: string; durationMs: number; killed: boolean }`
  - `type RuntimeSource = "flag" | "env" | "managed" | "path"`
  - `interface RuntimeStatusResult { available: boolean; version?: string; binaryPath?: string; source?: RuntimeSource; guidance?: string; protocolVersion: number }`
  - `type RuntimeErrorCode = "runtime-missing" | "download-failed" | "timeout" | "invalid-params" | "cancelled" | "internal"`
  - `class RuntimeRpcError extends Error { code: RuntimeErrorCode; data?: Record<string, unknown> }`
  - `interface RuntimeRpcRequest { jsonrpc: "2.0"; id: number; method: RuntimeMethod; params: unknown }`
  - `type RuntimeRpcResponse` (result XOR error), `createRequest(method, params)`, `okResponse(id, result)`, `errorResponse(id, err: RuntimeRpcError)`, `unwrapResponse<T>(res): T` (throws `RuntimeRpcError` on error responses)

- [ ] **Step 1: Write the failing test**

Create `packages/coding-agent/test/runtime-protocol.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import {
	createRequest,
	errorResponse,
	okResponse,
	RUNTIME_PROTOCOL_VERSION,
	RuntimeRpcError,
	unwrapResponse,
} from "../src/runtime/protocol";

describe("runtime protocol", () => {
	test("protocol version is 1", () => {
		expect(RUNTIME_PROTOCOL_VERSION).toBe(1);
	});

	test("createRequest produces JSON-RPC 2.0 with unique ids", () => {
		const a = createRequest("runtime/run", { code: "1" });
		const b = createRequest("runtime/status", undefined);
		expect(a.jsonrpc).toBe("2.0");
		expect(a.method).toBe("runtime/run");
		expect(b.id).not.toBe(a.id);
	});

	test("unwrapResponse returns result payloads", () => {
		const req = createRequest("runtime/status", undefined);
		const res = okResponse(req.id, { available: true, protocolVersion: 1 });
		expect(unwrapResponse<{ available: boolean }>(res).available).toBe(true);
	});

	test("unwrapResponse throws typed errors", () => {
		const req = createRequest("runtime/run", {});
		const res = errorResponse(req.id, new RuntimeRpcError("runtime-missing", "no runtime", { hint: "install" }));
		expect(() => unwrapResponse(res)).toThrow(RuntimeRpcError);
		try {
			unwrapResponse(res);
		} catch (e) {
			expect((e as RuntimeRpcError).code).toBe("runtime-missing");
			expect((e as RuntimeRpcError).data).toEqual({ hint: "install" });
		}
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/coding-agent && bun test test/runtime-protocol.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `protocol.ts`**

Create `packages/coding-agent/src/runtime/protocol.ts`:
```ts
/**
 * Aura runtime capability protocol — a small JSON-RPC 2.0 contract between
 * the RuntimeService (what tools see) and a RuntimeEndpoint (how dispatch
 * happens). The wire shape is the seam: today's endpoint shells the runtime
 * CLI per call; a stdio broker daemon or an in-process endpoint are drop-ins.
 */

export const RUNTIME_PROTOCOL_VERSION = 1 as const;

export type RuntimeMethod =
	| "runtime/run"
	| "runtime/check"
	| "runtime/build"
	| "runtime/insights"
	| "runtime/profile"
	| "runtime/status";

export type RuntimeLanguage = "js" | "ts" | "python";

export interface RuntimeRunParams {
	/** Inline source; mutually exclusive with `path`. Written to a temp file (stdin source mode is unsupported by the runtime). */
	code?: string;
	/** Existing file to run; preserves project cwd/imports. */
	path?: string;
	/** Language for inline code (default "ts"); inferred from the extension in path mode. */
	language?: RuntimeLanguage;
	args?: string[];
	stdin?: string;
	timeoutMs?: number;
	cwd?: string;
}

export interface RuntimeInsightsParams extends RuntimeRunParams {
	/** Inline insight instrumentation script (JS). */
	insight?: string;
	/** Existing insight script path. */
	insightPath?: string;
}

export interface RuntimeProfileParams extends RuntimeRunParams {
	mode: "cputracing" | "cpusampling";
}

export interface RuntimeBuildParams {
	/** ':'-prefixed build targets with scoped options, passed through verbatim. */
	targets?: string[];
	cwd?: string;
	timeoutMs?: number;
}

/** v1: check = validation build (resolve + compile, no artifacts requested). */
export type RuntimeCheckParams = RuntimeBuildParams;

export interface RuntimeExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
	killed: boolean;
}

export type RuntimeSource = "flag" | "env" | "managed" | "path";

export interface RuntimeStatusResult {
	available: boolean;
	version?: string;
	binaryPath?: string;
	source?: RuntimeSource;
	guidance?: string;
	protocolVersion: number;
}

export type RuntimeErrorCode =
	| "runtime-missing"
	| "download-failed"
	| "timeout"
	| "invalid-params"
	| "cancelled"
	| "internal";

export class RuntimeRpcError extends Error {
	constructor(
		readonly code: RuntimeErrorCode,
		message: string,
		readonly data?: Record<string, unknown>,
	) {
		super(message);
		this.name = "RuntimeRpcError";
	}
}

export interface RuntimeRpcRequest {
	jsonrpc: "2.0";
	id: number;
	method: RuntimeMethod;
	params: unknown;
}

export type RuntimeRpcResponse =
	| { jsonrpc: "2.0"; id: number; result: unknown }
	| { jsonrpc: "2.0"; id: number; error: { code: RuntimeErrorCode; message: string; data?: Record<string, unknown> } };

let nextRequestId = 1;

export function createRequest(method: RuntimeMethod, params: unknown): RuntimeRpcRequest {
	return { jsonrpc: "2.0", id: nextRequestId++, method, params };
}

export function okResponse(id: number, result: unknown): RuntimeRpcResponse {
	return { jsonrpc: "2.0", id, result };
}

export function errorResponse(id: number, err: RuntimeRpcError): RuntimeRpcResponse {
	return { jsonrpc: "2.0", id, error: { code: err.code, message: err.message, data: err.data } };
}

export function unwrapResponse<T>(res: RuntimeRpcResponse): T {
	if ("error" in res) {
		throw new RuntimeRpcError(res.error.code, res.error.message, res.error.data);
	}
	return res.result as T;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/coding-agent && bun test test/runtime-protocol.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/runtime/protocol.ts packages/coding-agent/test/runtime-protocol.test.ts
git commit -m "feat: aura runtime JSON-RPC protocol (v1)"
```

---

### Task 6: Distribution pins + binary resolution (`provision.ts` pins, `resolve.ts`)

**Files:**
- Create: `packages/coding-agent/src/runtime/dist.ts` (pins), `packages/coding-agent/src/runtime/resolve.ts`
- Test: `packages/coding-agent/test/runtime-resolve.test.ts`

**Interfaces:**
- Produces:
  - `dist.ts`: `ELIDE_VERSION = "1.4.1+20260718"`, `interface RuntimeDistEntry { file: string; sha256: string; archive: "txz" | "zip" }`, `RUNTIME_DIST: Record<string, RuntimeDistEntry>`, `platformKey(): string` (`${process.platform}-${process.arch}`), `distDownloadUrl(entry, baseUrl?): string`
  - `resolve.ts`: `interface ResolvedRuntime { binaryPath: string; source: RuntimeSource }`, `managedRuntimeRoot(): string` (= `~/​<CONFIG_DIR_NAME>/runtime`), `managedVersionDir(version?): string`, `findBinaryInTree(dir): Promise<string | null>` (locates `bin/elide[.exe]` anywhere under dir), `resolveRuntimeBinary(opts: { explicitPath?: string; env?: NodeJS.ProcessEnv }): Promise<ResolvedRuntime | null>`
- Resolution order: `explicitPath` (flag/setting) → `AURA_RUNTIME_BIN` → `ELIDE_BIN` → managed dir (`findBinaryInTree(managedVersionDir())`) → `Bun.which("elide")`.

- [ ] **Step 1: Write the failing test**

Create `packages/coding-agent/test/runtime-resolve.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { findBinaryInTree, resolveRuntimeBinary } from "../src/runtime/resolve";

async function makeFakeBinary(root: string, rel: string): Promise<string> {
	const p = path.join(root, rel);
	await fs.mkdir(path.dirname(p), { recursive: true });
	await fs.writeFile(p, "#!/bin/sh\necho fake\n", { mode: 0o755 });
	return p;
}

describe("runtime binary resolution", () => {
	const tmpDirs: string[] = [];
	afterEach(async () => {
		for (const d of tmpDirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
	});

	test("explicit path wins", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aura-rt-"));
		tmpDirs.push(dir);
		const bin = await makeFakeBinary(dir, "elide");
		const r = await resolveRuntimeBinary({ explicitPath: bin, env: {} });
		expect(r).toEqual({ binaryPath: bin, source: "flag" });
	});

	test("AURA_RUNTIME_BIN beats ELIDE_BIN", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aura-rt-"));
		tmpDirs.push(dir);
		const a = await makeFakeBinary(dir, "a/elide");
		const b = await makeFakeBinary(dir, "b/elide");
		const r = await resolveRuntimeBinary({ env: { AURA_RUNTIME_BIN: a, ELIDE_BIN: b } });
		expect(r).toEqual({ binaryPath: a, source: "env" });
	});

	test("nonexistent explicit path returns null rather than a lie", async () => {
		const r = await resolveRuntimeBinary({ explicitPath: "/nope/elide", env: {}, disablePathLookup: true });
		expect(r).toBeNull();
	});

	test("findBinaryInTree locates bin/elide at any depth", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aura-rt-"));
		tmpDirs.push(dir);
		const bin = await makeFakeBinary(dir, "elide-1.4.1/bin/elide");
		expect(await findBinaryInTree(dir)).toBe(bin);
	});
});
```
Note: the third test requires `resolveRuntimeBinary` to accept `disablePathLookup?: boolean` (skips `Bun.which` — needed for hermetic tests on machines that have elide on PATH). Include it in the options interface.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/coding-agent && bun test test/runtime-resolve.test.ts
```
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `dist.ts`**

Create `packages/coding-agent/src/runtime/dist.ts`:
```ts
/** Pinned Elide distribution (the runtime's engine). Bump version + all sha256s in lockstep. */

export const ELIDE_VERSION = "1.4.1+20260718";

export interface RuntimeDistEntry {
	file: string;
	sha256: string;
	archive: "txz" | "zip";
}

export const RUNTIME_DIST: Record<string, RuntimeDistEntry> = {
	"linux-x64": {
		file: "elide.linux-amd64.txz",
		sha256: "b1183f0c577acdb8f29950c2b0f0915b5dcd35568478866a0bd89b0273ada1bb",
		archive: "txz",
	},
	"linux-arm64": {
		file: "elide.linux-arm64.txz",
		sha256: "fd6765b32182e3d24e64d52f376fbbb224547ff0e51e25a66f2d5ed478f00403",
		archive: "txz",
	},
	"darwin-arm64": {
		file: "elide.macos-arm64.txz",
		sha256: "cef68ecf065d05900036c929a2128f659cd543232350c83a28433869c9aef39c",
		archive: "txz",
	},
	"win32-x64": {
		file: "elide.windows-amd64.zip",
		sha256: "656d9ff51bb229bfd28cbb8af263e67a0ac39c743e68b5d0c05ddfdc0c74f23d",
		archive: "zip",
	},
};

export function platformKey(): string {
	return `${process.platform}-${process.arch}`;
}

export function distDownloadUrl(
	entry: RuntimeDistEntry,
	baseUrl = `https://github.com/elide-dev/elide/releases/download/${encodeURIComponent(ELIDE_VERSION)}`,
): string {
	return `${baseUrl}/${entry.file}`;
}
```

- [ ] **Step 4: Implement `resolve.ts`**

Create `packages/coding-agent/src/runtime/resolve.ts`:
```ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@oh-my-pi/pi-utils";
import { ELIDE_VERSION } from "./dist";
import type { RuntimeSource } from "./protocol";

export interface ResolvedRuntime {
	binaryPath: string;
	source: RuntimeSource;
}

export interface ResolveOptions {
	/** From `--runtime` or the `runtime.path` setting. */
	explicitPath?: string;
	env?: NodeJS.ProcessEnv;
	/** Hermetic tests: skip the PATH fallback. */
	disablePathLookup?: boolean;
}

export function managedRuntimeRoot(): string {
	return path.join(os.homedir(), CONFIG_DIR_NAME, "runtime");
}

export function managedVersionDir(version = ELIDE_VERSION): string {
	return path.join(managedRuntimeRoot(), version);
}

const BINARY_NAMES = process.platform === "win32" ? ["elide.exe", "elide.cmd", "elide"] : ["elide"];

async function isFile(p: string): Promise<boolean> {
	try {
		return (await fs.stat(p)).isFile();
	} catch {
		return false;
	}
}

/** Locate `bin/<elide binary>` anywhere under `dir` (archive layouts vary across releases). */
export async function findBinaryInTree(dir: string): Promise<string | null> {
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch {
		return null;
	}
	// direct hit: dir/bin/elide
	for (const name of BINARY_NAMES) {
		const direct = path.join(dir, "bin", name);
		if (await isFile(direct)) return direct;
	}
	for (const entry of entries) {
		const child = path.join(dir, entry);
		let stat: Awaited<ReturnType<typeof fs.stat>>;
		try {
			stat = await fs.stat(child);
		} catch {
			continue;
		}
		if (!stat.isDirectory()) continue;
		const found = await findBinaryInTree(child);
		if (found) return found;
	}
	return null;
}

export async function resolveRuntimeBinary(opts: ResolveOptions = {}): Promise<ResolvedRuntime | null> {
	const env = opts.env ?? process.env;
	if (opts.explicitPath) {
		if (await isFile(opts.explicitPath)) return { binaryPath: opts.explicitPath, source: "flag" };
		return null; // an explicit path that doesn't exist is an error, not a fallthrough
	}
	for (const key of ["AURA_RUNTIME_BIN", "ELIDE_BIN"] as const) {
		const p = env[key];
		if (p && (await isFile(p))) return { binaryPath: p, source: "env" };
	}
	const managed = await findBinaryInTree(managedVersionDir());
	if (managed) return { binaryPath: managed, source: "managed" };
	if (!opts.disablePathLookup) {
		const onPath = Bun.which("elide");
		if (onPath) return { binaryPath: onPath, source: "path" };
	}
	return null;
}
```
Check the actual export surface of `@oh-my-pi/pi-utils` first (`grep -n "CONFIG_DIR_NAME" packages/utils/src/index.ts`); if `dirs` is a subpath export, import from `@oh-my-pi/pi-utils/dirs` instead.

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd packages/coding-agent && bun test test/runtime-resolve.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/coding-agent/src/runtime/dist.ts packages/coding-agent/src/runtime/resolve.ts packages/coding-agent/test/runtime-resolve.test.ts
git commit -m "feat: runtime distribution pins and binary resolution chain"
```

---

### Task 7: Auto-provisioning (`provision.ts`)

**Files:**
- Create: `packages/coding-agent/src/runtime/provision.ts`
- Test: `packages/coding-agent/test/runtime-provision.test.ts`

**Interfaces:**
- Consumes: `RUNTIME_DIST`, `distDownloadUrl`, `platformKey`, `ELIDE_VERSION` (Task 6); `findBinaryInTree` (Task 6); `RuntimeRpcError` (Task 5).
- Produces: `provisionRuntime(opts: ProvisionOptions): Promise<string>` — downloads, sha256-verifies, extracts, atomically installs, returns the binary path. `interface ProvisionOptions { baseUrl?: string; version?: string; dist?: RuntimeDistEntry; targetRoot?: string; onProgress?: (message: string) => void }` (`dist`/`targetRoot`/`baseUrl` overrides exist for tests and mirrors).

- [ ] **Step 1: Write the failing tests (fixture server)**

Create `packages/coding-agent/test/runtime-provision.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RuntimeRpcError } from "../src/runtime/protocol";
import { provisionRuntime } from "../src/runtime/provision";

let server: ReturnType<typeof Bun.serve>;
let archive: Uint8Array;
let archiveSha: string;
let workRoot: string;

beforeAll(async () => {
	workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aura-prov-"));
	// Build a tiny real .txz: dist/bin/elide (fake shell script)
	const stage = path.join(workRoot, "stage", "elide-dist");
	await fs.mkdir(path.join(stage, "bin"), { recursive: true });
	await fs.writeFile(path.join(stage, "bin", "elide"), "#!/bin/sh\necho 1.4.1-fake\n", { mode: 0o755 });
	const tar = Bun.spawnSync(["tar", "-cJf", path.join(workRoot, "fake.txz"), "-C", path.join(workRoot, "stage"), "elide-dist"]);
	if (tar.exitCode !== 0) throw new Error(`fixture tar failed: ${tar.stderr.toString()}`);
	archive = new Uint8Array(await Bun.file(path.join(workRoot, "fake.txz")).arrayBuffer());
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(archive);
	archiveSha = hasher.digest("hex");
	server = Bun.serve({
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname.endsWith("/fake.txz")) return new Response(archive);
			return new Response("not found", { status: 404 });
		},
	});
});

afterAll(async () => {
	server.stop(true);
	await fs.rm(workRoot, { recursive: true, force: true });
});

describe("runtime provisioning", () => {
	test("downloads, verifies, extracts, and returns the binary path", async () => {
		const targetRoot = path.join(workRoot, "managed-ok");
		const progress: string[] = [];
		const bin = await provisionRuntime({
			baseUrl: `http://localhost:${server.port}`,
			dist: { file: "fake.txz", sha256: archiveSha, archive: "txz" },
			version: "0.0.0-test",
			targetRoot,
			onProgress: m => progress.push(m),
		});
		expect(bin.endsWith(path.join("bin", "elide"))).toBe(true);
		expect((await fs.stat(bin)).isFile()).toBe(true);
		expect(progress.length).toBeGreaterThan(0);
		// idempotent: a second call returns the installed binary without re-downloading
		const again = await provisionRuntime({
			baseUrl: "http://localhost:1", // unreachable — must not be contacted
			dist: { file: "fake.txz", sha256: archiveSha, archive: "txz" },
			version: "0.0.0-test",
			targetRoot,
		});
		expect(again).toBe(bin);
	});

	test("checksum mismatch is a typed download-failed error and installs nothing", async () => {
		const targetRoot = path.join(workRoot, "managed-bad");
		const err = await provisionRuntime({
			baseUrl: `http://localhost:${server.port}`,
			dist: { file: "fake.txz", sha256: "0".repeat(64), archive: "txz" },
			version: "0.0.0-test",
			targetRoot,
		}).catch(e => e);
		expect(err).toBeInstanceOf(RuntimeRpcError);
		expect((err as RuntimeRpcError).code).toBe("download-failed");
		expect(await fs.readdir(targetRoot).catch(() => [])).toEqual([]);
	});

	test("unreachable server is a typed download-failed error", async () => {
		const err = await provisionRuntime({
			baseUrl: "http://localhost:1",
			dist: { file: "fake.txz", sha256: archiveSha, archive: "txz" },
			version: "0.0.0-test",
			targetRoot: path.join(workRoot, "managed-offline"),
		}).catch(e => e);
		expect(err).toBeInstanceOf(RuntimeRpcError);
		expect((err as RuntimeRpcError).code).toBe("download-failed");
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/coding-agent && bun test test/runtime-provision.test.ts
```
Expected: FAIL — `provision.ts` not found.

- [ ] **Step 3: Implement `provision.ts`**

Create `packages/coding-agent/src/runtime/provision.ts`:
```ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { distDownloadUrl, ELIDE_VERSION, platformKey, RUNTIME_DIST, type RuntimeDistEntry } from "./dist";
import { RuntimeRpcError } from "./protocol";
import { findBinaryInTree, managedRuntimeRoot } from "./resolve";

export interface ProvisionOptions {
	baseUrl?: string;
	version?: string;
	/** Platform dist override (tests/mirrors). Defaults to RUNTIME_DIST[platformKey()]. */
	dist?: RuntimeDistEntry;
	/** Install root override (tests). Defaults to managedRuntimeRoot(). */
	targetRoot?: string;
	onProgress?: (message: string) => void;
}

/**
 * Download → sha256-verify → extract → atomic rename into
 * `<targetRoot>/<version>/`. Returns the runtime binary path. Idempotent:
 * an existing install for `version` short-circuits without network access.
 */
export async function provisionRuntime(opts: ProvisionOptions = {}): Promise<string> {
	const version = opts.version ?? ELIDE_VERSION;
	const dist = opts.dist ?? RUNTIME_DIST[platformKey()];
	if (!dist) {
		throw new RuntimeRpcError("download-failed", `No runtime distribution is pinned for platform ${platformKey()}.`, {
			platform: platformKey(),
		});
	}
	const root = opts.targetRoot ?? managedRuntimeRoot();
	const versionDir = path.join(root, version);
	const existing = await findBinaryInTree(versionDir);
	if (existing) return existing;

	const progress = opts.onProgress ?? (() => {});
	const url = distDownloadUrl(dist, opts.baseUrl);
	const staging = path.join(root, `.staging-${process.pid}-${Date.now()}`);
	await fs.mkdir(staging, { recursive: true });
	try {
		progress(`Downloading runtime ${version}…`);
		let response: Response;
		try {
			response = await fetch(url);
		} catch (cause) {
			throw new RuntimeRpcError("download-failed", `Runtime download failed: cannot reach ${url}.`, {
				url,
				cause: String(cause),
			});
		}
		if (!response.ok) {
			throw new RuntimeRpcError("download-failed", `Runtime download failed: HTTP ${response.status} for ${url}.`, {
				url,
				status: response.status,
			});
		}
		const bytes = new Uint8Array(await response.arrayBuffer());

		progress("Verifying checksum…");
		const hasher = new Bun.CryptoHasher("sha256");
		hasher.update(bytes);
		const actual = hasher.digest("hex");
		if (actual !== dist.sha256) {
			throw new RuntimeRpcError("download-failed", "Runtime download failed checksum verification.", {
				url,
				expected: dist.sha256,
				actual,
			});
		}

		progress("Extracting…");
		const archivePath = path.join(staging, dist.file);
		await Bun.write(archivePath, bytes);
		const extractDir = path.join(staging, "extract");
		await fs.mkdir(extractDir, { recursive: true });
		const argv =
			dist.archive === "zip"
				? ["unzip", "-q", archivePath, "-d", extractDir]
				: ["tar", "-xJf", archivePath, "-C", extractDir];
		const proc = Bun.spawnSync(argv);
		if (proc.exitCode !== 0) {
			throw new RuntimeRpcError("download-failed", "Runtime archive extraction failed.", {
				argv,
				stderr: proc.stderr.toString(),
			});
		}

		const binary = await findBinaryInTree(extractDir);
		if (!binary) {
			throw new RuntimeRpcError("download-failed", "Runtime archive did not contain a bin/elide binary.", { url });
		}

		await fs.rm(versionDir, { recursive: true, force: true });
		await fs.mkdir(path.dirname(versionDir), { recursive: true });
		await fs.rename(extractDir, versionDir);
		const installed = await findBinaryInTree(versionDir);
		if (!installed) {
			throw new RuntimeRpcError("download-failed", "Runtime install did not land where expected.", { versionDir });
		}
		progress(`Runtime ${version} installed.`);
		return installed;
	} finally {
		await fs.rm(staging, { recursive: true, force: true });
		// Never leave an empty targetRoot behind on failure paths in tests.
		const leftover = await fs.readdir(root).catch(() => null);
		if (leftover !== null && leftover.length === 0) await fs.rmdir(root).catch(() => {});
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/coding-agent && bun test test/runtime-provision.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 5: Type gate and commit**

```bash
cd ../.. && bun run check:ts
git add packages/coding-agent/src/runtime/provision.ts packages/coding-agent/test/runtime-provision.test.ts
git commit -m "feat: runtime auto-provisioning with sha256 verification and atomic install"
```

---

### Task 8: Service + local endpoint (`service.ts`, `transport/local.ts`)

**Files:**
- Create: `packages/coding-agent/src/runtime/service.ts`, `packages/coding-agent/src/runtime/transport/local.ts`, `packages/coding-agent/src/runtime/index.ts`
- Test: `packages/coding-agent/test/runtime-service.test.ts`, `packages/coding-agent/test/runtime-local-endpoint.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 5–7.
- Produces:
  - `service.ts`: `interface RuntimeEndpoint { request(req: RuntimeRpcRequest, signal?: AbortSignal): Promise<RuntimeRpcResponse> }`; `class RuntimeService { constructor(endpoint: RuntimeEndpoint); run(p: RuntimeRunParams, signal?): Promise<RuntimeExecResult>; check(p: RuntimeCheckParams, signal?): Promise<RuntimeExecResult>; build(p: RuntimeBuildParams, signal?): Promise<RuntimeExecResult>; insights(p: RuntimeInsightsParams, signal?): Promise<RuntimeExecResult>; profile(p: RuntimeProfileParams, signal?): Promise<RuntimeExecResult>; status(): Promise<RuntimeStatusResult> }`
  - `transport/local.ts`: `class LocalRuntimeEndpoint implements RuntimeEndpoint { constructor(opts?: LocalEndpointOptions) }`; `interface LocalEndpointOptions { explicitPath?: string; autoDownload?: boolean; env?: NodeJS.ProcessEnv; onProgress?: (m: string) => void; provision?: typeof provisionRuntime; resolve?: typeof resolveRuntimeBinary }` (injectable for tests)
  - `index.ts`: re-exports + `getOrCreateRuntimeService(opts?: LocalEndpointOptions): RuntimeService` (module-level lazy singleton keyed on nothing — one per process; `resetRuntimeServiceForTests()` clears it)
- Argv mapping (pinned, from verified Elide 1.4.2 CLI):
  - `runtime/run` → `[bin, "run", "--error-format=plain", "--no-color", "-l", lang, file, ...(args?.length ? ["--", ...args] : [])]`
  - `runtime/insights` → run argv + `--insights=<insightFile>` before `-l`
  - `runtime/profile` → run argv + `--profiler=<mode>` before `-l`
  - `runtime/check` → `[bin, "build", "--no-color"]` (validation build, no targets)
  - `runtime/build` → `[bin, "build", "--no-color", ...(targets ?? [])]`
  - `runtime/status` → `[bin, "--version"]`
  - Inline `code` (and inline `insight`) are written to a temp dir (`fs.mkdtemp`) as `guest.<ext>` / `insight.js` (ext: js→`js`, ts→`ts`, python→`py`); temp dir removed in `finally`. Default language for inline code: `"ts"`.

- [ ] **Step 1: Write the failing service test (mock endpoint)**

Create `packages/coding-agent/test/runtime-service.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { okResponse, type RuntimeRpcRequest, type RuntimeRpcResponse } from "../src/runtime/protocol";
import { RuntimeService, type RuntimeEndpoint } from "../src/runtime/service";

class RecordingEndpoint implements RuntimeEndpoint {
	requests: RuntimeRpcRequest[] = [];
	async request(req: RuntimeRpcRequest): Promise<RuntimeRpcResponse> {
		this.requests.push(req);
		if (req.method === "runtime/status") {
			return okResponse(req.id, { available: true, protocolVersion: 1 });
		}
		return okResponse(req.id, { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1, killed: false });
	}
}

describe("RuntimeService", () => {
	test("maps each capability to its protocol method", async () => {
		const ep = new RecordingEndpoint();
		const svc = new RuntimeService(ep);
		await svc.run({ code: "console.log(1)" });
		await svc.check({});
		await svc.build({ targets: [":compile"] });
		await svc.insights({ code: "x", insight: "y" });
		await svc.profile({ code: "x", mode: "cpusampling" });
		await svc.status();
		expect(ep.requests.map(r => r.method)).toEqual([
			"runtime/run",
			"runtime/check",
			"runtime/build",
			"runtime/insights",
			"runtime/profile",
			"runtime/status",
		]);
	});

	test("returns unwrapped results", async () => {
		const svc = new RuntimeService(new RecordingEndpoint());
		const r = await svc.run({ code: "1" });
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toBe("ok");
	});
});
```

- [ ] **Step 2: Write the failing local-endpoint test (fake binary)**

Create `packages/coding-agent/test/runtime-local-endpoint.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createRequest, RuntimeRpcError, unwrapResponse } from "../src/runtime/protocol";
import { LocalRuntimeEndpoint } from "../src/runtime/transport/local";
import type { RuntimeExecResult, RuntimeStatusResult } from "../src/runtime/protocol";

let dir: string;
let fakeBin: string;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "aura-ep-"));
	fakeBin = path.join(dir, "elide");
	// Fake runtime: prints its argv so tests can assert the mapping; `--version` prints a version.
	await fs.writeFile(
		fakeBin,
		`#!/bin/sh\nif [ "$1" = "--version" ]; then echo "9.9.9-fake"; exit 0; fi\necho "ARGS:$@"\n`,
		{ mode: 0o755 },
	);
});

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

describe("LocalRuntimeEndpoint", () => {
	test("run maps to the pinned argv shape and writes inline code to a temp file", async () => {
		const ep = new LocalRuntimeEndpoint({ explicitPath: fakeBin, autoDownload: false });
		const res = await ep.request(createRequest("runtime/run", { code: "print(1)", language: "python", args: ["a", "b"] }));
		const out = unwrapResponse<RuntimeExecResult>(res);
		expect(out.exitCode).toBe(0);
		expect(out.stdout).toContain("run --error-format=plain --no-color -l python ");
		expect(out.stdout).toContain("guest.py");
		expect(out.stdout).toContain("-- a b");
	});

	test("check maps to a validation build", async () => {
		const ep = new LocalRuntimeEndpoint({ explicitPath: fakeBin, autoDownload: false });
		const out = unwrapResponse<RuntimeExecResult>(await ep.request(createRequest("runtime/check", {})));
		expect(out.stdout.trim()).toBe("ARGS:build --no-color");
	});

	test("build passes targets through", async () => {
		const ep = new LocalRuntimeEndpoint({ explicitPath: fakeBin, autoDownload: false });
		const out = unwrapResponse<RuntimeExecResult>(
			await ep.request(createRequest("runtime/build", { targets: [":deps", "--fresh"] })),
		);
		expect(out.stdout.trim()).toBe("ARGS:build --no-color :deps --fresh");
	});

	test("status reports version without provisioning", async () => {
		const ep = new LocalRuntimeEndpoint({ explicitPath: fakeBin, autoDownload: false });
		const out = unwrapResponse<RuntimeStatusResult>(await ep.request(createRequest("runtime/status", undefined)));
		expect(out.available).toBe(true);
		expect(out.version).toBe("9.9.9-fake");
		expect(out.source).toBe("flag");
	});

	test("missing runtime yields runtime-missing guidance (status) and error (run)", async () => {
		const ep = new LocalRuntimeEndpoint({ explicitPath: path.join(dir, "nope"), autoDownload: false });
		const status = unwrapResponse<RuntimeStatusResult>(await ep.request(createRequest("runtime/status", undefined)));
		expect(status.available).toBe(false);
		expect(status.guidance).toBeDefined();
		const runRes = await ep.request(createRequest("runtime/run", { code: "1" }));
		expect(() => unwrapResponse(runRes)).toThrow(RuntimeRpcError);
	});

	test("run without code or path is invalid-params", async () => {
		const ep = new LocalRuntimeEndpoint({ explicitPath: fakeBin, autoDownload: false });
		const res = await ep.request(createRequest("runtime/run", {}));
		try {
			unwrapResponse(res);
			throw new Error("expected error");
		} catch (e) {
			expect((e as RuntimeRpcError).code).toBe("invalid-params");
		}
	});

	test("timeout kills the process and reports killed", async () => {
		const slowBin = path.join(dir, "slow");
		await fs.writeFile(slowBin, `#!/bin/sh\nsleep 5\n`, { mode: 0o755 });
		const ep = new LocalRuntimeEndpoint({ explicitPath: slowBin, autoDownload: false });
		const out = unwrapResponse<RuntimeExecResult>(
			await ep.request(createRequest("runtime/run", { code: "1", timeoutMs: 200 })),
		);
		expect(out.killed).toBe(true);
	}, 10_000);
});
```
Note: `LocalRuntimeEndpoint` with an `explicitPath` that doesn't exist must NOT fall through to PATH — pass `disablePathLookup` semantics via `resolveRuntimeBinary`'s explicit-path rule (Task 6 already returns `null` for a dead explicit path).

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd packages/coding-agent && bun test test/runtime-service.test.ts test/runtime-local-endpoint.test.ts
```
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement `service.ts`**

Create `packages/coding-agent/src/runtime/service.ts`:
```ts
import {
	createRequest,
	type RuntimeBuildParams,
	type RuntimeCheckParams,
	type RuntimeExecResult,
	type RuntimeInsightsParams,
	type RuntimeMethod,
	type RuntimeProfileParams,
	type RuntimeRpcRequest,
	type RuntimeRpcResponse,
	type RuntimeRunParams,
	type RuntimeStatusResult,
	unwrapResponse,
} from "./protocol";

export interface RuntimeEndpoint {
	request(req: RuntimeRpcRequest, signal?: AbortSignal): Promise<RuntimeRpcResponse>;
}

/**
 * The only runtime surface tools see. Speaks the protocol to an endpoint and
 * never knows whether dispatch is per-call subprocess, broker, or in-process.
 */
export class RuntimeService {
	constructor(private readonly endpoint: RuntimeEndpoint) {}

	private async call<T>(method: RuntimeMethod, params: unknown, signal?: AbortSignal): Promise<T> {
		return unwrapResponse<T>(await this.endpoint.request(createRequest(method, params), signal));
	}

	run(params: RuntimeRunParams, signal?: AbortSignal): Promise<RuntimeExecResult> {
		return this.call("runtime/run", params, signal);
	}
	check(params: RuntimeCheckParams, signal?: AbortSignal): Promise<RuntimeExecResult> {
		return this.call("runtime/check", params, signal);
	}
	build(params: RuntimeBuildParams, signal?: AbortSignal): Promise<RuntimeExecResult> {
		return this.call("runtime/build", params, signal);
	}
	insights(params: RuntimeInsightsParams, signal?: AbortSignal): Promise<RuntimeExecResult> {
		return this.call("runtime/insights", params, signal);
	}
	profile(params: RuntimeProfileParams, signal?: AbortSignal): Promise<RuntimeExecResult> {
		return this.call("runtime/profile", params, signal);
	}
	status(): Promise<RuntimeStatusResult> {
		return this.call("runtime/status", undefined);
	}
}
```

- [ ] **Step 5: Implement `transport/local.ts`**

Create `packages/coding-agent/src/runtime/transport/local.ts`:
```ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	errorResponse,
	okResponse,
	RUNTIME_PROTOCOL_VERSION,
	RuntimeRpcError,
	type RuntimeBuildParams,
	type RuntimeExecResult,
	type RuntimeInsightsParams,
	type RuntimeLanguage,
	type RuntimeProfileParams,
	type RuntimeRpcRequest,
	type RuntimeRpcResponse,
	type RuntimeRunParams,
	type RuntimeStatusResult,
} from "../protocol";
import { provisionRuntime } from "../provision";
import { resolveRuntimeBinary, type ResolvedRuntime } from "../resolve";
import type { RuntimeEndpoint } from "../service";

export interface LocalEndpointOptions {
	explicitPath?: string;
	autoDownload?: boolean;
	env?: NodeJS.ProcessEnv;
	onProgress?: (message: string) => void;
	/** Injectable for tests. */
	provision?: typeof provisionRuntime;
	resolve?: typeof resolveRuntimeBinary;
}

const GUEST_EXT: Record<RuntimeLanguage, string> = { js: "js", ts: "ts", python: "py" };

const MISSING_GUIDANCE =
	"The runtime is not installed. It downloads automatically on first use when runtime.autoDownload is on; " +
	"or point AURA_RUNTIME_BIN (or the runtime.path setting) at an existing binary. Requires runtime >= 1.4.";

/** Per-call subprocess endpoint: services protocol requests by shelling the runtime CLI. */
export class LocalRuntimeEndpoint implements RuntimeEndpoint {
	constructor(private readonly opts: LocalEndpointOptions = {}) {}

	async request(req: RuntimeRpcRequest, signal?: AbortSignal): Promise<RuntimeRpcResponse> {
		try {
			switch (req.method) {
				case "runtime/status":
					return okResponse(req.id, await this.status());
				case "runtime/run":
					return okResponse(req.id, await this.execRun(req.params as RuntimeRunParams, signal));
				case "runtime/insights":
					return okResponse(req.id, await this.execInsights(req.params as RuntimeInsightsParams, signal));
				case "runtime/profile":
					return okResponse(req.id, await this.execProfile(req.params as RuntimeProfileParams, signal));
				case "runtime/check":
					return okResponse(req.id, await this.execBuild(req.params as RuntimeBuildParams, [], signal));
				case "runtime/build": {
					const params = req.params as RuntimeBuildParams;
					return okResponse(req.id, await this.execBuild(params, params.targets ?? [], signal));
				}
				default:
					return errorResponse(req.id, new RuntimeRpcError("invalid-params", `Unknown method ${req.method}`));
			}
		} catch (e) {
			if (e instanceof RuntimeRpcError) return errorResponse(req.id, e);
			return errorResponse(req.id, new RuntimeRpcError("internal", String(e)));
		}
	}

	private resolveFn(): typeof resolveRuntimeBinary {
		return this.opts.resolve ?? resolveRuntimeBinary;
	}

	private async locate(): Promise<ResolvedRuntime | null> {
		return this.resolveFn()({ explicitPath: this.opts.explicitPath, env: this.opts.env });
	}

	/** Resolve the binary; auto-provision when allowed. Throws runtime-missing otherwise. */
	private async ensureBinary(): Promise<ResolvedRuntime> {
		const found = await this.locate();
		if (found) return found;
		if (this.opts.autoDownload !== false && !this.opts.explicitPath) {
			const provision = this.opts.provision ?? provisionRuntime;
			const binaryPath = await provision({ onProgress: this.opts.onProgress });
			return { binaryPath, source: "managed" };
		}
		throw new RuntimeRpcError("runtime-missing", MISSING_GUIDANCE);
	}

	private async status(): Promise<RuntimeStatusResult> {
		const found = await this.locate();
		if (!found) {
			return { available: false, guidance: MISSING_GUIDANCE, protocolVersion: RUNTIME_PROTOCOL_VERSION };
		}
		const result = await this.spawn([found.binaryPath, "--version"], {});
		const version = result.stdout.trim().split(/\s+/)[0] || undefined;
		return {
			available: result.exitCode === 0,
			version,
			binaryPath: found.binaryPath,
			source: found.source,
			protocolVersion: RUNTIME_PROTOCOL_VERSION,
		};
	}

	private async execRun(params: RuntimeRunParams, signal?: AbortSignal): Promise<RuntimeExecResult> {
		return this.withGuestFile(params, async (bin, guestFile, language) => {
			const argv = [bin, "run", "--error-format=plain", "--no-color", "-l", language, guestFile];
			if (params.args?.length) argv.push("--", ...params.args);
			return this.spawn(argv, params, signal);
		});
	}

	private async execInsights(params: RuntimeInsightsParams, signal?: AbortSignal): Promise<RuntimeExecResult> {
		if (params.insight === undefined && params.insightPath === undefined) {
			throw new RuntimeRpcError("invalid-params", "insights requires insight (inline JS) or insightPath.");
		}
		return this.withGuestFile(params, async (bin, guestFile, language, tempDir) => {
			let insightFile = params.insightPath;
			if (insightFile === undefined) {
				insightFile = path.join(tempDir, "insight.js");
				await fs.writeFile(insightFile, params.insight ?? "");
			}
			const argv = [bin, "run", "--error-format=plain", "--no-color", `--insights=${insightFile}`, "-l", language, guestFile];
			if (params.args?.length) argv.push("--", ...params.args);
			return this.spawn(argv, params, signal);
		});
	}

	private async execProfile(params: RuntimeProfileParams, signal?: AbortSignal): Promise<RuntimeExecResult> {
		return this.withGuestFile(params, async (bin, guestFile, language) => {
			const argv = [bin, "run", "--error-format=plain", "--no-color", `--profiler=${params.mode}`, "-l", language, guestFile];
			if (params.args?.length) argv.push("--", ...params.args);
			return this.spawn(argv, params, signal);
		});
	}

	private async execBuild(
		params: RuntimeBuildParams,
		targets: string[],
		signal?: AbortSignal,
	): Promise<RuntimeExecResult> {
		const { binaryPath } = await this.ensureBinary();
		return this.spawn([binaryPath, "build", "--no-color", ...targets], params, signal);
	}

	/** Shared inline-code plumbing: resolve binary, materialize `code` to a temp guest file, clean up. */
	private async withGuestFile(
		params: RuntimeRunParams,
		fn: (bin: string, guestFile: string, language: RuntimeLanguage, tempDir: string) => Promise<RuntimeExecResult>,
	): Promise<RuntimeExecResult> {
		if (params.code === undefined && params.path === undefined) {
			throw new RuntimeRpcError("invalid-params", "run requires code (inline) or path (existing file).");
		}
		if (params.code !== undefined && params.path !== undefined) {
			throw new RuntimeRpcError("invalid-params", "code and path are mutually exclusive.");
		}
		const { binaryPath } = await this.ensureBinary();
		const language: RuntimeLanguage = params.language ?? (params.path ? inferLanguage(params.path) : "ts");
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aura-runtime-"));
		try {
			let guestFile = params.path;
			if (guestFile === undefined) {
				guestFile = path.join(tempDir, `guest.${GUEST_EXT[language]}`);
				await fs.writeFile(guestFile, params.code ?? "");
			}
			return await fn(binaryPath, guestFile, language, tempDir);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	}

	private async spawn(
		argv: string[],
		params: { stdin?: string; timeoutMs?: number; cwd?: string },
		signal?: AbortSignal,
	): Promise<RuntimeExecResult> {
		const start = performance.now();
		const proc = Bun.spawn(argv, {
			cwd: params.cwd,
			stdin: params.stdin !== undefined ? new TextEncoder().encode(params.stdin) : undefined,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, NO_COLOR: "1" },
		});
		let killed = false;
		const timers: ReturnType<typeof setTimeout>[] = [];
		if (params.timeoutMs) {
			timers.push(
				setTimeout(() => {
					killed = true;
					proc.kill();
				}, params.timeoutMs),
			);
		}
		const onAbort = () => {
			killed = true;
			proc.kill();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			if (signal?.aborted) throw new RuntimeRpcError("cancelled", "Runtime execution was cancelled.");
			return { exitCode, stdout, stderr, durationMs: Math.round(performance.now() - start), killed };
		} finally {
			for (const t of timers) clearTimeout(t);
			signal?.removeEventListener("abort", onAbort);
		}
	}
}

function inferLanguage(file: string): RuntimeLanguage {
	const ext = path.extname(file).toLowerCase();
	if (ext === ".py") return "python";
	if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return "js";
	return "ts";
}
```

- [ ] **Step 6: Implement `index.ts` (singleton + re-exports)**

Create `packages/coding-agent/src/runtime/index.ts`:
```ts
export * from "./protocol";
export * from "./service";
export { LocalRuntimeEndpoint, type LocalEndpointOptions } from "./transport/local";
export { resolveRuntimeBinary, managedRuntimeRoot, managedVersionDir } from "./resolve";
export { provisionRuntime } from "./provision";
export { ELIDE_VERSION } from "./dist";

import { RuntimeService } from "./service";
import { LocalRuntimeEndpoint, type LocalEndpointOptions } from "./transport/local";

let singleton: RuntimeService | undefined;

/** Process-wide lazy service over the local endpoint. Options apply on first call only. */
export function getOrCreateRuntimeService(opts?: LocalEndpointOptions): RuntimeService {
	singleton ??= new RuntimeService(new LocalRuntimeEndpoint(opts));
	return singleton;
}

export function resetRuntimeServiceForTests(): void {
	singleton = undefined;
}
```

- [ ] **Step 7: Run tests to verify they pass, plus type gate**

```bash
cd packages/coding-agent && bun test test/runtime-service.test.ts test/runtime-local-endpoint.test.ts
cd ../.. && bun run check:ts
```
Expected: PASS (all), exit 0.

- [ ] **Step 8: Commit**

```bash
git add packages/coding-agent/src/runtime packages/coding-agent/test/runtime-service.test.ts packages/coding-agent/test/runtime-local-endpoint.test.ts
git commit -m "feat: RuntimeService and per-call local endpoint over the runtime protocol"
```

---

### Task 9: Real-runtime integration test

**Files:**
- Test: `packages/coding-agent/test/runtime-integration.test.ts`

**Interfaces:**
- Consumes: `getOrCreateRuntimeService` semantics via a fresh `RuntimeService(new LocalRuntimeEndpoint(...))` (do NOT use the singleton in tests).

- [ ] **Step 1: Write the integration test (auto-skips without a real runtime)**

Create `packages/coding-agent/test/runtime-integration.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { LocalRuntimeEndpoint } from "../src/runtime/transport/local";
import { RuntimeService } from "../src/runtime/service";

const realBin = process.env.AURA_RUNTIME_BIN ?? process.env.ELIDE_BIN ?? Bun.which("elide") ?? undefined;

describe.skipIf(!realBin)("runtime integration (real binary)", () => {
	const svc = new RuntimeService(new LocalRuntimeEndpoint({ explicitPath: realBin, autoDownload: false }));

	test("status reports an available runtime >= 1.4", async () => {
		const s = await svc.status();
		expect(s.available).toBe(true);
		expect(s.version).toMatch(/^1\.[4-9]|^[2-9]/);
	});

	test("runs inline TypeScript", async () => {
		const r = await svc.run({ code: 'console.log("aura" + ":" + (40 + 2))', language: "ts", timeoutMs: 120_000 });
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("aura:42");
	}, 180_000);

	test("runs inline Python (GraalPy)", async () => {
		const r = await svc.run({ code: 'print("py:" + str(21 * 2))', language: "python", timeoutMs: 120_000 });
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("py:42");
	}, 180_000);

	test("nonzero exit is reported, not thrown", async () => {
		const r = await svc.run({ code: "process.exit(3)", language: "js", timeoutMs: 120_000 });
		expect(r.exitCode).toBe(3);
	}, 180_000);
});
```

- [ ] **Step 2: Run with a real runtime available**

```bash
cd packages/coding-agent && AURA_RUNTIME_BIN=$(command -v elide || echo ~/workspace/labs/BUCKSHOT/node_modules/.bin/elide) bun test test/runtime-integration.test.ts
```
Expected: PASS (4 tests). Also run WITHOUT the env on a PATH-less shell to confirm it skips cleanly.

- [ ] **Step 3: Commit**

```bash
git add packages/coding-agent/test/runtime-integration.test.ts
git commit -m "test: real-runtime integration coverage for run/status"
```

---

### Task 10: Settings schema (`runtime.*`)

**Files:**
- Modify: `packages/coding-agent/src/config/settings-schema.ts` (add three keys near the other feature groups, e.g. after `"advisor.enabled"` at `:429`)
- Test: `packages/coding-agent/test/runtime-settings.test.ts`

**Interfaces:**
- Produces: `settings.get("runtime.enabled"): boolean` (default `true`), `settings.get("runtime.autoDownload"): boolean` (default `true`), `settings.get("runtime.path"): string` (default `""`).
- Deliberate deviation from the spec: no `runtime.version` setting in v1 — the version is pinned in `dist.ts` and bumped in lockstep with the sha256s; a user-facing version override becomes meaningful only once multiple managed versions exist.

- [ ] **Step 1: Write the failing test**

First check how existing tests construct a settings object: `grep -rln "settings.get\|SettingsManager\|loadSettings" packages/coding-agent/test | head -5` and mirror that construction. The assertion body:
```ts
import { describe, expect, test } from "bun:test";
// import the same settings constructor used by an existing settings test found above

describe("runtime settings", () => {
	test("defaults: enabled + autoDownload on, no explicit path", () => {
		// settings = <same construction as the existing settings test, defaults only>
		expect(settings.get("runtime.enabled")).toBe(true);
		expect(settings.get("runtime.autoDownload")).toBe(true);
		expect(settings.get("runtime.path")).toBe("");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/coding-agent && bun test test/runtime-settings.test.ts
```
Expected: FAIL — unknown setting keys.

- [ ] **Step 3: Add the schema entries**

In `settings-schema.ts`, following the exact house shape of `"advisor.enabled"`:
```ts
	"runtime.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Runtime",
			label: "Enable runtime capabilities",
			description: "Innate run/check/build/insights/profile tools executed on the managed runtime.",
		},
	},
	"runtime.autoDownload": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Runtime",
			label: "Auto-download the runtime",
			description: "Fetch the pinned runtime into the config dir on first use when no binary is found.",
		},
	},
	"runtime.path": {
		type: "string",
		default: "",
		ui: {
			tab: "tools",
			group: "Runtime",
			label: "Runtime binary path",
			description: "Explicit runtime binary; overrides discovery and disables auto-download.",
		},
	},
```
Verify the `ui.tab` value: `grep -n 'tab: "' packages/coding-agent/src/config/settings-schema.ts | sort -u` and pick the tab used by tool-ish settings.

- [ ] **Step 4: Run tests + type gate, record in FORK.md, commit**

```bash
cd packages/coding-agent && bun test test/runtime-settings.test.ts && cd ../.. && bun run check:ts
```
Append to FORK.md: `| packages/coding-agent/src/config/settings-schema.ts | runtime.* settings (+ theme default from Task 4) |`
```bash
git add -A && git commit -m "feat: runtime.* settings"
```

---

### Task 11: ToolSession wiring (`getRuntimeService`)

**Files:**
- Modify: `packages/coding-agent/src/tools/index.ts` (ToolSession interface), `packages/coding-agent/src/sdk.ts` (~line 1658, beside `getMnemopiSessionState`)
- Test: covered by Task 12's tool tests (this task is interface plumbing; the type gate is its test)

**Interfaces:**
- Produces: `ToolSession.getRuntimeService?: () => RuntimeService | undefined` — returns the singleton when `runtime.enabled`, else `undefined`.

- [ ] **Step 1: Add the accessor to ToolSession**

In `packages/coding-agent/src/tools/index.ts`, inside the `ToolSession` interface (near `getMnemopiSessionState`), add:
```ts
	/** Aura runtime capability service (run/check/build/insights/profile); undefined when runtime.enabled is off. */
	getRuntimeService?: () => import("../runtime/service").RuntimeService | undefined;
```

- [ ] **Step 2: Wire it in sdk.ts**

At the wiring site (`sdk.ts` ~1658, next to `getMnemopiSessionState: () => session?.getMnemopiSessionState(),`), add — adapting to the identifiers actually in scope there (a `settings` accessor is available in that closure; confirm with the surrounding lines):
```ts
			getRuntimeService: () => {
				if (!settings.get("runtime.enabled")) return undefined;
				const explicit = settings.get("runtime.path").trim();
				return getOrCreateRuntimeService({
					explicitPath: explicit === "" ? undefined : explicit,
					autoDownload: settings.get("runtime.autoDownload"),
				});
			},
```
with the import at the top of `sdk.ts`:
```ts
import { getOrCreateRuntimeService } from "./runtime";
```
If the closure has no `settings` in scope, use whatever the adjacent wiring uses to reach settings (e.g. `session?.settings`) — mirror the neighbors exactly.

- [ ] **Step 3: Type gate**

```bash
bun run check:ts
```
Expected: exit 0.

- [ ] **Step 4: Record in FORK.md and commit**

Append rows for `tools/index.ts` (ToolSession accessor) and `sdk.ts` (service wiring).
```bash
git add -A && git commit -m "feat: expose RuntimeService through ToolSession"
```

---

### Task 12: The `run` tool

**Files:**
- Create: `packages/coding-agent/src/tools/runtime-run.ts`, `packages/coding-agent/src/prompts/tools/runtime-run.md`, `packages/coding-agent/src/runtime/format.ts`
- Test: `packages/coding-agent/test/runtime-run-tool.test.ts`

**Interfaces:**
- Consumes: `ToolSession.getRuntimeService` (Task 11), `RuntimeService.run` (Task 8).
- Produces: `class RuntimeRunTool implements AgentTool` with `name = "run"`, `loadMode = "essential"`, `approval = "exec"`, `static createIf(session)`; `formatExecResult(result: RuntimeExecResult): string` in `format.ts` (shared by Tasks 13–14).

- [ ] **Step 1: Write the failing test**

Create `packages/coding-agent/test/runtime-run-tool.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import type { RuntimeExecResult } from "../src/runtime/protocol";
import { formatExecResult } from "../src/runtime/format";
import { RuntimeRunTool } from "../src/tools/runtime-run";
import type { ToolSession } from "../src/tools";

function sessionWith(overrides: { enabled?: boolean; run?: (p: unknown) => Promise<RuntimeExecResult> }): ToolSession {
	const service = overrides.run ? { run: overrides.run } : undefined;
	return {
		settings: { get: (key: string) => (key === "runtime.enabled" ? (overrides.enabled ?? true) : undefined) },
		getRuntimeService: () => (overrides.enabled === false ? undefined : (service as never)),
	} as unknown as ToolSession;
}

describe("run tool", () => {
	test("createIf returns null when runtime.enabled is false", () => {
		expect(RuntimeRunTool.createIf(sessionWith({ enabled: false }))).toBeNull();
	});

	test("createIf constructs when enabled", () => {
		const tool = RuntimeRunTool.createIf(sessionWith({ enabled: true }));
		expect(tool?.name).toBe("run");
		expect(tool?.loadMode).toBe("essential");
		expect(tool?.approval).toBe("exec");
	});

	test("execute forwards params to the service and formats the result", async () => {
		let received: unknown;
		const tool = RuntimeRunTool.createIf(
			sessionWith({
				run: async p => {
					received = p;
					return { exitCode: 0, stdout: "hello\n", stderr: "", durationMs: 5, killed: false };
				},
			}),
		);
		const result = await tool?.execute("id1", { code: "console.log('hello')", language: "ts" } as never, new AbortController().signal, undefined as never);
		expect((received as { code: string }).code).toBe("console.log('hello')");
		const text = (result?.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("hello");
		expect(result?.details).toMatchObject({ exitCode: 0 });
	});

	test("nonzero exit is surfaced in the formatted output", () => {
		const text = formatExecResult({ exitCode: 2, stdout: "", stderr: "boom", durationMs: 3, killed: false });
		expect(text).toContain("exit code 2");
		expect(text).toContain("boom");
	});
});
```
Check `AgentTool.execute`'s exact signature in `@oh-my-pi/pi-agent-core` before finalizing (memory-edit uses `execute(_id, params)`; extra positional args like `signal`/`onUpdate` follow the interface — mirror `tools/bash.ts`'s signature).

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/coding-agent && bun test test/runtime-run-tool.test.ts
```
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `format.ts`**

Create `packages/coding-agent/src/runtime/format.ts`:
```ts
import type { RuntimeExecResult } from "./protocol";

const MAX_OUTPUT_CHARS = 60_000;

function cap(text: string): string {
	if (text.length <= MAX_OUTPUT_CHARS) return text;
	return `${text.slice(0, MAX_OUTPUT_CHARS)}\n… output truncated (${text.length} chars total)`;
}

/** Render an exec result for the model: stdout, stderr, and an exit annotation. */
export function formatExecResult(result: RuntimeExecResult): string {
	const parts: string[] = [];
	const stdout = result.stdout.replace(/\n+$/, "");
	const stderr = result.stderr.replace(/\n+$/, "");
	if (stdout) parts.push(cap(stdout));
	if (stderr) parts.push(`--- stderr ---\n${cap(stderr)}`);
	if (result.killed) parts.push("(process was killed: timeout or cancellation)");
	if (result.exitCode !== 0) parts.push(`(exit code ${result.exitCode})`);
	if (parts.length === 0) parts.push(`(no output, exit code ${result.exitCode})`);
	return parts.join("\n");
}
```

- [ ] **Step 4: Write the tool prompt**

Create `packages/coding-agent/src/prompts/tools/runtime-run.md`:
```markdown
Execute code on the managed polyglot runtime (JavaScript, TypeScript, Python).

Use this for direct code execution instead of `bash` (which is for shell
commands) or `eval` (the notebook-style kernel). Provide either `code`
(inline source; runs from a temp file) or `path` (an existing file — this
preserves the project working directory and imports). Python runs on a
CPython-compatible engine (3.12).

Inputs: `code` XOR `path`; `language` (js | ts | python; default ts for
inline code, inferred from the extension for files); optional `args`,
`stdin`, `timeoutMs`, `cwd`.

The result reports stdout, stderr, and the exit code. A missing runtime
returns installation guidance rather than failing.
```

- [ ] **Step 5: Implement the tool**

Create `packages/coding-agent/src/tools/runtime-run.ts`:
```ts
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import runtimeRunDescription from "../prompts/tools/runtime-run.md" with { type: "text" };
import { formatExecResult } from "../runtime/format";
import type { ToolSession } from ".";

const runtimeRunSchema = type({
	"code?": type("string").describe("inline source to execute (mutually exclusive with path)"),
	"path?": type("string").describe("existing file to run; preserves project cwd/imports"),
	"language?": type("'js' | 'ts' | 'python'").describe("language for inline code (default ts)"),
	"args?": type("string[]").describe("arguments passed to the program"),
	"stdin?": type("string").describe("data piped to the program's stdin"),
	"timeoutMs?": type("number").describe("kill the run after this many milliseconds"),
	"cwd?": type("string").describe("working directory (defaults to the session cwd)"),
});

export type RuntimeRunParams = typeof runtimeRunSchema.infer;

export class RuntimeRunTool implements AgentTool<typeof runtimeRunSchema> {
	readonly name = "run";
	readonly approval = "exec" as const;
	readonly label = "Run";
	readonly description = runtimeRunDescription;
	readonly parameters = runtimeRunSchema;
	readonly strict = true;
	readonly loadMode = "essential";
	readonly summary = "Execute js/ts/python on the managed runtime";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): RuntimeRunTool | null {
		if (!session.settings.get("runtime.enabled")) return null;
		return new RuntimeRunTool(session);
	}

	async execute(_id: string, params: RuntimeRunParams, signal?: AbortSignal): Promise<AgentToolResult> {
		const service = this.session.getRuntimeService?.();
		if (!service) throw new Error("Runtime capabilities are disabled (runtime.enabled = false).");
		const result = await service.run({ ...params, cwd: params.cwd ?? this.session.cwd }, signal);
		return {
			content: [{ type: "text", text: formatExecResult(result) }],
			details: result,
		};
	}
}
```
Adapt the `execute` signature to match `AgentTool` exactly (see `tools/bash.ts`); adapt `session.cwd` access if the field is named differently on `ToolSession`.

- [ ] **Step 6: Run tests + type gate**

```bash
cd packages/coding-agent && bun test test/runtime-run-tool.test.ts && cd ../.. && bun run check:ts
```
Expected: PASS / exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/coding-agent/src/tools/runtime-run.ts packages/coding-agent/src/prompts/tools/runtime-run.md packages/coding-agent/src/runtime/format.ts packages/coding-agent/test/runtime-run-tool.test.ts
git commit -m "feat: innate run tool on the managed runtime"
```

---

### Task 13: The `check` and `build` tools

**Files:**
- Create: `packages/coding-agent/src/tools/runtime-check.ts`, `packages/coding-agent/src/tools/runtime-build.ts`, `packages/coding-agent/src/prompts/tools/runtime-check.md`, `packages/coding-agent/src/prompts/tools/runtime-build.md`
- Test: `packages/coding-agent/test/runtime-check-build-tools.test.ts`

**Interfaces:**
- Consumes: `RuntimeService.check`/`.build`, `formatExecResult` (Task 12 pattern).
- Produces: `RuntimeCheckTool` (`name = "check"`) and `RuntimeBuildTool` (`name = "build"`), both `loadMode = "essential"`, `approval = "exec"`, `static createIf`.

- [ ] **Step 1: Write the failing test**

Create `packages/coding-agent/test/runtime-check-build-tools.test.ts` (same `sessionWith` helper shape as Task 12, with `check`/`build` service stubs):
```ts
import { describe, expect, test } from "bun:test";
import type { RuntimeExecResult } from "../src/runtime/protocol";
import { RuntimeBuildTool } from "../src/tools/runtime-build";
import { RuntimeCheckTool } from "../src/tools/runtime-check";
import type { ToolSession } from "../src/tools";

const OK: RuntimeExecResult = { exitCode: 0, stdout: "Build successful", stderr: "", durationMs: 10, killed: false };

function sessionWith(service: object | undefined, enabled = true): ToolSession {
	return {
		settings: { get: (key: string) => (key === "runtime.enabled" ? enabled : undefined) },
		getRuntimeService: () => service as never,
	} as unknown as ToolSession;
}

describe("check/build tools", () => {
	test("createIf gates on runtime.enabled", () => {
		expect(RuntimeCheckTool.createIf(sessionWith(undefined, false))).toBeNull();
		expect(RuntimeBuildTool.createIf(sessionWith(undefined, false))).toBeNull();
		expect(RuntimeCheckTool.createIf(sessionWith({}))?.name).toBe("check");
		expect(RuntimeBuildTool.createIf(sessionWith({}))?.name).toBe("build");
	});

	test("check calls service.check with no targets", async () => {
		let received: unknown;
		const tool = RuntimeCheckTool.createIf(sessionWith({ check: async (p: unknown) => ((received = p), OK) }));
		const r = await tool?.execute("id", {} as never, new AbortController().signal, undefined as never);
		expect(received).toMatchObject({});
		expect((r?.content[0] as { text: string }).text).toContain("Build successful");
	});

	test("build passes targets through", async () => {
		let received: unknown;
		const tool = RuntimeBuildTool.createIf(sessionWith({ build: async (p: unknown) => ((received = p), OK) }));
		await tool?.execute("id", { targets: [":deps", "--fresh"] } as never, new AbortController().signal, undefined as never);
		expect(received).toMatchObject({ targets: [":deps", "--fresh"] });
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/coding-agent && bun test test/runtime-check-build-tools.test.ts
```
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the prompts**

`packages/coding-agent/src/prompts/tools/runtime-check.md`:
```markdown
Validate the current project on the managed runtime: resolve dependencies
and compile every source set without producing artifacts or executing user
code. Use this as a fast "does the project still hold together" gate after
edits. Optional `cwd` selects the project directory; `timeoutMs` bounds the
validation.
```

`packages/coding-agent/src/prompts/tools/runtime-build.md`:
```markdown
Assemble project artifacts on the managed runtime's build system. `targets`
takes ':'-prefixed build targets with interleaved per-target options, passed
through verbatim (e.g. [":deps", "--fresh", ":compile"]); omit it to run the
default build. Optional `cwd` and `timeoutMs` as in `check`. Use `check` for
validation-only runs; use this when artifacts are the goal.
```

- [ ] **Step 4: Implement both tools**

`packages/coding-agent/src/tools/runtime-check.ts`:
```ts
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import runtimeCheckDescription from "../prompts/tools/runtime-check.md" with { type: "text" };
import { formatExecResult } from "../runtime/format";
import type { ToolSession } from ".";

const runtimeCheckSchema = type({
	"cwd?": type("string").describe("project directory (defaults to the session cwd)"),
	"timeoutMs?": type("number").describe("kill the validation after this many milliseconds"),
});

export type RuntimeCheckParams = typeof runtimeCheckSchema.infer;

export class RuntimeCheckTool implements AgentTool<typeof runtimeCheckSchema> {
	readonly name = "check";
	readonly approval = "exec" as const;
	readonly label = "Check";
	readonly description = runtimeCheckDescription;
	readonly parameters = runtimeCheckSchema;
	readonly strict = true;
	readonly loadMode = "essential";
	readonly summary = "Validate the project: resolve deps and compile without artifacts";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): RuntimeCheckTool | null {
		if (!session.settings.get("runtime.enabled")) return null;
		return new RuntimeCheckTool(session);
	}

	async execute(_id: string, params: RuntimeCheckParams, signal?: AbortSignal): Promise<AgentToolResult> {
		const service = this.session.getRuntimeService?.();
		if (!service) throw new Error("Runtime capabilities are disabled (runtime.enabled = false).");
		const result = await service.check({ ...params, cwd: params.cwd ?? this.session.cwd }, signal);
		return { content: [{ type: "text", text: formatExecResult(result) }], details: result };
	}
}
```

`packages/coding-agent/src/tools/runtime-build.ts`:
```ts
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import runtimeBuildDescription from "../prompts/tools/runtime-build.md" with { type: "text" };
import { formatExecResult } from "../runtime/format";
import type { ToolSession } from ".";

const runtimeBuildSchema = type({
	"targets?": type("string[]").describe("':'-prefixed build targets with interleaved options, passed through verbatim"),
	"cwd?": type("string").describe("project directory (defaults to the session cwd)"),
	"timeoutMs?": type("number").describe("kill the build after this many milliseconds"),
});

export type RuntimeBuildParams = typeof runtimeBuildSchema.infer;

export class RuntimeBuildTool implements AgentTool<typeof runtimeBuildSchema> {
	readonly name = "build";
	readonly approval = "exec" as const;
	readonly label = "Build";
	readonly description = runtimeBuildDescription;
	readonly parameters = runtimeBuildSchema;
	readonly strict = true;
	readonly loadMode = "essential";
	readonly summary = "Assemble project artifacts on the managed runtime";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): RuntimeBuildTool | null {
		if (!session.settings.get("runtime.enabled")) return null;
		return new RuntimeBuildTool(session);
	}

	async execute(_id: string, params: RuntimeBuildParams, signal?: AbortSignal): Promise<AgentToolResult> {
		const service = this.session.getRuntimeService?.();
		if (!service) throw new Error("Runtime capabilities are disabled (runtime.enabled = false).");
		const result = await service.build({ ...params, cwd: params.cwd ?? this.session.cwd }, signal);
		return { content: [{ type: "text", text: formatExecResult(result) }], details: result };
	}
}
```

- [ ] **Step 5: Run tests + type gate, commit**

```bash
cd packages/coding-agent && bun test test/runtime-check-build-tools.test.ts && cd ../.. && bun run check:ts
git add -A && git commit -m "feat: innate check and build tools"
```

---

### Task 14: The `insights` and `profile` tools

**Files:**
- Create: `packages/coding-agent/src/tools/runtime-insights.ts`, `packages/coding-agent/src/tools/runtime-profile.ts`, `packages/coding-agent/src/prompts/tools/runtime-insights.md`, `packages/coding-agent/src/prompts/tools/runtime-profile.md`
- Test: `packages/coding-agent/test/runtime-insights-profile-tools.test.ts`

**Interfaces:**
- Consumes: `RuntimeService.insights`/`.profile`, `formatExecResult`.
- Produces: `RuntimeInsightsTool` (`name = "insights"`) and `RuntimeProfileTool` (`name = "profile"`), both `loadMode = "discoverable"`, `approval = "exec"`, `static createIf`.

- [ ] **Step 1: Write the failing test**

Create `packages/coding-agent/test/runtime-insights-profile-tools.test.ts` (same shape as Task 13's test):
```ts
import { describe, expect, test } from "bun:test";
import type { RuntimeExecResult } from "../src/runtime/protocol";
import { RuntimeInsightsTool } from "../src/tools/runtime-insights";
import { RuntimeProfileTool } from "../src/tools/runtime-profile";
import type { ToolSession } from "../src/tools";

const OK: RuntimeExecResult = { exitCode: 0, stdout: "report", stderr: "", durationMs: 10, killed: false };

function sessionWith(service: object | undefined, enabled = true): ToolSession {
	return {
		settings: { get: (key: string) => (key === "runtime.enabled" ? enabled : undefined) },
		getRuntimeService: () => service as never,
	} as unknown as ToolSession;
}

describe("insights/profile tools", () => {
	test("both are discoverable and gated", () => {
		expect(RuntimeInsightsTool.createIf(sessionWith(undefined, false))).toBeNull();
		expect(RuntimeProfileTool.createIf(sessionWith(undefined, false))).toBeNull();
		const i = RuntimeInsightsTool.createIf(sessionWith({}));
		const p = RuntimeProfileTool.createIf(sessionWith({}));
		expect(i?.name).toBe("insights");
		expect(i?.loadMode).toBe("discoverable");
		expect(p?.name).toBe("profile");
		expect(p?.loadMode).toBe("discoverable");
	});

	test("insights forwards insight script params", async () => {
		let received: unknown;
		const tool = RuntimeInsightsTool.createIf(sessionWith({ insights: async (x: unknown) => ((received = x), OK) }));
		await tool?.execute("id", { code: "1", insight: "hook()" } as never, new AbortController().signal, undefined as never);
		expect(received).toMatchObject({ code: "1", insight: "hook()" });
	});

	test("profile requires a mode and forwards it", async () => {
		let received: unknown;
		const tool = RuntimeProfileTool.createIf(sessionWith({ profile: async (x: unknown) => ((received = x), OK) }));
		await tool?.execute("id", { code: "1", mode: "cputracing" } as never, new AbortController().signal, undefined as never);
		expect(received).toMatchObject({ mode: "cputracing" });
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/coding-agent && bun test test/runtime-insights-profile-tools.test.ts
```
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the prompts**

`packages/coding-agent/src/prompts/tools/runtime-insights.md`:
```markdown
Run code on the managed runtime with an Insights instrumentation script
attached. The insight script (JavaScript) hooks program events — source
load, function enter/return — and its observations are emitted alongside
program output. Provide the program as `code` or `path` (as in `run`) and
the instrumentation as `insight` (inline JS) or `insightPath`. One-shot
runs do not emit close events. Same optional controls as `run`
(`language`, `args`, `stdin`, `timeoutMs`, `cwd`).
```

`packages/coding-agent/src/prompts/tools/runtime-profile.md`:
```markdown
Profile a program on the managed runtime. `mode` selects the profiler:
`cputracing` (exact call tracing) or `cpusampling` (statistical sampling —
lower overhead, prefer it for longer runs). Provide the program as `code`
or `path` (as in `run`); the profiler report is returned as text. Same
optional controls as `run` (`language`, `args`, `stdin`, `timeoutMs`,
`cwd`).
```

- [ ] **Step 4: Implement both tools**

`packages/coding-agent/src/tools/runtime-insights.ts` — identical structure to `runtime-run.ts` with these differences: class `RuntimeInsightsTool`, `name = "insights"`, `label = "Insights"`, `loadMode = "discoverable"`, `summary = "Run code with instrumentation hooks attached"`, schema =
```ts
const runtimeInsightsSchema = type({
	"code?": type("string").describe("inline program source (mutually exclusive with path)"),
	"path?": type("string").describe("existing program file"),
	"insight?": type("string").describe("inline insight instrumentation script (JavaScript)"),
	"insightPath?": type("string").describe("existing insight script path"),
	"language?": type("'js' | 'ts' | 'python'").describe("program language (default ts for inline code)"),
	"args?": type("string[]").describe("arguments passed to the program"),
	"stdin?": type("string").describe("data piped to stdin"),
	"timeoutMs?": type("number").describe("kill the run after this many milliseconds"),
	"cwd?": type("string").describe("working directory (defaults to the session cwd)"),
});
```
and `execute` calls `service.insights({ ...params, cwd: params.cwd ?? this.session.cwd }, signal)`.

`packages/coding-agent/src/tools/runtime-profile.ts` — same structure: class `RuntimeProfileTool`, `name = "profile"`, `label = "Profile"`, `loadMode = "discoverable"`, `summary = "Profile a program (cpu tracing or sampling)"`, schema =
```ts
const runtimeProfileSchema = type({
	mode: type("'cputracing' | 'cpusampling'").describe("profiler mode"),
	"code?": type("string").describe("inline program source (mutually exclusive with path)"),
	"path?": type("string").describe("existing program file"),
	"language?": type("'js' | 'ts' | 'python'").describe("program language (default ts for inline code)"),
	"args?": type("string[]").describe("arguments passed to the program"),
	"stdin?": type("string").describe("data piped to stdin"),
	"timeoutMs?": type("number").describe("kill the run after this many milliseconds"),
	"cwd?": type("string").describe("working directory (defaults to the session cwd)"),
});
```
and `execute` calls `service.profile(...)`.

- [ ] **Step 5: Run tests + type gate, commit**

```bash
cd packages/coding-agent && bun test test/runtime-insights-profile-tools.test.ts && cd ../.. && bun run check:ts
git add -A && git commit -m "feat: innate insights and profile tools"
```

---

### Task 15: Registry wiring (builtin names, factories, essential set)

**Files:**
- Modify: `packages/coding-agent/src/tools/builtin-names.ts:1-30`, `packages/coding-agent/src/tools/index.ts` (BUILTIN_TOOLS + imports), `packages/coding-agent/src/tools/essential-tools.ts:23-35`
- Test: `packages/coding-agent/test/runtime-tool-registry.test.ts`

**Interfaces:**
- Consumes: all five tool classes (Tasks 12–14).
- Produces: `"run" | "check" | "build" | "insights" | "profile"` as `BuiltinToolName`s constructible via `BUILTIN_TOOLS`, with `run`/`check`/`build` in `ESSENTIAL_BUILTIN_TOOL_NAMES`.

- [ ] **Step 1: Write the failing test**

Create `packages/coding-agent/test/runtime-tool-registry.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { BUILTIN_TOOL_NAMES } from "../src/tools/builtin-names";
import { ESSENTIAL_BUILTIN_TOOL_NAMES } from "../src/tools/essential-tools";
import { BUILTIN_TOOLS } from "../src/tools";
import type { ToolSession } from "../src/tools";

const RUNTIME_TOOLS = ["run", "check", "build", "insights", "profile"] as const;

function stubSession(enabled: boolean): ToolSession {
	return {
		settings: { get: (key: string) => (key === "runtime.enabled" ? enabled : undefined) },
		getRuntimeService: () => undefined,
	} as unknown as ToolSession;
}

describe("runtime tool registry", () => {
	test("all five runtime tools are builtin names", () => {
		for (const name of RUNTIME_TOOLS) expect(BUILTIN_TOOL_NAMES).toContain(name);
	});

	test("run/check/build are essential; insights/profile are not", () => {
		expect(ESSENTIAL_BUILTIN_TOOL_NAMES.run).toBe(true);
		expect(ESSENTIAL_BUILTIN_TOOL_NAMES.check).toBe(true);
		expect(ESSENTIAL_BUILTIN_TOOL_NAMES.build).toBe(true);
		expect("insights" in ESSENTIAL_BUILTIN_TOOL_NAMES).toBe(false);
		expect("profile" in ESSENTIAL_BUILTIN_TOOL_NAMES).toBe(false);
	});

	test("factories gate on runtime.enabled", async () => {
		for (const name of RUNTIME_TOOLS) {
			expect(await BUILTIN_TOOLS[name](stubSession(false))).toBeNull();
			expect(await BUILTIN_TOOLS[name](stubSession(true))).not.toBeNull();
		}
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/coding-agent && bun test test/runtime-tool-registry.test.ts
```
Expected: FAIL — names not in `BUILTIN_TOOL_NAMES`.

- [ ] **Step 3: Wire the registry**

1. `builtin-names.ts`: append `"run", "check", "build", "insights", "profile",` to `BUILTIN_TOOL_NAMES`.
2. `tools/index.ts`: import the five classes and add to `BUILTIN_TOOLS`:
```ts
	run: RuntimeRunTool.createIf,
	check: RuntimeCheckTool.createIf,
	build: RuntimeBuildTool.createIf,
	insights: RuntimeInsightsTool.createIf,
	profile: RuntimeProfileTool.createIf,
```
3. `essential-tools.ts`: add `run: true, check: true, build: true,` to `ESSENTIAL_BUILTIN_TOOL_NAMES`.

- [ ] **Step 4: Run the new test AND the upstream drift/registry guards**

```bash
cd packages/coding-agent && bun test test/runtime-tool-registry.test.ts test/essential-tools.test.ts
bun test test/ 2>&1 | tail -20
```
Expected: the two named files PASS. The broader `test/` sweep surfaces upstream tests that snapshot the tool list (schema counts, tool-name lists) — update any such expectations to include the five new names. Fix forward until the sweep is green (or matches the pre-existing failure set from Task 1's baseline, if any).

- [ ] **Step 5: Type gate, FORK.md, commit**

```bash
cd ../.. && bun run check:ts
```
Append FORK.md rows for `builtin-names.ts`, `tools/index.ts`, `essential-tools.ts`.
```bash
git add -A && git commit -m "feat: register runtime tools as built-ins (run/check/build essential)"
```

---

### Task 16: `aura runtime status` CLI command

**Files:**
- Create: `packages/coding-agent/src/cli/runtime-cli.ts`, `packages/coding-agent/src/commands/runtime.ts`
- Modify: `packages/coding-agent/src/cli-commands.ts:14-40` (add the entry)
- Test: `packages/coding-agent/test/runtime-cli.test.ts`

**Interfaces:**
- Consumes: `RuntimeService.status()` (Task 8), `RuntimeStatusResult` (Task 5).
- Produces: `runRuntimeCommand(cmd: RuntimeCommandArgs, service?: Pick<RuntimeService, "status">): Promise<number>` (exit code; prints to stdout), `interface RuntimeCommandArgs { action: "status"; flags: { json?: boolean } }`; CLI command `runtime` registered in `cli-commands.ts`.

- [ ] **Step 1: Write the failing test**

Create `packages/coding-agent/test/runtime-cli.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { formatRuntimeStatus, runRuntimeCommand } from "../src/cli/runtime-cli";

describe("aura runtime status", () => {
	test("available runtime renders version, path, source and exits 0", async () => {
		const lines: string[] = [];
		const code = await runRuntimeCommand(
			{ action: "status", flags: {} },
			{ status: async () => ({ available: true, version: "1.4.1", binaryPath: "/x/bin/elide", source: "managed", protocolVersion: 1 }) },
			line => lines.push(line),
		);
		expect(code).toBe(0);
		const out = lines.join("\n");
		expect(out).toContain("available");
		expect(out).toContain("1.4.1");
		expect(out).toContain("managed");
	});

	test("missing runtime prints guidance and exits 1", async () => {
		const lines: string[] = [];
		const code = await runRuntimeCommand(
			{ action: "status", flags: {} },
			{ status: async () => ({ available: false, guidance: "point AURA_RUNTIME_BIN at a binary", protocolVersion: 1 }) },
			line => lines.push(line),
		);
		expect(code).toBe(1);
		expect(lines.join("\n")).toContain("AURA_RUNTIME_BIN");
	});

	test("--json emits machine-readable status", async () => {
		const lines: string[] = [];
		await runRuntimeCommand(
			{ action: "status", flags: { json: true } },
			{ status: async () => ({ available: true, version: "1.4.1", protocolVersion: 1 }) },
			line => lines.push(line),
		);
		const parsed = JSON.parse(lines.join("\n"));
		expect(parsed).toMatchObject({ available: true, version: "1.4.1", protocolVersion: 1 });
	});

	test("formatRuntimeStatus never mentions elide", () => {
		const text = formatRuntimeStatus({ available: false, guidance: "install the runtime", protocolVersion: 1 });
		expect(text.toLowerCase()).not.toContain("elide");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/coding-agent && bun test test/runtime-cli.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `cli/runtime-cli.ts`**

```ts
import type { RuntimeStatusResult } from "../runtime/protocol";
import type { RuntimeService } from "../runtime/service";
import { getOrCreateRuntimeService } from "../runtime";

export interface RuntimeCommandArgs {
	action: "status";
	flags: { json?: boolean };
}

export function formatRuntimeStatus(status: RuntimeStatusResult): string {
	if (!status.available) {
		return [`runtime: unavailable`, status.guidance ? `  ${status.guidance}` : undefined].filter(Boolean).join("\n");
	}
	return [
		`runtime: available`,
		`  version:  ${status.version ?? "unknown"}`,
		status.binaryPath ? `  binary:   ${status.binaryPath}` : undefined,
		status.source ? `  source:   ${status.source}` : undefined,
		`  protocol: v${status.protocolVersion}`,
	]
		.filter(Boolean)
		.join("\n");
}

export async function runRuntimeCommand(
	cmd: RuntimeCommandArgs,
	service: Pick<RuntimeService, "status"> = getOrCreateRuntimeService(),
	print: (line: string) => void = line => process.stdout.write(`${line}\n`),
): Promise<number> {
	const status = await service.status();
	if (cmd.flags.json) {
		print(JSON.stringify(status, null, 2));
	} else {
		print(formatRuntimeStatus(status));
	}
	return status.available ? 0 : 1;
}
```

- [ ] **Step 4: Implement `commands/runtime.ts` and register it**

`packages/coding-agent/src/commands/runtime.ts` (mirror `commands/config.ts`):
```ts
/**
 * Inspect the managed runtime powering the innate run/check/build/insights/profile tools.
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { runRuntimeCommand } from "../cli/runtime-cli";

export default class Runtime extends Command {
	static description = "Manage the innate code runtime";

	static args = {
		action: Args.string({
			description: "Runtime action",
			required: false,
			options: ["status"],
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Runtime);
		const action = (args.action ?? "status") as "status";
		const code = await runRuntimeCommand({ action, flags: { json: flags.json } });
		if (code !== 0) this.exit(code);
	}
}
```
In `cli-commands.ts`, add alphabetically near the other entries:
```ts
	{ name: "runtime", load: () => import("./commands/runtime").then(m => m.default) },
```

- [ ] **Step 5: Run tests, a live smoke, type gate**

```bash
cd packages/coding-agent && bun test test/runtime-cli.test.ts
bun src/cli.ts runtime status; echo "exit=$?"
cd ../.. && bun run check:ts
```
Expected: tests PASS; the live invocation prints either an available report (a runtime is on PATH/managed) or the guidance block with exit 1 — both are correct.

- [ ] **Step 6: FORK.md, commit**

Append: `| packages/coding-agent/src/cli-commands.ts | register runtime command |`
```bash
git add -A && git commit -m "feat: aura runtime status command"
```

---

### Task 17: Full-suite green + plan closeout

**Files:**
- Modify: `docs/aura/FORK.md` (final review), `AGENTS.md` (fork addendum)

- [ ] **Step 1: Run the full gates**

```bash
bun run check:ts
cd packages/coding-agent && bun test test/
cd ../utils && bun test
```
Expected: exit 0 / PASS, modulo only failures already present in Task 1's baseline (none expected). Fix anything the fork introduced.

- [ ] **Step 2: Run the integration suite against a real runtime one last time**

```bash
cd packages/coding-agent && AURA_RUNTIME_BIN=$(command -v elide || echo ~/workspace/labs/BUCKSHOT/node_modules/.bin/elide) bun test test/runtime-integration.test.ts
```
Expected: PASS.

- [ ] **Step 3: Add the fork addendum to AGENTS.md**

Append to `AGENTS.md`:
```markdown
## Aura fork conventions

This repo is aura — a fork of oh-my-pi. Read `docs/aura/FORK.md` before
editing any upstream file, and add a row there when you touch a new one.
Naming rule: Elide is never user-facing; the noun is "the runtime"
(tools run/check/build/insights/profile, settings `runtime.*`, CLI
`aura runtime status`). Specs live in `docs/superpowers/specs/`, plans in
`docs/superpowers/plans/`.
```

- [ ] **Step 4: Verify FORK.md is complete**

Cross-check `git diff --stat $(git merge-base upstream/main HEAD)..HEAD -- ':!docs' ':!packages/coding-agent/src/runtime' ':!packages/coding-agent/src/tools/runtime-*' ':!packages/coding-agent/src/prompts/tools/runtime-*' ':!packages/coding-agent/src/cli/runtime-cli.ts' ':!packages/coding-agent/src/commands/runtime.ts' ':!packages/coding-agent/test'` — every file it lists must have a FORK.md row.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "docs: fork conventions addendum and inventory closeout"
```
