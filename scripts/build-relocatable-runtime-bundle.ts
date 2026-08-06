#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * A host the bundler can build for. The bundle embeds native WHIPLASH libraries and is smoke
 * tested by executing it, so the host and the target are always the same machine — there is no
 * cross-building here.
 */
export interface BundleTarget {
	/** Release-target id shared with `scripts/ci-release-build-binaries.ts`. */
	id: string;
	platform: NodeJS.Platform;
	arch: string;
	/** Shared-library suffix WHIPLASH emits for this host. */
	librarySuffix: string;
	bundleName: string;
	auraBinaryName: string;
}

const BUNDLE_TARGETS: readonly BundleTarget[] = [
	{
		id: "linux-x64",
		platform: "linux",
		arch: "x64",
		librarySuffix: ".so",
		bundleName: "aura-elide-linux-x64",
		auraBinaryName: "aura-linux-x64",
	},
	{
		id: "darwin-arm64",
		platform: "darwin",
		arch: "arm64",
		librarySuffix: ".dylib",
		bundleName: "aura-elide-darwin-arm64",
		auraBinaryName: "aura-darwin-arm64",
	},
];

export function hostBundleTarget(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): BundleTarget {
	const target = BUNDLE_TARGETS.find(candidate => candidate.platform === platform && candidate.arch === arch);
	if (!target) {
		const supported = BUNDLE_TARGETS.map(candidate => `${candidate.platform}/${candidate.arch}`).join(", ");
		throw new Error(`Relocatable embedded bundles support ${supported}; received ${platform}/${arch}.`);
	}
	return target;
}

/** The embedded facade the launcher points Aura at, and the engine it dlopens in turn. */
export function embeddedLibraryNames(target: BundleTarget): { facade: string; engine: string } {
	return {
		facade: `libelide_embed${target.librarySuffix}`,
		engine: `libelide_embed_engine${target.librarySuffix}`,
	};
}

export function requiredRuntimeArtifacts(target: BundleTarget): string[] {
	const libraries = embeddedLibraryNames(target);
	return [path.join("bin", "elide"), path.join("lib", libraries.facade), path.join("lib", libraries.engine)];
}

const BUNDLE_CONFIG = "runtime:\n  enabled: true\n  adapter: auto\n  autoDownload: false\n";

function bundleLauncher(target: BundleTarget): string {
	return `#!/bin/sh
set -eu

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

export AURA_RUNTIME_BIN="$ROOT/bin/elide"
export AURA_RUNTIME_EMBEDDED_LIB="$ROOT/lib/${embeddedLibraryNames(target).facade}"

if [ -n "\${PI_CONFIG_FILES:-}" ]; then
    export PI_CONFIG_FILES="$ROOT/etc/aura-bundle.yml:$PI_CONFIG_FILES"
else
    export PI_CONFIG_FILES="$ROOT/etc/aura-bundle.yml"
fi

exec "$ROOT/bin/aura.bin" "$@"
`;
}

interface BundleOptions {
	runtimeDist: string;
	outputDir: string;
	auraBinary?: string;
	skipSmoke: boolean;
	archive: boolean;
}

export function pinnedBunPackage(packageManager: unknown): string {
	if (typeof packageManager !== "string" || !/^bun@\d+\.\d+\.\d+(?:[-+].+)?$/.test(packageManager)) {
		throw new Error("Expected packageManager to pin Bun with an exact version.");
	}
	return packageManager;
}

export function pinnedBunVersion(packageManager: unknown): string {
	return pinnedBunPackage(packageManager).slice("bun@".length);
}

/**
 * `bunx bun@<version>` cannot provision a compiler: Bun is absent from Bun's default
 * trusted-dependency list, so the postinstall that swaps `bin/bun.exe` for the real
 * binary never runs and the leftover placeholder exits 1 without output. Installing
 * against a manifest that trusts `bun` explicitly is what makes the postinstall run.
 */
export function pinnedBunManifest(version: string): string {
	const manifest = {
		name: "aura-pinned-bun",
		version: "0.0.0",
		private: true,
		dependencies: { bun: version },
		trustedDependencies: ["bun"],
	};
	return `${JSON.stringify(manifest, null, 2)}\n`;
}

function pinnedBunCacheRoot(): string {
	const cacheHome = process.env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), ".cache");
	return path.join(cacheHome, "aura", "pinned-bun");
}

