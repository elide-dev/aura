import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { embeddedRuntimeLibraryName, resolveEmbeddedRuntimeLibrary } from "../src/runtime/embedded/resolve";
import type { ResolvedRuntime } from "../src/runtime/resolve";

async function makeFile(root: string, relativePath: string): Promise<string> {
	const filePath = path.join(root, relativePath);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, "runtime library");
	return filePath;
}

describe("embedded runtime library resolution", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
	});

	async function makeLayout(): Promise<{
		root: string;
		managedVersionDirectory: string;
		managedLibrary: string;
		binary: ResolvedRuntime;
		adjacentLibrary: string;
	}> {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "aura-embedded-resolve-"));
		tempDirs.push(root);
		const managedVersionDirectory = path.join(root, "managed", "1.0.0");
		const managedLibrary = await makeFile(managedVersionDirectory, "lib/libelide_embed.so");
		const binaryPath = await makeFile(root, "standalone/bin/elide");
		const adjacentLibrary = await makeFile(root, "standalone/lib/libelide_embed.so");
		return {
			root,
			managedVersionDirectory,
			managedLibrary,
			binary: { binaryPath, source: "managed" },
			adjacentLibrary,
		};
	}

	test("maps every supported platform to its distribution filename", () => {
		expect(embeddedRuntimeLibraryName("linux")).toBe("libelide_embed.so");
		expect(embeddedRuntimeLibraryName("darwin")).toBe("libelide_embed.dylib");
		expect(embeddedRuntimeLibraryName("win32")).toBe("elide_embed.dll");
		expect(() => embeddedRuntimeLibraryName("freebsd")).toThrow("Unsupported embedded runtime platform: freebsd");
	});

	test("a nonblank setting wins over env, managed, and binary-adjacent candidates", async () => {
		const layout = await makeLayout();
		const settingLibrary = await makeFile(layout.root, "setting/libelide_embed.so");
		const envLibrary = await makeFile(layout.root, "env/libelide_embed.so");
		expect(
			await resolveEmbeddedRuntimeLibrary({
				embeddedPath: `  ${settingLibrary}  `,
				env: { AURA_RUNTIME_EMBEDDED_LIB: envLibrary },
				managedVersionDirectory: layout.managedVersionDirectory,
				resolvedRuntime: layout.binary,
				platform: "linux",
			}),
		).toEqual({ libraryPath: settingLibrary, source: "setting" });
	});

	test("a nonblank env override wins over managed and binary-adjacent candidates", async () => {
		const layout = await makeLayout();
		const envLibrary = await makeFile(layout.root, "env/libelide_embed.so");
		expect(
			await resolveEmbeddedRuntimeLibrary({
				embeddedPath: "\t ",
				env: { AURA_RUNTIME_EMBEDDED_LIB: ` ${envLibrary}\n` },
				managedVersionDirectory: layout.managedVersionDirectory,
				resolvedRuntime: layout.binary,
				platform: "linux",
			}),
		).toEqual({ libraryPath: envLibrary, source: "env" });
	});

	test("whitespace-only setting and env values are absent, so the installed managed library wins", async () => {
		const layout = await makeLayout();
		expect(
			await resolveEmbeddedRuntimeLibrary({
				embeddedPath: " \n\t ",
				env: { AURA_RUNTIME_EMBEDDED_LIB: "\t" },
				managedVersionDirectory: layout.managedVersionDirectory,
				resolvedRuntime: layout.binary,
				platform: "linux",
			}),
		).toEqual({ libraryPath: layout.managedLibrary, source: "managed" });
	});

	test("falls back to the library adjacent to an explicitly resolved regular runtime binary", async () => {
		const layout = await makeLayout();
		await fs.rm(layout.managedLibrary);
		expect(
			await resolveEmbeddedRuntimeLibrary({
				env: {},
				managedVersionDirectory: layout.managedVersionDirectory,
				resolvedRuntime: layout.binary,
				platform: "linux",
			}),
		).toEqual({ libraryPath: layout.adjacentLibrary, source: "binary-adjacent" });
	});

	test("does not use a binary-adjacent library without a resolved regular binary", async () => {
		const layout = await makeLayout();
		await fs.rm(layout.managedLibrary);
		expect(
			await resolveEmbeddedRuntimeLibrary({
				env: {},
				managedVersionDirectory: layout.managedVersionDirectory,
				platform: "linux",
			}),
		).toBeNull();

		await fs.rm(layout.binary.binaryPath);
		expect(
			await resolveEmbeddedRuntimeLibrary({
				env: {},
				managedVersionDirectory: layout.managedVersionDirectory,
				resolvedRuntime: layout.binary,
				platform: "linux",
			}),
		).toBeNull();
	});

	test("a configured missing path is binding and does not fall through", async () => {
		const layout = await makeLayout();
		expect(
			await resolveEmbeddedRuntimeLibrary({
				embeddedPath: path.join(layout.root, "missing.so"),
				env: {},
				managedVersionDirectory: layout.managedVersionDirectory,
				resolvedRuntime: layout.binary,
				platform: "linux",
			}),
		).toBeNull();
		expect(
			await resolveEmbeddedRuntimeLibrary({
				env: { AURA_RUNTIME_EMBEDDED_LIB: path.join(layout.root, "missing-env.so") },
				managedVersionDirectory: layout.managedVersionDirectory,
				resolvedRuntime: layout.binary,
				platform: "linux",
			}),
		).toBeNull();
	});

	test("rejects directories at every library candidate layer", async () => {
		const layout = await makeLayout();
		const settingDirectory = path.join(layout.root, "setting-directory");
		await fs.mkdir(settingDirectory);
		expect(
			await resolveEmbeddedRuntimeLibrary({
				embeddedPath: settingDirectory,
				env: {},
				managedVersionDirectory: layout.managedVersionDirectory,
				resolvedRuntime: layout.binary,
				platform: "linux",
			}),
		).toBeNull();

		await fs.rm(layout.managedLibrary);
		await fs.mkdir(layout.managedLibrary);
		await fs.rm(layout.adjacentLibrary);
		await fs.mkdir(layout.adjacentLibrary);
		expect(
			await resolveEmbeddedRuntimeLibrary({
				env: {},
				managedVersionDirectory: layout.managedVersionDirectory,
				resolvedRuntime: layout.binary,
				platform: "linux",
			}),
		).toBeNull();
	});
});
