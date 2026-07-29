import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pinnedBunPackage } from "./build-relocatable-runtime-bundle";

const repoRoot = path.join(import.meta.dir, "..");
const scriptPath = path.join(repoRoot, "scripts", "build-relocatable-runtime-bundle.ts");
const bundleName = "aura-elide-linux-x64";
const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aura-runtime-bundle-"));
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
	await Bun.write(path.join(runtimeDist, "lib", "libelide_embed.so"), "facade");
	await Bun.write(path.join(runtimeDist, "lib", "libelide_embed_engine.so"), "engine");
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
	expect(() => pinnedBunPackage("npm@11.0.0")).toThrow("Expected packageManager to pin Bun");
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
		expect(await Bun.file(path.join(bundle, "lib", "libelide_embed.so")).text()).toBe("facade");
		expect(await Bun.file(path.join(bundle, "lib", "libelide_embed_engine.so")).text()).toBe("engine");
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
		expect(stdout).toContain(`embedded=${path.join(bundle, "lib", "libelide_embed.so")}`);
		expect(stdout).toContain(`config=${path.join(bundle, "etc", "aura-bundle.yml")}:/user/override.yml`);
		expect(stdout).toContain("args=hello world");
	});

	test("rejects distributions missing a required runtime artifact", async () => {
		for (const relativePath of [
			path.join("bin", "elide"),
			path.join("lib", "libelide_embed.so"),
			path.join("lib", "libelide_embed_engine.so"),
		]) {
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
		const fakeBin = path.join(root, "fake-bin");
		await fs.mkdir(fakeBin);
		await writeExecutable(path.join(fakeBin, "ldd"), "#!/bin/sh\necho 'all dependencies resolved'\n");

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
			/^[a-f0-9]{64} {2}aura-elide-linux-x64\.tar\.gz$/,
		);

		const listing = Bun.spawn(["tar", "-tzf", archive], { stdout: "pipe", stderr: "pipe" });
		const [listingCode, stdout, stderr] = await Promise.all([
			listing.exited,
			new Response(listing.stdout).text(),
			new Response(listing.stderr).text(),
		]);
		expect(listingCode, stderr).toBe(0);
		expect(stdout).toContain(`${bundleName}/bin/aura\n`);
		expect(stdout).toContain(`${bundleName}/lib/libelide_embed_engine.so\n`);
	});
});