function usage(): string {
	return `Usage: bun scripts/build-relocatable-runtime-bundle.ts --runtime-dist <dir> [options]

Builds a bundle for the host platform (${BUNDLE_TARGETS.map(target => target.id).join(", ")}).

Options:
  --runtime-dist <dir>  Complete WHIPLASH distribution (or AURA_RUNTIME_DIST)
  --output-dir <dir>   Output parent directory (default: <repo>/out)
  --aura-binary <file> Reuse a prebuilt Aura binary instead of building one
  --skip-smoke         Skip executable/runtime probes (intended for contract tests)
  --no-archive         Keep the staged directory without creating tar.gz/checksum
  --help                Show this help
`;
}

function requireFlagValue(argv: string[], index: number, flag: string): string {
	const value = argv[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
	return value;
}

function parseOptions(argv: string[], cwd = process.cwd()): BundleOptions {
	let runtimeDist = process.env.AURA_RUNTIME_DIST?.trim() ?? "";
	let outputDir = path.join(path.dirname(import.meta.dir), "out");
	let auraBinary: string | undefined;
	let skipSmoke = false;
	let archive = true;

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		switch (argument) {
			case "--runtime-dist":
				runtimeDist = requireFlagValue(argv, index, argument);
				index += 1;
				break;
			case "--output-dir":
				outputDir = requireFlagValue(argv, index, argument);
				index += 1;
				break;
			case "--aura-binary":
				auraBinary = requireFlagValue(argv, index, argument);
				index += 1;
				break;
			case "--skip-smoke":
				skipSmoke = true;
				break;
			case "--no-archive":
				archive = false;
				break;
			case "--help":
				process.stdout.write(usage());
				return process.exit(0);
			default:
				throw new Error(`Unknown argument: ${argument}`);
		}
	}

	if (!runtimeDist) throw new Error("--runtime-dist or AURA_RUNTIME_DIST is required.");
	return {
		runtimeDist: path.resolve(cwd, runtimeDist),
		outputDir: path.resolve(cwd, outputDir),
		...(auraBinary ? { auraBinary: path.resolve(cwd, auraBinary) } : {}),
		skipSmoke,
		archive,
	};
}

async function isFile(file: string): Promise<boolean> {
	return (await fs.stat(file).catch(() => null))?.isFile() ?? false;
}

async function requireFile(file: string, displayPath: string, executable = false): Promise<void> {
	const stat = await fs.stat(file).catch(() => null);
	if (!stat) throw new Error(`Required artifact is missing: ${displayPath}`);
	if (!stat.isFile()) throw new Error(`Required artifact is not a file: ${displayPath}`);
	if (executable && (stat.mode & 0o111) === 0) throw new Error(`Required artifact is not executable: ${displayPath}`);
}

async function validateRuntimeDistribution(runtimeDist: string, target: BundleTarget): Promise<void> {
	for (const relativePath of requiredRuntimeArtifacts(target)) {
		await requireFile(path.join(runtimeDist, relativePath), relativePath, relativePath === path.join("bin", "elide"));
	}
}

async function runCommand(
	command: string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv; inherit?: boolean; description: string },
): Promise<string> {
	const inherit = options.inherit ?? false;
	const proc = Bun.spawn(command, {
		cwd: options.cwd,
		env: options.env ?? process.env,
		stdout: inherit ? "inherit" : "pipe",
		stderr: inherit ? "inherit" : "pipe",
	});
	if (inherit) {
		const exitCode = await proc.exited;
		if (exitCode !== 0) throw new Error(`${options.description} failed with exit code ${exitCode}.`);
		return "";
	}
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if (exitCode !== 0) {
		throw new Error(`${options.description} failed with exit code ${exitCode}.\n${stderr || stdout}`.trimEnd());
	}
	return stdout;
}

async function probeBunVersion(executable: string): Promise<string | null> {
	const stat = await fs.stat(executable).catch(() => null);
	if (!stat?.isFile() || (stat.mode & 0o111) === 0) return null;
	const reported = await runCommand([executable, "--version"], { description: "Pinned Bun version probe" }).catch(
		() => null,
	);
	return reported?.trim() ?? null;
}

/** Resolves an executable Bun matching the repository pin, installing it under `cacheRoot` if needed. */
export async function resolvePinnedBun(packageManager: string, cacheRoot: string): Promise<string> {
	const version = pinnedBunVersion(packageManager);
	if (Bun.version === version) return process.execPath;

	const installDir = path.join(cacheRoot, version);
	const executable = path.join(installDir, "node_modules", ".bin", "bun");
	if ((await probeBunVersion(executable)) === version) return executable;

	await fs.mkdir(installDir, { recursive: true });
	await Bun.write(path.join(installDir, "package.json"), pinnedBunManifest(version));
	await runCommand([process.execPath, "install"], {
		cwd: installDir,
		description: `Pinned Bun ${version} installation`,
	});
	const provisioned = await probeBunVersion(executable);
	if (provisioned !== version) {
		throw new Error(`Provisioning ${packageManager} produced ${provisioned ?? "no usable executable"}.`);
	}
	return executable;
}

