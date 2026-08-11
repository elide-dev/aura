import { describe, expect, it } from "bun:test";
import {
	analyzeInherentBenchmark,
	buildInherentBenchmarkLaunches,
	INHERENT_BENCHMARK_TASK_IDS,
	inherentBenchmarkToolsForTask,
	parseInherentBenchmarkCli,
	runInherentTelemetryProbe,
	scanInherentTranscript,
} from "./inherent-capability-benchmark";
import type { ArmSummary, RuntimeTaskMeasurement } from "./runtime-benchmark";

/**
 * `runtimeUsed` is per task, not blanket-true for the arm: `typescript-execution`
 * mounts no runtime tool since `run` retired, so a fixture that claimed adoption
 * on its trials would hide the very gap the adoption gate has to tolerate.
 */
const MOUNTS_RUNTIME_TOOL: Readonly<Record<string, boolean>> = {
	"typescript-execution": false,
	"jvm-dependencies": true,
};

function summary(
	arm: "baseline" | "runtime",
	options: {
		pass?: number;
		toolCalls?: number[];
		inputTokens?: number[];
		runtimeUsed?: (taskId: string) => boolean;
	} = {},
): ArmSummary {
	const toolCalls = options.toolCalls ?? [4, 4, 5, 5, 6, 6];
	const inputTokens = options.inputTokens ?? [100, 100, 110, 110, 120, 120];
	const runtimeUsed = options.runtimeUsed ?? ((taskId: string) => MOUNTS_RUNTIME_TOOL[taskId] === true);
	const trials = toolCalls.map((calls, index) => {
		const taskId = INHERENT_BENCHMARK_TASK_IDS[index % INHERENT_BENCHMARK_TASK_IDS.length];
		return {
			taskId,
			trialName: `trial-${index}`,
			status: "pass" as const,
			detail: "",
			durationMs: 100,
			tokIn: inputTokens[index],
			tokOut: 10,
			tokCache: 0,
			costUsd: 0,
			toolCalls: calls,
			runtimeUsed: arm === "runtime" && runtimeUsed(taskId),
		};
	});
	const taskMeasurements = INHERENT_BENCHMARK_TASK_IDS.map(taskId => ({
		taskId,
		group: taskId === "typescript-execution" ? ("execution" as const) : ("jvm" as const),
		trials: trials.filter(trial => trial.taskId === taskId),
	})) satisfies RuntimeTaskMeasurement[];
	const pass = options.pass ?? trials.length;
	return {
		arm,
		tasks: INHERENT_BENCHMARK_TASK_IDS.length,
		trials: trials.length,
		completedTrials: trials.length,
		pass,
		fail: trials.length - pass,
		error: 0,
		costUsd: 0,
		tokIn: inputTokens.reduce((sum, value) => sum + value, 0),
		tokOut: trials.length * 10,
		tokCache: 0,
		durationMs: trials.length * 100,
		elapsedMs: trials.length * 100,
		medianDurationMs: 100,
		toolCalls: toolCalls.reduce((sum, value) => sum + value, 0),
		runtimeTasks: taskMeasurements.filter(task => task.trials.some(trial => trial.runtimeUsed)).length,
		runtimeTrials: trials.filter(trial => trial.runtimeUsed).length,
		taskMeasurements,
	};
}

