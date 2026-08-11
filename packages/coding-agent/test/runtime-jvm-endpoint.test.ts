import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RuntimeJvmParams, RuntimeJvmResult, RuntimeRunResult } from "../src/runtime/protocol";
import { createRequest, type RuntimeRpcError, unwrapResponse } from "../src/runtime/protocol";
import { LocalRuntimeEndpoint } from "../src/runtime/transport/local";
import { SelectedRuntimeEndpoint } from "../src/runtime/transport/selected";

let dir: string;
let fakeBin: string;
let bundledBin: string;
let failingJavac: string;
let log: string;

/**
 * A fake runtime that records every invocation (argv plus the JDK env it was
 * handed) to `$AURA_FAKE_LOG`, and materializes the artifacts the multi-step
 * flows copy out of the workdir. Recording to a file rather than stdout is what
 * makes the *intermediate* invocations of a flow assertable — only the last
 * one's streams reach the caller.
 */
const FAKE_BODY = `#!/bin/sh
printf 'ARGS:%s\\n' "$*" >> "$AURA_FAKE_LOG"
if [ "$1" = "--version" ]; then echo "9.9.9-fake"; exit 0; fi
printf 'JAVA_HOME=[%s] JDK_HOME=[%s]\\n' "$JAVA_HOME" "$JDK_HOME" >> "$AURA_FAKE_LOG"
if [ "$1" = "javac" ]; then
  for a in "$@"; do
    case "$a" in *.java) touch "\${a%.java}.class" ;; esac
  done
fi
if [ "$1" = "kotlinc" ]; then mkdir -p out && touch out/MainKt.class; fi
if [ "$1" = "java" ]; then IFS= read -r input || true; printf 'STDIN:%s\\n' "$input" >> "$AURA_FAKE_LOG"; fi
if [ "$1" = "jar" ]; then
  case "$*" in *--create*) : > aura-out.jar ;; esac
fi
echo "ARGS:$*"
`;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "aura-jvm-"));
	fakeBin = path.join(dir, "elide");
	log = path.join(dir, "invocations.log");
	await fs.writeFile(fakeBin, FAKE_BODY, { mode: 0o755 });
	const bundledRoot = path.join(dir, "bundle");
	bundledBin = path.join(bundledRoot, "bin", "elide");
	const kotlinLib = path.join(bundledRoot, "lib", "resources", "kotlin", "2.4.0", "lib");
	await fs.mkdir(path.dirname(bundledBin), { recursive: true });
	await fs.mkdir(kotlinLib, { recursive: true });
	await fs.writeFile(bundledBin, FAKE_BODY, { mode: 0o755 });
	await fs.writeFile(path.join(kotlinLib, "kotlin-stdlib.jar"), "");
	failingJavac = path.join(dir, "elide-badjavac");
	await fs.writeFile(
		failingJavac,
		`#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.9.9-fake"; exit 0; fi
printf 'ARGS:%s\\n' "$*" >> "$AURA_FAKE_LOG"
if [ "$1" = "javac" ]; then echo "Main.java:1: error: boom" >&2; exit 1; fi
echo "ARGS:$*"
`,
		{ mode: 0o755 },
	);
});

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
	await fs.writeFile(log, "");
});

/** Endpoint over a fake binary, with a preset JDK in the env so stripping is observable. */
function endpoint(bin = fakeBin): LocalRuntimeEndpoint {
	return new LocalRuntimeEndpoint({
		explicitPath: bin,
		autoDownload: false,
		env: { ...process.env, AURA_FAKE_LOG: log, JAVA_HOME: "/opt/jdk17", JDK_HOME: "/opt/jdk17" },
	});
}

async function jvm(params: RuntimeJvmParams, bin = fakeBin): Promise<RuntimeJvmResult> {
	return unwrapResponse<RuntimeJvmResult>(await endpoint(bin).request(createRequest("runtime/jvm", params)));
}

