#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import { type ArmSummary, type RuntimeTaskMeasurement, runtimeToolsForTask, summarizeArm } from "./runtime-benchmark";
import { materializeRuntimeTasks, smokeTypeScriptTaskVerifier } from "./runtime-benchmark-suite";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const PKG_DIR = path.resolve(import.meta.dir, "..");
const DEFAULT_JOBS_DIR = path.join(REPO_ROOT, "runs", "harbor");
const INHERENT_TREATMENT_FILES = [
	"packages/coding-agent/src/prompts/system/system-prompt.md",
	"packages/coding-agent/src/prompts/tools/runtime-insights.md",
	"packages/coding-agent/src/prompts/tools/runtime-profile.md",
	"packages/coding-agent/src/prompts/tools/runtime-serve.md",
	"packages/coding-agent/src/prompts/tools/jvm-disassemble.md",
	"packages/coding-agent/src/prompts/tools/jvm-format.md",
	"packages/coding-agent/src/prompts/tools/jvm-jar.md",
	"packages/coding-agent/src/prompts/tools/jvm-deps.md",
	"packages/coding-agent/src/tools/builtin-names.ts",
	"packages/coding-agent/src/tools/essential-tools.ts",
	"packages/coding-agent/src/tools/index.ts",
	"packages/coding-agent/src/discovery/claude-plugins.ts",
	"packages/coding-agent/src/discovery/index.ts",
	"packages/coding-agent/src/capability/skill.ts",
	"packages/coding-agent/src/config/settings-schema.ts",
] as const;
const CORE_SKILLS: Readonly<Record<string, true>> = {
	runtime: true,
	insights: true,
	profiling: true,
	jvm: true,
	"stateful-debugger": true,
	"using-superpowers": true,
	brainstorming: true,
	"writing-plans": true,
	"test-driven-development": true,
	"systematic-debugging": true,
	"verification-before-completion": true,
	"dispatching-parallel-agents": true,
	"subagent-driven-development": true,
	"using-git-worktrees": true,
	"requesting-code-review": true,
	"receiving-code-review": true,
	"finishing-a-development-branch": true,
	"executing-plans": true,
};

export const INHERENT_BENCHMARK_TASK_IDS = ["typescript-execution", "jvm-dependencies"] as const;
export type InherentBenchmarkTaskId = (typeof INHERENT_BENCHMARK_TASK_IDS)[number];

export function inherentBenchmarkToolsForTask(taskId: InherentBenchmarkTaskId): string[] {
	return runtimeToolsForTask(taskId);
}

export type InherentBenchmarkArm = "legacy" | "inherent";

export interface InherentBenchmarkOptions {
	model: string;
	thinking: string;
	attempts: number;
	prefix: string;
	jobsDir: string;
	gatewayUrl: string;
	hostNetwork: boolean;
	legacyBinary?: string;
}

export interface InherentBenchmarkLaunch {
	arm: InherentBenchmarkArm;
	taskId: (typeof INHERENT_BENCHMARK_TASK_IDS)[number];
	attempt: number;
	jobName: string;
	args: string[];
}

export interface InherentTranscriptFacts {
	firstCapabilityTool: "jvm_deps" | "eval" | "bash" | undefined;
	coreSkillLoads: number;
}

export interface InherentBenchmarkAnalysis {
	verdict: "pass" | "fail";
	comparison: boolean;
	inherentPassRate: number;
	firstExecutionSelectionRate: number;
	coreSkillLoads: number;
	legacyMedianToolCalls: number;
	inherentMedianToolCalls: number;
	legacyMedianInputTokens: number;
	inherentMedianInputTokens: number;
	reasons: string[];
}

export interface InherentTelemetryFact {
	sessionId: string;
	language: string;
	outcome: string;
	durationMs: number;
	exitCode: number;
	errorType?: string;
}

export interface InherentTelemetryProbe {
	success: InherentTelemetryFact;
	failure: InherentTelemetryFact;
}

