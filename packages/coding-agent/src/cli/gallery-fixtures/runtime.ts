/**
 * Gallery fixtures for `insights`, `profile`, the four specialized `jvm_*`
 * flows, and the hub-backed `serve` tool.
 *
 * The success/error envelopes are built by the two helpers below rather than
 * repeated for every tool: the execution tools return the same
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

/** A settled hub job, as `serve` attaches it to `details`. */
function jobResult(text: string, over: Record<string, unknown>): GalleryResult {
	return {
		content: [{ type: "text", text }],
		details: { timedOut: false, startupOutput: text, argv: [], cwd: "/repo", ...over },
	};
}

export const runtimeFixtures: Record<string, GalleryFixture> = {
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
