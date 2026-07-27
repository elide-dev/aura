import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RuntimeService } from "../src/runtime/service";
import { LocalRuntimeEndpoint } from "../src/runtime/transport/local";

const realBin = process.env.AURA_RUNTIME_BIN ?? process.env.ELIDE_BIN ?? Bun.which("elide") ?? undefined;

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
});
