import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { materializeRuntimeTasks, RUNTIME_TASKS } from "./runtime-benchmark-suite";

const cleanups: string[] = [];
afterEach(() => {
	for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const EXPECTED_TASKS = [
	"python-execution",
	"typescript-execution",
	"project-validation",
	"project-build",
	"runtime-debugging",
	"instrumentation",
	"cpu-sampling",
	"call-tracing",
	"java-execution",
	"bytecode-inspection",
	"executable-jar",
	"jvm-dependency-docs",
];

describe("runtime capability suite", () => {
	it("defines the twelve approved capability tasks exactly once", () => {
		expect(RUNTIME_TASKS.map(task => task.id)).toEqual(EXPECTED_TASKS);
		expect(new Set(RUNTIME_TASKS.map(task => task.id)).size).toBe(EXPECTED_TASKS.length);
	});

	it("materializes self-contained Harbor task directories", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-suite-"));
		cleanups.push(root);

		const taskPaths = await materializeRuntimeTasks(root);

		expect(taskPaths.map(taskPath => path.basename(taskPath))).toEqual(EXPECTED_TASKS);
		for (const taskPath of taskPaths) {
			expect(fs.existsSync(path.join(taskPath, "task.toml"))).toBe(true);
			expect(fs.existsSync(path.join(taskPath, "instruction.md"))).toBe(true);
			expect(fs.existsSync(path.join(taskPath, "environment", "Dockerfile"))).toBe(true);
			expect(fs.existsSync(path.join(taskPath, "tests", "test.sh"))).toBe(true);
		}
	});
});
