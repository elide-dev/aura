import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RuntimeService } from "../src/runtime/service";
import { LocalRuntimeEndpoint } from "../src/runtime/transport/local";
import { matchRuntimeEndpoint } from "../src/tools/runtime-launch";

const embeddedLib = process.env.AURA_RUNTIME_EMBEDDED_LIB;
const packagedBin =
	embeddedLib === undefined ? undefined : path.resolve(path.dirname(embeddedLib), "..", "bin", "elide");
const realBin = process.env.AURA_RUNTIME_BIN ?? process.env.ELIDE_BIN ?? packagedBin ?? Bun.which("elide") ?? undefined;

describe.skipIf(!realBin)("runtime integration (real binary)", () => {
	const svc = new RuntimeService(new LocalRuntimeEndpoint({ explicitPath: realBin, autoDownload: false }));

	test("status reports an available runtime >= 1.4", async () => {
		const s = await svc.status();
		expect(s.available).toBe(true);
		const [major = 0, minor = 0] = (s.version ?? "").split(".").map(n => Number.parseInt(n, 10));
		expect(major > 1 || (major === 1 && minor >= 4)).toBe(true);
	}, 180_000);

	test("runs inline TypeScript", async () => {
		const r = await svc.run({ code: 'console.log("aura" + ":" + (40 + 2))', language: "ts", timeoutMs: 120_000 });
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("aura:42");
	}, 180_000);

	test("runs inline Python (GraalPy)", async () => {
		const r = await svc.run({ code: 'print("py:" + str(21 * 2))', language: "python", timeoutMs: 120_000 });
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("py:42");
	}, 180_000);

	test("nonzero exit is reported, not thrown", async () => {
		const r = await svc.run({ code: "process.exit(3)", language: "js", timeoutMs: 120_000 });
		expect(r.exitCode).toBe(3);
	}, 180_000);

	describe("JVM flows", () => {
		const JAVA_HELLO =
			'public class Greeter { public static void main(String[] a) { System.out.println("jvm:" + (40 + 2)); } }';

		test("compiles and runs Java (javac --release 17 → java)", async () => {
			const r = await svc.jvm({ action: "run", language: "java", code: JAVA_HELLO, timeoutMs: 240_000 });
			expect(r.phase).toBe("run");
			expect(r.className).toBe("Greeter");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("jvm:42");
		}, 300_000);

		test("compiles and disassembles Java (javac → javap -c)", async () => {
			const r = await svc.jvm({ action: "disassemble", language: "java", code: JAVA_HELLO, timeoutMs: 240_000 });
			expect(r.phase).toBe("disassemble");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("Compiled from");
			expect(r.stdout).toContain("public static void main");
		}, 300_000);

		test("compiles and runs Kotlin (kotlinc → java, MainKt)", async () => {
			const r = await svc.jvm({
				action: "run",
				language: "kotlin",
				code: 'fun main() { println("kt:" + (40 + 2)) }',
				timeoutMs: 240_000,
			});
			expect(r.className).toBe("MainKt");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("kt:42");
		}, 300_000);

		test("a real compile error stops the flow at the compile phase", async () => {
			const r = await svc.jvm({
				action: "run",
				language: "java",
				code: "public class Broken { void x() { return 1 } }",
				timeoutMs: 240_000,
			});
			expect(r.phase).toBe("compile");
			expect(r.exitCode).not.toBe(0);
			expect(`${r.stdout}${r.stderr}`).toContain("error");
		}, 300_000);

		test("builds a jar into a real directory and refuses to clobber it", async () => {
			const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "aura-jvm-it-"));
			try {
				const built = await svc.jvm({
					action: "jar",
					language: "java",
					code: JAVA_HELLO,
					output: "dist/greeter.jar",
					cwd: workdir,
					timeoutMs: 240_000,
				});
				expect(built.exitCode).toBe(0);
				expect(built.output).toBe(path.join(workdir, "dist", "greeter.jar"));
				expect(built.listing).toContain("Greeter.class");
				expect(await Bun.file(path.join(workdir, "dist", "greeter.jar")).exists()).toBe(true);

				const again = svc.jvm({
					action: "jar",
					language: "java",
					code: JAVA_HELLO,
					output: "dist/greeter.jar",
					cwd: workdir,
					timeoutMs: 240_000,
				});
				await expect(again).rejects.toThrow("pass overwrite: true to replace it");

				const replaced = await svc.jvm({
					action: "jar",
					language: "java",
					code: JAVA_HELLO,
					output: "dist/greeter.jar",
					overwrite: true,
					cwd: workdir,
					timeoutMs: 240_000,
				});
				expect(replaced.exitCode).toBe(0);

				const listed = await svc.jvm({
					action: "jar",
					mode: "inspect",
					jar: "dist/greeter.jar",
					cwd: workdir,
					timeoutMs: 240_000,
				});
				expect(listed.listing).toContain("Greeter.class");
			} finally {
				await fs.rm(workdir, { recursive: true, force: true });
			}
		}, 600_000);

		test("formats Java source in place and hands back the result", async () => {
			const r = await svc.jvm({
				action: "format",
				language: "java",
				code: "public class Src {   public static void main(String[]a){int x=1;} }",
				timeoutMs: 240_000,
			});
			expect(r.exitCode).toBe(0);
			expect(r.formatted).toContain("public static void main(String[] a) {");
		}, 300_000);

		test("analyzes dependencies of compiled Java source", async () => {
			const r = await svc.jvm({ action: "deps", language: "java", code: JAVA_HELLO, timeoutMs: 240_000 });
			expect(r.exitCode).toBe(0);
			expect(`${r.stdout}${r.stderr}`).toContain("java.base");
		}, 300_000);
	});

	/**
	 * The one live check of the `runtime/spawn` composition: that the argv the
	 * endpoint composes actually starts a server on the pinned runtime, and that
	 * the descriptor's own scraping rule matches the banner that runtime prints.
	 * The process is spawned directly (not through `hub`) so this test owns the
	 * handle and can guarantee it never leaks — the hub path is covered
	 * separately, without a real runtime.
	 */

	describe("serve launch descriptor", () => {
		test("the composed argv serves a directory and prints a scrapable endpoint", async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aura-serve-live-"));
			await fs.writeFile(path.join(dir, "index.html"), "<h1>aura</h1>\n");
			// A high, unlikely-to-be-taken port; a collision shows up as a failed
			// scrape with the runtime's own message, not as a hang.
			const port = 41_000 + Math.floor(Math.random() * 2_000);
			const descriptor = await svc.spawn({ directory: dir, port, host: "127.0.0.1", cwd: dir });
			expect(descriptor.argv.slice(1)).toEqual([
				"serve",
				dir,
				"--no-tui",
				"--port",
				String(port),
				"--host",
				"127.0.0.1",
			]);
			const proc = Bun.spawn(descriptor.argv, {
				cwd: descriptor.cwd,
				env: { ...process.env, ...descriptor.env },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			try {
				// The banner lands on *stderr* on 1.4.x, which is exactly why the tool
				// scrapes hub's merged log stream rather than one pipe. Both are read
				// here so the test does not depend on which stream it is this release.
				let output = "";
				let endpoint: string | undefined;
				const scan = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
					const decoder = new TextDecoder();
					for await (const chunk of stream) {
						output += decoder.decode(chunk, { stream: true });
						endpoint ??= matchRuntimeEndpoint(output, descriptor.endpointPattern);
						if (endpoint !== undefined) return;
					}
				};
				// Raced, not awaited together: the stream that does *not* carry the
				// banner stays open for the life of the server, so waiting on both
				// would always burn the whole window.
				await Promise.race([scan(proc.stdout), scan(proc.stderr), Bun.sleep(90_000)]);
				expect(endpoint, `no endpoint scraped from:\n${output}`).toBe(`http://127.0.0.1:${port}`);
				const res = await fetch(`http://127.0.0.1:${port}/index.html`);
				expect(res.status).toBe(200);
				expect(await res.text()).toContain("aura");
			} finally {
				// Belt and braces: a server left running would hold the port for the
				// rest of the suite and beyond it.
				proc.kill("SIGTERM");
				const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(2_000).then(() => false)]);
				if (!exited) proc.kill("SIGKILL");
				await proc.exited;
				await fs.rm(dir, { recursive: true, force: true });
			}
		}, 180_000);
	});
});
