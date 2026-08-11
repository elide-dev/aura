import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	EMBEDDED_RUNTIME_ABI_VERSION,
	EMBEDDED_RUNTIME_SCHEMA_SHA256,
} from "../../coding-agent/src/runtime/embedded/schema";
import {
	type AdapterBenchmarkRuntime,
	type ArmLaunch,
	type ArmSummary,
	analyzeRuntimeComparison,
	armRunnerArgs,
	BASELINE_TOOLS,
	type BenchmarkArm,
	buildArmLaunches,
	countToolCalls,
	countTrialToolCalls,
	formatComparison,
	measureAdapterCase,
	packagedRuntimeBinaryForLibrary,
	parseRuntimeBenchmarkCli,
	runAdapterMicrobenchmarks,
	summarizeAdapterSamples,
	summarizeArm,
	validateAdapterOutput,
	writeRuntimeBenchmarkManifest,
} from "./runtime-benchmark";
import {
	BENCHMARK_BUN_CONTAINER_PATH,
	type DockerRunResult,
	RUNTIME_ARM_PROBE_SENTINEL,
	RUNTIME_TASKS,
	smokeRuntimeArmExecution,
} from "./runtime-benchmark-suite";

const cleanups: string[] = [];

afterEach(() => {
	for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function summary(arm: "baseline" | "runtime"): ArmSummary {
	return {
		arm,
		tasks: 12,
		trials: 24,
		completedTrials: 24,
		pass: 18,
		fail: 5,
		error: 1,
		costUsd: 1.2,
		tokIn: 12000,
		tokOut: 3000,
		tokCache: 8000,
		durationMs: 120000,
		elapsedMs: 125000,
		medianDurationMs: 10_000,
		toolCalls: 80,
		runtimeTasks: 0,
		runtimeTrials: 0,
		taskMeasurements: [],
	};
}

interface ComparisonFixtureOptions {
	durationRatio?: number;
	tokenRatio?: number;
	includeTokens?: boolean;
	runtimeUsed?: (taskId: string) => boolean;
	runtimePass?: (taskId: string) => boolean;
}

function comparisonSummaries(options: ComparisonFixtureOptions = {}): {
	baseline: ArmSummary;
	runtime: ArmSummary;
} {
	const durationRatio = options.durationRatio ?? 0.8;
	const tokenRatio = options.tokenRatio ?? 0.9;
	const includeTokens = options.includeTokens ?? true;
	const runtimeUsed = options.runtimeUsed ?? (() => true);
	const runtimePass = options.runtimePass ?? (() => true);
	const baselineMeasurements = RUNTIME_TASKS.map(task => ({
		taskId: task.id,
		group: task.group,
		trials: [
			{
				taskId: task.id,
				trialName: `${task.id}-baseline`,
				status: "pass" as const,
				detail: "",
				durationMs: 1_000,
				tokIn: 100,
				tokOut: 0,
				tokCache: 0,
				costUsd: 0,
				toolCalls: 1,
				runtimeUsed: false,
			},
		],
	}));
	const runtimeMeasurements = RUNTIME_TASKS.map(task => ({
		taskId: task.id,
		group: task.group,
		trials: [
			{
				taskId: task.id,
				trialName: `${task.id}-runtime`,
				status: runtimePass(task.id) ? ("pass" as const) : ("fail" as const),
				detail: "",
				durationMs: 1_000 * durationRatio,
				tokIn: includeTokens ? 100 * tokenRatio : 0,
				tokOut: 0,
				tokCache: 0,
				costUsd: 0,
				toolCalls: 1,
				runtimeUsed: runtimeUsed(task.id),
			},
		],
	}));
	const runtimePasses = runtimeMeasurements.filter(task => task.trials[0].status === "pass").length;
	const runtimeTrials = runtimeMeasurements.filter(task => task.trials[0].runtimeUsed).length;
	return {
		baseline: {
			...summary("baseline"),
			trials: RUNTIME_TASKS.length,
			completedTrials: RUNTIME_TASKS.length,
			pass: RUNTIME_TASKS.length,
			fail: 0,
			error: 0,
			tokIn: RUNTIME_TASKS.length * 100,
			tokOut: 0,
			tokCache: 0,
			durationMs: RUNTIME_TASKS.length * 1_000,
			elapsedMs: RUNTIME_TASKS.length * 1_000,
			medianDurationMs: 1_000,
			runtimeTasks: 0,
			runtimeTrials: 0,
			taskMeasurements: baselineMeasurements,
		},
		runtime: {
			...summary("runtime"),
			trials: RUNTIME_TASKS.length,
			completedTrials: RUNTIME_TASKS.length,
			pass: runtimePasses,
			fail: RUNTIME_TASKS.length - runtimePasses,
			error: 0,
			tokIn: includeTokens ? RUNTIME_TASKS.length * 100 * tokenRatio : 0,
			tokOut: 0,
			tokCache: 0,
			durationMs: RUNTIME_TASKS.length * 1_000 * durationRatio,
			elapsedMs: RUNTIME_TASKS.length * 1_000 * durationRatio,
			medianDurationMs: 1_000 * durationRatio,
			runtimeTasks: runtimeTrials,
			runtimeTrials,
			taskMeasurements: runtimeMeasurements,
		},
	};
}
describe("runtime benchmark orchestration", () => {
	it("resolves the packaged Linux process binary next to the embedded library", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-package-linux-"));
		cleanups.push(root);
		const libraryPath = path.join(root, "lib", "libelide_embed.so");
		const binaryPath = path.join(root, "bin", "elide");
		fs.mkdirSync(path.dirname(libraryPath), { recursive: true });
		fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
		fs.writeFileSync(libraryPath, "library");
		fs.writeFileSync(binaryPath, "binary");

		expect(await packagedRuntimeBinaryForLibrary(libraryPath, { platform: "linux" })).toBe(binaryPath);
	});

	it("probes canonical Windows packaged binary names in precedence order", async () => {
		const libraryPath = String.raw`C:\runtime\lib\elide_embed.dll`;
		const expected = String.raw`C:\runtime\bin\elide.cmd`;
		const probed: string[] = [];

		const resolved = await packagedRuntimeBinaryForLibrary(libraryPath, {
			platform: "win32",
			isRegularFile: candidate => {
				probed.push(candidate);
				return Promise.resolve(candidate === expected);
			},
		});

		expect(resolved).toBe(expected);
		expect(probed).toEqual([String.raw`C:\runtime\bin\elide.exe`, expected]);
	});

	it("rejects a packaged embedded library without a sibling process binary", async () => {
		await expect(
			packagedRuntimeBinaryForLibrary("/runtime/lib/libelide_embed.so", {
				platform: "linux",
				isRegularFile: () => Promise.resolve(false),
			}),
		).rejects.toThrow("No packaged runtime binary found");
	});

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
			`--agent-arg=${[...BASELINE_TOOLS, "run", "check"].join(",")}`,
		);
		expect(launches.every(launch => launch.args.includes("--host-network"))).toBe(true);
	});

	it("mounts only task-relevant discoverable runtime tools", () => {
		const launches = buildArmLaunches({
			model: "openai-codex/gpt-5.6-sol",
			thinking: "xhigh",
			attempts: 1,
			prefix: "rtbench",
			jobsDir: "/tmp/jobs",
			taskRoot: "/tmp/tasks",
			gatewayUrl: "http://127.0.0.1:4000",
			hostNetwork: true,
			taskIds: ["project-validation", "instrumentation", "jvm-dependencies"],
		});
		const runtimeArgs = (taskId: string) =>
			launches.find(launch => launch.arm === "runtime" && launch.taskId === taskId)?.args;
		const essentials = [...BASELINE_TOOLS, "run", "check"];

		expect(runtimeArgs("project-validation")).toContain(`--agent-arg=${essentials.join(",")}`);
		expect(runtimeArgs("project-validation")?.join(" ")).not.toContain("project_advice");
		expect(runtimeArgs("instrumentation")).toContain(`--agent-arg=${[...essentials, "insights"].join(",")}`);
		expect(runtimeArgs("jvm-dependencies")).toContain(`--agent-arg=${[...essentials, "jvm_deps"].join(",")}`);
	});

	it("maps packaged runtime files into source-mounted task containers", () => {
		const runtimeBinary = path.resolve(import.meta.dir, "../../../out/aura-elide-linux-x64/bin/elide");
		const embeddedLib = path.resolve(import.meta.dir, "../../../out/aura-elide-linux-x64/lib/libelide_embed.so");
		const launches = Reflect.apply(buildArmLaunches, undefined, [
			{
				model: "openai-codex/gpt-5.6-sol",
				thinking: "xhigh",
				attempts: 1,
				prefix: "rtbench",
				jobsDir: "/tmp/jobs",
				taskRoot: "/tmp/tasks",
				gatewayUrl: "http://127.0.0.1:4000",
				hostNetwork: true,
				taskIds: ["python-execution"],
				runtimeBinary,
				embeddedLib,
			},
		]) as ArmLaunch[];
		for (const launch of launches) {
			expect(launch.args).toContain("--env=AURA_RUNTIME_BIN=/opt/omp/src/out/aura-elide-linux-x64/bin/elide");
			expect(launch.args).toContain(
				"--env=AURA_RUNTIME_EMBEDDED_LIB=/opt/omp/src/out/aura-elide-linux-x64/lib/libelide_embed.so",
			);
			expect(launch.args).toContain("--env=AURA_RUNTIME_ADAPTER=auto");
			expect(launch.args).toContain("--env=AURA_RUNTIME_AUTO_DOWNLOAD=false");
		}
	});

	it("never lets an agent container fetch the runtime it is measuring", () => {
		const runtimeBinary = path.resolve(import.meta.dir, "../../../out/aura-elide-linux-x64/bin/elide");
		const embeddedLib = path.resolve(import.meta.dir, "../../../out/aura-elide-linux-x64/lib/libelide_embed.so");
		const options = {
			model: "openai-codex/gpt-5.6-sol",
			thinking: "xhigh",
			attempts: 1,
			prefix: "rtbench",
			jobsDir: "/tmp/jobs",
			taskRoot: "/tmp/tasks",
			gatewayUrl: "http://127.0.0.1:4000",
			hostNetwork: true,
			taskIds: ["python-execution"],
			historicalBinary: "/tmp/aura-linux-x64",
		};
		const injected = buildArmLaunches({ ...options, runtimeBinary, embeddedLib });
		const bare = buildArmLaunches(options);
		const armArgs = (launches: ArmLaunch[], arm: BenchmarkArm) =>
			launches.find(launch => launch.arm === arm)?.args ?? [];

		// The measured arms carry the override the same way they carry every other
		// runtime env: the two arms must differ only in their tool set.
		expect(armArgs(injected, "runtime")).toContain("--env=AURA_RUNTIME_AUTO_DOWNLOAD=false");
		expect(armArgs(injected, "baseline")).toContain("--env=AURA_RUNTIME_AUTO_DOWNLOAD=false");

		// An artifact-less campaign is the shape that produced the original failure:
		// a runtime arm with `run`/`check` mounted, no runtime present, and nothing
		// stopping the container from fetching one. The override is unconditional.
		expect(armArgs(bare, "runtime")).toContain("--env=AURA_RUNTIME_AUTO_DOWNLOAD=false");
		expect(armArgs(bare, "baseline")).toContain("--env=AURA_RUNTIME_AUTO_DOWNLOAD=false");
		// Only the override is unconditional: the artifact paths still require artifacts.
		expect(armArgs(bare, "runtime").join(" ")).not.toContain("AURA_RUNTIME_BIN");
		expect(armArgs(bare, "runtime").join(" ")).not.toContain("AURA_RUNTIME_EMBEDDED_LIB");
		expect(armArgs(bare, "runtime").join(" ")).not.toContain("AURA_RUNTIME_ADAPTER");

		// The historical control runs a frozen binary from before this override
		// existed, with baseline tools and no runtime env of any kind.
		for (const launches of [injected, bare]) {
			expect(armArgs(launches, "historical").join(" ")).not.toContain("AURA_RUNTIME");
		}
	});

	it("skips completed arms and resumes interrupted arms on campaign resume", () => {
		const launch: ArmLaunch = {
			arm: "runtime",
			taskId: "python-execution",
			jobName: "pilot-runtime-python-execution",
			args: ["--path=/tmp/tasks/python-execution"],
		};
		const jobsDir = "/tmp/jobs";

		expect(
			armRunnerArgs(launch, jobsDir, true, () => ({
				nTotal: 2,
				running: 0,
				pending: 0,
				finishedAt: Date.now(),
			})),
		).toBeNull();
		expect(
			armRunnerArgs(launch, jobsDir, true, () => ({
				nTotal: 2,
				running: 1,
				pending: 1,
				finishedAt: null,
			})),
		).toEqual(["--resume=/tmp/jobs/pilot-runtime-python-execution"]);
		expect(armRunnerArgs(launch, jobsDir, false)).toEqual(launch.args);
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

	it("adds immutable historical binary launches without changing matched arm order", () => {
		const historicalBinary = "/tmp/aura-linux-x64";
		const launches = buildArmLaunches({
			model: "openai-codex/gpt-5.6-sol",
			thinking: "xhigh",
			attempts: 1,
			prefix: "rtbench",
			jobsDir: "/tmp/jobs",
			taskRoot: "/tmp/tasks",
			gatewayUrl: "http://127.0.0.1:4000",
			hostNetwork: true,
			taskIds: ["python-execution"],
			historicalBinary,
		});

		expect(launches.map(launch => launch.arm)).toEqual(["baseline", "runtime", "historical"]);
		expect(launches[2].args).toContain(`--binary=${historicalBinary}`);
		expect(launches[2].args).not.toContain("--install=source");
		expect(launches[2].args).toContain(`--agent-arg=${BASELINE_TOOLS.join(",")}`);
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

	it("collects per-trial usage, duration, cache tokens, and runtime adoption", () => {
		const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-summary-"));
		cleanups.push(jobsDir);
		const jobDir = path.join(jobsDir, "rtbench-runtime-python-execution");
		const trialName = "python-execution__attempt";
		const trialDir = path.join(jobDir, trialName);
		fs.mkdirSync(path.join(trialDir, "agent"), { recursive: true });
		fs.writeFileSync(
			path.join(trialDir, "result.json"),
			JSON.stringify({
				started_at: "2026-07-29T00:00:00.000Z",
				finished_at: "2026-07-29T00:00:01.000Z",
				agent_result: {
					n_input_tokens: 100,
					n_output_tokens: 20,
					n_cache_tokens: 40,
					cost_usd: 0.01,
				},
				verifier_result: { rewards: { reward: 1 } },
			}),
		);
		fs.writeFileSync(
			path.join(trialDir, "agent", "omp.txt"),
			`${JSON.stringify({ type: "tool_execution_start", toolCallId: "call-1", toolName: "run" })}\n`,
		);

		expect(countTrialToolCalls(jobDir, trialName)).toEqual({ total: 1, runtimeUsed: true });
		const result = summarizeArm(jobsDir, "rtbench", "runtime", ["python-execution"], 1_250);
		expect(result).toMatchObject({
			trials: 1,
			completedTrials: 1,
			pass: 1,
			tokIn: 100,
			tokOut: 20,
			tokCache: 40,
			durationMs: 1_000,
			elapsedMs: 1_250,
			runtimeTrials: 1,
			runtimeTasks: 1,
		});
		expect(result.taskMeasurements[0].trials[0]).toMatchObject({
			trialName,
			toolCalls: 1,
			runtimeUsed: true,
		});
		fs.writeFileSync(
			path.join(jobDir, "result.json"),
			JSON.stringify({
				started_at: "2026-07-29T00:00:00.000Z",
				finished_at: "2026-07-29T00:00:02.500Z",
				n_total_trials: 1,
				stats: { n_running_trials: 0, n_pending_trials: 0 },
			}),
		);
		expect(summarizeArm(jobsDir, "rtbench", "runtime", ["python-execution"]).elapsedMs).toBe(2_500);
	});

	it("passes deterministic paired gates for non-inferior outcomes and a 20% duration win", () => {
		const { baseline, runtime } = comparisonSummaries();
		const first = analyzeRuntimeComparison(baseline, runtime);
		const second = analyzeRuntimeComparison(baseline, runtime);

		expect(first).toEqual(second);
		expect(first.verdict).toBe("pass");
		expect(first.passRateDifferencePp).toEqual({ point: 0, lower: 0, upper: 0 });
		expect(first.durationRatio.point).toBeCloseTo(0.8);
		expect(first.tokenRatio.point).toBeCloseTo(0.9);
	});

	it("bootstraps trials within each fixed task stratum", () => {
		const { baseline, runtime } = comparisonSummaries();
		for (const [index, baselineTask] of baseline.taskMeasurements.entries()) {
			const runtimeTask = runtime.taskMeasurements[index];
			const durationRatio = 0.6 + index * 0.04;
			baselineTask.trials = Array.from({ length: 5 }, (_, trialIndex) => ({
				...baselineTask.trials[0],
				trialName: `${baselineTask.taskId}-baseline-${trialIndex}`,
			}));
			runtimeTask.trials = Array.from({ length: 5 }, (_, trialIndex) => ({
				...runtimeTask.trials[0],
				trialName: `${runtimeTask.taskId}-runtime-${trialIndex}`,
				durationMs: baselineTask.trials[trialIndex].durationMs * durationRatio,
			}));
		}

		const result = analyzeRuntimeComparison(baseline, runtime);

		expect(result.durationRatio.lower).toBeCloseTo(result.durationRatio.point);
		expect(result.durationRatio.upper).toBeCloseTo(result.durationRatio.point);
	});

	it("fails when effectiveness is established below the non-inferiority margin", () => {
		const { baseline, runtime } = comparisonSummaries({ runtimePass: () => false });

		const result = analyzeRuntimeComparison(baseline, runtime);

		expect(result.verdict).toBe("fail");
		expect(result.reasons).toContain("effectiveness is inferior at the -5 pp margin");
	});

	it("fails when the non-winning efficiency metric regresses beyond five percent", () => {
		const { baseline, runtime } = comparisonSummaries({ durationRatio: 0.8, tokenRatio: 1.1 });

		const result = analyzeRuntimeComparison(baseline, runtime);

		expect(result.verdict).toBe("fail");
		expect(result.reasons).toContain(
			"no material efficiency win with the other metric inside the 5% regression bound",
		);
	});

	it("returns inconclusive when token telemetry is missing", () => {
		const { baseline, runtime } = comparisonSummaries({ includeTokens: false });

		const result = analyzeRuntimeComparison(baseline, runtime);

		expect(result.verdict).toBe("inconclusive");
		expect(result.reasons).toContain("paired effectiveness or efficiency measurements are missing");
	});

	it("returns inconclusive below overall runtime adoption threshold", () => {
		const usedTasks = new Set(RUNTIME_TASKS.slice(0, 9).map(task => task.id));
		const { baseline, runtime } = comparisonSummaries({ runtimeUsed: taskId => usedTasks.has(taskId) });

		const result = analyzeRuntimeComparison(baseline, runtime);

		expect(result.adoptionOverall).toBe(0.75);
		expect(result.verdict).toBe("inconclusive");
		expect(result.reasons).toContain("runtime adoption 75.0% is below 80%");
	});

	it("returns inconclusive when one capability group is below adoption threshold", () => {
		const { baseline, runtime } = comparisonSummaries({
			runtimeUsed: taskId => RUNTIME_TASKS.find(task => task.id === taskId)?.group !== "profiling",
		});

		const result = analyzeRuntimeComparison(baseline, runtime);

		expect(result.adoptionOverall).toBeGreaterThanOrEqual(0.8);
		expect(result.adoptionByGroup.profiling).toBe(0);
		expect(result.verdict).toBe("inconclusive");
		expect(result.reasons).toContain("runtime adoption is below 50% for: profiling");
	});

	it("formats the primary success, efficiency, and tool-use deltas", () => {
		const baseline = summary("baseline");
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
		expect(report).toContain(
			"| Embedded cold open + first JS | — | 123.00 ms (single cold sample) | Not comparable |",
		);
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

	it("parses frozen revisions and requires an architecture-tagged historical binary", () => {
		const parsed = parseRuntimeBenchmarkCli([
			"--revision=current-revision",
			"--source-patch-sha256=patch-sha256",
			"--historical-revision=historical-revision",
			"--historical-binary=/tmp/aura-linux-x64",
		]);

		expect(parsed.manifestRevision).toBe("current-revision");
		expect(parsed.sourcePatchSha256).toBe("patch-sha256");
		expect(parsed.historicalRevision).toBe("historical-revision");
		expect(parsed.historicalBinary).toBe("/tmp/aura-linux-x64");
		expect(() => parseRuntimeBenchmarkCli(["--historical-binary=/tmp/aura-linux-x64"])).toThrow(
			"--historical-binary requires --historical-revision",
		);
		expect(() =>
			parseRuntimeBenchmarkCli(["--historical-revision=historical-revision", "--historical-binary=/tmp/aura"]),
		).toThrow("--historical-binary filename must identify the x64 architecture");
	});

	it("writes a frozen machine-readable benchmark manifest", async () => {
		const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-manifest-"));
		cleanups.push(jobsDir);
		const opts = parseRuntimeBenchmarkCli([
			`--jobs-dir=${jobsDir}`,
			"--prefix=manifest-test",
			"--task=python-execution",
			"--attempts=5",
			"--revision=current-revision",
			"--source-patch-sha256=patch-sha256",
			"--historical-revision=historical-revision",
		]);

		const manifestPath = await writeRuntimeBenchmarkManifest(opts, "2026-07-29T00:00:00.000Z");
		const manifest = await Bun.file(manifestPath).json();

		expect(manifest).toMatchObject({
			schemaVersion: 3,
			prefix: "manifest-test",
			startedAt: "2026-07-29T00:00:00.000Z",
			revision: "current-revision",
			sourcePatchSha256: "patch-sha256",
			historicalRevision: "historical-revision",
			model: "openai-codex/gpt-5.6-sol",
			thinking: "xhigh",
			attempts: 5,
			taskIds: ["python-execution"],
			tools: {
				baseline: BASELINE_TOOLS,
				runtimeByTask: {
					"python-execution": [...BASELINE_TOOLS, "run", "check"],
				},
				historical: BASELINE_TOOLS,
			},
			// A campaign that bypassed the runtime-arm gate must not be indistinguishable
			// from one that passed it.
			allowMissingRuntime: false,
		});
		expect(manifest.taskHashes["python-execution"]).toMatch(/^[a-f0-9]{64}$/);
		expect(manifest.verifierBun).toMatchObject({ version: Bun.version });
		expect(manifest.verifierBun.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(manifest.logicalCpuCount).toBeGreaterThan(0);

		const bypassed = await Bun.file(
			await writeRuntimeBenchmarkManifest(
				parseRuntimeBenchmarkCli([
					`--jobs-dir=${jobsDir}`,
					"--prefix=manifest-bypassed",
					"--task=python-execution",
					"--allow-missing-runtime",
				]),
				"2026-07-29T00:00:00.000Z",
			),
		).json();
		expect(bypassed.allowMissingRuntime).toBe(true);
	});

	it("labels the historical control separately from the causal decision", () => {
		const historical: ArmSummary = { ...summary("baseline"), arm: "historical" };

		const report = formatComparison("rtbench", summary("baseline"), summary("runtime"), [], undefined, historical);

		expect(report).toContain("## Historical whole-product control");
		expect(report).toContain("is not part of the causal runtime-tools decision");
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

	it("preserves the measurement failure when service cleanup also fails", async () => {
		const closed: string[] = [];
		const runtime = (name: string): AdapterBenchmarkRuntime => ({
			run: async () => {
				throw new Error(`${name} run should not be called`);
			},
			close: async () => {
				closed.push(name);
				if (name === "embedded") throw new Error("embedded close failed");
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

// ── runtime arm preflight ────────────────────────────────────────────────────
// Decision logic only: `runDocker` is always injected, so no test here ever
// contacts the docker daemon. The probe language must stay non-JS — TypeScript
// executes through the Bun adapter even with the packaged runtime absent, which
// is how a whole campaign once measured bash fallback and reported 100% pass.

const PROBE_REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const PROBE_RUNTIME_BINARY = path.join(PROBE_REPO_ROOT, "out", "aura-elide-linux-x64", "bin", "elide");
const PROBE_EMBEDDED_LIB = path.join(PROBE_REPO_ROOT, "out", "aura-elide-linux-x64", "lib", "libelide_embed.so");
const PROBE_BINARY_CONTAINER_PATH = "/opt/omp/src/out/aura-elide-linux-x64/bin/elide";
const PROBE_LIBRARY_CONTAINER_PATH = "/opt/omp/src/out/aura-elide-linux-x64/lib/libelide_embed.so";

function dockerStub(overrides: { build?: Partial<DockerRunResult>; run?: Partial<DockerRunResult> } = {}): {
	calls: string[][];
	runDocker: (args: string[]) => Promise<DockerRunResult>;
} {
	const calls: string[][] = [];
	return {
		calls,
		runDocker: async (args: string[]) => {
			calls.push(args);
			if (args[0] === "build") {
				return { exitCode: 0, stdout: "sha256:probe-image\n", stderr: "", ...overrides.build };
			}
			if (args[0] === "run") {
				return { exitCode: 0, stdout: `${RUNTIME_ARM_PROBE_SENTINEL}\n`, stderr: "", ...overrides.run };
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		},
	};
}

function probeScript(calls: string[][]): string {
	const run = calls.find(args => args[0] === "run");
	if (!run) throw new Error("the preflight never issued a docker run");
	return run.at(-1) ?? "";
}

describe("runtime arm preflight", () => {
	it("skips the probe entirely when no runtime artifacts are injected", async () => {
		const docker = dockerStub();

		await smokeRuntimeArmExecution({ taskRoot: "/tmp/tasks", runDocker: docker.runDocker });

		expect(docker.calls).toEqual([]);
	});

	it("executes the injected artifacts inside the existing task image when a runtime is supplied", async () => {
		const docker = dockerStub();

		await smokeRuntimeArmExecution({
			taskRoot: "/tmp/tasks",
			runtimeBinary: PROBE_RUNTIME_BINARY,
			embeddedLib: PROBE_EMBEDDED_LIB,
			runDocker: docker.runDocker,
		});

		expect(docker.calls[0]).toEqual(["build", "--quiet", path.join("/tmp/tasks", "python-execution", "environment")]);
		const run = docker.calls.find(args => args[0] === "run");
		expect(run).toBeDefined();
		expect(run).toContain(`${PROBE_REPO_ROOT}:/opt/omp/src:ro`);
		expect(run).toContain("sha256:probe-image");
		// The probe must prove the *injected* artifacts run, so it cannot reach the
		// network to acquire a runtime, and it needs a writable HOME to be believed.
		expect(run?.join(" ")).toContain("--network none");
		expect(run?.join(" ")).toContain("--env HOME=/tmp");
		expect(probeScript(docker.calls)).toContain(PROBE_BINARY_CONTAINER_PATH);
		expect(probeScript(docker.calls)).toContain(PROBE_LIBRARY_CONTAINER_PATH);
		// An absent artifact must say which one, not just fail an anonymous `test`.
		expect(probeScript(docker.calls)).toContain(
			`missing or non-executable process binary: ${PROBE_BINARY_CONTAINER_PATH}`,
		);
		expect(probeScript(docker.calls)).toContain(
			`missing or unreadable embedded library: ${PROBE_LIBRARY_CONTAINER_PATH}`,
		);
		expect(docker.calls.at(-1)).toEqual(["image", "rm", "--force", "sha256:probe-image"]);
	});

	it("fails the campaign naming the artifact path when the probe exits non-zero", async () => {
		const docker = dockerStub({ run: { exitCode: 1, stderr: "bash: elide: No such file or directory" } });

		const failure = await smokeRuntimeArmExecution({
			taskRoot: "/tmp/tasks",
			runtimeBinary: PROBE_RUNTIME_BINARY,
			embeddedLib: PROBE_EMBEDDED_LIB,
			runDocker: docker.runDocker,
		}).then(
			() => null,
			(error: unknown) => error as Error,
		);

		expect(failure).not.toBeNull();
		expect(failure?.message).toContain(PROBE_BINARY_CONTAINER_PATH);
		expect(failure?.message).toContain(PROBE_LIBRARY_CONTAINER_PATH);
		expect(failure?.message).toContain("bash: elide: No such file or directory");
	});

	it("fails the campaign when the probe prints something other than the sentinel", async () => {
		const docker = dockerStub({ run: { exitCode: 0, stdout: "hello from bash fallback\n" } });

		const failure = await smokeRuntimeArmExecution({
			taskRoot: "/tmp/tasks",
			runtimeBinary: PROBE_RUNTIME_BINARY,
			embeddedLib: PROBE_EMBEDDED_LIB,
			runDocker: docker.runDocker,
		}).then(
			() => null,
			(error: unknown) => error as Error,
		);

		expect(failure).not.toBeNull();
		expect(failure?.message).toContain(RUNTIME_ARM_PROBE_SENTINEL);
		expect(failure?.message).toContain("hello from bash fallback");
		expect(failure?.message).toContain(PROBE_BINARY_CONTAINER_PATH);
	});

	// `test -r` is not enough. Under `AURA_RUNTIME_ADAPTER=auto` a present-but-incompatible
	// library is still routed to the embedded endpoint (`selected.ts` picks embedded whenever
	// `embeddedLibraryPath` is set, and `embedded.ts` sets it in the broken branch too), so an
	// ABI or schema mismatch fails every runtime call and drops the agent onto bash.
	it("rejects a present but unloadable embedded library", async () => {
		const docker = dockerStub({
			run: { exitCode: 1, stderr: "AssertionError: abi 2" },
		});

		const failure = await smokeRuntimeArmExecution({
			taskRoot: "/tmp/tasks",
			runtimeBinary: PROBE_RUNTIME_BINARY,
			embeddedLib: PROBE_EMBEDDED_LIB,
			runDocker: docker.runDocker,
		}).then(
			() => null,
			(error: unknown) => error as Error,
		);

		expect(probeScript(docker.calls)).toContain(`ctypes.CDLL('${PROBE_LIBRARY_CONTAINER_PATH}')`);
		expect(probeScript(docker.calls)).toContain(`== ${EMBEDDED_RUNTIME_ABI_VERSION}`);
		expect(probeScript(docker.calls)).toContain(EMBEDDED_RUNTIME_SCHEMA_SHA256);
		expect(failure).not.toBeNull();
		expect(failure?.message).toContain(PROBE_LIBRARY_CONTAINER_PATH);
		expect(failure?.message).toContain("AssertionError: abi 2");
	});

	it("omits the library-load step when only a process binary is injected", async () => {
		const docker = dockerStub();

		await smokeRuntimeArmExecution({
			taskRoot: "/tmp/tasks",
			runtimeBinary: PROBE_RUNTIME_BINARY,
			runDocker: docker.runDocker,
		});

		const script = probeScript(docker.calls);
		expect(script).toContain(PROBE_BINARY_CONTAINER_PATH);
		expect(script).not.toContain("ctypes");
		expect(script).not.toContain(PROBE_LIBRARY_CONTAINER_PATH);
	});

	it("downgrades the failure to a warning under --allow-missing-runtime", async () => {
		const docker = dockerStub({ run: { exitCode: 1, stderr: "no such file" } });
		const warnings: string[] = [];

		await smokeRuntimeArmExecution({
			taskRoot: "/tmp/tasks",
			runtimeBinary: PROBE_RUNTIME_BINARY,
			embeddedLib: PROBE_EMBEDDED_LIB,
			runDocker: docker.runDocker,
			allowMissingRuntime: true,
			warn: message => warnings.push(message),
		});

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(PROBE_BINARY_CONTAINER_PATH);
		expect(parseRuntimeBenchmarkCli([]).allowMissingRuntime).toBe(false);
		expect(parseRuntimeBenchmarkCli(["--allow-missing-runtime"]).allowMissingRuntime).toBe(true);
	});

	it("probes a non-JavaScript language so the Bun adapter cannot mask a missing runtime", async () => {
		const docker = dockerStub();

		await smokeRuntimeArmExecution({
			taskRoot: "/tmp/tasks",
			runtimeBinary: PROBE_RUNTIME_BINARY,
			embeddedLib: PROBE_EMBEDDED_LIB,
			runDocker: docker.runDocker,
		});

		const script = probeScript(docker.calls);
		expect(script).toContain("-l python");
		expect(script).toContain(".py");
		expect(script).not.toContain(BENCHMARK_BUN_CONTAINER_PATH);
		expect(script).not.toContain(".ts");
		expect(script).not.toMatch(/\b(ts|typescript|javascript|bun|node)\b/i);
	});
});