describe("inherent capability benchmark", () => {
	it("runs one-attempt jobs in alternating matched arm order", () => {
		const options = parseInherentBenchmarkCli(["--legacy-binary=/tmp/legacy-omp", "--prefix=inherent-test"], {});
		const launches = buildInherentBenchmarkLaunches(options, "/tmp/tasks");
		expect(launches).toHaveLength(12);
		expect(launches.map(launch => [launch.attempt, launch.arm, launch.taskId])).toEqual([
			[1, "legacy", "typescript-execution"],
			[1, "inherent", "typescript-execution"],
			[1, "inherent", "jvm-dependencies"],
			[1, "legacy", "jvm-dependencies"],
			[2, "inherent", "typescript-execution"],
			[2, "legacy", "typescript-execution"],
			[2, "legacy", "jvm-dependencies"],
			[2, "inherent", "jvm-dependencies"],
			[3, "legacy", "typescript-execution"],
			[3, "inherent", "typescript-execution"],
			[3, "inherent", "jvm-dependencies"],
			[3, "legacy", "jvm-dependencies"],
		]);
		for (const launch of launches) {
			expect(launch.args).toContain("--attempts=1");
			expect(launch.args).toContain(`--agent-arg=${inherentBenchmarkToolsForTask(launch.taskId).join(",")}`);
		}
		expect(launches[0].args).toContain("--binary=/tmp/legacy-omp");
		expect(launches[1].args).toContain("--install=source");
	});

	it("defaults to a one-attempt current-only smoke", () => {
		const options = parseInherentBenchmarkCli(["--prefix=inherent-smoke"], {});
		expect(options.attempts).toBe(1);
		expect(options.legacyBinary).toBeUndefined();
		const launches = buildInherentBenchmarkLaunches(options, "/tmp/tasks");
		expect(launches.map(launch => [launch.arm, launch.taskId])).toEqual([
			["inherent", "typescript-execution"],
			["inherent", "jvm-dependencies"],
		]);
	});

	it("extracts first execution choice and promoted skill loads from emitted transcript events", () => {
		const transcript = [
			JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "/app/events.jsonl" } }),
			JSON.stringify({ type: "tool_execution_start", toolName: "eval", args: { path: "/app/aggregate.py" } }),
			JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "skill://runtime" } }),
			JSON.stringify({
				type: "tool_execution_start",
				toolName: "read",
				args: { path: "skill://superpowers:receiving-code-review" },
			}),
			JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "skill://frontend-design" } }),
		].join("\n");
		expect(scanInherentTranscript(transcript)).toEqual({ firstCapabilityTool: "eval", coreSkillLoads: 2 });
	});

	it("passes only when behavior improves without tool-call or token regression", () => {
		const legacy = summary("baseline", {
			toolCalls: [6, 6, 7, 7, 8, 8],
			inputTokens: [150, 150, 160, 160, 170, 170],
		});
		const inherent = summary("runtime");
		const traces = Array.from({ length: 3 }, () => [
			{ taskId: "typescript-execution", facts: { firstCapabilityTool: "bash" as const, coreSkillLoads: 0 } },
			{ taskId: "jvm-dependencies", facts: { firstCapabilityTool: "jvm_deps" as const, coreSkillLoads: 0 } },
		]).flat();
		const analysis = analyzeInherentBenchmark(legacy, inherent, traces);
		expect(analysis.verdict).toBe("pass");
		expect(analysis).toMatchObject({
			inherentPassRate: 1,
			firstExecutionSelectionRate: 1,
			coreSkillLoads: 0,
		});
	});

	it("fails on skill loading, wrong execution selection, or efficiency regression", () => {
		const legacy = summary("baseline");
		const inherent = summary("runtime", {
			pass: 5,
			toolCalls: [7, 7, 8, 8, 9, 9],
			inputTokens: [130, 130, 140, 140, 150, 150],
		});
		const analysis = analyzeInherentBenchmark(legacy, inherent, [
			{ taskId: "typescript-execution", facts: { firstCapabilityTool: "eval", coreSkillLoads: 1 } },
		]);
		expect(analysis.verdict).toBe("fail");
		expect(analysis.reasons).toEqual([
			"inherent arm did not pass every trial",
			"inherent arm is missing transcript evidence",
			"inherent arm did not select the task-specific capability tool first in every trial",
			"inherent arm loaded a promoted runtime or core workflow skill",
			"median paired tool calls increased",
			"median paired input tokens increased",
		]);
	});

	const passingTraces = () =>
		Array.from({ length: 3 }, () => [
			{ taskId: "typescript-execution", facts: { firstCapabilityTool: "bash" as const, coreSkillLoads: 0 } },
			{ taskId: "jvm-dependencies", facts: { firstCapabilityTool: "jvm_deps" as const, coreSkillLoads: 0 } },
		]).flat();

	it("fails when a trial that mounts a runtime tool does not use one", () => {
		const inherent = summary("runtime");
		// Drop adoption on a `jvm-dependencies` trial — the task that mounts `jvm_deps`.
		const jvm = inherent.taskMeasurements.find(task => task.taskId === "jvm-dependencies");
		if (!jvm) throw new Error("expected a jvm-dependencies measurement");
		jvm.trials[0] = { ...jvm.trials[0], runtimeUsed: false };

		const analysis = analyzeInherentBenchmark(undefined, inherent, passingTraces());

		expect(analysis.verdict).toBe("fail");
		expect(analysis.reasons).toContain("inherent arm did not use a runtime tool in every trial that mounts one");
	});

	it("does not demand adoption from a task whose arm mounts no runtime tool", () => {
		// `typescript-execution` mounts none since `run` retired, so its trials carry
		// `runtimeUsed: false` in the fixture. Counting them would fail this gate on
		// every campaign — a verdict about the tool inventory, not the runtime.
		const inherent = summary("runtime");
		expect(inherent.runtimeTrials).toBeLessThan(inherent.trials);

		const analysis = analyzeInherentBenchmark(undefined, inherent, passingTraces());

		expect(analysis.reasons).not.toContain("inherent arm did not use a runtime tool in every trial that mounts one");
		expect(analysis.verdict).toBe("pass");
	});

	it("preflights bounded success and failure runtime telemetry", async () => {
		const probe = await runInherentTelemetryProbe();
		expect(probe.success).toMatchObject({
			sessionId: "benchmark-preflight",
			language: "python",
			outcome: "ok",
			exitCode: 0,
		});
		expect(probe.failure).toMatchObject({
			sessionId: "benchmark-preflight",
			language: "python",
			outcome: "error",
			exitCode: 2,
			errorType: "non_zero_exit",
		});
		expect(probe.success.durationMs).toBeGreaterThanOrEqual(0);
		expect(probe.failure.durationMs).toBeGreaterThanOrEqual(0);
	});
});