interface InherentBenchmarkIdentities {
	currentSourceSha256: string;
	legacyBinarySha256?: string;
}

export function buildInherentBenchmarkLaunches(
	opts: InherentBenchmarkOptions,
	taskRoot: string,
): InherentBenchmarkLaunch[] {
	const launches: InherentBenchmarkLaunch[] = [];
	for (let attempt = 1; attempt <= opts.attempts; attempt++) {
		for (const [index, taskId] of INHERENT_BENCHMARK_TASK_IDS.entries()) {
			const legacyFirst = (attempt + index) % 2 === 1;
			const armOrder: readonly InherentBenchmarkArm[] = opts.legacyBinary
				? legacyFirst
					? ["legacy", "inherent"]
					: ["inherent", "legacy"]
				: ["inherent"];
			for (const arm of armOrder) {
				const jobName = `${opts.prefix}-a${attempt}-${arm === "legacy" ? "baseline" : "runtime"}-${taskId}`;
				const args = [
					`--path=${path.join(taskRoot, taskId)}`,
					arm === "legacy" ? `--binary=${opts.legacyBinary}` : "--install=source",
					`--model=${opts.model}`,
					`--thinking=${opts.thinking}`,
					"--attempts=1",
					"--tasks=1",
					"--concurrency=1",
					`--jobs-dir=${opts.jobsDir}`,
					`--gateway-url=${opts.gatewayUrl}`,
					`--job-name=${jobName}`,
					"--agent-arg=--tools",
					`--agent-arg=${inherentBenchmarkToolsForTask(taskId).join(",")}`,
				];
				if (opts.hostNetwork) args.push("--host-network");
				launches.push({ arm, taskId, attempt, jobName, args });
			}
		}
	}
	return launches;
}

