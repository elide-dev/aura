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
	// A set env override is as binding as an explicit path: pointing it at a missing
	// file is a misconfiguration to surface, not a reason to quietly run some other
	// binary the user did not ask for. Unset (or empty) overrides skip normally.
	for (const key of ["AURA_RUNTIME_BIN", "ELIDE_BIN"] as const) {
		const p = env[key];
		if (!p) continue;
		if (await isFile(p)) return { binaryPath: p, source: "env" };
		return null;
	}
	const managed = await findBinaryInTree(managedVersionDir());
	if (managed) return { binaryPath: managed, source: "managed" };
	if (!opts.disablePathLookup) {
		const onPath = Bun.which("elide");
		if (onPath) return { binaryPath: onPath, source: "path" };
	}
	return null;
}