/** The `runtime/jvm` call's error, or a failure if it unexpectedly succeeded. */
async function jvmError(params: RuntimeJvmParams): Promise<RuntimeRpcError> {
	const res = await endpoint().request(createRequest("runtime/jvm", params));
	try {
		unwrapResponse(res);
	} catch (e) {
		return e as RuntimeRpcError;
	}
	throw new Error("expected the call to fail");
}

/** Recorded argv lines, with the fake binary path elided so assertions read like the composed command. */
async function invocations(): Promise<string[]> {
	const text = await fs.readFile(log, "utf8");
	return text
		.split("\n")
		.filter(line => line.startsWith("ARGS:"))
		.map(line => line.slice("ARGS:".length).replace(`${fakeBin} `, "").replace(`${failingJavac} `, ""));
}

const JAVA_HELLO = 'public class Main { public static void main(String[] a) { System.out.println("hi"); } }';

describe("runtime/jvm — argv per action", () => {
	test("run compiles with the pinned bytecode release, then runs the derived class", async () => {
		const r = await jvm({ action: "run", language: "java", code: JAVA_HELLO });
		expect(r.action).toBe("run");
		expect(r.phase).toBe("run");
		expect(r.className).toBe("Main");
		expect(await invocations()).toEqual(["javac -- --release 17 Main.java", "java -- -cp . Main"]);
	});

	test("run compiles Kotlin into out/ and runs MainKt from there", async () => {
		const r = await jvm({ action: "run", language: "kotlin", code: 'fun main() { println("hi") }' });
		expect(r.className).toBe("MainKt");
		expect(await invocations()).toEqual(["kotlinc -- Main.kt -cp . -d out", "java -- -cp out MainKt"]);
	});

	test("run adds the adjacent bundled Kotlin libraries to the runtime classpath", async () => {
		await jvm({ action: "run", language: "kotlin", code: 'fun main() { println("hi") }' }, bundledBin);
		const kotlinLib = path.join(dir, "bundle", "lib", "resources", "kotlin", "2.4.0", "lib", "*");
		expect(await invocations()).toEqual([
			"kotlinc -- Main.kt -cp . -d out",
			`java -- -cp out${path.delimiter}${kotlinLib} MainKt`,
		]);
	});

	test("an explicit mainClass names both the source file and the run target", async () => {
		await jvm({ action: "run", language: "java", code: "class Other {}", mainClass: "Entry" });
		expect(await invocations()).toEqual(["javac -- --release 17 Entry.java", "java -- -cp . Entry"]);
	});

	test("run accepts program arguments and stdin without feeding them to the compiler", async () => {
		await jvm({ action: "run", language: "java", code: JAVA_HELLO, args: ["one", "two"], stdin: "payload\n" });
		expect(await invocations()).toEqual(["javac -- --release 17 Main.java", "java -- -cp . Main one two"]);
		expect(await fs.readFile(log, "utf8")).toContain("STDIN:payload");
	});

	test("unified run reads a Java source path and reports the resolved engine", async () => {
		const source = path.join(dir, "FromFile.java");
		await fs.writeFile(
			source,
			'public class FromFile { public static void main(String[] args) { System.out.println("file"); } }',
		);
		const local = endpoint();
		const selected = new SelectedRuntimeEndpoint({
			adapter: "process",
			processEndpoint: local,
			embeddedEndpoint: local,
		});
		const result = unwrapResponse<RuntimeRunResult & RuntimeJvmResult>(
			await selected.request(
				createRequest("runtime/run", {
					path: source,
					language: "java",
					args: ["value"],
					stdin: "input\n",
				}),
			),
		);
		expect(result).toMatchObject({
			action: "run",
			phase: "run",
			className: "FromFile",
			engine: "elide",
			language: "java",
		});
		const calls = await invocations();
		expect(calls[0]).toBe("javac -- --release 17 FromFile.java");
		expect(calls[1]).toEndWith(" FromFile value");
		await selected.close();
	});
	test("disassemble javaps the compiled class", async () => {
		const r = await jvm({ action: "disassemble", language: "java", code: JAVA_HELLO });
		expect(r.phase).toBe("disassemble");
		expect(await invocations()).toEqual(["javac -- --release 17 Main.java", "javap -- -c Main"]);
	});

	test("disassemble points javap at out/ for Kotlin", async () => {
		await jvm({ action: "disassemble", language: "kotlin", code: "fun main() {}" });
		expect((await invocations())[1]).toBe("javap -- -c -classpath out MainKt");
	});

	test("format runs the in-place formatter and reads the source back", async () => {
		const r = await jvm({ action: "format", language: "java", code: "public class Src {}" });
		expect(await invocations()).toEqual(["javaformat --allow-write -- -i Source.java"]);
		// The fake formatter does not rewrite the file, so what comes back is what went in —
		// what matters is that the formatted source is read from the workdir, not from stdout.
		expect(r.formatted).toBe("public class Src {}");
	});

	test("format uses ktfmt for Kotlin", async () => {
		const r = await jvm({ action: "format", language: "kotlin", code: "fun main() {}" });
		expect(await invocations()).toEqual(["ktfmt --allow-write -- Source.kt"]);
		expect(r.formatted).toBe("fun main() {}");
	});

	test("deps analyzes the compiled class in source mode", async () => {
		const r = await jvm({ action: "deps", language: "java", code: JAVA_HELLO });
		expect(r.phase).toBe("deps");
		expect(await invocations()).toEqual(["javac -- --release 17 Main.java", "jdeps -- Main.class"]);
	});
	test("deps accepts a Java source path and compiles it in scratch space", async () => {
		const source = path.join(dir, "SourceDeps.java");
		await fs.writeFile(source, "public class SourceDeps {}");
		const r = await jvm({ action: "deps", path: "SourceDeps.java", cwd: dir });
		expect(r).toMatchObject({ phase: "deps", language: "java", className: "SourceDeps" });
		expect(await invocations()).toEqual(["javac -- --release 17 SourceDeps.java", "jdeps -- SourceDeps.class"]);
	});

	test("deps writes its successful report to a guarded project output", async () => {
		const output = path.join(dir, "deps-report.txt");
		const r = await jvm({
			action: "deps",
			language: "java",
			code: JAVA_HELLO,
			output: "deps-report.txt",
			cwd: dir,
		});
		expect(r.output).toBe(output);
		expect(await fs.readFile(output, "utf8")).toBe("ARGS:jdeps -- Main.class\n");
	});

	test("deps analyzes out/ in Kotlin source mode", async () => {
		await jvm({ action: "deps", language: "kotlin", code: "fun main() {}" });
		expect((await invocations())[1]).toBe("jdeps -- out");
	});

	test("deps in artifact mode jdeps the resolved path without compiling", async () => {
		const target = path.join(dir, "Thing.class");
		await fs.writeFile(target, "");
		const r = await jvm({ action: "deps", path: "Thing.class", cwd: dir });
		expect(r.phase).toBe("deps");
		expect(await invocations()).toEqual([`jdeps -- ${target}`]);
	});
	test("deps refuses to replace an existing report without overwrite", async () => {
		const output = path.join(dir, "existing-deps.txt");
		await fs.writeFile(output, "keep");
		const err = await jvmError({
			action: "deps",
			language: "java",
			code: JAVA_HELLO,
			output: "existing-deps.txt",
			cwd: dir,
		});
		expect(err.message).toBe(`Refusing to overwrite ${output} — pass overwrite: true to replace it.`);
		expect(await fs.readFile(output, "utf8")).toBe("keep");
		expect(await invocations()).toEqual([]);
	});
});