/** Extract prompt-architecture signals from a runner JSONL transcript. */
export function scanInherentTranscript(content: string): InherentTranscriptFacts {
	let firstCapabilityTool: InherentTranscriptFacts["firstCapabilityTool"];
	let coreSkillLoads = 0;
	for (const line of content.split("\n")) {
		if (!line.startsWith("{")) continue;
		try {
			const event: unknown = JSON.parse(line);
			if (!isRecord(event) || event.type !== "tool_execution_start" || typeof event.toolName !== "string") continue;
			if (
				firstCapabilityTool === undefined &&
				(event.toolName === "jvm_deps" || event.toolName === "eval" || event.toolName === "bash")
			) {
				firstCapabilityTool = event.toolName;
			}
			if (event.toolName !== "read" || !isRecord(event.args) || typeof event.args.path !== "string") continue;
			const match = /^skill:\/\/(?:superpowers:)?([^/:?#]+)/.exec(event.args.path);
			if (match?.[1] && CORE_SKILLS[match[1]]) coreSkillLoads++;
		} catch {}
	}
	return { firstCapabilityTool, coreSkillLoads };
}

function parseTelemetryFact(value: unknown): InherentTelemetryFact {
	if (
		!isRecord(value) ||
		typeof value.sessionId !== "string" ||
		typeof value.language !== "string" ||
		typeof value.outcome !== "string" ||
		typeof value.durationMs !== "number" ||
		typeof value.exitCode !== "number" ||
		(value.errorType !== undefined && typeof value.errorType !== "string")
	) {
		throw new Error("runtime telemetry preflight returned invalid evidence");
	}
	return {
		sessionId: value.sessionId,
		language: value.language,
		outcome: value.outcome,
		durationMs: value.durationMs,
		exitCode: value.exitCode,
		errorType: value.errorType,
	};
}

export async function runInherentTelemetryProbe(): Promise<InherentTelemetryProbe> {
	const script = path.join(REPO_ROOT, "packages", "coding-agent", "scripts", "runtime-telemetry-preflight.ts");
	const child = Bun.spawn(["bun", script], {
		cwd: REPO_ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		Bun.readableStreamToText(child.stdout),
		Bun.readableStreamToText(child.stderr),
		child.exited,
	]);
	if (exitCode !== 0) throw new Error(`runtime telemetry preflight exited ${exitCode}: ${stderr.trim()}`);
	let value: unknown;
	try {
		value = JSON.parse(stdout);
	} catch {
		throw new Error("runtime telemetry preflight returned invalid JSON");
	}
	if (!isRecord(value)) throw new Error("runtime telemetry preflight returned invalid evidence");
	return { success: parseTelemetryFact(value.success), failure: parseTelemetryFact(value.failure) };
}

function median(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const sorted = values.toSorted((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function benchmarkPairs(summary: ArmSummary | undefined): Map<string, { toolCalls: number; tokIn: number }> {
	const pairs = new Map<string, { toolCalls: number; tokIn: number }>();
	if (!summary) return pairs;
	for (const task of summary.taskMeasurements) {
		for (const trial of task.trials) {
			const separator = trial.trialName.indexOf(":");
			const attempt = separator < 0 ? trial.trialName : trial.trialName.slice(0, separator);
			pairs.set(`${task.taskId}:${attempt}`, { toolCalls: trial.toolCalls, tokIn: trial.tokIn });
		}
	}
	return pairs;
}

export function analyzeInherentBenchmark(
	legacy: ArmSummary | undefined,
	inherent: ArmSummary,
	inherentTranscripts: ReadonlyArray<{ taskId: string; facts: InherentTranscriptFacts }>,
): InherentBenchmarkAnalysis {
	const comparison = legacy !== undefined;
	const inherentPassRate = inherent.trials === 0 ? 0 : inherent.pass / inherent.trials;
	// `typescript-execution` used to expect `run`. With the fork's execution tools
	// retired, the arm carries no execution tool of its own, so `bash` is the only
	// capability the transcript can show; the gate stays structural until the eval
	// backend gives execution tasks a runtime-backed surface to select again.
	const expectedFirstTool: Readonly<Record<InherentBenchmarkTaskId, "bash" | "jvm_deps">> = {
		"typescript-execution": "bash",
		"jvm-dependencies": "jvm_deps",
	};
	const selectedCorrectly = inherentTranscripts.filter(
		entry =>
			INHERENT_BENCHMARK_TASK_IDS.includes(entry.taskId as InherentBenchmarkTaskId) &&
			entry.facts.firstCapabilityTool === expectedFirstTool[entry.taskId as InherentBenchmarkTaskId],
	).length;
	const firstExecutionSelectionRate =
		inherentTranscripts.length === 0 ? 0 : selectedCorrectly / inherentTranscripts.length;
	const coreSkillLoads = inherentTranscripts.reduce((sum, entry) => sum + entry.facts.coreSkillLoads, 0);
	const legacyToolCalls = legacy?.taskMeasurements.flatMap(task => task.trials.map(trial => trial.toolCalls)) ?? [];
	const inherentToolCalls = inherent.taskMeasurements.flatMap(task => task.trials.map(trial => trial.toolCalls));
	const legacyInputTokens = legacy?.taskMeasurements.flatMap(task => task.trials.map(trial => trial.tokIn)) ?? [];
	const inherentInputTokens = inherent.taskMeasurements.flatMap(task => task.trials.map(trial => trial.tokIn));
	const legacyMedianToolCalls = median(legacyToolCalls);
	const inherentMedianToolCalls = median(inherentToolCalls);
	const legacyMedianInputTokens = median(legacyInputTokens);
	const inherentMedianInputTokens = median(inherentInputTokens);
	const reasons: string[] = [];
	if (inherent.trials === 0 || inherent.completedTrials !== inherent.trials)
		reasons.push("inherent arm has missing or incomplete trials");
	if (inherentPassRate !== 1) reasons.push("inherent arm did not pass every trial");
	if (inherent.runtimeTrials !== inherent.trials)
		reasons.push("inherent arm did not use a runtime tool in every trial");
	if (inherentTranscripts.length !== inherent.trials) reasons.push("inherent arm is missing transcript evidence");
	if (firstExecutionSelectionRate !== 1)
		reasons.push("inherent arm did not select the task-specific capability tool first in every trial");
	if (coreSkillLoads !== 0) reasons.push("inherent arm loaded a promoted runtime or core workflow skill");
	if (comparison) {
		const legacyPairs = benchmarkPairs(legacy);
		const inherentPairs = benchmarkPairs(inherent);
		const toolCallDeltas: number[] = [];
		const inputTokenDeltas: number[] = [];
		for (const [pair, current] of inherentPairs) {
			const baseline = legacyPairs.get(pair);
			if (!baseline) continue;
			toolCallDeltas.push(current.toolCalls - baseline.toolCalls);
			inputTokenDeltas.push(current.tokIn - baseline.tokIn);
		}
		if (legacyPairs.size !== inherentPairs.size || toolCallDeltas.length !== inherentPairs.size)
			reasons.push("comparison arm is missing matched task-attempt evidence");
		if (median(toolCallDeltas) > 0) reasons.push("median paired tool calls increased");
		if (median(inputTokenDeltas) > 0) reasons.push("median paired input tokens increased");
	}
	return {
		verdict: reasons.length === 0 ? "pass" : "fail",
		comparison,
		inherentPassRate,
		firstExecutionSelectionRate,
		coreSkillLoads,
		legacyMedianToolCalls,
		inherentMedianToolCalls,
		legacyMedianInputTokens,
		inherentMedianInputTokens,
		reasons,
	};
}

export function parseInherentBenchmarkCli(
	argv: string[],
	env: NodeJS.ProcessEnv = process.env,
): InherentBenchmarkOptions {
	const envLegacyBinary = env.AURA_LEGACY_BINARY?.trim() || undefined;
	const opts: InherentBenchmarkOptions = {
		model: "openai-codex/gpt-5.6-sol",
		thinking: "xhigh",
		attempts: 1,
		prefix: `inherent${Date.now()}`,
		jobsDir: DEFAULT_JOBS_DIR,
		gatewayUrl: "http://127.0.0.1:4000",
		hostNetwork: true,
		legacyBinary: envLegacyBinary,
	};
	let attemptsExplicit = false;
	for (let index = 0; index < argv.length; index++) {
		const [flag, inline] = argv[index].split("=", 2);
		const take = () => inline ?? argv[++index];
		switch (flag) {
			case "--model":
				opts.model = take();
				break;
			case "--thinking":
				opts.thinking = take();
				break;
			case "--attempts":
				opts.attempts = Number(take());
				attemptsExplicit = true;
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
			case "--legacy-binary":
				opts.legacyBinary = path.resolve(take());
				break;
			case "--no-host-network":
				opts.hostNetwork = false;
				break;
			default:
				throw new Error(`unknown inherent benchmark flag: ${flag}`);
		}
	}
	if (opts.legacyBinary && !attemptsExplicit) opts.attempts = 3;
	if (!Number.isSafeInteger(opts.attempts) || opts.attempts < 1)
		throw new Error("--attempts must be a positive integer");
	return opts;
}

async function readBenchmarkIdentities(opts: InherentBenchmarkOptions): Promise<InherentBenchmarkIdentities> {
	const sourceHasher = new Bun.CryptoHasher("sha256");
	for (const relativePath of INHERENT_TREATMENT_FILES) {
		sourceHasher.update(relativePath);
		sourceHasher.update(await Bun.file(path.join(REPO_ROOT, relativePath)).bytes());
	}
	const legacyBinarySha256 = opts.legacyBinary
		? new Bun.CryptoHasher("sha256").update(await Bun.file(opts.legacyBinary).bytes()).digest("hex")
		: undefined;
	return { currentSourceSha256: sourceHasher.digest("hex"), legacyBinarySha256 };
}

export function summarizeInherentArm(opts: InherentBenchmarkOptions, arm: InherentBenchmarkArm): ArmSummary {
	const summaries = Array.from({ length: opts.attempts }, (_, index) =>
		summarizeArm(opts.jobsDir, `${opts.prefix}-a${index + 1}`, arm === "legacy" ? "baseline" : "runtime", [
			...INHERENT_BENCHMARK_TASK_IDS,
		]),
	);
	const taskMeasurements: RuntimeTaskMeasurement[] = INHERENT_BENCHMARK_TASK_IDS.map(taskId => {
		const source = summaries[0]?.taskMeasurements.find(task => task.taskId === taskId);
		if (!source) throw new Error(`missing ${arm} benchmark task summary: ${taskId}`);
		return {
			taskId,
			group: source.group,
			trials: summaries.flatMap((summary, index) => {
				const task = summary.taskMeasurements.find(entry => entry.taskId === taskId);
				if (!task) throw new Error(`missing ${arm} benchmark task summary: ${taskId}`);
				return task.trials.map(trial => ({ ...trial, trialName: `${index + 1}:${trial.trialName}` }));
			}),
		};
	});
	const trials = taskMeasurements.flatMap(task => task.trials);
	return {
		arm: arm === "legacy" ? "baseline" : "runtime",
		tasks: INHERENT_BENCHMARK_TASK_IDS.length,
		trials: trials.length,
		completedTrials: trials.length,
		pass: trials.filter(trial => trial.status === "pass").length,
		fail: trials.filter(trial => trial.status === "fail").length,
		error: trials.filter(trial => trial.status === "error").length,
		costUsd: trials.reduce((sum, trial) => sum + trial.costUsd, 0),
		tokIn: trials.reduce((sum, trial) => sum + trial.tokIn, 0),
		tokOut: trials.reduce((sum, trial) => sum + trial.tokOut, 0),
		tokCache: trials.reduce((sum, trial) => sum + trial.tokCache, 0),
		durationMs: trials.reduce((sum, trial) => sum + trial.durationMs, 0),
		elapsedMs: summaries.reduce((sum, summary) => sum + summary.elapsedMs, 0),
		medianDurationMs: median(trials.map(trial => trial.durationMs)),
		toolCalls: trials.reduce((sum, trial) => sum + trial.toolCalls, 0),
		runtimeTasks: taskMeasurements.filter(task => task.trials.some(trial => trial.runtimeUsed)).length,
		runtimeTrials: trials.filter(trial => trial.runtimeUsed).length,
		taskMeasurements,
	};
}

function readInherentTranscripts(
	opts: InherentBenchmarkOptions,
	summary: ArmSummary,
): Array<{ taskId: string; facts: InherentTranscriptFacts }> {
	return summary.taskMeasurements.flatMap(task =>
		task.trials.map(trial => {
			const separator = trial.trialName.indexOf(":");
			if (separator < 1) throw new Error(`invalid aggregated trial name: ${trial.trialName}`);
			const attempt = trial.trialName.slice(0, separator);
			const rawTrialName = trial.trialName.slice(separator + 1);
			const transcriptPath = path.join(
				opts.jobsDir,
				`${opts.prefix}-a${attempt}-runtime-${task.taskId}`,
				rawTrialName,
				"agent",
				"omp.txt",
			);
			if (!fs.existsSync(transcriptPath))
				throw new Error(`missing inherent benchmark transcript: ${transcriptPath}`);
			return { taskId: task.taskId, facts: scanInherentTranscript(fs.readFileSync(transcriptPath, "utf8")) };
		}),
	);
}

function formatInherentReport(
	opts: InherentBenchmarkOptions,
	legacy: ArmSummary | undefined,
	analysis: InherentBenchmarkAnalysis,
	identities: InherentBenchmarkIdentities,
	telemetry: InherentTelemetryProbe,
): string {
	const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
	const legacyIdentity = opts.legacyBinary
		? `- Legacy binary: \`${opts.legacyBinary}\`\n- Legacy binary SHA-256: \`${identities.legacyBinarySha256}\`\n`
		: "";
	return (
		`# Inherent Harness Capability Benchmark\n\n` +
		`- Model: \`${opts.model}\`\n` +
		`- Attempts per task: ${opts.attempts}\n` +
		`- Tasks: ${INHERENT_BENCHMARK_TASK_IDS.map(task => `\`${task}\``).join(", ")}\n` +
		`- Task tools: ${INHERENT_BENCHMARK_TASK_IDS.map(
			task =>
				`\`${task}\` = ${inherentBenchmarkToolsForTask(task)
					.map(tool => `\`${tool}\``)
					.join(", ")}`,
		).join("; ")}\n` +
		`- Current treatment SHA-256: \`${identities.currentSourceSha256}\`\n` +
		`- Telemetry preflight: \`${telemetry.success.outcome}\` → \`${telemetry.failure.outcome}\` (` +
		`${telemetry.success.language}, ${telemetry.success.durationMs.toFixed(3)}/${telemetry.failure.durationMs.toFixed(3)} ms)\n` +
		legacyIdentity +
		`\n| Signal | Legacy skills | Inherent prompt |\n|---|---:|---:|\n` +
		`| Pass rate | ${legacy ? percent(legacy.trials === 0 ? 0 : legacy.pass / legacy.trials) : "—"} | ${percent(analysis.inherentPassRate)} |\n` +
		`| Median tool calls | ${legacy ? analysis.legacyMedianToolCalls : "—"} | ${analysis.inherentMedianToolCalls} |\n` +
		`| Median input tokens | ${legacy ? analysis.legacyMedianInputTokens : "—"} | ${analysis.inherentMedianInputTokens} |\n` +
		`| Correct runtime tool selected first | — | ${percent(analysis.firstExecutionSelectionRate)} |\n` +
		`| Promoted skill loads | — | ${analysis.coreSkillLoads} |\n\n` +
		`## Verdict: ${analysis.verdict.toUpperCase()}\n\n` +
		(analysis.reasons.length === 0
			? "All gates passed.\n"
			: `${analysis.reasons.map(reason => `- ${reason}`).join("\n")}\n`)
	);
}

async function main(): Promise<void> {
	const opts = parseInherentBenchmarkCli(process.argv.slice(2));
	const identities = await readBenchmarkIdentities(opts);
	const telemetry = await runInherentTelemetryProbe();
	const taskRoot = path.join(opts.jobsDir, "_bench", opts.prefix, "tasks");
	await materializeRuntimeTasks(taskRoot);
	await smokeTypeScriptTaskVerifier(taskRoot);
	const launches = buildInherentBenchmarkLaunches(opts, taskRoot);
	for (const [index, launch] of launches.entries()) {
		process.stdout.write(
			`[${index + 1}/${launches.length}] attempt ${launch.attempt} · ${launch.arm} · ${launch.taskId}\n`,
		);
		const runner = Bun.spawn(["bun", "src/runner.ts", ...launch.args], {
			cwd: PKG_DIR,
			stdout: "inherit",
			stderr: "inherit",
		});
		const exitCode = await runner.exited;
		if (exitCode !== 0) throw new Error(`${launch.jobName} exited ${exitCode}`);
	}
	const legacy = opts.legacyBinary ? summarizeInherentArm(opts, "legacy") : undefined;
	const inherent = summarizeInherentArm(opts, "inherent");
	const analysis = analyzeInherentBenchmark(legacy, inherent, readInherentTranscripts(opts, inherent));
	const reportPath = path.join(opts.jobsDir, "_bench", `${opts.prefix}-inherent-capabilities.md`);
	await Bun.write(reportPath, formatInherentReport(opts, legacy, analysis, identities, telemetry));
	process.stdout.write(`Inherent capability benchmark report: ${reportPath}\n`);
	if (analysis.verdict === "fail") process.exitCode = 1;
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	});
}
