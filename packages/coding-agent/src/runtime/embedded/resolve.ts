import * as path from "node:path";
import type { RuntimeEmbeddedSource } from "../protocol";
import { isRegularFile, managedVersionDir, type ResolvedRuntime } from "../resolve";

export interface ResolvedEmbeddedRuntimeLibrary {
	libraryPath: string;
	source: RuntimeEmbeddedSource;
}

export interface ResolveEmbeddedRuntimeLibraryOptions {
	/** `runtime.embeddedPath`; nonblank values are binding. */
	embeddedPath?: string;
	env?: NodeJS.ProcessEnv;
	/** Injectable managed-version root for hermetic tests. */
	managedVersionDirectory?: string;
	/** A binary already returned by the runtime binary resolver. This resolver never scans PATH itself. */
	resolvedRuntime?: ResolvedRuntime | null;
	platform?: NodeJS.Platform;
}

export function embeddedRuntimeLibraryName(platform: NodeJS.Platform = process.platform): string {
	switch (platform) {
		case "linux":
			return "libelide_embed.so";
		case "darwin":
			return "libelide_embed.dylib";
		case "win32":
			return "elide_embed.dll";
		default:
			throw new Error(`Unsupported embedded runtime platform: ${platform}`);
	}
}

/**
 * Resolve the embedded runtime library without provisioning or PATH lookup.
 * Configured setting/environment overrides are binding: a nonblank path that is
 * missing or not a regular file stops resolution instead of silently selecting
 * a different installation.
 */
export async function resolveEmbeddedRuntimeLibrary(
	options: ResolveEmbeddedRuntimeLibraryOptions = {},
): Promise<ResolvedEmbeddedRuntimeLibrary | null> {
	const settingPath = options.embeddedPath?.trim();
	if (settingPath) {
		return (await isRegularFile(settingPath)) ? { libraryPath: settingPath, source: "setting" } : null;
	}

	const envPath = (options.env ?? process.env).AURA_RUNTIME_EMBEDDED_LIB?.trim();
	if (envPath) {
		return (await isRegularFile(envPath)) ? { libraryPath: envPath, source: "env" } : null;
	}

	const libraryName = embeddedRuntimeLibraryName(options.platform);
	const managedLibrary = path.join(options.managedVersionDirectory ?? managedVersionDir(), "lib", libraryName);
	if (await isRegularFile(managedLibrary)) return { libraryPath: managedLibrary, source: "managed" };

	const binaryPath = options.resolvedRuntime?.binaryPath;
	if (!binaryPath || binaryPath.trim() === "" || !(await isRegularFile(binaryPath))) return null;
	const adjacentLibrary = path.resolve(path.dirname(binaryPath), "..", "lib", libraryName);
	return (await isRegularFile(adjacentLibrary)) ? { libraryPath: adjacentLibrary, source: "binary-adjacent" } : null;
}
