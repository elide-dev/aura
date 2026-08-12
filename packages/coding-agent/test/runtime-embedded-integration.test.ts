import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Settings } from "../src/config/settings";
import {
	decodeEmbeddedResponse,
	type EmbeddedContextInvocation,
	type EmbeddedContextSpecInput,
	type EmbeddedControlOperation,
	type EmbeddedDecodedResponse,
	type EmbeddedEvalResult,
	EmbeddedFailureCode,
	encodeContextCall,
	encodeContextControl,
	encodeOpenRequest,
} from "../src/runtime/embedded/codec";
import { EMBEDDED_RUNTIME_ABI_VERSION, EMBEDDED_RUNTIME_SCHEMA_SHA256 } from "../src/runtime/embedded/schema";
import { EmbeddedWorkerHost, pumpEmbeddedContextOutput } from "../src/runtime/embedded/worker-core";
import { RuntimeService } from "../src/runtime/service";
import { SelectedRuntimeEndpoint } from "../src/runtime/transport/selected";
import type { ToolSession } from "../src/tools";
import { RuntimeProfileTool } from "../src/tools/runtime-profile";

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

/** Drops the dev-build artifact's isolate-teardown GC summary; every other stderr byte survives. */
function stripRuntimeGcSummaries(stderr: string): string {
	return stderr.replace(/GC summary\n(?:[ \t]+[^\n]*\n)+/g, "");
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
	options: {
		adapter?: "process" | "embedded" | "auto";
		embeddedPath?: string;
		explicitPath?: string;
		env?: NodeJS.ProcessEnv;
	} = {},
): RuntimeService {
	return new RuntimeService(
		new SelectedRuntimeEndpoint({
			adapter: options.adapter ?? "embedded",
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
	}, 120_000);

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
		const javascript = await service.run({ code: "console.log('inline-js')", language: "js", engine: "elide" });
		expect(javascript).toMatchObject({ exitCode: 0, stdout: "inline-js\n", stderr: "", killed: false });

		const typescript = await service.run({
			code: "const answer: number = 42; console.log('inline-ts:' + answer)",
			language: "ts",
			engine: "elide",
		});
		expect(typescript).toMatchObject({ exitCode: 0, stdout: "inline-ts:42\n", stderr: "", killed: false });

		const python = await service.run({ code: 'print("inline-python")', language: "python" });
		expect(python).toMatchObject({ exitCode: 0, stdout: "inline-python\n", stderr: "", killed: false });
	}, 120_000);

	test("runs through a source runtime tool with isolated embedded settings", async () => {
		const settings = Settings.isolated({
			"runtime.enabled": true,
			"runtime.adapter": "embedded",
			"runtime.embeddedPath": embeddedPath,
			"runtime.path": processPath,
			"runtime.autoDownload": false,
		});
		const tool = RuntimeProfileTool.createIf({
			cwd: process.cwd(),
			settings,
			getRuntimeService: () => service,
		} as unknown as ToolSession);
		if (!tool) throw new Error("runtime profile tool was disabled by isolated settings");
		const result = await tool.execute(
			"task-5-source-tool-smoke",
			{ mode: "cpusampling", code: "console.log('source-tool-smoke')", language: "js" },
			new AbortController().signal,
		);
		const text = result.content.find(block => block.type === "text")?.text ?? "";
		expect(text).toContain("source-tool-smoke");
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

		const result = await service.run({ path: entry, language: "ts", engine: "elide", cwd: requestedCwd });
		expect(result).toMatchObject({
			exitCode: 0,
			stdout: `sibling:resolved\ncwd:${requestedCwd}\n`,
			stderr: "",
			killed: false,
		});
	}, 120_000);

	test("preserves Python file identity across embedded and process adapters", async () => {
		const directory = await makeTempDir("aura-embedded-python-file-");
		const entry = path.join(directory, "main.py");
		await fs.writeFile(entry, "from pathlib import Path\nprint(Path(__file__).resolve())\n");

		const [embeddedPython, processPython] = await Promise.all([
			service.run({ path: entry, language: "python", cwd: directory }),
			processService.run({ path: entry, language: "python", cwd: directory }),
		]);
		for (const result of [embeddedPython, processPython]) {
			expect(result).toMatchObject({ exitCode: 0, stdout: `${entry}\n`, stderr: "", killed: false });
		}
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

		const firstModuleRun = await service.run({ path: entry, language: "ts", engine: "elide" });
		expect(firstModuleRun).toMatchObject({ exitCode: 0, stdout: "1,2\n", stderr: "", killed: false });
		const secondModuleRun = await service.run({ path: entry, language: "ts", engine: "elide" });
		expect(secondModuleRun).toMatchObject({ exitCode: 0, stdout: "1,2\n", stderr: "", killed: false });

		const firstContext = await service.run({
			code: "globalThis.__auraEmbeddedLeak = 'one'; console.log('first-context')",
			language: "js",
			engine: "elide",
		});
		expect(firstContext.stdout).toBe("first-context\n");
		const secondContext = await service.run({
			code: "if ('__auraEmbeddedLeak' in globalThis) throw new Error('global leaked'); console.log('isolated-context')",
			language: "js",
			engine: "elide",
		});
		expect(secondContext).toMatchObject({
			exitCode: 0,
			stdout: "isolated-context\n",
			stderr: "",
			killed: false,
		});
	}, 120_000);

	test("returns stable guest syntax and runtime errors without poisoning reuse", async () => {
		const syntax = await service.run({ code: "const = broken", language: "js", engine: "elide" });
		expect(syntax.exitCode).not.toBe(0);
		expect(syntax.stderr).toContain("SyntaxError");
		expect(syntax.stderr).not.toContain("\u001b[");

		const runtime = await service.run({
			code: "throw new TypeError('embedded-stable-error')",
			language: "js",
			engine: "elide",
		});
		expect(runtime.exitCode).not.toBe(0);
		expect(runtime.stderr).toMatch(/^TypeError: embedded-stable-error(?:\n|$)/);
		expect(runtime.stderr).not.toContain("\u001b[");

		const reuse = await service.run({ code: "console.log('reused-after-error')", language: "js", engine: "elide" });
		expect(reuse).toMatchObject({ exitCode: 0, stdout: "reused-after-error\n", stderr: "", killed: false });
	}, 120_000);

	test("times out an active call within a bound and reuses the runtime", async () => {
		const startedAt = performance.now();
		const timedOut = await service.run({
			code: "while (true) {}",
			language: "js",
			engine: "elide",
			timeoutMs: 1_000,
		});
		expect(timedOut).toMatchObject({ exitCode: 1, stdout: "", stderr: "", killed: true });
		expect(performance.now() - startedAt).toBeLessThan(15_000);

		const reuse = await service.run({ code: "console.log('reused-after-timeout')", language: "js", engine: "elide" });
		expect(reuse).toMatchObject({ exitCode: 0, stdout: "reused-after-timeout\n", stderr: "", killed: false });
	}, 120_000);

	test("cancels an active call within a bound and reuses the runtime", async () => {
		const controller = new AbortController();
		const startedAt = performance.now();
		const active = service.run({ code: "while (true) {}", language: "js", engine: "elide" }, controller.signal);
		// Native execution has no test-only "entered call" hook; a short real delay lets the warmed engine enter the infinite guest.
		await Bun.sleep(500);
		controller.abort();
		await expect(active).rejects.toMatchObject({ code: "cancelled" });
		expect(performance.now() - startedAt).toBeLessThan(15_000);

		const reuse = await service.run({ code: "console.log('reused-after-cancel')", language: "js", engine: "elide" });
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
		const first = service
			.run({ code: "while (true) {}", language: "js", engine: "elide" }, firstController.signal)
			.finally(() => {
				firstSettled = true;
			});
		// Native execution has no test-only "entered call" hook; let the warmed engine enter before queueing two calls.
		await Bun.sleep(500);
		const second = service
			.run({ code: "console.log('fifo-second')", language: "js", engine: "elide" }, secondController.signal)
			.then(result => {
				completionOrder.push("second");
				return result;
			})
			.finally(() => {
				secondSettled = true;
			});
		const third = service
			.run({ code: "console.log('fifo-third')", language: "js", engine: "elide" }, thirdController.signal)
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
				`const result = await service.run({ code: "console.log('dispose-child')", language: "js", engine: "elide" });`,
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
		// A dev-build artifact writes a GraalVM `-R:+PrintGCSummary` block to the host's stderr when the
		// isolate tears down. It is the embedded library polluting its caller's stderr, not Aura output —
		// WHIPLASH already strips the flag from its tools-library image (build.mts:1699-1701) but not yet
		// from the embedded facade. Everything else on stderr is still a failure.
		expect(stripRuntimeGcSummaries(stderr)).toBe("");
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
			await expect(
				missing.run({ code: "console.log('must-not-run')", language: "js", engine: "elide" }),
			).rejects.toMatchObject({
				code: "runtime-missing",
				message: missingLibraryGuidance,
			});
			expect(await exists(marker)).toBe(false);
		} finally {
			await missing.close();
		}
	}, 120_000);

	test("runs Java and Kotlin through auto selection while check uses the process adapter", async () => {
		const embeddedJvm = createService({ adapter: "auto" });
		try {
			const java = await embeddedJvm.jvm({
				action: "run",
				language: "java",
				code: 'import java.util.List; public class Main { record Item(int value) {} public static void main(String[] args) { System.out.println("java-embedded:" + List.of(new Item(20), new Item(22)).stream().mapToInt(Item::value).sum()); } }',
			});
			expect(java).toMatchObject({
				action: "run",
				phase: "run",
				language: "java",
				className: "Main",
				exitCode: 0,
				stdout: "java-embedded:42\n",
				killed: false,
			});

			const kotlin = await embeddedJvm.jvm({
				action: "run",
				language: "kotlin",
				code: 'data class Item(val value: Int)\nfun main() { println("kotlin-embedded:" + listOf(Item(20), Item(22)).sumOf { it.value }) }',
			});
			expect(kotlin).toMatchObject({
				action: "run",
				phase: "run",
				language: "kotlin",
				className: "MainKt",
				exitCode: 0,
				stdout: "kotlin-embedded:42\n",
				killed: false,
			});
			expect((await embeddedJvm.status()).effectiveAdapter).toBe("embedded");
		} finally {
			await embeddedJvm.close();
		}

		const project = await makeTempDir("aura-embedded-check-");
		await fs.writeFile(path.join(project, "package.json"), '{"name":"embedded-check","type":"module"}\n');
		await fs.writeFile(path.join(project, "main.ts"), 'console.log("check-me");\n');
		const checked = await service.check({ cwd: project, timeoutMs: 120_000 });
		expect(checked.exitCode).toBe(0);
		expect(checked.killed).toBe(false);
	}, 180_000);
});