export interface MachOLoadCommands {
	/** `LC_RPATH` entries, in load order — the search list `@rpath` expands against. */
	rpaths: string[];
	/** `LC_LOAD_DYLIB`-style dependencies, excluding the library's own `LC_ID_DYLIB` install name. */
	dependencies: string[];
}

const DYLIB_LOAD_COMMANDS = new Set(["LC_LOAD_DYLIB", "LC_LOAD_WEAK_DYLIB", "LC_REEXPORT_DYLIB"]);
/** Absolute dependencies below these live in the dyld shared cache, so no file backs them on disk. */
const DYLD_SHARED_CACHE_PREFIXES = ["/usr/lib/", "/System/"];

/** Parses `otool -l` output into the load commands that decide whether a dylib survives relocation. */
export function parseMachOLoadCommands(output: string): MachOLoadCommands {
	const rpaths: string[] = [];
	const dependencies: string[] = [];
	let command = "";
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		const commandMatch = /^cmd (LC_\w+)$/.exec(trimmed);
		if (commandMatch?.[1]) {
			command = commandMatch[1];
			continue;
		}
		// Both `name` and `path` carry a trailing `(offset N)` that is not part of the value.
		const valueMatch = /^(name|path) (.+) \(offset \d+\)$/.exec(trimmed);
		if (!valueMatch?.[2]) continue;
		if (valueMatch[1] === "path" && command === "LC_RPATH") rpaths.push(valueMatch[2]);
		if (valueMatch[1] === "name" && DYLIB_LOAD_COMMANDS.has(command)) dependencies.push(valueMatch[2]);
	}
	return { rpaths, dependencies };
}

export interface MachOLinkagePlan {
	/** Linkage that cannot survive relocation, regardless of what exists on this machine. */
	issues: string[];
	/** Bundle-internal dependencies; each must be satisfied by at least one candidate path. */
	dependencies: { name: string; candidates: string[] }[];
}

/**
 * Resolves a dylib's load commands against the bundle it was staged into. A relocatable bundle
 * only references `@rpath`/`@loader_path`/`@executable_path` and the dyld shared cache; anything
 * pointing at an absolute build-machine path breaks as soon as the bundle is extracted elsewhere.
 */
export function machOLinkagePlan(
	locations: { libraryDirectory: string; executableDirectory: string },
	commands: MachOLoadCommands,
): MachOLinkagePlan {
	const issues: string[] = [];
	const expand = (reference: string): string | null => {
		if (reference.startsWith("@loader_path"))
			return path.resolve(locations.libraryDirectory, `.${reference.slice("@loader_path".length)}`);
		if (reference.startsWith("@executable_path"))
			return path.resolve(locations.executableDirectory, `.${reference.slice("@executable_path".length)}`);
		return null;
	};

	const searchPaths: string[] = [];
	for (const rpath of commands.rpaths) {
		const expanded = expand(rpath);
		if (expanded) searchPaths.push(expanded);
		else issues.push(`LC_RPATH ${rpath} is not relative to @loader_path or @executable_path.`);
	}

	const dependencies: { name: string; candidates: string[] }[] = [];
	for (const dependency of commands.dependencies) {
		if (dependency.startsWith("@rpath/")) {
			const relative = dependency.slice("@rpath/".length);
			dependencies.push({ name: dependency, candidates: searchPaths.map(base => path.resolve(base, relative)) });
			continue;
		}
		const expanded = expand(dependency);
		if (expanded) {
			dependencies.push({ name: dependency, candidates: [expanded] });
			continue;
		}
		if (!dependency.startsWith("/")) continue;
		if (DYLD_SHARED_CACHE_PREFIXES.some(prefix => dependency.startsWith(prefix))) continue;
		issues.push(`Dependency ${dependency} points outside the bundle and the system library cache.`);
	}
	return { issues, dependencies };
}

/**
 * Walks the embedded runtime's dependency graph the way dyld will, since `otool` — unlike `ldd`
 * — reports one object's direct dependencies and nothing below them. `@loader_path` is relative
 * to whichever library is doing the loading, so each object is resolved from its own directory.
 */
