import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Settings } from "../src/config/settings";
import { EMBEDDED_RUNTIME_ABI_VERSION, EMBEDDED_RUNTIME_SCHEMA_SHA256 } from "../src/runtime/embedded/schema";
import { RuntimeService } from "../src/runtime/service";
import { SelectedRuntimeEndpoint } from "../src/runtime/transport/selected";
import type { ToolSession } from "../src/tools";
import { RuntimeRunTool } from "../src/tools/runtime-run";

const embeddedLib = process.env.AURA_RUNTIME_EMBEDDED_LIB;
const applicable = embeddedLib !== undefined;
const embeddedPath = path.resolve(embeddedLib ?? "missing-AURA_RUNTIME_EMBEDDED_LIB");
const missingLibraryGuidance =
	"The embedded runtime library is unavailable. Point runtime.embeddedPath or AURA_RUNTIME_EMBEDDED_LIB at a compatible library.";
const processPath = path.resolve(path.dirname(embeddedPath), "..", "bin", "elide");
const integrationEnv: NodeJS.ProcessEnv = { ...process.env, RUN_TOKEN: "embedded-env" };
const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempRoots.push(directory);
	return directory;
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await fs.stat(filePath);
		return true;
	} catch {
		return false;
	}
}

function createService(
	options: { embeddedPath?: string; explicitPath?: string; env?: NodeJS.ProcessEnv } = {},
): RuntimeService {
	return new RuntimeService(
		new SelectedRuntimeEndpoint({
			adapter: "embedded",
			autoDownload: false,
			embeddedPath: options.embeddedPath ?? embeddedPath,
			explicitPath: options.explicitPath ?? processPath,
			env: options.env ?? integrationEnv,
		}),
	);
}

async function waitForExit(proc: Bun.Subprocess<"ignore", "pipe", "pipe">, timeoutMs: number): Promise<number> {
	// This is the behavior under test: a leaked real Worker keeps the child alive, so bound the platform-clock observation.
	const outcome = await Promise.race([
		proc.exited.then(exitCode => ({ type: "exit" as const, exitCode })),
		Bun.sleep(timeoutMs).then(() => ({ type: "timeout" as const })),
	]);
	if (outcome.type === "exit") return outcome.exitCode;
	proc.kill();
	await proc.exited;
	throw new Error(`embedded disposal child did not exit within ${timeoutMs}ms`);
}

