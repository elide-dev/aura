import { describe, expect, test } from "bun:test";
import type { RuntimeJvmParams, RuntimeJvmResult } from "../src/runtime/protocol";
import type { ToolSession } from "../src/tools";
import { JvmDepsTool } from "../src/tools/jvm-deps";
import { JvmDisassembleTool } from "../src/tools/jvm-disassemble";
import { JvmFormatTool } from "../src/tools/jvm-format";
import { JvmJarTool } from "../src/tools/jvm-jar";
import { JvmJavadocTool } from "../src/tools/jvm-javadoc";
import { JvmRunTool } from "../src/tools/jvm-run";

const SESSION_CWD = "/work/project";

function ok(extra: Partial<RuntimeJvmResult>): RuntimeJvmResult {
	return {
		exitCode: 0,
		stdout: "",
		stderr: "",
		durationMs: 5,
		killed: false,
		action: "run",
		phase: "run",
		...extra,
	};
}

/** A session whose runtime service records the `runtime/jvm` params and returns `result`. */
function sessionReturning(result: RuntimeJvmResult): { session: ToolSession; seen: () => RuntimeJvmParams } {
	let received: RuntimeJvmParams | undefined;
	const session = {
		cwd: SESSION_CWD,
		settings: { get: (key: string) => (key === "runtime.enabled" ? true : undefined) },
		getRuntimeService: () => ({
			jvm: async (params: RuntimeJvmParams) => {
				received = params;
				return result;
			},
		}),
	} as unknown as ToolSession;
	return {
		session,
		seen: () => {
			if (!received) throw new Error("the service was never called");
			return received;
		},
	};
}

function textOf(result: { content: { type: string }[] }): string {
	return (result.content[0] as unknown as { text: string }).text;
}

const SIGNAL = new AbortController().signal;

describe("jvm_run", () => {
	test("maps to the run action with the session cwd and renders the program's streams", async () => {
		const { session, seen } = sessionReturning(
			ok({ stdout: "hi\n", className: "Main", language: "java", action: "run", phase: "run" }),
		);
		const tool = JvmRunTool.createIf(session);
		const out = await tool!.execute("id", { language: "java", code: "public class Main {}" }, SIGNAL);
		expect(seen()).toEqual({ action: "run", language: "java", code: "public class Main {}", cwd: SESSION_CWD });
		expect(textOf(out)).toBe("hi");
		expect(out.details?.className).toBe("Main");
	});

	test("a failed compile surfaces the compiler's diagnostics and the exit code", async () => {
		const { session } = sessionReturning(
			ok({ exitCode: 1, stderr: "Main.java:1: error: ';' expected", phase: "compile" }),
		);
		const out = await JvmRunTool.createIf(session)!.execute("id", { language: "java", code: "bad" }, SIGNAL);
		expect(textOf(out)).toContain("error: ';' expected");
		expect(textOf(out)).toContain("(exit code 1)");
	});
});

describe("jvm_disassemble", () => {
	test("renders the javap listing on success", async () => {
		const { session, seen } = sessionReturning(
			ok({ action: "disassemble", phase: "disassemble", stdout: "  0: aload_0\n", className: "Main" }),
		);
		const out = await JvmDisassembleTool.createIf(session)!.execute(
			"id",
			{ language: "java", code: "class Main {}", mainClass: "Main" },
			SIGNAL,
		);
		expect(seen().action).toBe("disassemble");
		expect(seen().mainClass).toBe("Main");
		expect(textOf(out)).toBe("  0: aload_0");
	});

	test("an empty listing is stated rather than shown as nothing", async () => {
		const { session } = sessionReturning(ok({ action: "disassemble", phase: "disassemble", stdout: "" }));
		const out = await JvmDisassembleTool.createIf(session)!.execute(
			"id",
			{ language: "java", code: "class Main {}" },
			SIGNAL,
		);
		expect(textOf(out)).toBe("(no output)");
	});
});

describe("jvm_format", () => {
	test("returns the formatted source, not the formatter's own chatter", async () => {
		const { session, seen } = sessionReturning(
			ok({
				action: "format",
				phase: "format",
				stdout: "Formatted 1 Java sources",
				formatted: "public class Src {}",
			}),
		);
		const out = await JvmFormatTool.createIf(session)!.execute(
			"id",
			{ language: "java", code: "public class  Src{}" },
			SIGNAL,
		);
		expect(seen().action).toBe("format");
		expect(textOf(out)).toBe("public class Src {}");
	});
});