async function darwinLinkageIssues(bundle: string, library: string): Promise<string[]> {
	const issues: string[] = [];
	const visited = new Set<string>();
	const pending = [library];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current || visited.has(current)) continue;
		visited.add(current);
		const object = path.relative(bundle, current);
		const plan = machOLinkagePlan(
			{ libraryDirectory: path.dirname(current), executableDirectory: path.join(bundle, "bin") },
			parseMachOLoadCommands(
				await runCommand(["otool", "-l", current], { description: `Linkage probe for ${object}` }),
			),
		);
		issues.push(...plan.issues.map(issue => `${object}: ${issue}`));
		for (const dependency of plan.dependencies) {
			const present = await Promise.all(dependency.candidates.map(candidate => isFile(candidate)));
			const resolved = dependency.candidates.find((_, index) => present[index]);
			if (resolved) pending.push(resolved);
			else issues.push(`${object}: dependency ${dependency.name} is missing from the bundle.`);
		}
	}
	return issues;
}

/** Rejects an embedded runtime whose dependencies would not resolve after the bundle moves. */
async function verifyEmbeddedLinkage(bundle: string, target: BundleTarget): Promise<void> {
	const library = path.join(bundle, "lib", embeddedLibraryNames(target).facade);
	if (target.platform === "darwin") {
		const issues = await darwinLinkageIssues(bundle, library);
		if (issues.length > 0) throw new Error(`Embedded runtime has unresolved dependencies.\n${issues.join("\n")}`);
		return;
	}
	const linkage = await runCommand(["ldd", library], { description: "Embedded runtime linkage probe" });
	if (linkage.includes("not found")) throw new Error(`Embedded runtime has unresolved dependencies.\n${linkage}`);
}

async function resolveAuraBinary(options: BundleOptions, repoRoot: string, target: BundleTarget): Promise<string> {
	if (options.auraBinary) {
		await requireFile(options.auraBinary, options.auraBinary, true);
		return options.auraBinary;
	}
	const manifest: unknown = await Bun.file(path.join(repoRoot, "package.json")).json();
	const packageManager =
		typeof manifest === "object" && manifest !== null && "packageManager" in manifest
			? pinnedBunPackage(manifest.packageManager)
			: pinnedBunPackage(undefined);
	const bun = await resolvePinnedBun(packageManager, pinnedBunCacheRoot());
	await runCommand([bun, "scripts/ci-release-build-binaries.ts", "--targets", target.id], {
		cwd: repoRoot,
		// Codegen steps inside the release build shell out to `bun`; keep them on the pin too.
		env: { ...process.env, PATH: `${path.dirname(bun)}${path.delimiter}${process.env.PATH ?? ""}` },
		inherit: true,
		description: `Aura release binary build with ${packageManager}`,
	});
	const binary = path.join(repoRoot, "packages", "coding-agent", "binaries", target.auraBinaryName);
	await requireFile(binary, path.relative(repoRoot, binary), true);
	return binary;
}

async function verifyBundle(bundle: string, target: BundleTarget): Promise<void> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "aura-bundle-smoke-"));
	const env = {
		...process.env,
		AURA_PROFILE: "",
		OMP_PROFILE: "",
		PI_PROFILE: "",
		PI_CODING_AGENT_DIR: agentDir,
		HOME: agentDir,
		XDG_CACHE_HOME: path.join(agentDir, "cache"),
		XDG_DATA_HOME: path.join(agentDir, "data"),
		XDG_STATE_HOME: path.join(agentDir, "state"),
	};
	try {
		const launcher = path.join(bundle, "bin", "aura");
		await runCommand([launcher, "--version"], { env, description: "Bundled Aura version probe" });
		await runCommand([launcher, "--smoke-test"], { env, description: "Bundled Aura worker smoke test" });
		await runCommand([launcher, "runtime", "status", "--json"], { env, description: "Bundled runtime status probe" });
		await verifyEmbeddedLinkage(bundle, target);
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}

async function installBundle(
	runtimeDist: string,
	auraBinary: string,
	staging: string,
	target: BundleTarget,
): Promise<void> {
	await fs.cp(runtimeDist, staging, { recursive: true, dereference: true, preserveTimestamps: true });
	const binDir = path.join(staging, "bin");
	await fs.mkdir(binDir, { recursive: true });
	await fs.copyFile(auraBinary, path.join(binDir, "aura.bin"));
	await fs.chmod(path.join(binDir, "aura.bin"), 0o755);
	await Bun.write(path.join(staging, "etc", "aura-bundle.yml"), BUNDLE_CONFIG);
	await Bun.write(path.join(binDir, "aura"), bundleLauncher(target));
	await fs.chmod(path.join(binDir, "aura"), 0o755);
	await validateRuntimeDistribution(staging, target);
}

