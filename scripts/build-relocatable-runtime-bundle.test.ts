import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	bsdtarCreateFlags,
	embeddedLibraryNames,
	hostBundleTarget,
	machOLinkagePlan,
	parseMachOLoadCommands,
	pinnedBunManifest,
	pinnedBunPackage,
	pinnedBunVersion,
	requiredRuntimeArtifacts,
	resolvePinnedBun,
} from "./build-relocatable-runtime-bundle";

const repoRoot = path.join(import.meta.dir, "..");
const scriptPath = path.join(repoRoot, "scripts", "build-relocatable-runtime-bundle.ts");
// The bundler always targets its host, so the contract tests must follow the host's naming too.
const hostTarget = hostBundleTarget();
const bundleName = hostTarget.bundleName;
const libraries = embeddedLibraryNames(hostTarget);
const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
	// The launcher resolves its own root with `cd -P`, so tests have to compare against real paths:
	// macOS hands out /var/folders/... temp dirs that are symlinks into /private/var/folders/....
	const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aura-runtime-bundle-")));
	tempDirs.push(directory);
	return directory;
}

async function writeExecutable(file: string, content: string): Promise<void> {
	await Bun.write(file, content);
	await fs.chmod(file, 0o755);
}

async function createInputs(root: string): Promise<{ runtimeDist: string; auraBinary: string }> {
	const runtimeDist = path.join(root, "runtime");
	await fs.mkdir(path.join(runtimeDist, "bin"), { recursive: true });
	await fs.mkdir(path.join(runtimeDist, "lib"), { recursive: true });
	await fs.mkdir(path.join(runtimeDist, "share"), { recursive: true });
	await writeExecutable(path.join(runtimeDist, "bin", "elide"), "#!/bin/sh\nexit 0\n");
	await Bun.write(path.join(runtimeDist, "lib", libraries.facade), "facade");
	await Bun.write(path.join(runtimeDist, "lib", libraries.engine), "engine");
	await Bun.write(path.join(runtimeDist, "share", "runtime-marker.txt"), "complete distribution");

	const auraBinary = path.join(root, "fake-aura");
	await writeExecutable(
		auraBinary,
		'#!/bin/sh\nprintf "runtime=%s\\n" "$AURA_RUNTIME_BIN"\nprintf "embedded=%s\\n" "$AURA_RUNTIME_EMBEDDED_LIB"\nprintf "config=%s\\n" "$PI_CONFIG_FILES"\nprintf "args=%s\\n" "$*"\n',
	);
	return { runtimeDist, auraBinary };
}

