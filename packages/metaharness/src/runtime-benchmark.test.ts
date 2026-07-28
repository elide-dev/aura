import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AdapterBenchmarkRuntime,
	type ArmSummary,
	BASELINE_TOOLS,
	buildArmLaunches,
	countToolCalls,
	formatComparison,
	measureAdapterCase,
	parseRuntimeBenchmarkCli,
	runAdapterMicrobenchmarks,
	RUNTIME_TOOLS,
	summarizeAdapterSamples,
	validateAdapterOutput,
} from "./runtime-benchmark";
import { RUNTIME_TASKS } from "./runtime-benchmark-suite";

const cleanups: string[] = [];

afterEach(() => {
	for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function summary(arm: "baseline" | "runtime"): ArmSummary {
	return {
		arm,
		tasks: 12,
		trials: 24,
		pass: 18,
		fail: 5,
		error: 1,
		costUsd: 1.2,
		tokIn: 12000,
		tokOut: 3000,
		durationMs: 120000,
		medianDurationMs: 10_000,
		toolCalls: 80,
		runtimeTasks: 0,
	};
}
describe("runtime benchmark orchestration", () => {
	it("builds matched baseline and runtime launches for every capability task", () => {
		const launches = buildArmLaunches({
			model: "openai-codex/gpt-5.6-sol",
			thinking: "xhigh",
			attempts: 2,
			prefix: "rtbench",
			jobsDir: "/tmp/jobs",
			taskRoot: "/tmp/tasks",
			gatewayUrl: "http://127.0.0.1:4000",
			hostNetwork: true,
			taskIds: RUNTIME_TASKS.map(task => task.id),
		});

		expect(launches).toHaveLength(RUNTIME_TASKS.length * 2);
		expect(launches.filter(launch => launch.arm === "baseline")).toHaveLength(RUNTIME_TASKS.length);
		expect(launches.filter(launch => launch.arm === "runtime")).toHaveLength(RUNTIME_TASKS.length);
		expect(launches[0].args).toContain(`--agent-arg=${BASELINE_TOOLS.join(",")}`);
		expect(launches.find(launch => launch.arm === "runtime")?.args).toContain(
			`--agent-arg=${RUNTIME_TOOLS.join(",")}`,
		);
		expect(launches.every(launch => launch.args.includes("--host-network"))).toBe(true);
	});

	it("balances matched task arms in deterministic AB/BA order", () => {
		const launches = buildArmLaunches({
			model: "openai-codex/gpt-5.6-sol",
			thinking: "xhigh",
			attempts: 1,
			prefix: "rtbench",
			jobsDir: "/tmp/jobs",
			taskRoot: "/tmp/tasks",
			gatewayUrl: "http://127.0.0.1:4000",
			hostNetwork: true,
			taskIds: ["python-execution", "typescript-execution"],
		});

		expect(launches.map(launch => `${launch.taskId}:${launch.arm}`)).toEqual([
			"python-execution:baseline",
			"python-execution:runtime",
			"typescript-execution:runtime",
			"typescript-execution:baseline",
		]);
	});

	it("counts each executed tool invocation once", () => {
		const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-tool-count-"));
		cleanups.push(jobDir);
		const agentDir = path.join(jobDir, "trial", "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		const call = { type: "toolCall", id: "call-1", name: "run", arguments: {} };
		const lines = [
			{ type: "message_start", message: { role: "assistant", content: [call] } },
			{ type: "message_end", message: { role: "assistant", content: [call] } },
			{ type: "tool_execution_start", toolCallId: "call-1", toolName: "run" },
		];
		fs.writeFileSync(path.join(agentDir, "omp.txt"), lines.map(line => JSON.stringify(line)).join("\n"));

		expect(countToolCalls(jobDir)).toEqual({ total: 1, runtimeUsed: true });
	});

	it("formats the primary success, efficiency, and tool-use deltas", () => {
		const baseline: ArmSummary = {
			arm: "baseline",
			tasks: 12,
			trials: 24,
			pass: 18,
			fail: 5,
			error: 1,
			costUsd: 1.2,
			tokIn: 12000,
			tokOut: 3000,
			durationMs: 120000,
			medianDurationMs: 10_000,
			toolCalls: 80,
			runtimeTasks: 0,
		};
		const runtime: ArmSummary = { ...baseline, arm: "runtime", pass: 21, fail: 3, error: 0, runtimeTasks: 8 };

		const report = formatComparison("rtbench", baseline, runtime, []);

		expect(report).toContain("# Runtime capability benchmark — rtbench");
		expect(report).toContain("75.0%");
		expect(report).toContain("+12.5 pp");
		expect(report).toContain("8/12");
		expect(report).toContain("Median trial time");
	});

	it("alternates process and embedded samples after warming each operation once", async () => {
		const calls: string[] = [];
		const result = await measureAdapterCase({
			name: "Warm JS startup",
			iterations: 2,
			process: async () => {
				calls.push("process");
				return { durationMs: 10, value: "ok" };
			},
			embedded: async () => {
				calls.push("embedded");
				return { durationMs: 5, value: "ok" };
			},
			validate: value => {
				if (value !== "ok") throw new Error(`unexpected output: ${value}`);
			},
		});

		expect(calls).toEqual(["process", "embedded", "process", "embedded", "embedded", "process"]);
		expect(result.processMs).toBe(10);
		expect(result.embeddedMs).toBe(5);
	});

	it("rejects an invalid exact output before accepting its timed sample", async () => {
		const calls: string[] = [];
		let processCalls = 0;
		const valid = { exitCode: 0, stdout: "ok\n", stderr: "", durationMs: 1, killed: false };

		const measured = measureAdapterCase({
			name: "Warm JS startup",
			iterations: 1,
			process: async () => {
				calls.push("process");
				processCalls++;
				return {
					durationMs: 10,
					value: processCalls === 1 ? valid : { ...valid, stdout: "wrong\n" },
				};
			},
			embedded: async () => {
				calls.push("embedded");
				return { durationMs: 5, value: valid };
			},
			validate: value => validateAdapterOutput(value, "ok\n"),
		});

		await expect(measured).rejects.toThrow('expected stdout "ok\\n", received "wrong\\n"');
		expect(calls).toEqual(["process", "embedded", "process"]);
	});

	it("computes p50, p95, and process-over-embedded speedups", () => {
		const result = summarizeAdapterSamples("Warm JS startup", [10, 20, 30, 40], [2, 4, 6, 8]);

		expect(result).toMatchObject({
			name: "Warm JS startup",
			processMs: 25,
			embeddedMs: 5,
			speedup: 5,
		});
		expect(result.processP95Ms).toBeCloseTo(38.5);
		expect(result.embeddedP95Ms).toBeCloseTo(7.7);
		expect(result.p95Speedup).toBeCloseTo(5);
	});

	it("keeps the embedded cold-open row explicitly non-comparable", () => {
		const result = summarizeAdapterSamples("Embedded cold open + first JS", null, [123]);

		expect(result).toEqual({
			name: "Embedded cold open + first JS",
			processMs: null,
			processP95Ms: null,
			embeddedMs: 123,
			embeddedP95Ms: 123,
			speedup: null,
			p95Speedup: null,
		});
	});

	it("reports an explicit adapter skip when no embedded library is supplied", () => {
		const report = formatComparison("rtbench", summary("baseline"), summary("runtime"), []);

		expect(report).toContain("## Runtime adapter microbenchmarks");
		expect(report).toContain("Adapter comparison skipped: no embedded runtime library was supplied");
	});

	it("formats the adapter heading, table, percentiles, speedups, and cold-row semantics", () => {
		const cold = summarizeAdapterSamples("Embedded cold open + first JS", null, [123]);
		const warm = summarizeAdapterSamples("Warm JS startup", [10, 20, 30, 40], [2, 4, 6, 8]);
		const report = formatComparison("rtbench", summary("baseline"), summary("runtime"), [], {
			kind: "completed",
			results: [cold, warm],
		});

		expect(report).toContain("## Runtime adapter microbenchmarks");
		expect(report).toContain("| Case | Process runtime | Embedded runtime | Speedup |");
		expect(report).toContain("| Embedded cold open + first JS | — | 123.00 ms (single cold sample) | Not comparable |");
		expect(report).toContain(
			"| Warm JS startup | 25.00 ms p50 / 38.50 ms p95 | 5.00 ms p50 / 7.70 ms p95 | 5.00× p50 / 5.00× p95 |",
		);
	});

	it("gives --embedded-lib precedence over the benchmark environment without mutating it", () => {
		const env = { AURA_RUNTIME_EMBEDDED_LIB: "/env/libelide_embed.so" };

		const fromFlag = parseRuntimeBenchmarkCli(["--embedded-lib=/flag/libelide_embed.so"], env);
		const fromEnv = parseRuntimeBenchmarkCli([], env);

		expect(fromFlag.embeddedLib).toBe("/flag/libelide_embed.so");
		expect(fromEnv.embeddedLib).toBe("/env/libelide_embed.so");
		expect(env.AURA_RUNTIME_EMBEDDED_LIB).toBe("/env/libelide_embed.so");
	});

	it("closes both independent adapter services when measurement fails", async () => {
		const closed: string[] = [];
		const runtime = (name: string): AdapterBenchmarkRuntime => ({
			run: async () => {
				throw new Error(`${name} run should not be called`);
			},
			close: async () => {
				closed.push(name);
			},
		});

		await expect(
			runAdapterMicrobenchmarks(
				{
					iterations: 30,
					processBinaryPath: "/runtime/bin/elide",
					embeddedLibraryPath: "/runtime/lib/libelide_embed.so",
				},
				{
					createProcessService: () => runtime("process"),
					createEmbeddedService: () => runtime("embedded"),
					runCases: async () => {
						throw new Error("measurement failed");
					},
				},
			),
		).rejects.toThrow("measurement failed");
		expect(closed).toEqual(["process", "embedded"]);
	});
});