async function replaceBundle(staging: string, bundle: string): Promise<void> {
	await fs.rm(bundle, { recursive: true, force: true });
	await fs.rename(staging, bundle);
}

async function sha256(file: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(file).stream()) hasher.update(chunk);
	return hasher.digest("hex");
}

interface ArchiveTool {
	command: string;
	/** Flags that normalize order, ownership, and timestamps so the archive hashes reproducibly. */
	createFlags: string[];
	deterministic: boolean;
}

/**
 * macOS ships bsdtar as `tar`, which rejects `--sort`, `--owner`, `--group`, and `--mtime`
 * outright. Prefer a GNU tar wherever one is installed (`gtar` on Homebrew and the GitHub macOS
 * runners) and degrade to bsdtar's narrower set rather than failing the build.
 */
export function bsdtarCreateFlags(platform: NodeJS.Platform = process.platform): string[] {
	// Without --no-mac-metadata bsdtar emits an AppleDouble `._` entry beside every file with xattrs.
	return ["--numeric-owner", "--uname=", "--gname=", ...(platform === "darwin" ? ["--no-mac-metadata"] : [])];
}

async function resolveArchiveTool(): Promise<ArchiveTool> {
	for (const command of ["tar", "gtar"]) {
		const version = await runCommand([command, "--version"], { description: `${command} version probe` }).catch(
			() => null,
		);
		if (version?.startsWith("tar (GNU tar)")) {
			return {
				command,
				createFlags: ["--sort=name", "--owner=0", "--group=0", "--numeric-owner", "--mtime=@0"],
				deterministic: true,
			};
		}
	}
	return { command: "tar", createFlags: bsdtarCreateFlags(), deterministic: false };
}

async function archiveBundle(
	outputDir: string,
	bundle: string,
	skipSmoke: boolean,
	target: BundleTarget,
): Promise<{ archive: string; checksum: string }> {
	const archive = path.join(outputDir, `${target.bundleName}.tar.gz`);
	const checksum = `${archive}.sha256`;
	await fs.rm(archive, { force: true });
	await fs.rm(checksum, { force: true });
	const tar = await resolveArchiveTool();
	if (!tar.deterministic) {
		console.warn("No GNU tar found; the archive will not be byte-reproducible. Install GNU tar (gtar) to fix this.");
	}
	await runCommand([tar.command, ...tar.createFlags, "-C", outputDir, "-czf", archive, path.basename(bundle)], {
		description: "Bundle archive creation",
	});
	const digest = await sha256(archive);
	await Bun.write(checksum, `${digest}  ${path.basename(archive)}\n`);

	if (!skipSmoke) {
		const extractedRoot = await fs.mkdtemp(path.join(outputDir, ".bundle-verify-"));
		try {
			await runCommand([tar.command, "-xzf", archive, "-C", extractedRoot], {
				description: "Bundle archive extraction",
			});
			await verifyBundle(path.join(extractedRoot, target.bundleName), target);
		} finally {
			await fs.rm(extractedRoot, { recursive: true, force: true });
		}
	}
	return { archive, checksum };
}

async function main(): Promise<void> {
	const target = hostBundleTarget();
	const options = parseOptions(process.argv.slice(2));
	await validateRuntimeDistribution(options.runtimeDist, target);

	const repoRoot = path.join(import.meta.dir, "..");
	const auraBinary = await resolveAuraBinary(options, repoRoot, target);
	await fs.mkdir(options.outputDir, { recursive: true });
	const bundle = path.join(options.outputDir, target.bundleName);
	const staging = path.join(options.outputDir, `.${target.bundleName}.staging-${crypto.randomUUID()}`);

	try {
		await installBundle(options.runtimeDist, auraBinary, staging, target);
		if (!options.skipSmoke) await verifyBundle(staging, target);
		await replaceBundle(staging, bundle);
	} finally {
		await fs.rm(staging, { recursive: true, force: true });
	}

	const artifacts = options.archive ? await archiveBundle(options.outputDir, bundle, options.skipSmoke, target) : null;
	const bundleSize = await fs.stat(path.join(bundle, "bin", "aura.bin"));
	console.log(`Bundle: ${bundle}`);
	console.log(`Aura binary: ${bundleSize.size} bytes`);
	if (artifacts) {
		console.log(`Archive: ${artifacts.archive}`);
		console.log(`Checksum: ${artifacts.checksum}`);
	}
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
