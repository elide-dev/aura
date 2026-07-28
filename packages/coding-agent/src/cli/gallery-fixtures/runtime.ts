/**
 * Gallery fixtures for the runtime tool family (`run`, `check`, `build`,
 * `insights`, `profile`, `project_advice`, the six `jvm_*` flows, and the
 * hub-backed `runtime_debug` / `serve`).
 *
 * The success/error envelopes are built by the two helpers below rather than
 * spelled out fourteen times: every one of these tools returns the same
 * `RuntimeExecResult` shape (or that shape plus a JVM flow's extras), so the
 * only per-tool data worth hand-writing is the args and the output text — which
 * is exactly what the gallery is there to show.
 */
import type { GalleryFixture, GalleryResult } from "./types";

/** A settled `RuntimeExecResult`, as the runtime tools attach it to `details`. */
function execResult(text: string, over: Record<string, unknown> = {}): GalleryResult {
	const exitCode = typeof over.exitCode === "number" ? over.exitCode : 0;
	return {
		content: [{ type: "text", text }],
		isError: exitCode !== 0,
		details: { exitCode, stdout: text, stderr: "", durationMs: 240, killed: false, ...over },
	};
}

/** A settled hub job, as `runtime_debug` / `serve` attach it to `details`. */
function jobResult(text: string, over: Record<string, unknown>): GalleryResult {
	return {
		content: [{ type: "text", text }],
		details: { mode: "serve", timedOut: false, startupOutput: text, argv: [], cwd: "/repo", ...over },
	};
}

