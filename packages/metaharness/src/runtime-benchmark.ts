#!/usr/bin/env bun
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	EmbeddedRuntimeEndpoint,
	type LocalEndpointOptions,
	LocalRuntimeEndpoint,
	type RuntimeExecResult,
	RuntimeRpcError,
	type RuntimeRunParams,
	RuntimeService,
} from "../../coding-agent/src/runtime";
import { isRegularFile as isRuntimeRegularFile, runtimeBinaryNames } from "../../coding-agent/src/runtime/resolve";
import { type JobInfo, readJobResult, readTrials, type TrialStatus } from "./runner";
import {
	BENCHMARK_BUN_VERSION,
	materializeRuntimeTasks,
	RUNTIME_TASKS,
	type RuntimeCapabilityGroup,
	smokeRuntimeArmExecution,
	smokeTypeScriptTaskVerifier,
	sourceMountedRuntimePath,
	spawnDocker,
} from "./runtime-benchmark-suite";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const PKG_DIR = path.resolve(import.meta.dir, "..");
const DEFAULT_JOBS_DIR = path.join(REPO_ROOT, "runs", "harbor");
const RUNTIME_TOOL_NAMES: Record<string, true> = {
	run: true,
	check: true,
	insights: true,
	profile: true,
	serve: true,
	jvm_disassemble: true,
	jvm_format: true,
	jvm_jar: true,
	jvm_deps: true,
};

export const BASELINE_TOOLS = ["read", "write", "edit", "bash", "grep", "glob"];
export const ESSENTIAL_RUNTIME_TOOLS = [...BASELINE_TOOLS, "run", "check"];

export type BenchmarkArm = "baseline" | "runtime" | "historical";

export interface ArmLaunchOptions {
	model: string;
	thinking: string;
	attempts: number;
	prefix: string;
	jobsDir: string;
	taskRoot: string;
	gatewayUrl: string;
	hostNetwork: boolean;
	taskIds: string[];
	historicalBinary?: string;
	runtimeBinary?: string;
	embeddedLib?: string;
}

export interface ArmLaunch {
	arm: BenchmarkArm;
	taskId: string;
	jobName: string;
	args: string[];
}

export interface RuntimeTrialMeasurement {
	taskId: string;
	trialName: string;
	status: TrialStatus;
	detail: string;
	durationMs: number;
	tokIn: number;
	tokOut: number;
	tokCache: number;
	costUsd: number;
	toolCalls: number;
	runtimeUsed: boolean;
}

export interface RuntimeTaskMeasurement {
	taskId: string;
	group: RuntimeCapabilityGroup;
	trials: RuntimeTrialMeasurement[];
}

export interface ArmSummary {
	arm: BenchmarkArm;
	tasks: number;
	trials: number;
	completedTrials: number;
	pass: number;
	fail: number;
	error: number;
	costUsd: number;
	tokIn: number;
	tokOut: number;
	tokCache: number;
	durationMs: number;
	elapsedMs: number;
	medianDurationMs: number;
	toolCalls: number;
	runtimeTasks: number;
	runtimeTrials: number;
	taskMeasurements: RuntimeTaskMeasurement[];
}

export interface ConfidenceInterval {
	point: number;
	lower: number;
	upper: number;
}

export interface RuntimeComparisonAnalysis {
	passRateDifferencePp: ConfidenceInterval;
	durationRatio: ConfidenceInterval;
	tokenRatio: ConfidenceInterval;
	adoptionOverall: number;
	adoptionByGroup: Record<RuntimeCapabilityGroup, number>;
	verdict: "pass" | "fail" | "inconclusive";
	reasons: string[];
}

export interface MicroResult {
	name: string;
	baselineMs: number;
	runtimeMs: number;
	ratio: number;
}

export interface AdapterMicroResult {
	name: string;
	/** Process p50; null for the embedded-only cold-open row. */
	processMs: number | null;
	processP95Ms: number | null;
	embeddedMs: number;
	embeddedP95Ms: number;
	/** Process p50 divided by embedded p50; null when the row is not comparable. */
	speedup: number | null;
	p95Speedup: number | null;
}

export type AdapterMicrobenchmarkOutcome =
	| { kind: "skipped"; message: string }
	| { kind: "completed"; results: AdapterMicroResult[] };

export interface AdapterMicrobenchmarkConfig {
	iterations: number;
	processBinaryPath: string;
	embeddedLibraryPath: string;
	env?: NodeJS.ProcessEnv;
}

export interface AdapterBenchmarkRuntime {
	run(params: RuntimeRunParams, signal?: AbortSignal): Promise<RuntimeExecResult>;
	close(): Promise<void>;
}

export interface TimedAdapterSample<T> {
	durationMs: number;
	value: T;
}

export interface AdapterCaseOptions<T> {
	name: string;
	iterations: number;
	process: () => Promise<TimedAdapterSample<T>>;
	embedded: () => Promise<TimedAdapterSample<T>>;
	validate: (value: T) => void;
}

export interface AdapterMicrobenchmarkDependencies {
	createProcessService: (config: AdapterMicrobenchmarkConfig) => AdapterBenchmarkRuntime;
	createEmbeddedService: (config: AdapterMicrobenchmarkConfig) => AdapterBenchmarkRuntime;
	runCases: (
		config: AdapterMicrobenchmarkConfig,
		processService: AdapterBenchmarkRuntime,
		embeddedService: AdapterBenchmarkRuntime,
	) => Promise<AdapterMicroResult[]>;
}

export const ADAPTER_MICROBENCHMARK_SKIPPED =
	"Adapter comparison skipped: no embedded runtime library was supplied (use --embedded-lib=<path> or AURA_RUNTIME_EMBEDDED_LIB).";

export interface RuntimeBenchmarkCliOptions {
	model: string;
	thinking: string;
	attempts: number;
	prefix: string;
	jobsDir: string;
	gatewayUrl: string;
	hostNetwork: boolean;
	taskIds: string[];
	microIterations: number;
	mode: "all" | "agent" | "micro";
	embeddedLib: string | undefined;
	manifestRevision: string | undefined;
	sourcePatchSha256: string | undefined;
	historicalRevision: string | undefined;
	historicalBinary: string | undefined;
	resume: boolean;
	/** Report an unreachable runtime arm instead of aborting the campaign. */
	allowMissingRuntime: boolean;
}

export function runtimeToolsForTask(taskId: string): string[] {
	const task = RUNTIME_TASKS.find(candidate => candidate.id === taskId);
	if (!task) throw new Error(`unknown runtime task: ${taskId}`);
	return [...ESSENTIAL_RUNTIME_TOOLS, ...task.runtimeTools];
}

export function buildArmLaunches(opts: ArmLaunchOptions): ArmLaunch[] {
	const launches: ArmLaunch[] = [];
	for (const [index, taskId] of opts.taskIds.entries()) {
		const armOrder: BenchmarkArm[] = index % 2 === 0 ? ["baseline", "runtime"] : ["runtime", "baseline"];
		for (const arm of armOrder) {
			const tools = arm === "runtime" ? runtimeToolsForTask(taskId) : BASELINE_TOOLS;
			const jobName = `${opts.prefix}-${arm}-${taskId}`;
			const args = [
				`--path=${path.join(opts.taskRoot, taskId)}`,
				"--install=source",
				`--model=${opts.model}`,
				`--thinking=${opts.thinking}`,
				`--attempts=${opts.attempts}`,
				"--tasks=1",
				"--concurrency=1",
				`--jobs-dir=${opts.jobsDir}`,
				`--gateway-url=${opts.gatewayUrl}`,
				`--job-name=${jobName}`,
				"--agent-arg=--tools",
				`--agent-arg=${tools.join(",")}`,
			];
			// Categorical, artifacts or not: a benchmark never reaches for the network
			// to acquire its own subject. A download that succeeds silently swaps the
			// subject; one that fails (no `xz` in the task image) turns every runtime
			// call into an error — 163 of them on one task. Without artifacts the arm
			// then reports runtime-missing immediately instead of burning the campaign
			// on a fetch that cannot work.
			args.push("--env=AURA_RUNTIME_AUTO_DOWNLOAD=false");
			if (opts.runtimeBinary || opts.embeddedLib) {
				if (!opts.runtimeBinary || !opts.embeddedLib) {
					throw new Error("Runtime benchmark agent launches require both process and embedded runtime artifacts.");
				}
				args.push(
					`--env=AURA_RUNTIME_BIN=${sourceMountedRuntimePath(opts.runtimeBinary)}`,
					`--env=AURA_RUNTIME_EMBEDDED_LIB=${sourceMountedRuntimePath(opts.embeddedLib)}`,
					"--env=AURA_RUNTIME_ADAPTER=auto",
				);
			}
			if (opts.hostNetwork) args.push("--host-network");
			launches.push({ arm, taskId, jobName, args });
		}
		if (opts.historicalBinary) {
			const arm: BenchmarkArm = "historical";
			const jobName = `${opts.prefix}-${arm}-${taskId}`;
			const args = [
				`--path=${path.join(opts.taskRoot, taskId)}`,
				`--binary=${opts.historicalBinary}`,
				`--model=${opts.model}`,
				`--thinking=${opts.thinking}`,
				`--attempts=${opts.attempts}`,
				"--tasks=1",
				"--concurrency=1",
				`--jobs-dir=${opts.jobsDir}`,
				`--gateway-url=${opts.gatewayUrl}`,
				`--job-name=${jobName}`,
				"--agent-arg=--tools",
				`--agent-arg=${BASELINE_TOOLS.join(",")}`,
			];
			if (opts.hostNetwork) args.push("--host-network");
			launches.push({ arm, taskId, jobName, args });
		}
	}
	return launches;
}