async function runBuilder(
	args: string[],
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(["bun", scriptPath, ...args], {
		cwd: repoRoot,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}
test("uses the repository-pinned Bun release compiler", () => {
	expect(pinnedBunPackage("bun@1.3.14")).toBe("bun@1.3.14");
	expect(pinnedBunVersion("bun@1.3.14")).toBe("1.3.14");
	expect(() => pinnedBunPackage("npm@11.0.0")).toThrow("Expected packageManager to pin Bun");
});

test("provisions the pinned Bun with a trusted postinstall", () => {
	const manifest = JSON.parse(pinnedBunManifest("1.3.14"));
	expect(manifest.dependencies).toEqual({ bun: "1.3.14" });
	// Without this, Bun skips the postinstall that replaces bin/bun.exe with the real
	// compiler, leaving a placeholder that exits 1 without printing anything.
	expect(manifest.trustedDependencies).toEqual(["bun"]);
});

test("reuses the running Bun when it already satisfies the pin", async () => {
	const cacheRoot = await temporaryDirectory();
	expect(await resolvePinnedBun(`bun@${Bun.version}`, cacheRoot)).toBe(process.execPath);
	expect(await fs.readdir(cacheRoot)).toEqual([]);
});

test("resolves the repository pin to an executable Bun compiler", async () => {
	const manifest: { packageManager?: unknown } = await Bun.file(path.join(repoRoot, "package.json")).json();
	const packageManager = pinnedBunPackage(manifest.packageManager);
	const executable = await resolvePinnedBun(packageManager, await temporaryDirectory());
	const probe = Bun.spawn([executable, "--version"], { stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		probe.exited,
		new Response(probe.stdout).text(),
		new Response(probe.stderr).text(),
	]);
	expect(exitCode, stderr).toBe(0);
	expect(stdout.trim()).toBe(pinnedBunVersion(packageManager));
});

describe("relocatable Aura runtime bundle", () => {
	test("copies the complete runtime and launches Aura with relocated runtime paths", async () => {
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
		expect(await Bun.file(path.join(bundle, "share", "runtime-marker.txt")).text()).toBe("complete distribution");
		expect(await Bun.file(path.join(bundle, "lib", libraries.facade)).text()).toBe("facade");
		expect(await Bun.file(path.join(bundle, "lib", libraries.engine)).text()).toBe("engine");
		expect(await Bun.file(path.join(bundle, "etc", "aura-bundle.yml")).text()).toBe(
			"runtime:\n  enabled: true\n  adapter: auto\n  autoDownload: false\n",
		);
		expect((await fs.stat(path.join(bundle, "bin", "aura"))).mode & 0o111).not.toBe(0);
		expect((await fs.stat(path.join(bundle, "bin", "aura.bin"))).mode & 0o111).not.toBe(0);

		const launch = Bun.spawn([path.join(bundle, "bin", "aura"), "hello", "world"], {
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
		expect(stdout).toContain(`embedded=${path.join(bundle, "lib", libraries.facade)}`);
		expect(stdout).toContain(`config=${path.join(bundle, "etc", "aura-bundle.yml")}:/user/override.yml`);
		expect(stdout).toContain("args=hello world");
	});

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
		expect(stdout).toContain(`embedded=${path.join(bundle, "lib", libraries.facade)}`);
		expect(stdout).toContain(`config=${path.join(bundle, "etc", "aura-bundle.yml")}:/user/override.yml`);
		expect(stdout).toContain("args=hello world");
	});

	test("rejects distributions missing a required runtime artifact", async () => {
		for (const relativePath of requiredRuntimeArtifacts(hostTarget)) {
			const root = await temporaryDirectory();
			const { runtimeDist, auraBinary } = await createInputs(root);
			await fs.rm(path.join(runtimeDist, relativePath));
			const result = await runBuilder([
				"--runtime-dist",
				runtimeDist,
				"--aura-binary",
				auraBinary,
				"--output-dir",
				path.join(root, "output"),
				"--skip-smoke",
				"--no-archive",
			]);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain(relativePath);
		}
	});

	test("runs smoke probes with an isolated native-addon cache", async () => {
		const root = await temporaryDirectory();
		const { runtimeDist } = await createInputs(root);
		const auraBinary = path.join(root, "smoke-aura");
		await writeExecutable(
			auraBinary,
			`#!/bin/sh
[ "\${PI_CODING_AGENT_DIR:-}" != "/poisoned" ] || exit 42
[ "$HOME" != "/poisoned-home" ] || exit 45
[ -d "$PI_CODING_AGENT_DIR" ] || exit 43
[ -z "\${AURA_PROFILE:-}" ] || exit 44
exit 0
`,
		);
		// The fake libraries are not real objects, so the linkage probe has to be stubbed. Each stub
		// still reports linkage that the real checker must accept for the smoke run to pass.
		const fakeBin = path.join(root, "fake-bin");
		await fs.mkdir(fakeBin);
		await writeExecutable(path.join(fakeBin, "ldd"), "#!/bin/sh\necho 'all dependencies resolved'\n");
		await writeExecutable(
			path.join(fakeBin, "otool"),
			`#!/bin/sh
cat <<'LOADCOMMANDS'
          cmd LC_ID_DYLIB
         name @rpath/${libraries.facade} (offset 24)
          cmd LC_LOAD_DYLIB
         name @rpath/${libraries.engine} (offset 24)
          cmd LC_LOAD_DYLIB
         name /usr/lib/libSystem.B.dylib (offset 24)
          cmd LC_RPATH
         path @loader_path (offset 12)
LOADCOMMANDS
`,
		);

		const result = await runBuilder(
			[
				"--runtime-dist",
				runtimeDist,
				"--aura-binary",
				auraBinary,
				"--output-dir",
				path.join(root, "output"),
				"--no-archive",
			],
			{
				...process.env,
				AURA_PROFILE: "poisoned",
				HOME: "/poisoned-home",
				PI_CODING_AGENT_DIR: "/poisoned",
				PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
			},
		);
		expect(result.exitCode, result.stderr).toBe(0);
	});
	test("dereferences a runtime distribution symlink into a real bundle directory", async () => {
		const root = await temporaryDirectory();
		const { runtimeDist, auraBinary } = await createInputs(root);
		const current = path.join(root, "current");
		await fs.symlink(runtimeDist, current);
		const outputDir = path.join(root, "output");
		const result = await runBuilder([
			"--runtime-dist",
			current,
			"--aura-binary",
			auraBinary,
			"--output-dir",
			outputDir,
			"--skip-smoke",
		]);
		expect(result.exitCode, result.stderr).toBe(0);
		expect((await fs.lstat(path.join(outputDir, bundleName))).isDirectory()).toBeTrue();
	});

	test("creates an archive and checksum containing the relocatable directory", async () => {
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
		]);
		expect(result.exitCode, result.stderr).toBe(0);
		const archive = path.join(outputDir, `${bundleName}.tar.gz`);
		expect(await Bun.file(archive).exists()).toBe(true);
		expect((await Bun.file(`${archive}.sha256`).text()).trim()).toMatch(
			new RegExp(`^[a-f0-9]{64} {2}${bundleName.replaceAll(".", "\\.")}\\.tar\\.gz$`),
		);

		const listing = Bun.spawn(["tar", "-tzf", archive], { stdout: "pipe", stderr: "pipe" });
		const [listingCode, stdout, stderr] = await Promise.all([
			listing.exited,
			new Response(listing.stdout).text(),
			new Response(listing.stderr).text(),
		]);
		expect(listingCode, stderr).toBe(0);
		expect(stdout).toContain(`${bundleName}/bin/aura\n`);
		expect(stdout).toContain(`${bundleName}/lib/${libraries.engine}\n`);
	});
});