/**
 * One session, driven at the transport seam rather than through `RuntimeService`, because Tier 2's
 * contract lives below the one-shot `run()` surface: an eval on the execution worker with control
 * ops arriving concurrently on the control worker.
 */
class ContextSession {
	readonly host = new EmbeddedWorkerHost();
	#nextRequestId = 0n;

	async open(): Promise<void> {
		const opened = await this.host.open(embeddedPath, encodeOpenRequest({ languages: ["js", "ts", "python"] }));
		const response = decodeEmbeddedResponse(opened.response, 0n);
		if (response.type !== "opened") throw new Error(`embedded runtime open returned ${response.type}`);
	}

	async control(operation: EmbeddedControlOperation): Promise<EmbeddedDecodedResponse> {
		const requestId = this.#requestId();
		return decodeEmbeddedResponse(
			await this.host.contextControl(encodeContextControl(requestId, operation)),
			requestId,
		);
	}

	async openContext(spec: EmbeddedContextSpecInput): Promise<bigint> {
		const response = await this.control({ type: "open", spec });
		if (response.type !== "context-opened") {
			throw new Error(`context open returned ${response.type}: ${JSON.stringify(response)}`);
		}
		return response.contextId;
	}

	evaluate(
		contextId: bigint,
		invocation: Omit<EmbeddedContextInvocation, "contextId">,
	): Promise<EmbeddedDecodedResponse> {
		const requestId = this.#requestId();
		const request = encodeContextCall(requestId, { ...invocation, contextId });
		return this.host
			.contextCall(requestId, contextId, request)
			.then(bytes => decodeEmbeddedResponse(bytes, requestId));
	}

