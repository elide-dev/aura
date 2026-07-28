import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { RenderResultOptions } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { toolRenderers } from "@oh-my-pi/pi-coding-agent/tools/renderers";
import { RUNTIME_RENDERER_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/runtime-renderer";

const WIDTH = 100;
const OPTIONS: RenderResultOptions = { expanded: false, isPartial: false };

let uiTheme: Theme;

beforeEach(async () => {
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	const loaded = await themeModule.getThemeByName("dark");
	expect(loaded).toBeDefined();
	uiTheme = loaded!;
});

afterEach(() => {
	resetSettingsForTest();
});

const call = (tool: string, args: unknown, options: RenderResultOptions = OPTIONS): string => {
	const renderer = toolRenderers[tool];
	expect(renderer, `no renderer registered for ${tool}`).toBeDefined();
	return Bun.stripANSI(renderer.renderCall(args, options, uiTheme).render(WIDTH).join("\n"));
};

const settled = (
	tool: string,
	result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
	args?: unknown,
	options: RenderResultOptions = OPTIONS,
): string => {
	const renderer = toolRenderers[tool];
	expect(renderer, `no renderer registered for ${tool}`).toBeDefined();
	return Bun.stripANSI(renderer.renderResult(result, options, uiTheme, args).render(WIDTH).join("\n"));
};

/** A settled exec result as `formatExecResult` + the central spill leave it. */
const exec = (over: Partial<Record<string, unknown>> = {}) => ({
	exitCode: 0,
	stdout: "",
	stderr: "",
	durationMs: 120,
	killed: false,
	...over,
});

describe("runtime tool renderers: registration", () => {
	it("registers a renderer for every runtime tool", () => {
		for (const name of RUNTIME_RENDERER_TOOL_NAMES) {
			expect(toolRenderers[name], `${name} has no renderer`).toBeDefined();
		}
	});

	it("merges the call into the result frame", () => {
		// The result header restates the whole call line, so leaving the pending
		// call painted above it would double every runtime row in the transcript.
		for (const name of RUNTIME_RENDERER_TOOL_NAMES) {
			expect(toolRenderers[name].mergeCallAndResult, `${name} does not merge`).toBe(true);
		}
	});

	it("covers the five core runtime tools, the six JVM tools, and the two job tools", () => {
		expect([...RUNTIME_RENDERER_TOOL_NAMES].sort()).toEqual(
			[
				"build",
				"check",
				"insights",
				"jvm_deps",
				"jvm_disassemble",
				"jvm_format",
				"jvm_jar",
				"jvm_javadoc",
				"jvm_run",
				"profile",
				"project_advice",
				"run",
				"runtime_debug",
				"serve",
			].sort(),
		);
	});
});

describe("run", () => {
	it("shows language and inline-vs-path on the call line", () => {
		expect(call("run", { code: "console.log(1)" })).toContain("Run");
		expect(call("run", { code: "console.log(1)" })).toContain("inline");
		expect(call("run", { code: "console.log(1)" })).toContain("ts");
		expect(call("run", { code: "print(1)", language: "python" })).toContain("python");
		expect(call("run", { path: "scripts/build.ts" })).toContain("scripts/build.ts");
		// A path run is not "inline" — the distinction is the whole point of the line.
		expect(call("run", { path: "scripts/build.ts" })).not.toContain("inline");
	});

	it("summarizes a successful run without an exit-code note", () => {
		const text = settled("run", { content: [{ type: "text", text: "hello" }], details: exec() }, { code: "x" });
		expect(text).toContain("Run");
		expect(text).toContain("hello");
		expect(text).not.toContain("exit");
	});

	it("surfaces the exit code and stderr preview on a failed run", () => {
		const text = settled(
			"run",
			{
				content: [{ type: "text", text: "--- stderr ---\nReferenceError: nope" }],
				isError: true,
				details: exec({ exitCode: 1, stderr: "ReferenceError: nope" }),
			},
			{ code: "nope()" },
		);
		expect(text).toContain("exit 1");
		expect(text).toContain("ReferenceError: nope");
	});

	it("does not print the exit annotation twice", () => {
		// `formatExecResult` bakes `(exit code N)` into the model-facing body; the
		// header already carries it, so the body must not repeat it — the same
		// reason `bash` strips its own exit-code notice before previewing.
		const text = settled(
			"run",
			{
				content: [{ type: "text", text: "boom\n(exit code 3)" }],
				isError: true,
				details: exec({ exitCode: 3 }),
			},
			{ code: "x" },
		);
		expect(text).toContain("exit 3");
		expect(text).not.toContain("(exit code 3)");
		expect(text).toContain("boom");
	});

	it("drops a body that was only the no-output annotation", () => {
		const text = settled(
			"run",
			{ content: [{ type: "text", text: "(no output, exit code 0)" }], details: exec() },
			{ code: "x" },
		);
		expect(text).not.toContain("no output, exit code");
		expect(text).toContain("Run");
	});

	it("reports a killed run", () => {
		const text = settled(
			"run",
			{ content: [{ type: "text", text: "" }], details: exec({ exitCode: 137, killed: true }) },
			{ code: "while(true){}" },
		);
		expect(text).toContain("killed");
	});
});

describe("check and build", () => {
	it("shows pass on a clean check and fail on a broken one", () => {
		expect(settled("check", { content: [{ type: "text", text: "ok" }], details: exec() }, {})).toContain("passed");
		const failed = settled(
			"check",
			{ content: [{ type: "text", text: "boom" }], isError: true, details: exec({ exitCode: 2 }) },
			{},
		);
		expect(failed).toContain("failed");
		expect(failed).toContain("exit 2");
	});

	it("shows the requested build targets on the call line and pass/fail on the result", () => {
		expect(call("build", { targets: [":jvm", ":native"] })).toContain(":jvm :native");
		expect(call("build", {})).toContain("default targets");
		const text = settled(
			"build",
			{ content: [{ type: "text", text: "BUILD OK" }], details: exec() },
			{ targets: [":jvm"] },
		);
		expect(text).toContain("Build");
		expect(text).toContain(":jvm");
		expect(text).toContain("passed");
	});
});

describe("insights and profile", () => {
	it("shows the insight script source", () => {
		expect(call("insights", { code: "x", insightPath: "hooks/trace.js" })).toContain("hooks/trace.js");
		expect(call("insights", { code: "x", insight: "// inline hook" })).toContain("inline insight");
	});

	it("shows the profiler mode", () => {
		expect(call("profile", { mode: "cpusampling", code: "x" })).toContain("cpusampling");
		const text = settled(
			"profile",
			{ content: [{ type: "text", text: "Total: 12ms" }], details: exec() },
			{ mode: "cputracing", code: "x" },
		);
		expect(text).toContain("cputracing");
	});
});

describe("jvm tools", () => {
	it("shows the action and main class for jvm_run", () => {
		expect(call("jvm_run", { language: "java", code: "class Main {}", mainClass: "Main" })).toContain("JVM Run");
		expect(call("jvm_run", { language: "java", code: "class Main {}", mainClass: "Main" })).toContain("Main");
		const text = settled(
			"jvm_run",
			{
				content: [{ type: "text", text: "hi" }],
				details: exec({ action: "run", phase: "run", language: "java", className: "Main" }),
			},
			{ language: "java", code: "class Main {}" },
		);
		expect(text).toContain("Main");
		expect(text).toContain("hi");
	});

	it("reports the phase a failed JVM flow stopped at", () => {
		const text = settled(
			"jvm_run",
			{
				content: [{ type: "text", text: "Main.java:1: error: bad" }],
				isError: true,
				details: exec({ exitCode: 1, action: "run", phase: "compile", language: "java" }),
			},
			{ language: "java", code: "class Main {" },
		);
		expect(text).toContain("compile");
		expect(text).toContain("error: bad");
	});

	it("shows the written output path for jvm_jar and jvm_javadoc", () => {
		const jar = settled(
			"jvm_jar",
			{
				content: [{ type: "text", text: "Built app.jar" }],
				details: exec({ action: "jar", phase: "jar", className: "Main", output: "/tmp/app.jar" }),
			},
			{ action: "create", language: "java", code: "class Main {}" },
		);
		expect(jar).toContain("/tmp/app.jar");

		const javadoc = settled(
			"jvm_javadoc",
			{
				content: [{ type: "text", text: "done" }],
				details: exec({ action: "javadoc", phase: "javadoc", output: "/tmp/javadoc-out", entryCount: 7 }),
			},
			{ code: "class Main {}" },
		);
		expect(javadoc).toContain("/tmp/javadoc-out");
		expect(javadoc).toContain("7");
	});
});

describe("runtime_debug and serve", () => {
	it("shows the endpoint and the hub job handle", () => {
		const debug = settled(
			"runtime_debug",
			{
				content: [{ type: "text", text: "CDP debugger listening at ws://127.0.0.1:4242/x" }],
				details: {
					mode: "debug",
					jobName: "runtime-debug-cdp-1a2b3c4d",
					endpoint: "ws://127.0.0.1:4242/x",
					timedOut: false,
					startupOutput: "",
					argv: ["elide"],
					cwd: "/repo",
				},
			},
			{ path: "app.ts" },
		);
		expect(debug).toContain("ws://127.0.0.1:4242/x");
		expect(debug).toContain("runtime-debug-cdp-1a2b3c4d");

		const serve = settled(
			"serve",
			{
				content: [{ type: "text", text: "Serving /repo/public at http://127.0.0.1:8080" }],
				details: {
					mode: "serve",
					jobName: "runtime-serve-9f8e7d6c",
					endpoint: "http://127.0.0.1:8080",
					timedOut: false,
					startupOutput: "",
					argv: ["elide", "serve", "/repo/public"],
					cwd: "/repo",
				},
			},
			{ directory: "public" },
		);
		expect(serve).toContain("http://127.0.0.1:8080");
		expect(serve).toContain("runtime-serve-9f8e7d6c");
	});

	it("says so when no endpoint was scraped inside the wait window", () => {
		const text = settled(
			"serve",
			{
				content: [{ type: "text", text: "no endpoint" }],
				details: {
					mode: "serve",
					jobName: "runtime-serve-1",
					timedOut: true,
					startupOutput: "",
					argv: [],
					cwd: "/repo",
				},
			},
			{ directory: "public" },
		);
		expect(text).toContain("no endpoint");
		expect(text).toContain("timed out");
		// A launched-but-unscraped job is not a failure (the process may be fine),
		// so the frame warns rather than erroring — but it must not read as clean.
		expect(text.startsWith(" ")).toBe(true);
		expect(Bun.stripANSI(uiTheme.symbol("status.warning"))).toBeTruthy();
		expect(text).toContain(Bun.stripANSI(uiTheme.symbol("status.warning")));
	});

	it("errors — not warns — when the launch itself failed", () => {
		// A rejected launch also has no endpoint, so the endpoint-less warning path
		// must not swallow it.
		const text = settled(
			"runtime_debug",
			{
				content: [{ type: "text", text: "hub refused to start the process" }],
				isError: true,
				details: {
					mode: "debug",
					jobName: "runtime-debug-cdp-2",
					timedOut: false,
					startupOutput: "",
					argv: [],
					cwd: "/repo",
				},
			},
			{ path: "app.ts" },
		);
		expect(text).toContain(Bun.stripANSI(uiTheme.symbol("status.error")));
		expect(text).not.toContain(Bun.stripANSI(uiTheme.symbol("status.warning")));
	});

	it("shows the target on the call line", () => {
		expect(call("runtime_debug", { path: "app.ts", protocol: "dap" })).toContain("app.ts");
		expect(call("runtime_debug", { path: "app.ts", protocol: "dap" })).toContain("dap");
		expect(call("serve", { directory: "public", port: 9000 })).toContain("public");
		expect(call("serve", { directory: "public", port: 9000 })).toContain("9000");
	});
});

describe("project_advice", () => {
	it("shows the project name", () => {
		expect(call("project_advice", { cwd: "/home/dev/my-project" })).toContain("my-project");
		const text = settled(
			"project_advice",
			{ content: [{ type: "text", text: "Run tests with: elide test" }], details: exec() },
			{ cwd: "/home/dev/my-project" },
		);
		expect(text).toContain("my-project");
		expect(text).toContain("Run tests with");
	});
});

describe("spilled output", () => {
	it("shows the artifact reference the central spill attached", () => {
		const text = settled(
			"run",
			{
				content: [{ type: "text", text: "tail of the output" }],
				details: exec({
					meta: {
						truncation: {
							direction: "tail",
							truncatedBy: "bytes",
							totalLines: 9000,
							totalBytes: 900000,
							outputLines: 40,
							outputBytes: 4000,
							maxBytes: 4000,
							shownRange: { start: 8961, end: 9000 },
							artifactId: "art-123",
						},
					},
				}),
			},
			{ code: "x" },
		);
		expect(text).toContain("artifact://art-123");
		expect(text).toContain("tail of the output");
	});
});

describe("naming rule", () => {
	it("never says Elide in a rendered runtime frame", () => {
		const frames = [
			call("run", { code: "x" }),
			call("check", {}),
			call("build", { targets: [":jvm"] }),
			call("insights", { code: "x" }),
			call("profile", { mode: "cputracing", code: "x" }),
			call("project_advice", {}),
			call("jvm_run", { language: "java", code: "class Main {}" }),
			call("jvm_deps", { path: "app.jar" }),
			call("jvm_format", { language: "kotlin", code: "fun main(){}" }),
			call("jvm_disassemble", { language: "java", code: "class Main {}" }),
			call("jvm_jar", { action: "inspect", jar: "app.jar" }),
			call("jvm_javadoc", { code: "class Main {}" }),
			call("runtime_debug", { path: "app.ts" }),
			call("serve", { directory: "public" }),
		];
		for (const frame of frames) {
			expect(frame.toLowerCase()).not.toContain("elide");
		}
	});
});