describe.skipIf(!applicable).serial("runtime integration (real embedded library)", () => {
	let service: RuntimeService;
	let processService: RuntimeService;

	beforeAll(() => {
		service = createService();
		processService = new RuntimeService(
			new SelectedRuntimeEndpoint({
				adapter: "process",
				autoDownload: false,
				explicitPath: processPath,
				env: integrationEnv,
			}),
		);
	});

	afterAll(async () => {
		await Promise.allSettled([service.close(), processService.close()]);
		await Promise.all(tempRoots.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
	});

	test("reports embedded adapter ABI schema and absolute library path", async () => {
		const status = await service.status();
		const canonicalEmbeddedPath = await fs.realpath(embeddedPath);
		expect(status).toMatchObject({
			available: true,
			adapter: "embedded",
			effectiveAdapter: "embedded",
			embeddedAbiVersion: EMBEDDED_RUNTIME_ABI_VERSION,
			embeddedSchemaHash: EMBEDDED_RUNTIME_SCHEMA_SHA256,
			embeddedLibraryPath: canonicalEmbeddedPath,
		});
	}, 120_000);

	test("runs inline JavaScript TypeScript and Python with exact stdout", async () => {
		const javascript = await service.run({ code: "console.log('inline-js')", language: "js" });
		expect(javascript).toMatchObject({ exitCode: 0, stdout: "inline-js\n", stderr: "", killed: false });

		const typescript = await service.run({
			code: "const answer: number = 42; console.log('inline-ts:' + answer)",
			language: "ts",
		});
		expect(typescript).toMatchObject({ exitCode: 0, stdout: "inline-ts:42\n", stderr: "", killed: false });

		const python = await service.run({ code: 'print("inline-python")', language: "python" });
		expect(python).toMatchObject({ exitCode: 0, stdout: "inline-python\n", stderr: "", killed: false });
	}, 120_000);

	test("runs through the source run tool with isolated embedded settings", async () => {
		const settings = Settings.isolated({
			"runtime.enabled": true,
			"runtime.adapter": "embedded",
			"runtime.embeddedPath": embeddedPath,
			"runtime.path": processPath,
			"runtime.autoDownload": false,
		});
		const tool = RuntimeRunTool.createIf({
			cwd: process.cwd(),
			settings,
			getRuntimeService: () => service,
		} as unknown as ToolSession);
		if (!tool) throw new Error("runtime run tool was disabled by isolated settings");
		const result = await tool.execute(
			"task-5-source-tool-smoke",
			{ code: "console.log('source-tool-smoke')", language: "js" },
			new AbortController().signal,
		);
		expect(result.content).toEqual([{ type: "text", text: "source-tool-smoke" }]);
		expect(result.details).toMatchObject({ exitCode: 0, killed: false });
	}, 120_000);

	test("resolves a sibling TypeScript import independently of requested cwd", async () => {
		const entryDirectory = await makeTempDir("aura-embedded-entry-");
		const requestedCwd = await makeTempDir("aura-embedded-cwd-");
		const entry = path.join(entryDirectory, "main.ts");
		await fs.writeFile(path.join(entryDirectory, "value.ts"), 'export const value = "resolved";\n');
		await fs.writeFile(
			entry,
			'import { value } from "./value.ts";\nconsole.log("sibling:" + value);\nconsole.log("cwd:" + process.cwd());\n',
		);

		const result = await service.run({ path: entry, language: "ts", cwd: requestedCwd });
		expect(result).toMatchObject({
			exitCode: 0,
			stdout: `sibling:resolved\ncwd:${requestedCwd}\n`,
			stderr: "",
			killed: false,
		});
	}, 120_000);

	test("matches process-adapter argv cwd environment stdin stdout and stderr", async () => {
		const cwd = await makeTempDir("aura-embedded-io-");
		const jsCode =
			'console.log([process.argv[process.argv.length - 1], process.cwd(), process.env.RUN_TOKEN].join("|"))';
		const jsParams = { code: jsCode, language: "js" as const, args: ["js-arg"], cwd };
		const [embeddedJs, processJs] = await Promise.all([service.run(jsParams), processService.run(jsParams)]);
		expect(embeddedJs).toMatchObject({
			exitCode: 0,
			stdout: `js-arg|${cwd}|embedded-env\n`,
			stderr: "",
			killed: false,
		});
		expect(embeddedJs.stdout).toBe(processJs.stdout);
		expect(processJs.exitCode).toBe(0);

		const pythonCode = [
			"import os, sys",
			"payload = sys.stdin.read()",
			'print("|".join([sys.argv[1], os.getcwd(), payload]), end="")',
			'sys.stderr.write("io-stderr")',
		].join("\n");
		const pythonParams = {
			code: pythonCode,
			language: "python" as const,
			args: ["python-arg"],
			cwd,
			stdin: "python-input",
		};
		const [embeddedPython, processPython] = await Promise.all([
			service.run(pythonParams),
			processService.run(pythonParams),
		]);
		expect(embeddedPython).toMatchObject({
			exitCode: 0,
			stdout: `python-arg|${cwd}|python-input`,
			stderr: "io-stderr",
			killed: false,
		});
		expect(embeddedPython.stdout).toBe(processPython.stdout);
		expect(embeddedPython.stderr).toBe(processPython.stderr);
		expect(processPython.exitCode).toBe(0);
	}, 120_000);

	test("isolates globals modules and execution context across sequential calls", async () => {
		const moduleDirectory = await makeTempDir("aura-embedded-module-isolation-");
		const stateModule = path.join(moduleDirectory, "state.ts");
		const entry = path.join(moduleDirectory, "main.ts");
		await fs.writeFile(
			stateModule,
			"let state = 0;\nexport function mutate(): number { state += 1; return state; }\n",
		);
		await fs.writeFile(entry, 'import { mutate } from "./state.ts";\nconsole.log(mutate() + "," + mutate());\n');

		const firstModuleRun = await service.run({ path: entry, language: "ts" });
		expect(firstModuleRun).toMatchObject({ exitCode: 0, stdout: "1,2\n", stderr: "", killed: false });
		const secondModuleRun = await service.run({ path: entry, language: "ts" });
		expect(secondModuleRun).toMatchObject({ exitCode: 0, stdout: "1,2\n", stderr: "", killed: false });

		const firstContext = await service.run({
			code: "globalThis.__auraEmbeddedLeak = 'one'; console.log('first-context')",
			language: "js",
		});
		expect(firstContext.stdout).toBe("first-context\n");
		const secondContext = await service.run({
			code: "if ('__auraEmbeddedLeak' in globalThis) throw new Error('global leaked'); console.log('isolated-context')",
			language: "js",
		});
		expect(secondContext).toMatchObject({
			exitCode: 0,
			stdout: "isolated-context\n",
			stderr: "",
			killed: false,
		});
	}, 120_000);

	test("returns stable guest syntax and runtime errors without poisoning reuse", async () => {
		const syntax = await service.run({ code: "const = broken", language: "js" });
		expect(syntax.exitCode).not.toBe(0);
		expect(syntax.stderr).toContain("SyntaxError");
		expect(syntax.stderr).not.toContain("\u001b[");

		const runtime = await service.run({ code: "throw new TypeError('embedded-stable-error')", language: "js" });
		expect(runtime.exitCode).not.toBe(0);
		expect(runtime.stderr).toMatch(/^TypeError: embedded-stable-error(?:\n|$)/);
		expect(runtime.stderr).not.toContain("\u001b[");

		const reuse = await service.run({ code: "console.log('reused-after-error')", language: "js" });
		expect(reuse).toMatchObject({ exitCode: 0, stdout: "reused-after-error\n", stderr: "", killed: false });
	}, 120_000);

	test("times out an active call within a bound and reuses the runtime", async () => {
		const startedAt = performance.now();
		const timedOut = await service.run({ code: "while (true) {}", language: "js", timeoutMs: 1_000 });
		expect(timedOut).toMatchObject({ exitCode: 1, stdout: "", stderr: "", killed: true });
		expect(performance.now() - startedAt).toBeLessThan(15_000);

		const reuse = await service.run({ code: "console.log('reused-after-timeout')", language: "js" });
		expect(reuse).toMatchObject({ exitCode: 0, stdout: "reused-after-timeout\n", stderr: "", killed: false });
	}, 120_000);

	test("cancels an active call within a bound and reuses the runtime", async () => {
		const controller = new AbortController();
		const startedAt = performance.now();
		const active = service.run({ code: "while (true) {}", language: "js" }, controller.signal);
		// Native execution has no test-only "entered call" hook; a short real delay lets the warmed engine enter the infinite guest.
		await Bun.sleep(500);
		controller.abort();
		await expect(active).rejects.toMatchObject({ code: "cancelled" });
		expect(performance.now() - startedAt).toBeLessThan(15_000);

		const reuse = await service.run({ code: "console.log('reused-after-cancel')", language: "js" });
		expect(reuse).toMatchObject({ exitCode: 0, stdout: "reused-after-cancel\n", stderr: "", killed: false });
	}, 120_000);

	test("keeps embedded FIFO ordering isolated from a parallel process service", async () => {
		const firstController = new AbortController();
		const secondController = new AbortController();
		const thirdController = new AbortController();
		const processController = new AbortController();
		let firstSettled = false;
		let secondSettled = false;
		let thirdSettled = false;
		const completionOrder: string[] = [];
		const first = service.run({ code: "while (true) {}", language: "js" }, firstController.signal).finally(() => {
			firstSettled = true;
		});
		// Native execution has no test-only "entered call" hook; let the warmed engine enter before queueing two calls.
		await Bun.sleep(500);
		const second = service
			.run({ code: "console.log('fifo-second')", language: "js" }, secondController.signal)
			.then(result => {
				completionOrder.push("second");
				return result;
			})
			.finally(() => {
				secondSettled = true;
			});
		const third = service
			.run({ code: "console.log('fifo-third')", language: "js" }, thirdController.signal)
			.then(result => {
				completionOrder.push("third");
				return result;
			})
			.finally(() => {
				thirdSettled = true;
			});
		const processCall = processService.run(
			{ code: "console.log('parallel-process')", language: "js", timeoutMs: 15_000 },
			processController.signal,
		);

		try {
			const processResult = await processCall;
			expect(processResult).toMatchObject({
				exitCode: 0,
				stdout: "parallel-process\n",
				stderr: "",
				killed: false,
			});
			expect(firstSettled).toBe(false);
			expect(secondSettled).toBe(false);
			expect(thirdSettled).toBe(false);

			firstController.abort();
			await expect(first).rejects.toMatchObject({ code: "cancelled" });
			const [secondResult, thirdResult] = await Promise.all([second, third]);
			expect(secondResult).toMatchObject({
				exitCode: 0,
				stdout: "fifo-second\n",
				stderr: "",
				killed: false,
			});
			expect(thirdResult).toMatchObject({
				exitCode: 0,
				stdout: "fifo-third\n",
				stderr: "",
				killed: false,
			});
			expect(completionOrder).toEqual(["second", "third"]);
		} finally {
			firstController.abort();
			secondController.abort();
			thirdController.abort();
			processController.abort();
			await Promise.allSettled([first, second, third, processCall]);
		}
	}, 120_000);

	test("dispose closes native state and Workers so a child exits promptly", async () => {
		const directory = await makeTempDir("aura-embedded-dispose-");
		const script = path.join(directory, "dispose.ts");
		const serviceUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/runtime/service.ts")).href;
		const selectedUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/runtime/transport/selected.ts")).href;
		await fs.writeFile(
			script,
			[
				`import { RuntimeService } from ${JSON.stringify(serviceUrl)};`,
				`import { SelectedRuntimeEndpoint } from ${JSON.stringify(selectedUrl)};`,
				`const service = new RuntimeService(new SelectedRuntimeEndpoint({ adapter: "embedded", embeddedPath: ${JSON.stringify(embeddedPath)}, explicitPath: ${JSON.stringify(processPath)}, autoDownload: false }));`,
				`const result = await service.run({ code: "console.log('dispose-child')", language: "js" });`,
				`if (result.stdout !== "dispose-child\\n") throw new Error("unexpected child output");`,
				"await service.close();",
				'process.stdout.write("disposed\\n");',
			].join("\n"),
		);
		const proc = Bun.spawn([process.execPath, script], {
			cwd: directory,
			env: integrationEnv,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			waitForExit(proc, 60_000),
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toBe("disposed\n");
		expect(stderr).toBe("");
	}, 120_000);

	test("explicit embedded missing path fails with guidance without spawning process", async () => {
		const directory = await makeTempDir("aura-embedded-missing-");
		const marker = path.join(directory, "spawned");
		const fakeProcess = path.join(directory, "elide");
		await fs.writeFile(fakeProcess, `#!/bin/sh\nprintf spawned > ${JSON.stringify(marker)}\nexit 99\n`);
		await fs.chmod(fakeProcess, 0o755);
		const missing = createService({
			embeddedPath: path.join(directory, "missing-libelide_embed.so"),
			explicitPath: fakeProcess,
		});
		try {
			await expect(missing.run({ code: "console.log('must-not-run')", language: "js" })).rejects.toMatchObject({
				code: "runtime-missing",
				message: missingLibraryGuidance,
			});
			expect(await exists(marker)).toBe(false);
		} finally {
			await missing.close();
		}
	}, 120_000);

	test("routes Java Kotlin and check through the process adapter", async () => {
		const jvmCwd = await makeTempDir("aura-embedded-jvm-");
		const javaPath = path.join(jvmCwd, "Main.java");
		const kotlinPath = path.join(jvmCwd, "Main.kt");
		await fs.writeFile(
			javaPath,
			'public class Main { public static void main(String[] args) { System.out.println("java-process"); } }\n',
		);
		await fs.writeFile(kotlinPath, 'fun main() { println("kotlin-process") }\n');
		const java = await service.run({ path: javaPath, language: "java", cwd: jvmCwd });
		expect(java).toMatchObject({ exitCode: 0, stdout: "java-process\n", killed: false });

		const kotlin = await service.run({ path: kotlinPath, language: "kotlin", cwd: jvmCwd });
		expect(kotlin).toMatchObject({ exitCode: 0, stdout: "kotlin-process\n", killed: false });

		const project = await makeTempDir("aura-embedded-check-");
		await fs.writeFile(path.join(project, "package.json"), '{"name":"embedded-check","type":"module"}\n');
		await fs.writeFile(path.join(project, "main.ts"), 'console.log("check-me");\n');
		const checked = await service.check({ cwd: project, timeoutMs: 120_000 });
		expect(checked.exitCode).toBe(0);
		expect(checked.killed).toBe(false);
	}, 180_000);
});
