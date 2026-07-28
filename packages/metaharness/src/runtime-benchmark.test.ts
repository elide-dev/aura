import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type ArmSummary,
	BASELINE_TOOLS,
	buildArmLaunches,
	countToolCalls,
	formatComparison,
	RUNTIME_TOOLS,
} from "./runtime-benchmark";
import { RUNTIME_TASKS } from "./runtime-benchmark-suite";

const cleanups: string[] = [];

afterEach(() => {
	for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
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
});