describe("host bundle targets", () => {
	test("names the bundle, Aura binary, and embedded libraries per host", () => {
		const linux = hostBundleTarget("linux", "x64");
		expect(linux.bundleName).toBe("aura-elide-linux-x64");
		expect(linux.auraBinaryName).toBe("aura-linux-x64");
		expect(embeddedLibraryNames(linux)).toEqual({
			facade: "libelide_embed.so",
			engine: "libelide_embed_engine.so",
		});

		const darwin = hostBundleTarget("darwin", "arm64");
		expect(darwin.bundleName).toBe("aura-elide-darwin-arm64");
		expect(darwin.auraBinaryName).toBe("aura-darwin-arm64");
		expect(embeddedLibraryNames(darwin)).toEqual({
			facade: "libelide_embed.dylib",
			engine: "libelide_embed_engine.dylib",
		});
	});

	test("rejects hosts with no verified embedded runtime", () => {
		expect(() => hostBundleTarget("darwin", "x64")).toThrow(
			"Relocatable embedded bundles support linux/x64, darwin/arm64; received darwin/x64.",
		);
		expect(() => hostBundleTarget("win32", "x64")).toThrow("received win32/x64");
	});

	test("omits bsdtar's macOS metadata flag off darwin", () => {
		expect(bsdtarCreateFlags("darwin")).toContain("--no-mac-metadata");
		expect(bsdtarCreateFlags("linux")).not.toContain("--no-mac-metadata");
	});
});

describe("Mach-O linkage", () => {
	const loadCommands = `Load command 8
          cmd LC_ID_DYLIB
      cmdsize 56
         name @rpath/libelide_embed.dylib (offset 24)
   time stamp 1 Wed Dec 31 16:00:01 1969
Load command 9
          cmd LC_LOAD_DYLIB
      cmdsize 64
         name @rpath/libelide_embed_engine.dylib (offset 24)
   time stamp 2 Wed Dec 31 16:00:02 1969
Load command 10
          cmd LC_LOAD_DYLIB
      cmdsize 56
         name /usr/lib/libSystem.B.dylib (offset 24)
Load command 11
          cmd LC_RPATH
      cmdsize 32
         path @loader_path (offset 12)
`;

	test("reads dependencies and rpaths without mistaking the install name for a dependency", () => {
		expect(parseMachOLoadCommands(loadCommands)).toEqual({
			rpaths: ["@loader_path"],
			dependencies: ["@rpath/libelide_embed_engine.dylib", "/usr/lib/libSystem.B.dylib"],
		});
	});

	test("expands @rpath against the staged bundle and ignores the dyld shared cache", () => {
		const plan = machOLinkagePlan(
			{ libraryDirectory: "/bundle/lib", executableDirectory: "/bundle/bin" },
			parseMachOLoadCommands(loadCommands),
		);
		expect(plan.issues).toEqual([]);
		// /usr/lib/libSystem.B.dylib has no file behind it, so it must not become a required path.
		expect(plan.dependencies).toEqual([
			{
				name: "@rpath/libelide_embed_engine.dylib",
				candidates: ["/bundle/lib/libelide_embed_engine.dylib"],
			},
		]);
	});

	test("flags linkage that would break once the bundle moves", () => {
		const plan = machOLinkagePlan(
			{ libraryDirectory: "/bundle/lib", executableDirectory: "/bundle/bin" },
			{
				rpaths: ["/build/host/lib", "@executable_path/../lib"],
				dependencies: ["/opt/homebrew/lib/libz.dylib", "@loader_path/libelide_embed_engine.dylib"],
			},
		);
		expect(plan.issues).toEqual([
			"LC_RPATH /build/host/lib is not relative to @loader_path or @executable_path.",
			"Dependency /opt/homebrew/lib/libz.dylib points outside the bundle and the system library cache.",
		]);
		expect(plan.dependencies).toEqual([
			{
				name: "@loader_path/libelide_embed_engine.dylib",
				candidates: ["/bundle/lib/libelide_embed_engine.dylib"],
			},
		]);
	});
});