	async evalResult(
		contextId: bigint,
		invocation: Omit<EmbeddedContextInvocation, "contextId">,
	): Promise<EmbeddedEvalResult> {
		const response = await this.evaluate(contextId, invocation);
		if (response.type !== "eval-result") {
			throw new Error(`context eval returned ${response.type}: ${JSON.stringify(response, replaceBigints)}`);
		}
		return response.result;
	}

	close(): Promise<void> {
		return this.host.shutdown();
	}

	#requestId(): bigint {
		this.#nextRequestId += 1n;
		return this.#nextRequestId;
	}
}

function replaceBigints(_key: string, value: unknown): unknown {
	return typeof value === "bigint" ? value.toString() : value;
}

function js(code: string): Omit<EmbeddedContextInvocation, "contextId"> {
	return { language: "js", source: { type: "content", code }, sourceName: "cell.js", mode: "interactive" };
}

describe.skipIf(!applicable).serial("Tier 2 persistent contexts (real embedded library)", () => {
	let session: ContextSession;

	beforeAll(async () => {
		session = new ContextSession();
		await session.open();
	}, 120_000);

	afterAll(async () => {
		await session.close();
	}, 120_000);

	test("reports the capability matrix the ABI 2 build landed", async () => {
		const contextId = await session.openContext({ languages: ["js"], label: "capabilities" });
		const described = await session.control({ type: "describe", contextId });
		if (described.type !== "description") throw new Error(`describe returned ${described.type}`);

		expect(described.capabilities).toMatchObject({
			streaming: true,
			reset: true,
			interrupt: true,
			mainScriptMode: true,
			threadedContexts: true,
			hostCalls: false,
			captureResultValue: false,
		});
		expect(described.capabilities.maxContexts).toBe(64);
		// 63 MiB, not 64: the budget is the wire envelope minus response headroom.
		expect(described.capabilities.maxOutputBytes).toBe(66_060_288n);
		expect(described.label).toBe("capabilities");
		expect(described.languages).toEqual(["js"]);
		await session.control({ type: "close", contextId });
	}, 120_000);

	test("keeps guest state across evals in one context", async () => {
		const contextId = await session.openContext({ languages: ["js"] });
		try {
			const first = await session.evalResult(contextId, js("globalThis.counter = 1; console.log('set')"));
			expect(first.outcome).toEqual({ type: "ok" });
			expect(first.stdout).toBe("set\n");
			expect(first.contextAlive).toBe(true);

			const second = await session.evalResult(contextId, js("globalThis.counter += 1; console.log(counter)"));
			expect(second.outcome).toEqual({ type: "ok" });
			expect(second.stdout).toBe("2\n");
		} finally {
			await session.control({ type: "close", contextId });
		}
	}, 120_000);

	test("isolates two contexts on one session and never deduplicates a byte-identical spec", async () => {
		const spec: EmbeddedContextSpecInput = { languages: ["js"], label: "twin" };
		const first = await session.openContext(spec);
		const second = await session.openContext(spec);
		try {
			expect(second).not.toBe(first);

			await session.evalResult(first, js("globalThis.mine = 'first'"));
			const isolated = await session.evalResult(
				second,
				js("console.log(typeof globalThis.mine === 'undefined' ? 'isolated' : 'leaked')"),
			);
			expect(isolated.stdout).toBe("isolated\n");
		} finally {
			await session.control({ type: "close", contextId: first });
			await session.control({ type: "close", contextId: second });
		}
	}, 120_000);

	test("survives a guest exit: the eval ends, the context and its globals do not", async () => {
		const contextId = await session.openContext({ languages: ["js"] });
		try {
			await session.evalResult(contextId, js("globalThis.beforeExit = 'kept'"));
			const exited = await session.evalResult(contextId, js("console.log('exiting'); process.exit(3)"));

			expect(exited.outcome.type).toBe("error");
			if (exited.outcome.type !== "error") throw new Error("expected an error outcome");
			expect(exited.outcome.error.isExit).toBe(true);
			expect(exited.outcome.error.exitStatus).toBe(3);
			expect(exited.exitCode).toBe(3);
			expect(exited.contextAlive).toBe(true);
			expect(exited.stdout).toBe("exiting\n");

			const after = await session.evalResult(contextId, js("console.log(globalThis.beforeExit)"));
			expect(after.outcome).toEqual({ type: "ok" });
			expect(after.stdout).toBe("kept\n");
		} finally {
			await session.control({ type: "close", contextId });
		}
	}, 120_000);

	test("returns a guest error as a value with its type, message, and no ANSI escapes", async () => {
		const contextId = await session.openContext({ languages: ["js"] });
		try {
			const thrown = await session.evalResult(contextId, js("throw new TypeError('context-error')"));
			expect(thrown.contextAlive).toBe(true);
			if (thrown.outcome.type !== "error") throw new Error("expected an error outcome");
			expect(thrown.outcome.error.typeName).toContain("TypeError");
			expect(thrown.outcome.error.message).toContain("context-error");
			expect(thrown.outcome.error.isExit).toBe(false);
			expect(JSON.stringify(thrown.outcome.error)).not.toContain("[");

			const reuse = await session.evalResult(contextId, js("console.log('reused')"));
			expect(reuse.stdout).toBe("reused\n");
		} finally {
			await session.control({ type: "close", contextId });
		}
	}, 120_000);

	test("interrupts a running eval from the control worker and leaves guest state intact", async () => {
		const contextId = await session.openContext({ languages: ["js"] });
		try {
			await session.evalResult(contextId, js("globalThis.survivor = 'alive'"));
			const running = session.evaluate(contextId, js("while (true) {}"));
			// Native execution has no test-only "entered guest" hook; a short real delay is the idiom here.
			await Bun.sleep(500);

			const interrupted = await session.control({ type: "interrupt", contextId, timeoutMillis: 10_000 });
			expect(interrupted.type).toBe("context-ack");

			const settled = await running;
			if (settled.type !== "eval-result") throw new Error(`interrupted eval returned ${settled.type}`);
			// Either arm is an interrupt landing: a bare `interrupted` outcome, or a cancelled guest error.
			expect(["interrupted", "error"]).toContain(settled.result.outcome.type);
			if (settled.result.outcome.type === "error") expect(settled.result.outcome.error.isCancelled).toBe(true);
			expect(settled.result.contextAlive).toBe(true);

			const after = await session.evalResult(contextId, js("console.log(globalThis.survivor)"));
			expect(after.stdout).toBe("alive\n");
		} finally {
			await session.control({ type: "close", contextId });
		}
	}, 120_000);

	test("reset discards guest state while keeping the context id usable", async () => {
		const contextId = await session.openContext({ languages: ["js"] });
		try {
			await session.evalResult(contextId, js("globalThis.doomed = 'present'"));
			const reset = await session.control({ type: "reset", contextId });
			expect(reset.type).toBe("context-ack");

			const after = await session.evalResult(
				contextId,
				js("console.log(typeof globalThis.doomed === 'undefined' ? 'cleared' : 'survived')"),
			);
			expect(after.stdout).toBe("cleared\n");

			const described = await session.control({ type: "describe", contextId });
			if (described.type !== "description") throw new Error(`describe returned ${described.type}`);
			expect(described.resetCount).toBeGreaterThan(0n);
		} finally {
			await session.control({ type: "close", contextId });
		}
	}, 120_000);

	test("drains a streaming eval in sequence order from the control worker", async () => {
		const contextId = await session.openContext({ languages: ["js"], streamOutput: true, outputChunkBytes: 64 });
		try {
			const lines = 40;
			let settled = false;
			const evaluation = session
				.evaluate(contextId, js(`for (let index = 0; index < ${lines}; index += 1) console.log('line-' + index)`))
				.finally(() => {
					settled = true;
				});

			const stdout: Uint8Array[] = [];
			const seqs: bigint[] = [];
			const drain = await pumpEmbeddedContextOutput({
				poll: () => session.control({ type: "poll-output", contextId, waitMillis: 50, maxBytes: 65_536 }),
				onChunk: chunk => {
					seqs.push(chunk.seq);
					if (chunk.stream === "stdout") stdout.push(chunk.data);
				},
				isEvalSettled: () => settled,
				evalSettlement: evaluation.then(
					() => undefined,
					() => undefined,
				),
			});

			const result = await evaluation;
			if (result.type !== "eval-result") throw new Error(`streaming eval returned ${result.type}`);
			expect(result.result.outcome).toEqual({ type: "ok" });
			// A streaming context reports empty buffered output; the pump holds the bytes.
			expect(result.result.stdout).toBe("");
			expect(drain.closed).toBe(false);

			const joined = new Uint8Array(stdout.reduce((total, chunk) => total + chunk.byteLength, 0));
			let offset = 0;
			for (const chunk of stdout) {
				joined.set(chunk, offset);
				offset += chunk.byteLength;
			}
			const expected = Array.from({ length: lines }, (_, index) => `line-${index}`).join("\n");
			expect(new TextDecoder().decode(joined)).toBe(`${expected}\n`);
			expect(seqs).toEqual([...seqs].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
			expect(new Set(seqs).size).toBe(seqs.length);
		} finally {
			await session.control({ type: "close", contextId });
		}
	}, 120_000);

	test("answers a closed context id with unknownContext on both eval and describe", async () => {
		const contextId = await session.openContext({ languages: ["js"] });
		expect((await session.control({ type: "close", contextId })).type).toBe("context-ack");

		const evaluated = await session.evaluate(contextId, js("console.log('gone')"));
		expect(evaluated).toMatchObject({ type: "failure", code: EmbeddedFailureCode.UNKNOWN_CONTEXT });
		const described = await session.control({ type: "describe", contextId });
		expect(described).toMatchObject({ type: "failure", code: EmbeddedFailureCode.UNKNOWN_CONTEXT });
	}, 120_000);

	test("answers an unimplemented capability with unsupportedOperation rather than internal", async () => {
		const contextId = await session.openContext({ languages: ["js"] });
		try {
			const captured = await session.evaluate(contextId, { ...js("1 + 1"), captureResultValue: true });
			expect(captured).toMatchObject({ type: "failure", code: EmbeddedFailureCode.UNSUPPORTED_OPERATION });
		} finally {
			await session.control({ type: "close", contextId });
		}
	}, 120_000);

	test("runs a Python context alongside a JavaScript one on the same session", async () => {
		const python = await session.openContext({ languages: ["python"], primaryLanguage: "python" });
		const javascript = await session.openContext({ languages: ["js"] });
		try {
			const first = await session.evalResult(python, {
				language: "python",
				source: { type: "content", code: "state = 41" },
				sourceName: "cell.py",
				mode: "interactive",
			});
			expect(first.outcome).toEqual({ type: "ok" });
			const second = await session.evalResult(python, {
				language: "python",
				source: { type: "content", code: "state += 1\nprint(state)" },
				sourceName: "cell.py",
				mode: "interactive",
			});
			expect(second.stdout).toBe("42\n");

			const isolated = await session.evalResult(javascript, js("console.log(typeof state)"));
			expect(isolated.stdout).toBe("undefined\n");
		} finally {
			await session.control({ type: "close", contextId: python });
			await session.control({ type: "close", contextId: javascript });
		}
	}, 120_000);
});