describe("runtime/jvm — compile failures", () => {
	test("a failed compile is reported as the compiler saw it and the flow stops", async () => {
		const r = await jvm({ action: "run", language: "java", code: JAVA_HELLO }, failingJavac);
		expect(r.phase).toBe("compile");
		expect(r.action).toBe("run");
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("error: boom");
		// No `java` invocation followed the failed compile.
		expect(await invocations()).toEqual(["javac -- --release 17 Main.java"]);
	});
});

describe("runtime/jvm — jar", () => {
	test("create compiles, jars the class files, copies the artifact out, and lists it", async () => {
		const dest = path.join(dir, "build", "app.jar");
		const r = await jvm({ action: "jar", language: "java", code: JAVA_HELLO, output: "build/app.jar", cwd: dir });
		expect(r.output).toBe(dest);
		expect(r.className).toBe("Main");
		expect(r.listing).toContain("ARGS:");
		expect(await invocations()).toEqual([
			"javac -- --release 17 Main.java",
			"jar -- --create --file aura-out.jar --main-class Main Main.class",
			"jar -- --list --file aura-out.jar",
		]);
		expect(await fs.stat(dest).then(s => s.isFile())).toBe(true);
		await fs.rm(path.join(dir, "build"), { recursive: true, force: true });
	});

	test("create jars the Kotlin output directory", async () => {
		await jvm({ action: "jar", language: "kotlin", code: "fun main() {}", output: "kt.jar", cwd: dir });
		expect((await invocations())[1]).toBe("jar -- --create --file aura-out.jar --main-class MainKt -C out .");
		await fs.rm(path.join(dir, "kt.jar"), { force: true });
	});

	test("create refuses an existing output and names the flag that authorizes it", async () => {
		const dest = path.join(dir, "taken.jar");
		await fs.writeFile(dest, "existing");
		const err = await jvmError({
			action: "jar",
			language: "java",
			code: JAVA_HELLO,
			output: "taken.jar",
			cwd: dir,
		});
		expect(err.code).toBe("invalid-params");
		expect(err.message).toBe(`Refusing to overwrite ${dest} — pass overwrite: true to replace it.`);
		expect(err.data).toEqual({ output: dest });
		// The guard runs before anything is spawned, and the file is untouched.
		expect(await invocations()).toEqual([]);
		expect(await fs.readFile(dest, "utf8")).toBe("existing");
	});

	test("overwrite true replaces the existing output", async () => {
		const dest = path.join(dir, "replaceme.jar");
		await fs.writeFile(dest, "existing");
		const r = await jvm({
			action: "jar",
			language: "java",
			code: JAVA_HELLO,
			output: "replaceme.jar",
			overwrite: true,
			cwd: dir,
		});
		expect(r.output).toBe(dest);
		expect(await fs.readFile(dest, "utf8")).not.toBe("existing");
		await fs.rm(dest, { force: true });
	});

	test("create without output is invalid-params naming the required fields", async () => {
		const err = await jvmError({ action: "jar", language: "java", code: JAVA_HELLO });
		expect(err.code).toBe("invalid-params");
		expect(err.message).toBe(
			"jvm_jar create requires `language`, `code`, and `output` (cwd-relative path for the built jar).",
		);
	});

	test("inspect without jar is invalid-params", async () => {
		const err = await jvmError({ action: "jar", mode: "inspect" });
		expect(err.message).toBe("jvm_jar inspect requires `jar` (path to an existing .jar).");
	});

	test("inspect of a missing jar names the resolved path", async () => {
		const err = await jvmError({ action: "jar", mode: "inspect", jar: "ghost.jar", cwd: dir });
		expect(err.code).toBe("invalid-params");
		expect(err.message).toBe(`No jar found at ${path.join(dir, "ghost.jar")}.`);
	});

	test("inspect lists an existing jar by absolute path", async () => {
		const jarPath = path.join(dir, "there.jar");
		await fs.writeFile(jarPath, "");
		const r = await jvm({ action: "jar", mode: "inspect", jar: "there.jar", cwd: dir });
		expect(r.jar).toBe(jarPath);
		expect(r.listing).toContain("--list");
		expect(await invocations()).toEqual([`jar -- --list --file ${jarPath}`]);
	});

	test("deps of a missing input names the resolved path", async () => {
		const err = await jvmError({ action: "deps", path: "ghost.class", cwd: dir });
		expect(err.message).toBe(
			`No JVM source, class, JAR, or class directory found at ${path.join(dir, "ghost.class")}.`,
		);
	});
});