describe("jvm_jar", () => {
	test("create maps the tool action onto the protocol's jar mode and reports the artifact", async () => {
		const { session, seen } = sessionReturning(
			ok({
				action: "jar",
				phase: "jar",
				output: "/work/project/build/app.jar",
				className: "Main",
				listing: "META-INF/\nMain.class",
			}),
		);
		const out = await JvmJarTool.createIf(session)!.execute(
			"id",
			{ action: "create", language: "java", code: "public class Main {}", output: "build/app.jar" },
			SIGNAL,
		);
		expect(seen()).toEqual({
			action: "jar",
			mode: "create",
			language: "java",
			code: "public class Main {}",
			output: "build/app.jar",
			cwd: SESSION_CWD,
		});
		expect(textOf(out)).toBe(
			"Built /work/project/build/app.jar (main class Main).\n[contents]\nMETA-INF/\nMain.class",
		);
	});

	test("inspect reports the listed archive", async () => {
		const { session, seen } = sessionReturning(
			ok({ action: "jar", phase: "jar", jar: "/work/project/lib/dep.jar", listing: "a/B.class" }),
		);
		const out = await JvmJarTool.createIf(session)!.execute("id", { action: "inspect", jar: "lib/dep.jar" }, SIGNAL);
		expect(seen()).toEqual({ action: "jar", mode: "inspect", jar: "lib/dep.jar", cwd: SESSION_CWD });
		expect(textOf(out)).toBe("Entries of /work/project/lib/dep.jar:\na/B.class");
	});

	test("overwrite is forwarded so the endpoint guard can be authorized", async () => {
		const { session, seen } = sessionReturning(ok({ action: "jar", phase: "jar", output: "/x.jar" }));
		await JvmJarTool.createIf(session)!.execute(
			"id",
			{ action: "create", language: "java", code: "class Main {}", output: "x.jar", overwrite: true },
			SIGNAL,
		);
		expect(seen().overwrite).toBe(true);
	});

	test("a failed jar invocation renders the toolchain's output", async () => {
		const { session } = sessionReturning(ok({ action: "jar", phase: "jar", exitCode: 2, stderr: "no such file" }));
		const out = await JvmJarTool.createIf(session)!.execute("id", { action: "inspect", jar: "gone.jar" }, SIGNAL);
		expect(textOf(out)).toContain("no such file");
		expect(textOf(out)).toContain("(exit code 2)");
	});
});

describe("jvm_deps", () => {
	test("artifact mode forwards path and renders the jdeps report", async () => {
		const { session, seen } = sessionReturning(
			ok({ action: "deps", phase: "deps", stdout: "Main.class -> java.base\n" }),
		);
		const out = await JvmDepsTool.createIf(session)!.execute("id", { path: "out/Main.class" }, SIGNAL);
		expect(seen()).toEqual({ action: "deps", path: "out/Main.class", cwd: SESSION_CWD });
		expect(textOf(out)).toBe("Main.class -> java.base");
	});
});

describe("jvm_javadoc", () => {
	test("reports the written tree, its size, and how to browse it", async () => {
		const { session, seen } = sessionReturning(
			ok({
				action: "javadoc",
				phase: "javadoc",
				className: "Widget",
				output: "/work/project/apidocs",
				entryCount: 42,
				topLevel: ["index.html", "Widget.html"],
			}),
		);
		const out = await JvmJavadocTool.createIf(session)!.execute(
			"id",
			{ code: "public class Widget {}", output: "apidocs" },
			SIGNAL,
		);
		expect(seen()).toEqual({
			action: "javadoc",
			code: "public class Widget {}",
			output: "apidocs",
			cwd: SESSION_CWD,
		});
		expect(textOf(out)).toBe(
			"Generated API docs for Widget → /work/project/apidocs (42 entries).\n" +
				"Top-level: index.html, Widget.html\n" +
				"Tip: open /work/project/apidocs/index.html to browse them.",
		);
	});

	test("a javadoc failure renders the generator's output", async () => {
		const { session } = sessionReturning(
			ok({ action: "javadoc", phase: "javadoc", exitCode: 1, stderr: "error: bad @link" }),
		);
		const out = await JvmJavadocTool.createIf(session)!.execute("id", { code: "class X {}" }, SIGNAL);
		expect(textOf(out)).toContain("error: bad @link");
	});
});

describe("JVM tools without a runtime service", () => {
	test("every tool explains why there is no runtime rather than throwing something opaque", async () => {
		const session = {
			cwd: SESSION_CWD,
			settings: { get: () => true },
			getRuntimeService: () => undefined,
		} as unknown as ToolSession;
		const tools = [
			JvmRunTool.createIf(session)!,
			JvmDisassembleTool.createIf(session)!,
			JvmFormatTool.createIf(session)!,
			JvmJarTool.createIf(session)!,
			JvmDepsTool.createIf(session)!,
			JvmJavadocTool.createIf(session)!,
		];
		for (const tool of tools) {
			await expect(
				tool.execute("id", { language: "java", code: "class Main {}", action: "create" } as never, SIGNAL),
			).rejects.toThrow("The runtime service is unavailable on this session");
		}
	});
});