export const runtimeFixtures: Record<string, GalleryFixture> = {
	run: {
		label: "Run",
		streamingArgs: { code: "const rows = await db.query(" },
		args: { code: 'const rows = await db.query("select 1");\nconsole.log(rows.length);', language: "ts" },
		result: execResult("1"),
		errorResult: execResult("--- stderr ---\nReferenceError: db is not defined\n(exit code 1)", { exitCode: 1 }),
	},

	check: {
		label: "Check",
		args: { cwd: "packages/api" },
		result: execResult("Resolved 41 dependencies. Compiled 128 sources."),
		errorResult: execResult("src/api/routes.ts:88:12 — cannot find symbol `Router`\n(exit code 2)", { exitCode: 2 }),
	},

	build: {
		label: "Build",
		streamingArgs: { targets: [":jvm"] },
		args: { targets: [":jvm", ":native"] },
		result: execResult("Built :jvm in 4.2s\nBuilt :native in 31.8s", { durationMs: 36_000 }),
		errorResult: execResult("Target :native failed: linker exited with 1\n(exit code 1)", { exitCode: 1 }),
	},

	insights: {
		label: "Insights",
		args: { path: "src/worker.ts", insightPath: "hooks/alloc-trace.js" },
		result: execResult("[alloc] 1284 objects, 3.1 MB peak\nworker finished"),
		errorResult: execResult("--- stderr ---\ninsight script threw: TypeError\n(exit code 1)", { exitCode: 1 }),
	},

	profile: {
		label: "Profile",
		args: { mode: "cpusampling", path: "src/worker.ts" },
		result: execResult(
			["Samples: 4102", "  61.2%  parseFrame", "  22.7%  decodeChunk", "   9.4%  gc", "   6.7%  (other)"].join("\n"),
		),
		errorResult: execResult("--- stderr ---\nprofiler could not attach\n(exit code 1)", { exitCode: 1 }),
	},

	project_advice: {
		label: "Project Advice",
		args: {},
		result: execResult(
			[
				"This project builds with the project manifest at ./elide.pkl.",
				"  build:  build :jvm",
				"  test:   test --coverage",
				"  serve:  serve public/",
			].join("\n"),
		),
		errorResult: execResult("no project manifest found in this directory\n(exit code 1)", { exitCode: 1 }),
	},

	jvm_run: {
		label: "JVM Run",
		streamingArgs: { language: "java", code: "public class Main { public static v" },
		args: {
			language: "java",
			code: 'public class Main {\n  public static void main(String[] a) {\n    System.out.println("hi");\n  }\n}',
		},
		result: execResult("hi", { action: "run", phase: "run", language: "java", className: "Main" }),
		errorResult: execResult("Main.java:3: error: ';' expected\n(exit code 1)", {
			exitCode: 1,
			action: "run",
			phase: "compile",
			language: "java",
		}),
	},

	jvm_disassemble: {
		label: "JVM Disassemble",
		args: { language: "java", code: "public class Main { static int add(int a, int b) { return a + b; } }" },
		result: execResult(
			["  static int add(int, int);", "    0: iload_0", "    1: iload_1", "    2: iadd", "    3: ireturn"].join(
				"\n",
			),
			{ action: "disassemble", phase: "disassemble", language: "java", className: "Main" },
		),
		errorResult: execResult("Main.java:1: error: class expected\n(exit code 1)", {
			exitCode: 1,
			action: "disassemble",
			phase: "compile",
			language: "java",
		}),
	},

	jvm_format: {
		label: "JVM Format",
		args: { language: "kotlin", code: 'fun main( ){println( "hi" )}' },
		result: execResult('fun main() {\n    println("hi")\n}', {
			action: "format",
			phase: "format",
			language: "kotlin",
		}),
		errorResult: execResult("formatter rejected the input: unbalanced braces\n(exit code 1)", {
			exitCode: 1,
			action: "format",
			phase: "format",
			language: "kotlin",
		}),
	},

	jvm_jar: {
		label: "JVM Jar",
		args: { action: "create", language: "java", code: "public class Main {}", output: "build/app.jar" },
		result: execResult("Built build/app.jar (main class Main).\n[contents]\nMETA-INF/MANIFEST.MF\nMain.class", {
			action: "jar",
			phase: "jar",
			language: "java",
			className: "Main",
			output: "/repo/build/app.jar",
			listing: "META-INF/MANIFEST.MF\nMain.class",
		}),
		errorResult: execResult("build/app.jar already exists; pass overwrite: true to replace it\n(exit code 1)", {
			exitCode: 1,
			action: "jar",
			phase: "jar",
		}),
	},

	jvm_deps: {
		label: "JVM Deps",
		args: { path: "build/app.jar" },
		result: execResult("java.base\n  java.lang\n  java.util\njava.sql", {
			action: "deps",
			phase: "deps",
			className: "Main",
		}),
		errorResult: execResult("build/app.jar: not a class, jar, or class directory\n(exit code 1)", {
			exitCode: 1,
			action: "deps",
			phase: "deps",
		}),
	},

	jvm_javadoc: {
		label: "JVM Javadoc",
		args: { code: "/** Entry point. */\npublic class Main {}", output: "docs/api" },
		result: execResult("Generated 12 entries into docs/api", {
			action: "javadoc",
			phase: "javadoc",
			output: "/repo/docs/api",
			entryCount: 12,
			topLevel: ["index.html", "Main.html"],
		}),
		errorResult: execResult("docs/api already exists; pass overwrite: true to replace it\n(exit code 1)", {
			exitCode: 1,
			action: "javadoc",
			phase: "javadoc",
		}),
	},

	runtime_debug: {
		label: "Runtime Debug",
		args: { path: "src/worker.ts", protocol: "cdp" },
		result: jobResult(
			[
				"CDP debugger listening at ws://127.0.0.1:4242/session/1",
				"Open it in Chrome DevTools. The program is suspended until a client attaches.",
				"Job: runtime-debug-cdp-1a2b3c4d (use hub logs / hub stop).",
			].join("\n"),
			{
				mode: "debug",
				jobName: "runtime-debug-cdp-1a2b3c4d",
				endpoint: "ws://127.0.0.1:4242/session/1",
				state: "running",
			},
		),
		errorResult: jobResult("The CDP debugger printed no endpoint within 15s.", {
			mode: "debug",
			jobName: "runtime-debug-cdp-7e6f5a4b",
			timedOut: true,
		}),
	},

	serve: {
		label: "Serve",
		args: { directory: "public", port: 8080 },
		result: jobResult(
			[
				"Serving /repo/public at http://127.0.0.1:8080",
				"Job: runtime-serve-9f8e7d6c (use hub logs / hub stop).",
			].join("\n"),
			{ jobName: "runtime-serve-9f8e7d6c", endpoint: "http://127.0.0.1:8080", state: "running" },
		),
		errorResult: jobResult("The static file server printed no endpoint within 15s.", {
			jobName: "runtime-serve-3c2b1a09",
			timedOut: true,
		}),
	},
};