describe("runtime/jvm — output paths are bound to the working directory", () => {
	/** A scratch project with a sentinel file and a sentinel subdirectory. */
	async function project(): Promise<string> {
		const root = await fs.mkdtemp(path.join(dir, "proj-"));
		await fs.writeFile(path.join(root, "README.md"), "keep me");
		await fs.mkdir(path.join(root, "src"), { recursive: true });
		await fs.writeFile(path.join(root, "src", "Thing.java"), "class Thing {}");
		return root;
	}

	/** Every path an existing project must survive, whatever `overwrite` says. */
	const OUT_OF_BOUNDS = [".", "..", "./", path.join("..", "sibling"), path.join("src", "..")];

	test("deps refuses an output that is the working directory or above it, even with overwrite", async () => {
		for (const output of OUT_OF_BOUNDS) {
			const root = await project();
			const err = await jvmError({
				action: "deps",
				language: "java",
				code: JAVA_HELLO,
				output,
				overwrite: true,
				cwd: root,
			});
			expect(err.code, `expected ${output} to be refused`).toBe("invalid-params");
			expect(err.message).toContain("output must be a path inside the working directory");
			expect(await invocations()).toEqual([]);
			expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe("keep me");
			expect(await fs.readdir(root)).toContain("src");
		}
	});

	test("a symlinked prefix cannot smuggle file output outside the working directory", async () => {
		const root = await project();
		const outside = await fs.mkdtemp(path.join(dir, "outside-"));
		await fs.mkdir(path.join(outside, "docs"), { recursive: true });
		await fs.writeFile(path.join(outside, "docs", "PRECIOUS.txt"), "irreplaceable");
		await fs.symlink(outside, path.join(root, "link"), "dir");

		for (const params of [
			{
				action: "deps" as const,
				language: "java" as const,
				code: JAVA_HELLO,
				output: "link/deps.txt",
				overwrite: true,
				cwd: root,
			},
			{
				action: "jar" as const,
				language: "java" as const,
				code: JAVA_HELLO,
				output: "link/out.jar",
				overwrite: true,
				cwd: root,
			},
		]) {
			const err = await jvmError(params);
			expect(err.code, `expected ${params.output} to be refused`).toBe("invalid-params");
			expect(err.message).toContain("output must be a path inside the working directory");
			expect(await invocations()).toEqual([]);
		}
		expect(await fs.readFile(path.join(outside, "docs", "PRECIOUS.txt"), "utf8")).toBe("irreplaceable");
		expect(await fs.readdir(outside)).toEqual(["docs"]);
	});

	test("a destination symlink cannot redirect dependency output", async () => {
		const root = await project();
		const outside = await fs.mkdtemp(path.join(dir, "outside-file-"));
		const target = path.join(outside, "deps.txt");
		await fs.writeFile(target, "keep");
		await fs.symlink(target, path.join(root, "deps.txt"));
		const err = await jvmError({
			action: "deps",
			language: "java",
			code: JAVA_HELLO,
			output: "deps.txt",
			overwrite: true,
			cwd: root,
		});
		expect(err.code).toBe("invalid-params");
		expect(err.message).toContain("output must be a path inside the working directory");
		expect(await fs.readFile(target, "utf8")).toBe("keep");
		expect(await invocations()).toEqual([]);
	});

	test("a symlink pointing inside the working directory still accepts dependency output", async () => {
		const root = await project();
		await fs.mkdir(path.join(root, "real"), { recursive: true });
		await fs.symlink(path.join(root, "real"), path.join(root, "inside-link"), "dir");
		const r = await jvm({
			action: "deps",
			language: "java",
			code: JAVA_HELLO,
			output: "inside-link/deps.txt",
			cwd: root,
		});
		expect(r.output).toBe(path.join(root, "inside-link", "deps.txt"));
		expect(await fs.readFile(path.join(root, "real", "deps.txt"), "utf8")).toContain("jdeps");
	});

	test("jar create refuses an output that is the working directory or above it", async () => {
		for (const output of OUT_OF_BOUNDS) {
			const root = await project();
			const err = await jvmError({
				action: "jar",
				language: "java",
				code: JAVA_HELLO,
				output,
				overwrite: true,
				cwd: root,
			});
			expect(err.code, `expected ${output} to be refused`).toBe("invalid-params");
			expect(err.message).toContain("output must be a path inside the working directory");
			expect(await invocations()).toEqual([]);
			expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe("keep me");
		}
	});

	test("jar create onto an existing directory is invalid-params, not an internal error", async () => {
		const root = await project();
		const err = await jvmError({
			action: "jar",
			language: "java",
			code: JAVA_HELLO,
			output: "src",
			overwrite: true,
			cwd: root,
		});
		expect(err.code).toBe("invalid-params");
		expect(err.message).toBe(`Refusing to write the jar to ${path.join(root, "src")} — it is an existing directory.`);
		expect(await invocations()).toEqual([]);
		expect(await fs.readFile(path.join(root, "src", "Thing.java"), "utf8")).toBe("class Thing {}");
	});
});

