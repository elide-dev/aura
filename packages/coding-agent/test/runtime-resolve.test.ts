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

	test("a set-but-dead AURA_RUNTIME_BIN is an error, not a fallthrough to ELIDE_BIN", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aura-rt-"));
		tmpDirs.push(dir);
		const b = await makeFakeBinary(dir, "b/elide");
		const r = await resolveRuntimeBinary({ env: { AURA_RUNTIME_BIN: "/nope/elide", ELIDE_BIN: b } });
		expect(r).toBeNull();
	});

	test("a set-but-dead ELIDE_BIN stops resolution rather than falling through", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aura-rt-"));
		tmpDirs.push(dir);
		const r = await resolveRuntimeBinary({ env: { ELIDE_BIN: path.join(dir, "gone/elide") } });
		expect(r).toBeNull();
	});

	test("an empty or unset env override is skipped normally", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aura-rt-"));
		tmpDirs.push(dir);
		const b = await makeFakeBinary(dir, "b/elide");
		expect(await resolveRuntimeBinary({ env: { AURA_RUNTIME_BIN: "", ELIDE_BIN: b } })).toEqual({
			binaryPath: b,
			source: "env",
		});
		expect(await resolveRuntimeBinary({ env: { ELIDE_BIN: b } })).toEqual({ binaryPath: b, source: "env" });
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