export function armRunnerArgs(
	launch: ArmLaunch,
	jobsDir: string,
	resume: boolean,
	readResult: (jobDir: string) => JobInfo | null = readJobResult,
): string[] | null {
	if (!resume) return launch.args;
	const jobDir = path.join(jobsDir, launch.jobName);
	const result = readResult(jobDir);
	if (result?.finishedAt !== null && result?.finishedAt !== undefined) return null;
	if (result || fs.existsSync(path.join(jobDir, "config.json"))) return [`--resume=${jobDir}`];
	return launch.args;
}

export function countTrialToolCalls(jobDir: string, trialName: string): { total: number; runtimeUsed: boolean } {
	let total = 0;
	let runtimeUsed = false;
	const transcriptPath = path.join(jobDir, trialName, "agent", "omp.txt");
	if (!fs.existsSync(transcriptPath)) return { total, runtimeUsed };
	for (const line of fs.readFileSync(transcriptPath, "utf8").split("\n")) {
		if (!line.startsWith("{")) continue;
		try {
			const event = JSON.parse(line) as { type?: string; toolName?: string };
			if (event.type !== "tool_execution_start" || !event.toolName) continue;
			total++;
			if (RUNTIME_TOOL_NAMES[event.toolName]) runtimeUsed = true;
		} catch {
			// A transcript may end with a partial JSON line after interruption.
		}
	}
	return { total, runtimeUsed };
}

export function countToolCalls(jobDir: string): { total: number; runtimeUsed: boolean } {
	let total = 0;
	let runtimeUsed = false;
	for (const trial of readTrials(jobDir)) {
		const tools = countTrialToolCalls(jobDir, trial.name);
		total += tools.total;
		runtimeUsed ||= tools.runtimeUsed;
	}
	return { total, runtimeUsed };
}

export function summarizeArm(
	jobsDir: string,
	prefix: string,
	arm: BenchmarkArm,
	taskIds: string[],
	elapsedMs?: number,
): ArmSummary {
	const durations: number[] = [];
	const groups = Object.fromEntries(RUNTIME_TASKS.map(task => [task.id, task.group])) as Record<
		string,
		RuntimeCapabilityGroup
	>;
	const summary: ArmSummary = {
		arm,
		tasks: taskIds.length,
		trials: 0,
		completedTrials: 0,
		pass: 0,
		fail: 0,
		error: 0,
		costUsd: 0,
		tokIn: 0,
		tokOut: 0,
		tokCache: 0,
		durationMs: 0,
		elapsedMs: elapsedMs ?? 0,
		toolCalls: 0,
		medianDurationMs: 0,
		runtimeTasks: 0,
		runtimeTrials: 0,
		taskMeasurements: [],
	};
	for (const taskId of taskIds) {
		const group = groups[taskId];
		if (!group) throw new Error(`unknown runtime task: ${taskId}`);
		const jobDir = path.join(jobsDir, `${prefix}-${arm}-${taskId}`);
		if (elapsedMs === undefined) {
			const job = readJobResult(jobDir);
			if (job?.startedAt !== null && job?.startedAt !== undefined && job.finishedAt !== null) {
				summary.elapsedMs += Math.max(0, job.finishedAt - job.startedAt);
			}
		}
		const trials = readTrials(jobDir);
		if (trials.some(trial => trial.status === "running"))
			throw new Error(`${prefix}-${arm}-${taskId} has undecided trials`);
		const measurements = trials.map(trial => {
			const tools = countTrialToolCalls(jobDir, trial.name);
			return {
				taskId,
				trialName: trial.name,
				status: trial.status,
				detail: trial.detail,
				durationMs: trial.durationMs,
				tokIn: trial.tokIn,
				tokOut: trial.tokOut,
				tokCache: trial.tokCache,
				costUsd: trial.costUsd,
				toolCalls: tools.total,
				runtimeUsed: tools.runtimeUsed,
			} satisfies RuntimeTrialMeasurement;
		});
		summary.taskMeasurements.push({ taskId, group, trials: measurements });
		summary.trials += measurements.length;
		summary.completedTrials += measurements.length;
		summary.pass += measurements.filter(trial => trial.status === "pass").length;
		summary.fail += measurements.filter(trial => trial.status === "fail").length;
		summary.error += measurements.filter(trial => trial.status === "error").length;
		summary.costUsd += measurements.reduce((sum, trial) => sum + trial.costUsd, 0);
		summary.tokIn += measurements.reduce((sum, trial) => sum + trial.tokIn, 0);
		summary.tokOut += measurements.reduce((sum, trial) => sum + trial.tokOut, 0);
		summary.tokCache += measurements.reduce((sum, trial) => sum + trial.tokCache, 0);
		summary.durationMs += measurements.reduce((sum, trial) => sum + trial.durationMs, 0);
		summary.toolCalls += measurements.reduce((sum, trial) => sum + trial.toolCalls, 0);
		summary.runtimeTrials += measurements.filter(trial => trial.runtimeUsed).length;
		if (measurements.some(trial => trial.runtimeUsed)) summary.runtimeTasks++;
		durations.push(...measurements.map(trial => trial.durationMs));
	}
	summary.medianDurationMs = durations.length === 0 ? 0 : median(durations);
	return summary;
}

function percentage(value: number, total: number): number {
	return total === 0 ? 0 : (value / total) * 100;
}

function signed(value: number, suffix: string): string {
	return `${value >= 0 ? "+" : ""}${value.toFixed(1)}${suffix}`;
}

interface TaskComparison {
	taskId: string;
	group: RuntimeCapabilityGroup;
	baselinePassRate: number;
	runtimePassRate: number;
	durationRatio: number;
	tokenRatio: number;
	baselineTrials: readonly RuntimeTrialMeasurement[];
	runtimeTrials: readonly RuntimeTrialMeasurement[];
}

const BOOTSTRAP_SAMPLES = 10_000;
const BOOTSTRAP_SEED = 0xa17a2026;
const EFFECTIVENESS_MARGIN_PP = -5;
const DURATION_WIN_RATIO = 0.85;
const TOKEN_WIN_RATIO = 0.9;
const MAX_OTHER_REGRESSION_RATIO = 1.05;
const MIN_OVERALL_ADOPTION = 0.8;
const MIN_GROUP_ADOPTION = 0.5;

