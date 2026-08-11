import { describe, expect, test } from "bun:test";
import type { PlanModeState } from "../src/plan-mode/state";
import type { RuntimeJvmParams, RuntimeJvmResult } from "../src/runtime/protocol";
import type { ToolSession } from "../src/tools";
import { JvmDepsTool } from "../src/tools/jvm-deps";
import { JvmDisassembleTool } from "../src/tools/jvm-disassemble";
import { JvmFormatTool } from "../src/tools/jvm-format";
import { JvmJarTool } from "../src/tools/jvm-jar";

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

	test("source path and output are forwarded without manual compilation or writing", async () => {
		const { session, seen } = sessionReturning(
			ok({
				action: "deps",
				phase: "deps",
				stdout: "Report.class -> java.sql\n",
				output: "/work/project/deps.txt",
			}),
		);
		const out = await JvmDepsTool.createIf(session)!.execute(
			"id",
			{ path: "Report.java", output: "deps.txt", overwrite: true },
			SIGNAL,
		);
		expect(seen()).toEqual({
			action: "deps",
			path: "Report.java",
			output: "deps.txt",
			overwrite: true,
			cwd: SESSION_CWD,
		});
		expect(textOf(out)).toContain("Wrote dependency report to /work/project/deps.txt");
		expect(textOf(out)).toContain("Report.class -> java.sql");
	});
});

/**
 * Plan mode keeps the working tree read-only (`prompts/system/plan-mode-active.md`:
 * "You NEVER create, edit… working-tree files"). `jvm_jar create` and a
 * `jvm_deps` with an `output` both land a file in the working tree through the
 * runtime service instead of through `write`/`edit`, so they need the same guard
 * those tools call — the enforcement lives in the tool, because the runtime
 * service has no idea a session is planning.
 */
describe("JVM writes under plan mode", () => {
	const PLAN_MODE: PlanModeState = { enabled: true, planFilePath: "local://jvm-plan.md" };
	const GUARD_ERROR = /Plan mode: the working tree is read-only/;

	/** A plan-mode session that records whether the runtime service was reached at all. */
	function planningSession(result: RuntimeJvmResult): { session: ToolSession; dispatched: () => boolean } {
		let dispatched = false;
		const session = {
			cwd: SESSION_CWD,
			settings: { get: (key: string) => (key === "runtime.enabled" ? true : undefined) },
			getArtifactsDir: () => null,
			getSessionId: () => "plan-session",
			getPlanModeState: () => PLAN_MODE,
			getRuntimeService: () => ({
				jvm: async () => {
					dispatched = true;
					return result;
				},
			}),
		} as unknown as ToolSession;
		return { session, dispatched: () => dispatched };
	}

	test("jvm_jar create is refused before the runtime service is reached", async () => {
		const { session, dispatched } = planningSession(ok({ action: "jar", phase: "jar", output: "/x.jar" }));
		await expect(
			JvmJarTool.createIf(session)!.execute(
				"id",
				{ action: "create", language: "java", code: "class Main {}", output: "build/app.jar" },
				SIGNAL,
			),
		).rejects.toThrow(GUARD_ERROR);
		expect(dispatched()).toBe(false);
	});

	test("jvm_jar inspect still runs: reading an archive writes nothing", async () => {
		const { session, dispatched } = planningSession(
			ok({ action: "jar", phase: "jar", jar: "/work/project/lib/dep.jar", listing: "a/B.class" }),
		);
		const out = await JvmJarTool.createIf(session)!.execute("id", { action: "inspect", jar: "lib/dep.jar" }, SIGNAL);
		expect(dispatched()).toBe(true);
		expect(textOf(out)).toBe("Entries of /work/project/lib/dep.jar:\na/B.class");
	});

	test("jvm_deps is refused when it would write its report", async () => {
		const { session, dispatched } = planningSession(ok({ action: "deps", phase: "deps", output: "/deps.txt" }));
		await expect(
			JvmDepsTool.createIf(session)!.execute("id", { path: "Report.java", output: "deps.txt" }, SIGNAL),
		).rejects.toThrow(GUARD_ERROR);
		expect(dispatched()).toBe(false);
	});

	test("jvm_deps still runs when it only reports to the transcript", async () => {
		const { session, dispatched } = planningSession(
			ok({ action: "deps", phase: "deps", stdout: "Main.class -> java.base\n" }),
		);
		const out = await JvmDepsTool.createIf(session)!.execute("id", { path: "out/Main.class" }, SIGNAL);
		expect(dispatched()).toBe(true);
		expect(textOf(out)).toBe("Main.class -> java.base");
	});

	/**
	 * The guard exempts the session's `local://` sandbox, because for `write`/`edit`
	 * that scheme really does resolve there. The JVM transport does not know the
	 * scheme: `resolveOutputDest` is a bare `path.resolve(cwd, output)`, so
	 * `local://app.jar` becomes `<cwd>/local:/app.jar` — inside the working tree.
	 * Guarding the raw string therefore let plan mode write exactly what it forbids,
	 * and the guard's own refusal names a `local://` path, so this is the model's
	 * natural next call rather than an exotic one. Both fields are documented
	 * cwd-relative; the guard resolves them the way the transport will.
	 */
	test("jvm_jar create cannot launder a working-tree write through local://", async () => {
		const { session, dispatched } = planningSession(ok({ action: "jar", phase: "jar", output: "/x.jar" }));
		await expect(
			JvmJarTool.createIf(session)!.execute(
				"id",
				{ action: "create", language: "java", code: "class Main {}", output: "local://app.jar" },
				SIGNAL,
			),
		).rejects.toThrow(GUARD_ERROR);
		expect(dispatched()).toBe(false);
	});

	test("jvm_deps cannot launder a working-tree write through local://", async () => {
		const { session, dispatched } = planningSession(ok({ action: "deps", phase: "deps", output: "/deps.txt" }));
		await expect(
			JvmDepsTool.createIf(session)!.execute("id", { path: "out/Main.class", output: "local://deps.txt" }, SIGNAL),
		).rejects.toThrow(GUARD_ERROR);
		expect(dispatched()).toBe(false);
	});

	test("a session that is not planning is unaffected", async () => {
		const { session, seen } = sessionReturning(ok({ action: "jar", phase: "jar", output: "/x.jar" }));
		await JvmJarTool.createIf(session)!.execute(
			"id",
			{ action: "create", language: "java", code: "class Main {}", output: "build/app.jar" },
			SIGNAL,
		);
		expect(seen().output).toBe("build/app.jar");
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
			JvmDisassembleTool.createIf(session)!,
			JvmFormatTool.createIf(session)!,
			JvmJarTool.createIf(session)!,
			JvmDepsTool.createIf(session)!,
		];
		for (const tool of tools) {
			await expect(
				tool.execute("id", { language: "java", code: "class Main {}", action: "create" } as never, SIGNAL),
			).rejects.toThrow("The runtime service is unavailable on this session");
		}
	});
});
