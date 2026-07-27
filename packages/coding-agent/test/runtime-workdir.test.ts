import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RuntimeExecResult } from "../src/runtime/protocol";
import {
	jvmSpawnEnv,
	type RuntimeSpawn,
	type RuntimeSpawnOptions,
	withRuntimeWorkdir,
} from "../src/runtime/transport/local";

interface SpawnCall {
	argv: string[];
	opts: RuntimeSpawnOptions;
	signal?: AbortSignal;
}

/** A spawn stand-in that records calls instead of running anything. */
function recordingSpawn(): { calls: SpawnCall[]; spawn: RuntimeSpawn } {
	const calls: SpawnCall[] = [];
	const spawn: RuntimeSpawn = async (argv, opts, signal) => {
		calls.push({ argv, opts, signal });
		return { exitCode: 0, stdout: "", stderr: "", durationMs: 0, killed: false } satisfies RuntimeExecResult;
	};
	return { calls, spawn };
}

async function exists(p: string): Promise<boolean> {
	return await fs
		.stat(p)
		.then(() => true)
		.catch(() => false);
}

describe("withRuntimeWorkdir", () => {
	test("two invocations in one flow share the same directory, and files written before the first survive to the second", async () => {
		const calls: SpawnCall[] = [];
		/** Records the call, then reports what the workdir contains at that moment. */
		const listing: string[][] = [];
		let workdir = "";
		const spawn: RuntimeSpawn = async (argv, opts, signal) => {
			calls.push({ argv, opts, signal });
			listing.push((await fs.readdir(workdir)).sort());
			return { exitCode: 0, stdout: "", stderr: "", durationMs: 0, killed: false } satisfies RuntimeExecResult;
		};
		const seen = await withRuntimeWorkdir({ spawn }, async wd => {
			workdir = wd.dir;
			await wd.write("Main.java", "class Main {}");
			await wd.run(["javac", "Main.java"], { cwd: wd.dir });
			// Stand in for the compiler's output: the second invocation must see it.
			await wd.write("Main.class", "bytecode");
			await wd.run(["java", "Main"], { cwd: wd.dir });
			return wd.dir;
		});
		expect(calls.map(c => c.opts.cwd)).toEqual([seen, seen]);
		expect(listing[0]).toEqual(["Main.java"]);
		expect(listing[1]).toEqual(["Main.class", "Main.java"]);
	});

	test("write refuses to escape the workdir", async () => {
		await withRuntimeWorkdir({ spawn: recordingSpawn().spawn }, async wd => {
			await expect(wd.write(path.join("..", "escape.java"), "x")).rejects.toThrow(
				/Refusing to write outside the runtime workdir/,
			);
			await expect(wd.write(path.join("a", "..", "..", "escape.java"), "x")).rejects.toThrow(
				/Refusing to write outside the runtime workdir/,
			);
			await expect(wd.write(path.join(os.tmpdir(), "absolute.java"), "x")).rejects.toThrow(
				/Refusing to write outside the runtime workdir/,
			);
			// A nested name that stays inside is still fine.
			expect(await wd.write(path.join("a", "b", "Ok.java"), "x")).toBe(path.join(wd.dir, "a", "b", "Ok.java"));
		});
	});

	test("a cleanup failure does not mask the flow's result", async () => {
		const rm = spyOn(fs, "rm").mockRejectedValueOnce(new Error("EBUSY: directory is busy"));
		try {
			const value = await withRuntimeWorkdir({ spawn: recordingSpawn().spawn }, async () => "flow-value");
			expect(value).toBe("flow-value");
			expect(rm).toHaveBeenCalled();
		} finally {
			rm.mockRestore();
		}
	});

	test("a cleanup failure does not mask the flow's error either", async () => {
		const rm = spyOn(fs, "rm").mockRejectedValueOnce(new Error("EBUSY: directory is busy"));
		try {
			await expect(
				withRuntimeWorkdir({ spawn: recordingSpawn().spawn }, async () => {
					throw new Error("flow failed");
				}),
			).rejects.toThrow("flow failed");
		} finally {
			rm.mockRestore();
		}
	});

	test("write materializes files into the workdir and returns absolute paths", async () => {
		let file = "";
		const dir = await withRuntimeWorkdir({ spawn: recordingSpawn().spawn }, async wd => {
			file = await wd.write("Main.java", "class Main {}");
			expect(path.isAbsolute(file)).toBe(true);
			expect(path.dirname(file)).toBe(wd.dir);
			expect(await Bun.file(file).text()).toBe("class Main {}");
			return wd.dir;
		});
		expect(await exists(dir)).toBe(false);
	});

	test("write creates nested parents (package-shaped guest sources)", async () => {
		await withRuntimeWorkdir({ spawn: recordingSpawn().spawn }, async wd => {
			const file = await wd.write(path.join("com", "example", "Main.java"), "package com.example;");
			expect(await Bun.file(file).text()).toBe("package com.example;");
		});
	});

	test("the directory is removed after a successful flow", async () => {
		const dir = await withRuntimeWorkdir({ spawn: recordingSpawn().spawn }, async wd => wd.dir);
		expect(await exists(dir)).toBe(false);
	});

	test("the directory is removed when the flow throws, and the error propagates", async () => {
		let captured = "";
		await expect(
			withRuntimeWorkdir({ spawn: recordingSpawn().spawn }, async wd => {
				captured = wd.dir;
				await wd.write("guest.ts", "boom");
				throw new Error("flow failed");
			}),
		).rejects.toThrow("flow failed");
		expect(captured).not.toBe("");
		expect(await exists(captured)).toBe(false);
	});

	test("per-call options win over the flow defaults, field by field", async () => {
		const { calls, spawn } = recordingSpawn();
		await withRuntimeWorkdir(
			{ spawn, defaults: { cwd: "/flow/cwd", stdin: "flow-in", timeoutMs: 1000 } },
			async wd => {
				await wd.run(["a"]);
				await wd.run(["b"], { cwd: "/call/cwd", timeoutMs: 5 });
			},
		);
		expect(calls[0]?.opts).toMatchObject({ cwd: "/flow/cwd", stdin: "flow-in", timeoutMs: 1000 });
		expect(calls[1]?.opts).toMatchObject({ cwd: "/call/cwd", stdin: "flow-in", timeoutMs: 5 });
	});

	test("an undefined default cwd stays undefined (single-shot inherits the process cwd)", async () => {
		const { calls, spawn } = recordingSpawn();
		await withRuntimeWorkdir({ spawn }, async wd => {
			await wd.run(["a"]);
		});
		expect(calls[0]?.opts.cwd).toBeUndefined();
	});

	test("the flow signal reaches every invocation", async () => {
		const { calls, spawn } = recordingSpawn();
		const controller = new AbortController();
		await withRuntimeWorkdir({ spawn, signal: controller.signal }, async wd => {
			await wd.run(["a"]);
		});
		expect(calls[0]?.signal).toBe(controller.signal);
	});
});

describe("jvmSpawnEnv", () => {
	test("strips JAVA_HOME and JDK_HOME while preserving everything else", () => {
		const env = jvmSpawnEnv({ JAVA_HOME: "/opt/jdk17", JDK_HOME: "/opt/jdk17", PATH: "/usr/bin", FOO: "bar" });
		expect(env).not.toHaveProperty("JAVA_HOME");
		expect(env).not.toHaveProperty("JDK_HOME");
		expect(env.PATH).toBe("/usr/bin");
		expect(env.FOO).toBe("bar");
	});

	test("does not mutate the base environment", () => {
		const base = { JAVA_HOME: "/opt/jdk17", PATH: "/usr/bin" };
		jvmSpawnEnv(base);
		expect(base.JAVA_HOME).toBe("/opt/jdk17");
	});

	test("an environment without a preset JDK passes through unchanged", () => {
		expect(jvmSpawnEnv({ PATH: "/usr/bin" })).toEqual({ PATH: "/usr/bin" });
	});
});
