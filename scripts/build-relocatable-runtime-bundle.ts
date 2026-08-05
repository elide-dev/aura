#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const BUNDLE_NAME = "aura-elide-linux-x64";
const REQUIRED_RUNTIME_ARTIFACTS = [
	path.join("bin", "elide"),
	path.join("lib", "libelide_embed.so"),
	path.join("lib", "libelide_embed_engine.so"),
] as const;
const BUNDLE_CONFIG = "runtime:\n  enabled: true\n  adapter: auto\n  autoDownload: false\n";
const BUNDLE_LAUNCHER = `#!/bin/sh
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
export AURA_RUNTIME_EMBEDDED_LIB="$ROOT/lib/libelide_embed.so"

if [ -n "\${PI_CONFIG_FILES:-}" ]; then
    export PI_CONFIG_FILES="$ROOT/etc/aura-bundle.yml:$PI_CONFIG_FILES"
else
    export PI_CONFIG_FILES="$ROOT/etc/aura-bundle.yml"
fi

exec "$ROOT/bin/aura.bin" "$@"
`;

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

async function requireFile(file: string, displayPath: string, executable = false): Promise<void> {
	const stat = await fs.stat(file).catch(() => null);
	if (!stat) throw new Error(`Required artifact is missing: ${displayPath}`);
	if (!stat.isFile()) throw new Error(`Required artifact is not a file: ${displayPath}`);
	if (executable && (stat.mode & 0o111) === 0) throw new Error(`Required artifact is not executable: ${displayPath}`);
}

async function validateRuntimeDistribution(runtimeDist: string): Promise<void> {
	for (const relativePath of REQUIRED_RUNTIME_ARTIFACTS) {
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

async function resolveAuraBinary(options: BundleOptions, repoRoot: string): Promise<string> {
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
	await runCommand([bun, "scripts/ci-release-build-binaries.ts", "--targets", "linux-x64"], {
		cwd: repoRoot,
		// Codegen steps inside the release build shell out to `bun`; keep them on the pin too.
		env: { ...process.env, PATH: `${path.dirname(bun)}${path.delimiter}${process.env.PATH ?? ""}` },
		inherit: true,
		description: `Aura release binary build with ${packageManager}`,
	});
	const binary = path.join(repoRoot, "packages", "coding-agent", "binaries", "aura-linux-x64");
	await requireFile(binary, path.relative(repoRoot, binary), true);
	return binary;
}

async function verifyBundle(bundle: string): Promise<void> {
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
		const linkage = await runCommand(["ldd", path.join(bundle, "lib", "libelide_embed.so")], {
			description: "Embedded runtime linkage probe",
		});
		if (linkage.includes("not found")) throw new Error(`Embedded runtime has unresolved dependencies.\n${linkage}`);
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}

async function installBundle(runtimeDist: string, auraBinary: string, staging: string): Promise<void> {
	await fs.cp(runtimeDist, staging, { recursive: true, dereference: true, preserveTimestamps: true });
	const binDir = path.join(staging, "bin");
	await fs.mkdir(binDir, { recursive: true });
	await fs.copyFile(auraBinary, path.join(binDir, "aura.bin"));
	await fs.chmod(path.join(binDir, "aura.bin"), 0o755);
	await Bun.write(path.join(staging, "etc", "aura-bundle.yml"), BUNDLE_CONFIG);
	await Bun.write(path.join(binDir, "aura"), BUNDLE_LAUNCHER);
	await fs.chmod(path.join(binDir, "aura"), 0o755);
	await validateRuntimeDistribution(staging);
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

async function archiveBundle(
	outputDir: string,
	bundle: string,
	skipSmoke: boolean,
): Promise<{ archive: string; checksum: string }> {
	const archive = path.join(outputDir, `${BUNDLE_NAME}.tar.gz`);
	const checksum = `${archive}.sha256`;
	await fs.rm(archive, { force: true });
	await fs.rm(checksum, { force: true });
	await runCommand(
		[
			"tar",
			"--sort=name",
			"--owner=0",
			"--group=0",
			"--numeric-owner",
			"--mtime=@0",
			"-C",
			outputDir,
			"-czf",
			archive,
			path.basename(bundle),
		],
		{ description: "Bundle archive creation" },
	);
	const digest = await sha256(archive);
	await Bun.write(checksum, `${digest}  ${path.basename(archive)}\n`);

	if (!skipSmoke) {
		const extractedRoot = await fs.mkdtemp(path.join(outputDir, ".bundle-verify-"));
		try {
			await runCommand(["tar", "-xzf", archive, "-C", extractedRoot], {
				description: "Bundle archive extraction",
			});
			await verifyBundle(path.join(extractedRoot, BUNDLE_NAME));
		} finally {
			await fs.rm(extractedRoot, { recursive: true, force: true });
		}
	}
	return { archive, checksum };
}

async function main(): Promise<void> {
	if (process.platform !== "linux" || process.arch !== "x64") {
		throw new Error(
			`Relocatable embedded bundles currently require linux/x64; received ${process.platform}/${process.arch}.`,
		);
	}
	const options = parseOptions(process.argv.slice(2));
	await validateRuntimeDistribution(options.runtimeDist);

	const repoRoot = path.join(import.meta.dir, "..");
	const auraBinary = await resolveAuraBinary(options, repoRoot);
	await fs.mkdir(options.outputDir, { recursive: true });
	const bundle = path.join(options.outputDir, BUNDLE_NAME);
	const staging = path.join(options.outputDir, `.${BUNDLE_NAME}.staging-${crypto.randomUUID()}`);

	try {
		await installBundle(options.runtimeDist, auraBinary, staging);
		if (!options.skipSmoke) await verifyBundle(staging);
		await replaceBundle(staging, bundle);
	} finally {
		await fs.rm(staging, { recursive: true, force: true });
	}

	const artifacts = options.archive ? await archiveBundle(options.outputDir, bundle, options.skipSmoke) : null;
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
