import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	BENCHMARK_BUN_CONTAINER_PATH,
	materializeRuntimeTasks,
	RUNTIME_TASKS,
	TYPESCRIPT_VERIFIER_SMOKE_SOURCE,
} from "./runtime-benchmark-suite";

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
	"jvm-dependencies",
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

	it("uses the pinned task-owned Bun for every TypeScript verifier", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-suite-"));
		cleanups.push(root);

		await materializeRuntimeTasks(root);

		for (const taskId of EXPECTED_TASKS) {
			const environment = path.join(root, taskId, "environment");
			const dockerfile = await Bun.file(path.join(environment, "Dockerfile")).text();
			expect(dockerfile).toContain("COPY benchmark-bun");
			expect(dockerfile).toContain(BENCHMARK_BUN_CONTAINER_PATH);
			expect(fs.statSync(path.join(environment, "benchmark-bun")).mode & 0o111).not.toBe(0);
		}
		for (const taskId of ["typescript-execution", "instrumentation", "call-tracing"]) {
			const verifier = await Bun.file(path.join(root, taskId, "tests", "test.sh")).text();
			expect(verifier).not.toContain("/opt/omp");
			expect(verifier).not.toContain("/usr/bin/tsc");
			expect(verifier).not.toContain("/usr/bin/node");
			expect(verifier).toContain(BENCHMARK_BUN_CONTAINER_PATH);
		}
	});

	it("smoke source exercises Node imports, TypeScript syntax, top-level await, and sorted BFS output", () => {
		expect(TYPESCRIPT_VERIFIER_SMOKE_SOURCE).toContain('from "node:fs/promises"');
		expect(TYPESCRIPT_VERIFIER_SMOKE_SOURCE).toContain("interface Graph");
		expect(TYPESCRIPT_VERIFIER_SMOKE_SOURCE).toContain("await ");
		expect(TYPESCRIPT_VERIFIER_SMOKE_SOURCE).toContain("Object.keys(distances).sort()");
	});

	it("provisions the validation fixture as an Elide Java project", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-suite-"));
		cleanups.push(root);

		await materializeRuntimeTasks(root);

		const taskPath = path.join(root, "project-validation", "environment");
		expect(await Bun.file(path.join(taskPath, "Dockerfile")).text()).toContain("openjdk-17-jdk-headless");
		expect(await Bun.file(path.join(taskPath, "elide.pkl")).text()).toContain('amends "elide:project.pkl"');
		expect(await Bun.file(path.join(taskPath, "src/main/java/RenderTotal.java")).text()).toContain(
			"public final class RenderTotal",
		);
	});
});