function mean(values: readonly number[]): number {
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function geometricMean(values: readonly number[]): number {
	return Math.exp(mean(values.map(Math.log)));
}

function seededRandom(seed: number): () => number {
	let state = seed;
	return () => {
		state |= 0;
		state = (state + 0x6d2b79f5) | 0;
		let value = Math.imul(state ^ (state >>> 15), 1 | state);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
}

function distributionQuantile(values: readonly number[], quantile: number): number {
	if (values.length === 0) return Number.NaN;
	if (values.some(value => !Number.isFinite(value))) return Number.NaN;
	const sorted = values.toSorted((a, b) => a - b);
	const rank = (sorted.length - 1) * quantile;
	const lower = Math.floor(rank);
	const upper = Math.ceil(rank);
	if (lower === upper) return sorted[lower];
	return sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
}

function interval(point: number, samples: number[]): ConfidenceInterval {
	return {
		point,
		lower: distributionQuantile(samples, 0.025),
		upper: distributionQuantile(samples, 0.975),
	};
}

function taskComparisons(baseline: ArmSummary, runtime: ArmSummary): TaskComparison[] {
	const baselineByTask = Object.fromEntries(baseline.taskMeasurements.map(task => [task.taskId, task])) as Record<
		string,
		RuntimeTaskMeasurement
	>;
	const comparisons: TaskComparison[] = [];
	for (const runtimeTask of runtime.taskMeasurements) {
		const baselineTask = baselineByTask[runtimeTask.taskId];
		if (
			!baselineTask ||
			baselineTask.trials.length === 0 ||
			baselineTask.trials.length !== runtimeTask.trials.length
		) {
			continue;
		}
		const baselineDuration = mean(baselineTask.trials.map(trial => trial.durationMs));
		const runtimeDuration = mean(runtimeTask.trials.map(trial => trial.durationMs));
		const baselineTokens = baselineTask.trials.reduce((sum, trial) => sum + trial.tokIn + trial.tokOut, 0);
		const runtimeTokens = runtimeTask.trials.reduce((sum, trial) => sum + trial.tokIn + trial.tokOut, 0);
		comparisons.push({
			taskId: runtimeTask.taskId,
			group: runtimeTask.group,
			baselinePassRate:
				baselineTask.trials.filter(trial => trial.status === "pass").length / baselineTask.trials.length,
			runtimePassRate:
				runtimeTask.trials.filter(trial => trial.status === "pass").length / runtimeTask.trials.length,
			durationRatio: baselineDuration > 0 ? runtimeDuration / baselineDuration : Number.NaN,
			tokenRatio: baselineTokens > 0 && runtimeTokens > 0 ? runtimeTokens / baselineTokens : Number.NaN,
			baselineTrials: baselineTask.trials,
			runtimeTrials: runtimeTask.trials,
		});
	}
	return comparisons;
}

function bootstrapComparisons(comparisons: readonly TaskComparison[]): {
	pass: ConfidenceInterval;
	duration: ConfidenceInterval;
	tokens: ConfidenceInterval;
} {
	if (comparisons.length === 0) {
		const invalid = { point: Number.NaN, lower: Number.NaN, upper: Number.NaN };
		return { pass: invalid, duration: invalid, tokens: invalid };
	}
	const durationRatios = comparisons.map(comparison => comparison.durationRatio);
	const tokenRatios = comparisons.map(comparison => comparison.tokenRatio);
	if (
		durationRatios.some(ratio => !Number.isFinite(ratio) || ratio <= 0) ||
		tokenRatios.some(ratio => !Number.isFinite(ratio) || ratio <= 0)
	) {
		const invalid = { point: Number.NaN, lower: Number.NaN, upper: Number.NaN };
		return { pass: invalid, duration: invalid, tokens: invalid };
	}
	const passPoint = mean(
		comparisons.map(comparison => (comparison.runtimePassRate - comparison.baselinePassRate) * 100),
	);
	const durationPoint = geometricMean(durationRatios);
	const tokenPoint = geometricMean(tokenRatios);
	const passSamples: number[] = [];
	const durationSamples: number[] = [];
	const tokenSamples: number[] = [];
	const random = seededRandom(BOOTSTRAP_SEED);
	for (let iteration = 0; iteration < BOOTSTRAP_SAMPLES; iteration++) {
		const passDifferences: number[] = [];
		const sampledDurationRatios: number[] = [];
		const sampledTokenRatios: number[] = [];
		for (const comparison of comparisons) {
			let baselinePasses = 0;
			let runtimePasses = 0;
			let baselineDuration = 0;
			let runtimeDuration = 0;
			let baselineTokens = 0;
			let runtimeTokens = 0;
			const trialCount = comparison.baselineTrials.length;
			for (let index = 0; index < trialCount; index++) {
				const baselineTrial = comparison.baselineTrials[Math.floor(random() * trialCount)];
				const runtimeTrial = comparison.runtimeTrials[Math.floor(random() * trialCount)];
				if (baselineTrial.status === "pass") baselinePasses++;
				if (runtimeTrial.status === "pass") runtimePasses++;
				baselineDuration += baselineTrial.durationMs;
				runtimeDuration += runtimeTrial.durationMs;
				baselineTokens += baselineTrial.tokIn + baselineTrial.tokOut;
				runtimeTokens += runtimeTrial.tokIn + runtimeTrial.tokOut;
			}
			passDifferences.push(((runtimePasses - baselinePasses) / trialCount) * 100);
			sampledDurationRatios.push(runtimeDuration / baselineDuration);
			sampledTokenRatios.push(runtimeTokens / baselineTokens);
		}
		passSamples.push(mean(passDifferences));
		durationSamples.push(geometricMean(sampledDurationRatios));
		tokenSamples.push(geometricMean(sampledTokenRatios));
	}
	return {
		pass: interval(passPoint, passSamples),
		duration: interval(durationPoint, durationSamples),
		tokens: interval(tokenPoint, tokenSamples),
	};
}

function runtimeAdoption(runtime: ArmSummary): {
	overall: number;
	byGroup: Record<RuntimeCapabilityGroup, number>;
} {
	const counts: Record<RuntimeCapabilityGroup, { completed: number; used: number }> = {
		execution: { completed: 0, used: 0 },
		project: { completed: 0, used: 0 },
		debugging: { completed: 0, used: 0 },
		profiling: { completed: 0, used: 0 },
		jvm: { completed: 0, used: 0 },
	};
	for (const task of runtime.taskMeasurements) {
		counts[task.group].completed += task.trials.length;
		counts[task.group].used += task.trials.filter(trial => trial.runtimeUsed).length;
	}
	const byGroup = Object.fromEntries(
		Object.entries(counts).map(([group, count]) => [group, count.completed === 0 ? 0 : count.used / count.completed]),
	) as Record<RuntimeCapabilityGroup, number>;
	return {
		overall: runtime.completedTrials === 0 ? 0 : runtime.runtimeTrials / runtime.completedTrials,
		byGroup,
	};
}

function newSystematicErrors(baseline: ArmSummary, runtime: ArmSummary): string[] {
	const baselineErrors = new Set(
		baseline.taskMeasurements.flatMap(task =>
			task.trials.filter(trial => trial.status === "error").map(trial => trial.detail),
		),
	);
	const runtimeCounts: Record<string, number> = {};
	for (const detail of runtime.taskMeasurements.flatMap(task =>
		task.trials.filter(trial => trial.status === "error").map(trial => trial.detail),
	)) {
		runtimeCounts[detail] = (runtimeCounts[detail] ?? 0) + 1;
	}
	return Object.entries(runtimeCounts)
		.filter(([detail, count]) => detail !== "" && count >= 2 && !baselineErrors.has(detail))
		.map(([detail]) => detail)
		.toSorted();
}

export function analyzeRuntimeComparison(baseline: ArmSummary, runtime: ArmSummary): RuntimeComparisonAnalysis {
	const comparisons = taskComparisons(baseline, runtime);
	const bootstrapped = bootstrapComparisons(comparisons);
	const adoption = runtimeAdoption(runtime);
	const systematicErrors = newSystematicErrors(baseline, runtime);
	const reasons: string[] = [];
	let establishedFailure = false;
	let unresolved = false;
	if (comparisons.length !== baseline.tasks || comparisons.length !== runtime.tasks) {
		reasons.push(`paired task coverage is ${comparisons.length}/${Math.max(baseline.tasks, runtime.tasks)}`);
		unresolved = true;
	}
	if (!Number.isFinite(bootstrapped.pass.lower)) {
		reasons.push("paired effectiveness or efficiency measurements are missing");
		unresolved = true;
	} else if (bootstrapped.pass.upper <= EFFECTIVENESS_MARGIN_PP) {
		reasons.push(`effectiveness is inferior at the ${EFFECTIVENESS_MARGIN_PP} pp margin`);
		establishedFailure = true;
	} else if (bootstrapped.pass.lower <= EFFECTIVENESS_MARGIN_PP) {
		reasons.push(`effectiveness interval crosses the ${EFFECTIVENESS_MARGIN_PP} pp margin`);
		unresolved = true;
	}
	const durationWin = bootstrapped.duration.upper <= DURATION_WIN_RATIO;
	const tokenWin = bootstrapped.tokens.upper <= TOKEN_WIN_RATIO;
	const durationSafe = bootstrapped.duration.upper <= MAX_OTHER_REGRESSION_RATIO;
	const tokenSafe = bootstrapped.tokens.upper <= MAX_OTHER_REGRESSION_RATIO;
	if (!(durationWin && tokenSafe) && !(tokenWin && durationSafe)) {
		reasons.push("no material efficiency win with the other metric inside the 5% regression bound");
		if (
			(durationWin && bootstrapped.tokens.lower > MAX_OTHER_REGRESSION_RATIO) ||
			(tokenWin && bootstrapped.duration.lower > MAX_OTHER_REGRESSION_RATIO) ||
			(bootstrapped.duration.lower > MAX_OTHER_REGRESSION_RATIO &&
				bootstrapped.tokens.lower > MAX_OTHER_REGRESSION_RATIO)
		)
			establishedFailure = true;
		else unresolved = true;
	}
	if (systematicErrors.length > 0) {
		reasons.push(`new systematic runtime errors: ${systematicErrors.join(", ")}`);
		establishedFailure = true;
	}
	if (adoption.overall < MIN_OVERALL_ADOPTION) {
		reasons.push(`runtime adoption ${(adoption.overall * 100).toFixed(1)}% is below 80%`);
		unresolved = true;
	}
	const lowGroups = Object.entries(adoption.byGroup)
		.filter(([, rate]) => rate < MIN_GROUP_ADOPTION)
		.map(([group]) => group);
	if (lowGroups.length > 0) {
		reasons.push(`runtime adoption is below 50% for: ${lowGroups.join(", ")}`);
		unresolved = true;
	}
	return {
		passRateDifferencePp: bootstrapped.pass,
		durationRatio: bootstrapped.duration,
		tokenRatio: bootstrapped.tokens,
		adoptionOverall: adoption.overall,
		adoptionByGroup: adoption.byGroup,
		verdict: establishedFailure ? "fail" : unresolved ? "inconclusive" : "pass",
		reasons,
	};
}

function formatConfidenceInterval(value: ConfidenceInterval, suffix = ""): string {
	if (![value.point, value.lower, value.upper].every(Number.isFinite)) return "unavailable";
	return `${value.point.toFixed(3)}${suffix} [95% CI ${value.lower.toFixed(3)}, ${value.upper.toFixed(3)}]`;
}

export function formatComparison(
	prefix: string,
	baseline: ArmSummary,
	runtime: ArmSummary,
	micro: MicroResult[],
	adapter: AdapterMicrobenchmarkOutcome = { kind: "skipped", message: ADAPTER_MICROBENCHMARK_SKIPPED },
	historical?: ArmSummary,
): string {
	const basePass = percentage(baseline.pass, baseline.trials);
	const runtimePass = percentage(runtime.pass, runtime.trials);
	const analysis = analyzeRuntimeComparison(baseline, runtime);
	const rows = [
		["Pass rate", `${basePass.toFixed(1)}%`, `${runtimePass.toFixed(1)}%`, signed(runtimePass - basePass, " pp")],
		["Errors", String(baseline.error), String(runtime.error), signed(runtime.error - baseline.error, "")],
		[
			"Cost",
			`$${baseline.costUsd.toFixed(3)}`,
			`$${runtime.costUsd.toFixed(3)}`,
			signed(runtime.costUsd - baseline.costUsd, ""),
		],
		[
			"Median trial time",
			`${(baseline.medianDurationMs / 1000).toFixed(1)}s`,
			`${(runtime.medianDurationMs / 1000).toFixed(1)}s`,
			signed((runtime.medianDurationMs - baseline.medianDurationMs) / 1000, "s"),
		],
		[
			"End-to-end arm time",
			`${(baseline.elapsedMs / 1000).toFixed(1)}s`,
			`${(runtime.elapsedMs / 1000).toFixed(1)}s`,
			signed((runtime.elapsedMs - baseline.elapsedMs) / 1000, "s"),
		],
		["Input tokens", String(baseline.tokIn), String(runtime.tokIn), signed(runtime.tokIn - baseline.tokIn, "")],
		["Output tokens", String(baseline.tokOut), String(runtime.tokOut), signed(runtime.tokOut - baseline.tokOut, "")],
		[
			"Cache tokens",
			String(baseline.tokCache),
			String(runtime.tokCache),
			signed(runtime.tokCache - baseline.tokCache, ""),
		],
		[
			"Tool calls",
			String(baseline.toolCalls),
			String(runtime.toolCalls),
			signed(runtime.toolCalls - baseline.toolCalls, ""),
		],
		[
			"Runtime-used tasks",
			`${baseline.runtimeTasks}/${baseline.tasks}`,
			`${runtime.runtimeTasks}/${runtime.tasks}`,
			"—",
		],
		[
			"Runtime-used trials",
			`${baseline.runtimeTrials}/${baseline.completedTrials}`,
			`${runtime.runtimeTrials}/${runtime.completedTrials}`,
			"—",
		],
	];
	const lines = [
		`# Runtime capability benchmark — ${prefix}`,
		"",
		"| Metric | Bash baseline | Runtime | Delta |",
		"|---|---:|---:|---:|",
		...rows.map(row => `| ${row.join(" | ")} |`),
		"",
		"## Pre-registered decision",
		"",
		`**${analysis.verdict.toUpperCase()}**`,
		"",
		"| Paired effect | Estimate |",
		"|---|---:|",
		`| Pass-rate difference | ${formatConfidenceInterval(analysis.passRateDifferencePp, " pp")} |`,
		`| Runtime/Bash duration | ${formatConfidenceInterval(analysis.durationRatio, "×")} |`,
		`| Runtime/Bash tokens | ${formatConfidenceInterval(analysis.tokenRatio, "×")} |`,
		"",
		`Runtime adoption: ${(analysis.adoptionOverall * 100).toFixed(1)}% overall.`,
		"",
		...Object.entries(analysis.adoptionByGroup).map(([group, rate]) => `- ${group}: ${(rate * 100).toFixed(1)}%`),
		"",
		...(analysis.reasons.length === 0
			? ["All pre-registered gates hold."]
			: analysis.reasons.map(reason => `- ${reason}`)),
	];
	if (baseline.taskMeasurements.length > 0 && runtime.taskMeasurements.length > 0) {
		const baselineByTask = Object.fromEntries(baseline.taskMeasurements.map(task => [task.taskId, task])) as Record<
			string,
			RuntimeTaskMeasurement
		>;
		lines.push(
			"",
			"## Task matrix",
			"",
			"| Task | Group | Bash pass | Runtime pass | Duration ratio | Token ratio | Runtime adoption |",
			"|---|---|---:|---:|---:|---:|---:|",
		);
		for (const runtimeTask of runtime.taskMeasurements) {
			const baselineTask = baselineByTask[runtimeTask.taskId];
			if (!baselineTask) continue;
			const baselineDuration = mean(baselineTask.trials.map(trial => trial.durationMs));
			const runtimeDuration = mean(runtimeTask.trials.map(trial => trial.durationMs));
			const baselineTokens = baselineTask.trials.reduce((sum, trial) => sum + trial.tokIn + trial.tokOut, 0);
			const runtimeTokens = runtimeTask.trials.reduce((sum, trial) => sum + trial.tokIn + trial.tokOut, 0);
			lines.push(
				`| ${runtimeTask.taskId} | ${runtimeTask.group} | ${percentage(baselineTask.trials.filter(trial => trial.status === "pass").length, baselineTask.trials.length).toFixed(1)}% | ${percentage(runtimeTask.trials.filter(trial => trial.status === "pass").length, runtimeTask.trials.length).toFixed(1)}% | ${(runtimeDuration / baselineDuration).toFixed(3)}× | ${(runtimeTokens / baselineTokens).toFixed(3)}× | ${percentage(runtimeTask.trials.filter(trial => trial.runtimeUsed).length, runtimeTask.trials.length).toFixed(1)}% |`,
			);
		}
	}
	if (historical) {
		lines.push(
			"",
			"## Historical whole-product control",
			"",
			"The historical arm changes code revision and is not part of the causal runtime-tools decision.",
			"",
			"| Metric | Historical Bash control |",
			"|---|---:|",
			`| Pass rate | ${percentage(historical.pass, historical.trials).toFixed(1)}% |`,
			`| Errors | ${historical.error} |`,
			`| Median trial time | ${(historical.medianDurationMs / 1000).toFixed(1)}s |`,
			`| End-to-end arm time | ${(historical.elapsedMs / 1000).toFixed(1)}s |`,
			`| Input tokens | ${historical.tokIn} |`,
			`| Output tokens | ${historical.tokOut} |`,
			`| Cache tokens | ${historical.tokCache} |`,
			`| Cost | $${historical.costUsd.toFixed(3)} |`,
		);
	}
	if (micro.length > 0) {
		lines.push(
			"",
			"## Deterministic microbenchmarks",
			"",
			"| Case | Direct toolchain | Runtime | Runtime/direct |",
			"|---|---:|---:|---:|",
		);
		for (const result of micro) {
			lines.push(
				`| ${result.name} | ${result.baselineMs.toFixed(2)} ms | ${result.runtimeMs.toFixed(2)} ms | ${result.ratio.toFixed(2)}× |`,
			);
		}
	}
	lines.push("", "## Runtime adapter microbenchmarks", "");
	if (adapter.kind === "skipped") {
		lines.push(adapter.message);
	} else {
		lines.push("| Case | Process runtime | Embedded runtime | Speedup |", "|---|---:|---:|---:|");
		for (const result of adapter.results) {
			if (result.processMs === null || result.processP95Ms === null) {
				lines.push(
					`| ${result.name} | — | ${result.embeddedMs.toFixed(2)} ms (single cold sample) | Not comparable |`,
				);
				continue;
			}
			lines.push(
				`| ${result.name} | ${formatAdapterLatency(result.processMs, result.processP95Ms)} | ${formatAdapterLatency(result.embeddedMs, result.embeddedP95Ms)} | ${formatAdapterSpeedup(result)} |`,
			);
		}
	}
	return `${lines.join("\n")}\n`;
}

function median(values: number[]): number {
	const sorted = values.toSorted((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(values: readonly number[], quantile: number): number {
	if (values.length === 0) throw new Error("adapter samples must not be empty");
	for (const value of values) {
		if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid adapter sample duration: ${value}`);
	}
	const sorted = values.toSorted((a, b) => a - b);
	const rank = (sorted.length - 1) * quantile;
	const lower = Math.floor(rank);
	const upper = Math.ceil(rank);
	if (lower === upper) return sorted[lower];
	return sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
}

export function summarizeAdapterSamples(
	name: string,
	processSamples: readonly number[] | null,
	embeddedSamples: readonly number[],
): AdapterMicroResult {
	const embeddedMs = percentile(embeddedSamples, 0.5);
	const embeddedP95Ms = percentile(embeddedSamples, 0.95);
	if (processSamples === null) {
		return {
			name,
			processMs: null,
			processP95Ms: null,
			embeddedMs,
			embeddedP95Ms,
			speedup: null,
			p95Speedup: null,
		};
	}
	const processMs = percentile(processSamples, 0.5);
	const processP95Ms = percentile(processSamples, 0.95);
	return {
		name,
		processMs,
		processP95Ms,
		embeddedMs,
		embeddedP95Ms,
		speedup: processMs / embeddedMs,
		p95Speedup: processP95Ms / embeddedP95Ms,
	};
}

export async function measureAdapterCase<T>(options: AdapterCaseOptions<T>): Promise<AdapterMicroResult> {
	if (!Number.isSafeInteger(options.iterations) || options.iterations < 1) {
		throw new Error("adapter benchmark iterations must be a positive integer");
	}
	options.validate((await options.process()).value);
	options.validate((await options.embedded()).value);
	const processSamples: number[] = [];
	const embeddedSamples: number[] = [];
	const accept = async (operation: () => Promise<TimedAdapterSample<T>>, samples: number[]): Promise<void> => {
		const sample = await operation();
		options.validate(sample.value);
		if (!Number.isFinite(sample.durationMs) || sample.durationMs <= 0) {
			throw new Error(`invalid adapter sample duration: ${sample.durationMs}`);
		}
		samples.push(sample.durationMs);
	};
	for (let iteration = 0; iteration < options.iterations; iteration++) {
		if (iteration % 2 === 0) {
			await accept(options.process, processSamples);
			await accept(options.embedded, embeddedSamples);
		} else {
			await accept(options.embedded, embeddedSamples);
			await accept(options.process, processSamples);
		}
	}
	return summarizeAdapterSamples(options.name, processSamples, embeddedSamples);
}

export function validateAdapterOutput(result: RuntimeExecResult, expectedStdout: string): void {
	if (result.exitCode !== 0) throw new Error(`expected exit code 0, received ${result.exitCode}`);
	if (result.stdout !== expectedStdout) {
		throw new Error(`expected stdout ${JSON.stringify(expectedStdout)}, received ${JSON.stringify(result.stdout)}`);
	}
	if (result.stderr !== "") throw new Error(`expected empty stderr, received ${JSON.stringify(result.stderr)}`);
	if (result.killed) throw new Error("expected runtime execution not to be killed");
}

function formatAdapterLatency(p50Ms: number, p95Ms: number): string {
	return `${p50Ms.toFixed(2)} ms p50 / ${p95Ms.toFixed(2)} ms p95`;
}

function formatAdapterSpeedup(result: AdapterMicroResult): string {
	if (result.speedup === null || result.p95Speedup === null) return "Not comparable";
	return `${result.speedup.toFixed(2)}× p50 / ${result.p95Speedup.toFixed(2)}× p95`;
}

async function measure(iterations: number, operation: () => Promise<void>): Promise<number> {
	const samples: number[] = [];
	await operation();
	for (let i = 0; i < iterations; i++) {
		const start = performance.now();
		await operation();
		samples.push(performance.now() - start);
	}
	return median(samples);
}

async function runProcess(command: string[], cwd?: string): Promise<void> {
	const proc = Bun.spawn(command, { cwd, stdout: "ignore", stderr: "pipe" });
	const exitCode = await proc.exited;
	if (exitCode !== 0)
		throw new Error(`${command.join(" ")} exited ${exitCode}: ${await new Response(proc.stderr).text()}`);
}

/**
 * Endpoint options for the host-side micro suite. It runs outside every
 * container guard, so it carries the same policy in its own right: never fetch
 * the subject (a downloaded release would report numbers for a *different*
 * binary than the agent arms measure), and prefer the packaged binary under
 * test over whatever PATH resolution turns up. Mirrors the adapter suite's
 * process endpoint (`DEFAULT_ADAPTER_DEPENDENCIES`).
 */
export function microRuntimeEndpointOptions(processBinaryPath?: string): LocalEndpointOptions {
	return { autoDownload: false, ...(processBinaryPath === undefined ? {} : { explicitPath: processBinaryPath }) };
}

export async function runMicrobenchmarks(iterations: number, processBinaryPath?: string): Promise<MicroResult[]> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "aura-runtime-micro-"));
	const service = new RuntimeService(new LocalRuntimeEndpoint(microRuntimeEndpointOptions(processBinaryPath)));
	try {
		const python = Bun.which("python3");
		const bun = Bun.which("bun");
		const javac = Bun.which("javac");
		const java = Bun.which("java");
		if (!python || !bun || !javac || !java)
			throw new Error("microbenchmarks require python3, bun, javac, and java on PATH");
		const pythonPath = path.join(root, "work.py");
		const tsPath = path.join(root, "work.ts");
		const javaPath = path.join(root, "Main.java");
		const pythonHelloPath = path.join(root, "hello.py");
		const tsHelloPath = path.join(root, "hello.ts");
		const projectDir = path.join(root, "project");
		const computePython = "print(sum(i*i for i in range(200000)))\n";
		const computeTs = "let s=0; for(let i=0;i<200000;i++) s+=i*i; console.log(s);\n";
		await Bun.write(pythonPath, computePython);
		await Bun.write(pythonHelloPath, "print('ok')\n");
		await Bun.write(tsHelloPath, "console.log('ok');\n");
		await Bun.write(tsPath, computeTs);
		await Bun.write(
			javaPath,
			"public class Main { public static void main(String[] a){ long s=0; for(int i=0;i<200000;i++) s+=(long)i*i; System.out.println(s); } }\n",
		);
		await Bun.write(path.join(projectDir, "package.json"), '{"name":"runtime-micro-project","type":"module"}\n');
		await Bun.write(path.join(projectDir, "src.ts"), "export const answer: number = 42;\nconsole.log(answer);\n");

		const results: MicroResult[] = [];
		const add = async (name: string, baseline: () => Promise<void>, runtime: () => Promise<void>) => {
			const baselineMs = await measure(iterations, baseline);
			const runtimeMs = await measure(iterations, runtime);
			results.push({ name, baselineMs, runtimeMs, ratio: runtimeMs / baselineMs });
		};
		await add(
			"Python startup",
			() => runProcess([python, pythonHelloPath]),
			async () => {
				const result = await service.run({ path: pythonHelloPath });
				if (result.exitCode !== 0) throw new Error(result.stderr);
			},
		);
		await add(
			"TypeScript startup",
			() => runProcess([bun, tsHelloPath]),
			async () => {
				const result = await service.run({ path: tsHelloPath });
				if (result.exitCode !== 0) throw new Error(result.stderr);
			},
		);
		await add(
			"Python compute",
			() => runProcess([python, pythonPath]),
			async () => {
				const result = await service.run({ path: pythonPath });
				if (result.exitCode !== 0) throw new Error(result.stderr);
			},
		);
		await add(
			"TypeScript compute",
			() => runProcess([bun, tsPath]),
			async () => {
				const result = await service.run({ path: tsPath });
				if (result.exitCode !== 0) throw new Error(result.stderr);
			},
		);
		await add(
			"Project validation",
			() => runProcess([bun, "build", "src.ts", "--outdir=dist"], projectDir),
			async () => {
				const result = await service.check({ cwd: projectDir });
				if (result.exitCode !== 0) throw new Error(result.stderr);
			},
		);
		await add(
			"Java compile + run",
			async () => {
				await runProcess([javac, "--release", "17", "Main.java"], root);
				await runProcess([java, "Main"], root);
			},
			async () => {
				const result = await service.jvm({
					action: "run",
					language: "java",
					code: await Bun.file(javaPath).text(),
				});
				if (result.exitCode !== 0) throw new Error(result.stderr);
			},
		);
		await add(
			"CPU sampling overhead",
			async () => {
				const result = await service.run({ path: tsPath });
				if (result.exitCode !== 0) throw new Error(result.stderr);
			},
			async () => {
				const result = await service.profile({ path: tsPath, mode: "cpusampling" });
				if (result.exitCode !== 0) throw new Error(result.stderr);
			},
		);
		await add(
			"CPU tracing overhead",
			async () => {
				const result = await service.run({ path: tsPath });
				if (result.exitCode !== 0) throw new Error(result.stderr);
			},
			async () => {
				const result = await service.profile({ path: tsPath, mode: "cputracing" });
				if (result.exitCode !== 0) throw new Error(result.stderr);
			},
		);
		await add(
			"Insights overhead",
			async () => {
				const result = await service.run({ path: tsPath });
				if (result.exitCode !== 0) throw new Error(result.stderr);
			},
			async () => {
				const result = await service.insights({ path: tsPath, insight: "({})" });
				if (result.exitCode !== 0) throw new Error(result.stderr);
			},
		);
		return results;
	} finally {
		try {
			await service.close();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}
}

interface RuntimeAdapterRunCase {
	name: string;
	params: RuntimeRunParams;
	expectedStdout: string;
}

interface CancellationObservation {
	code: string;
	message: string;
}

type CancellationSettlement = { kind: "resolved" } | { kind: "rejected"; error: unknown };

const ADAPTER_COLD_JS = {
	code: 'console.log("adapter-cold-js")',
	language: "js",
} satisfies RuntimeRunParams;

const ADAPTER_RUN_CASES: readonly RuntimeAdapterRunCase[] = [
	{
		name: "Warm JS startup",
		params: { code: 'console.log("adapter-js-startup")', language: "js" },
		expectedStdout: "adapter-js-startup\n",
	},
	{
		name: "Warm TS startup",
		params: {
			code: "const value: number = 42; console.log('adapter-ts-startup:' + value)",
			language: "ts",
		},
		expectedStdout: "adapter-ts-startup:42\n",
	},
	{
		name: "Warm Python startup",
		params: { code: 'print("adapter-python-startup")', language: "python" },
		expectedStdout: "adapter-python-startup\n",
	},
	{
		name: "JS compute",
		params: {
			code: "let total = 0; for (let i = 0; i < 200000; i++) total += i * i; console.log(total);",
			language: "js",
		},
		expectedStdout: "2666646666700000\n",
	},
	{
		name: "TS compute",
		params: {
			code: "let total: number = 0; for (let i = 0; i < 200000; i++) total += i * i; console.log(total);",
			language: "ts",
		},
		expectedStdout: "2666646666700000\n",
	},
	{
		name: "Python compute",
		params: { code: "print(sum(i * i for i in range(200000)))", language: "python" },
		expectedStdout: "2666646666700000\n",
	},
];

const ADAPTER_CANCELLATION_PARAMS = {
	code: "while (true) {}",
	language: "js",
} satisfies RuntimeRunParams;
const ADAPTER_CANCELLATION_ENTER_DELAY_MS = 250;
const ADAPTER_CANCELLATION_BOUND_MS = 15_000;
const ADAPTER_CANCELLED_MESSAGE = "Runtime execution was cancelled.";

async function timedRuntimeRun(
	service: AdapterBenchmarkRuntime,
	params: RuntimeRunParams,
): Promise<TimedAdapterSample<RuntimeExecResult>> {
	const startedAt = performance.now();
	const value = await service.run(params);
	return { durationMs: performance.now() - startedAt, value };
}

async function measureEmbeddedCold(embeddedService: AdapterBenchmarkRuntime): Promise<AdapterMicroResult> {
	const sample = await timedRuntimeRun(embeddedService, ADAPTER_COLD_JS);
	validateAdapterOutput(sample.value, "adapter-cold-js\n");
	return summarizeAdapterSamples("Embedded cold open + first JS", null, [sample.durationMs]);
}

async function settleWithin<T>(pending: Promise<T>, timeoutMs: number): Promise<T> {
	const timeout = Promise.withResolvers<T>();
	const timer: NodeJS.Timeout = setTimeout(
		() => timeout.reject(new Error(`runtime cancellation exceeded ${timeoutMs} ms`)),
		timeoutMs,
	);
	try {
		return await Promise.race([pending, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

async function timedCancellation(
	service: AdapterBenchmarkRuntime,
): Promise<TimedAdapterSample<CancellationObservation>> {
	const controller = new AbortController();
	const active = service
		.run(ADAPTER_CANCELLATION_PARAMS, controller.signal)
		.then<CancellationSettlement, CancellationSettlement>(
			() => ({ kind: "resolved" }),
			error => ({ kind: "rejected", error }),
		);
	await Bun.sleep(ADAPTER_CANCELLATION_ENTER_DELAY_MS);
	const startedAt = performance.now();
	controller.abort();
	const settlement = await settleWithin(active, ADAPTER_CANCELLATION_BOUND_MS);
	const durationMs = performance.now() - startedAt;
	if (settlement.kind === "resolved")
		throw new Error("runtime cancellation unexpectedly completed the infinite guest");
	if (!(settlement.error instanceof RuntimeRpcError)) {
		if (settlement.error instanceof Error) throw settlement.error;
		throw new Error(`runtime cancellation failed: ${String(settlement.error)}`);
	}
	return {
		durationMs,
		value: { code: settlement.error.code, message: settlement.error.message },
	};
}

function validateCancellation(observation: CancellationObservation): void {
	if (observation.code !== "cancelled" || observation.message !== ADAPTER_CANCELLED_MESSAGE) {
		throw new Error(
			`expected cancellation ${JSON.stringify({ code: "cancelled", message: ADAPTER_CANCELLED_MESSAGE })}, received ${JSON.stringify(observation)}`,
		);
	}
}

async function runAdapterCases(
	config: AdapterMicrobenchmarkConfig,
	processService: AdapterBenchmarkRuntime,
	embeddedService: AdapterBenchmarkRuntime,
): Promise<AdapterMicroResult[]> {
	const results = [await measureEmbeddedCold(embeddedService)];
	for (const benchmarkCase of ADAPTER_RUN_CASES) {
		results.push(
			await measureAdapterCase({
				name: benchmarkCase.name,
				iterations: config.iterations,
				process: () => timedRuntimeRun(processService, benchmarkCase.params),
				embedded: () => timedRuntimeRun(embeddedService, benchmarkCase.params),
				validate: result => validateAdapterOutput(result, benchmarkCase.expectedStdout),
			}),
		);
	}
	results.push(
		await measureAdapterCase({
			name: "Cancellation latency",
			iterations: config.iterations,
			process: () => timedCancellation(processService),
			embedded: () => timedCancellation(embeddedService),
			validate: validateCancellation,
		}),
	);
	return results;
}

const DEFAULT_ADAPTER_DEPENDENCIES: AdapterMicrobenchmarkDependencies = {
	createProcessService: config =>
		new RuntimeService(
			new LocalRuntimeEndpoint({
				explicitPath: config.processBinaryPath,
				autoDownload: false,
				env: config.env,
			}),
		),
	createEmbeddedService: config =>
		new RuntimeService(
			new EmbeddedRuntimeEndpoint({
				embeddedPath: config.embeddedLibraryPath,
				explicitPath: config.processBinaryPath,
				env: config.env,
			}),
		),
	runCases: runAdapterCases,
};

export async function runAdapterMicrobenchmarks(
	config: AdapterMicrobenchmarkConfig,
	dependencies: AdapterMicrobenchmarkDependencies = DEFAULT_ADAPTER_DEPENDENCIES,
): Promise<AdapterMicroResult[]> {
	if (!Number.isSafeInteger(config.iterations) || config.iterations < 1) {
		throw new Error("adapter benchmark iterations must be a positive integer");
	}
	const services: AdapterBenchmarkRuntime[] = [];
	let outcome: { kind: "completed"; results: AdapterMicroResult[] } | { kind: "failed"; error: unknown };
	try {
		const processService = dependencies.createProcessService(config);
		services.push(processService);
		const embeddedService = dependencies.createEmbeddedService(config);
		services.push(embeddedService);
		outcome = { kind: "completed", results: await dependencies.runCases(config, processService, embeddedService) };
	} catch (error) {
		outcome = { kind: "failed", error };
	}

	const closed = await Promise.allSettled(services.map(service => service.close()));
	if (outcome.kind === "failed") throw outcome.error;
	const closeFailure = closed.find(result => result.status === "rejected");
	if (closeFailure?.status === "rejected") throw closeFailure.reason;
	return outcome.results;
}

export interface PackagedRuntimeBinaryOptions {
	platform?: NodeJS.Platform;
	isRegularFile?: (candidate: string) => Promise<boolean>;
}

export async function packagedRuntimeBinaryForLibrary(
	libraryPath: string,
	options: PackagedRuntimeBinaryOptions = {},
): Promise<string> {
	const platform = options.platform ?? process.platform;
	const pathImpl = platform === "win32" ? path.win32 : path.posix;
	const binaryDir = pathImpl.resolve(pathImpl.dirname(libraryPath), "..", "bin");
	const probe = options.isRegularFile ?? isRuntimeRegularFile;
	for (const name of runtimeBinaryNames(platform)) {
		const candidate = pathImpl.join(binaryDir, name);
		if (await probe(candidate)) return candidate;
	}
	throw new Error(`No packaged runtime binary found in ${binaryDir} for embedded library ${libraryPath}.`);
}

export async function writeRuntimeBenchmarkManifest(
	opts: RuntimeBenchmarkCliOptions,
	startedAt: string,
): Promise<string> {
	const taskHashes: Record<string, string> = {};
	for (const task of RUNTIME_TASKS.filter(task => opts.taskIds.includes(task.id))) {
		taskHashes[task.id] = new Bun.CryptoHasher("sha256").update(JSON.stringify(task)).digest("hex");
	}
	const runtimeEnvironment: Record<string, string> = {};
	for (const key of [
		"AURA_RUNTIME_BIN",
		"AURA_RUNTIME_EMBEDDED_LIB",
		"AURA_RUNTIME_ADAPTER",
		"AURA_RUNTIME_VERSION",
	]) {
		const value = process.env[key];
		if (value) runtimeEnvironment[key] = value;
	}
	let historicalBinarySha256: string | undefined;
	if (opts.historicalBinary) {
		const bytes = await Bun.file(opts.historicalBinary).bytes();
		historicalBinarySha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
	}
	const verifierBunSha256 = new Bun.CryptoHasher("sha256")
		.update(await Bun.file(process.execPath).bytes())
		.digest("hex");
	const cpus = os.cpus();
	const manifestPath = path.join(opts.jobsDir, "_bench", `${opts.prefix}-runtime-manifest.json`);
	await Bun.write(
		manifestPath,
		`${JSON.stringify(
			{
				schemaVersion: 3,
				prefix: opts.prefix,
				startedAt,
				revision: opts.manifestRevision,
				sourcePatchSha256: opts.sourcePatchSha256,
				historicalRevision: opts.historicalRevision,
				historicalBinary: opts.historicalBinary,
				historicalBinarySha256,
				model: opts.model,
				thinking: opts.thinking,
				attempts: opts.attempts,
				taskIds: opts.taskIds,
				taskHashes,
				tools: {
					baseline: BASELINE_TOOLS,
					runtimeByTask: Object.fromEntries(opts.taskIds.map(taskId => [taskId, runtimeToolsForTask(taskId)])),
					historical: BASELINE_TOOLS,
				},
				jobsDir: opts.jobsDir,
				gatewayUrl: opts.gatewayUrl,
				hostNetwork: opts.hostNetwork,
				microIterations: opts.microIterations,
				mode: opts.mode,
				embeddedLib: opts.embeddedLib,
				// Provenance for the runtime-arm gate: a campaign that bypassed it must not
				// read as one that passed it. The flag, not an outcome — this function also
				// runs for `--micro-only`, where no probe happens at all.
				allowMissingRuntime: opts.allowMissingRuntime,
				runtimeEnvironment,
				bunVersion: Bun.version,
				verifierBun: {
					version: BENCHMARK_BUN_VERSION,
					sha256: verifierBunSha256,
				},
				platform: process.platform,
				architecture: process.arch,
				cpuModel: cpus[0]?.model ?? "unknown",
				logicalCpuCount: cpus.length,
			},
			null,
			2,
		)}\n`,
	);
	return manifestPath;
}

export function parseRuntimeBenchmarkCli(
	argv: string[],
	env: NodeJS.ProcessEnv = process.env,
): RuntimeBenchmarkCliOptions {
	const envEmbeddedLib = env.AURA_RUNTIME_EMBEDDED_LIB?.trim();
	const opts: RuntimeBenchmarkCliOptions = {
		model: "openai-codex/gpt-5.6-sol",
		thinking: "xhigh",
		attempts: 2,
		prefix: `rtbench${Date.now()}`,
		jobsDir: DEFAULT_JOBS_DIR,
		gatewayUrl: "http://127.0.0.1:4000",
		hostNetwork: true,
		taskIds: RUNTIME_TASKS.map(task => task.id),
		microIterations: 5,
		mode: "all",
		embeddedLib: envEmbeddedLib || undefined,
		manifestRevision: undefined,
		sourcePatchSha256: undefined,
		historicalRevision: undefined,
		historicalBinary: undefined,
		resume: false,
		allowMissingRuntime: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const [flag, inline] = argv[i].split("=", 2);
		const take = () => inline ?? argv[++i];
		switch (flag) {
			case "--model":
				opts.model = take();
				break;
			case "--thinking":
				opts.thinking = take();
				break;
			case "--attempts":
				opts.attempts = Number(take());
				break;
			case "--prefix":
				opts.prefix = take();
				break;
			case "--jobs-dir":
				opts.jobsDir = path.resolve(take());
				break;
			case "--gateway-url":
				opts.gatewayUrl = take();
				break;
			case "--task":
				opts.taskIds = opts.taskIds.length === RUNTIME_TASKS.length ? [take()] : [...opts.taskIds, take()];
				break;
			case "--micro-iterations":
				opts.microIterations = Number(take());
				break;
			case "--revision":
				opts.manifestRevision = take().trim() || undefined;
				break;
			case "--source-patch-sha256":
				opts.sourcePatchSha256 = take().trim() || undefined;
				break;
			case "--historical-revision":
				opts.historicalRevision = take().trim() || undefined;
				break;
			case "--historical-binary":
				opts.historicalBinary = path.resolve(take());
				break;
			case "--embedded-lib": {
				const embeddedLib = take().trim();
				if (embeddedLib === "") throw new Error("--embedded-lib must be a non-empty path");
				opts.embeddedLib = embeddedLib;
				break;
			}
			case "--resume":
				opts.resume = true;
				break;
			// Turns the runtime-arm preflight into a warning. Only for runs that
			// deliberately measure the fallback: the numbers are not runtime numbers.
			case "--allow-missing-runtime":
				opts.allowMissingRuntime = true;
				break;
			case "--agent-only":
				opts.mode = "agent";
				break;
			case "--micro-only":
				opts.mode = "micro";
				break;
			case "--no-host-network":
				opts.hostNetwork = false;
				break;
			default:
				throw new Error(`unknown runtime benchmark flag: ${flag}`);
		}
	}
	const valid = new Set(RUNTIME_TASKS.map(task => task.id));
	for (const taskId of opts.taskIds) if (!valid.has(taskId)) throw new Error(`unknown runtime task: ${taskId}`);
	if (!Number.isSafeInteger(opts.attempts) || opts.attempts < 1)
		throw new Error("--attempts must be a positive integer");
	if (!Number.isSafeInteger(opts.microIterations) || opts.microIterations < 1)
		throw new Error("--micro-iterations must be a positive integer");
	if (opts.historicalBinary && !opts.historicalRevision)
		throw new Error("--historical-binary requires --historical-revision");
	if (opts.historicalBinary && !/(?:x64|x86[_-]?64|amd64)/i.test(path.basename(opts.historicalBinary)))
		throw new Error("--historical-binary filename must identify the x64 architecture");
	return opts;
}

async function main(): Promise<void> {
	const opts = parseRuntimeBenchmarkCli(process.argv.slice(2));
	const startedAt = new Date().toISOString();
	const taskRoot = path.join(opts.jobsDir, "_bench", opts.prefix, "tasks");
	let micro: MicroResult[] = [];
	const elapsedByArm: Record<BenchmarkArm, number> = { baseline: 0, runtime: 0, historical: 0 };
	if (opts.mode !== "micro") {
		await materializeRuntimeTasks(taskRoot);
		const manifestPath = path.join(opts.jobsDir, "_bench", `${opts.prefix}-runtime-manifest.json`);
		process.stdout.write("Verifying generated TypeScript task image...\n");
		await smokeTypeScriptTaskVerifier(taskRoot);
		process.stdout.write("TypeScript task verifier smoke: passed\n");
		const runtimeBinary = opts.embeddedLib ? await packagedRuntimeBinaryForLibrary(opts.embeddedLib) : undefined;
		if (runtimeBinary || opts.embeddedLib) {
			process.stdout.write("Probing the injected runtime arm (Python) inside a task container...\n");
			await smokeRuntimeArmExecution({
				taskRoot,
				runtimeBinary,
				embeddedLib: opts.embeddedLib,
				runDocker: spawnDocker,
				allowMissingRuntime: opts.allowMissingRuntime,
			});
			process.stdout.write("Runtime arm preflight: complete\n");
		} else {
			process.stdout.write("Runtime arm preflight: skipped (no runtime artifacts injected)\n");
		}
		if (!opts.resume || !fs.existsSync(manifestPath)) await writeRuntimeBenchmarkManifest(opts, startedAt);
		process.stdout.write(`Runtime benchmark manifest: ${manifestPath}\n`);
		const launches = buildArmLaunches({ ...opts, taskRoot, runtimeBinary });
		for (const [index, launch] of launches.entries()) {
			const runnerArgs = armRunnerArgs(launch, opts.jobsDir, opts.resume);
			if (runnerArgs === null) {
				process.stdout.write(`[${index + 1}/${launches.length}] ${launch.arm} · ${launch.taskId} (complete)\n`);
				continue;
			}
			process.stdout.write(
				`[${index + 1}/${launches.length}] ${launch.arm} · ${launch.taskId}${runnerArgs === launch.args ? "" : " (resume)"}\n`,
			);
			const launchStartedAt = performance.now();
			const proc = Bun.spawn(["bun", "src/runner.ts", ...runnerArgs], {
				cwd: PKG_DIR,
				stdout: "inherit",
				stderr: "inherit",
			});
			const exitCode = await proc.exited;
			if (exitCode !== 0) throw new Error(`${launch.jobName} exited ${exitCode}`);
			elapsedByArm[launch.arm] += performance.now() - launchStartedAt;
		}
	}
	if (opts.mode === "micro") {
		const manifestPath = await writeRuntimeBenchmarkManifest(opts, startedAt);
		process.stdout.write(`Runtime benchmark manifest: ${manifestPath}\n`);
	}
	if (opts.mode !== "agent") {
		// Same derivation the adapter suite below uses, so both micro suites and the
		// agent arms all measure the one binary the campaign is about.
		const microBinary = opts.embeddedLib ? await packagedRuntimeBinaryForLibrary(opts.embeddedLib) : undefined;
		micro = await runMicrobenchmarks(opts.microIterations, microBinary);
	}
	let adapter: AdapterMicrobenchmarkOutcome = { kind: "skipped", message: ADAPTER_MICROBENCHMARK_SKIPPED };
	if (opts.embeddedLib && opts.mode === "agent") {
		adapter = { kind: "skipped", message: "Adapter comparison skipped: --agent-only disables microbenchmarks." };
	} else if (opts.embeddedLib) {
		adapter = {
			kind: "completed",
			results: await runAdapterMicrobenchmarks({
				iterations: opts.microIterations,
				processBinaryPath: await packagedRuntimeBinaryForLibrary(opts.embeddedLib),
				embeddedLibraryPath: opts.embeddedLib,
			}),
		};
	}
	const empty = (arm: BenchmarkArm): ArmSummary => ({
		arm,
		tasks: 0,
		trials: 0,
		completedTrials: 0,
		pass: 0,
		fail: 0,
		error: 0,
		costUsd: 0,
		tokIn: 0,
		tokOut: 0,
		tokCache: 0,
		durationMs: 0,
		elapsedMs: 0,
		toolCalls: 0,
		medianDurationMs: 0,
		runtimeTasks: 0,
		runtimeTrials: 0,
		taskMeasurements: [],
	});
	const baseline =
		opts.mode === "micro"
			? empty("baseline")
			: summarizeArm(
					opts.jobsDir,
					opts.prefix,
					"baseline",
					opts.taskIds,
					opts.resume ? undefined : elapsedByArm.baseline,
				);
	const runtime =
		opts.mode === "micro"
			? empty("runtime")
			: summarizeArm(
					opts.jobsDir,
					opts.prefix,
					"runtime",
					opts.taskIds,
					opts.resume ? undefined : elapsedByArm.runtime,
				);
	const historical =
		opts.mode === "micro" || !opts.historicalBinary
			? undefined
			: summarizeArm(
					opts.jobsDir,
					opts.prefix,
					"historical",
					opts.taskIds,
					opts.resume ? undefined : elapsedByArm.historical,
				);
	const reportPath = path.join(opts.jobsDir, "_bench", `${opts.prefix}-runtime-comparison.md`);
	await Bun.write(reportPath, formatComparison(opts.prefix, baseline, runtime, micro, adapter, historical));
	process.stdout.write(`Runtime benchmark report: ${reportPath}\n`);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	});
}