describe("runtime/jvm — shared behaviour", () => {
	test("the host's preset JDK never reaches a JVM invocation", async () => {
		await jvm({ action: "run", language: "java", code: JAVA_HELLO });
		const env = (await fs.readFile(log, "utf8")).split("\n").filter(l => l.startsWith("JAVA_HOME="));
		expect(env.length).toBe(2);
		for (const line of env) expect(line).toBe("JAVA_HOME=[] JDK_HOME=[]");
	});

	test("an empty path takes the source branch instead of analyzing the whole cwd", async () => {
		const err = await jvmError({ action: "deps", path: "", cwd: dir });
		expect(err.message).toBe(
			"jvm_deps requires `path` (source, .class, .jar, or class directory) or `language` + `code`.",
		);
		expect(await invocations()).toEqual([]);
	});

	test("a mainClass that is not a class name is refused before anything is spawned", async () => {
		const err = await jvmError({ action: "run", language: "java", code: JAVA_HELLO, mainClass: "-Xshare:off" });
		expect(err.code).toBe("invalid-params");
		expect(err.message).toContain("-Xshare:off");
		expect(await invocations()).toEqual([]);
	});

	test("missing language or code is invalid-params per action", async () => {
		expect((await jvmError({ action: "run", code: JAVA_HELLO })).message).toBe(
			"run requires `language` and code or path.",
		);
		expect((await jvmError({ action: "disassemble", language: "java" })).message).toBe(
			"jvm_disassemble requires `language` and `code`.",
		);
		expect((await jvmError({ action: "format", language: "java" })).message).toBe(
			"jvm_format requires `language` and `code`.",
		);
		expect((await jvmError({ action: "deps" })).message).toBe(
			"jvm_deps requires `path` (source, .class, .jar, or class directory) or `language` + `code`.",
		);
	});

	test("an unknown action is invalid-params", async () => {
		const err = await jvmError({ action: "teleport" } as unknown as RuntimeJvmParams);
		expect(err.code).toBe("invalid-params");
		expect(err.message).toBe("Unknown jvm action teleport.");
	});

	test("timeoutMs reaches the JVM invocations", async () => {
		const slow = path.join(dir, "elide-slow");
		await fs.writeFile(slow, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "9.9.9-fake"; exit 0; fi\nsleep 5\n`, {
			mode: 0o755,
		});
		const r = await jvm({ action: "run", language: "java", code: JAVA_HELLO, timeoutMs: 200 }, slow);
		expect(r.killed).toBe(true);
		expect(r.phase).toBe("compile");
	}, 15_000);
});
