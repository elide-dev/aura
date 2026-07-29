#!/usr/bin/env bun
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	EmbeddedRuntimeEndpoint,
	LocalRuntimeEndpoint,
	type RuntimeExecResult,
	RuntimeRpcError,
	type RuntimeRunParams,
	RuntimeService,
} from "../../coding-agent/src/runtime";
import { isRegularFile as isRuntimeRegularFile, runtimeBinaryNames } from "../../coding-agent/src/runtime/resolve";
import { readBenchmarkSnapshot } from "./benchmarks";
import { materializeRuntimeTasks, RUNTIME_TASKS } from "./runtime-benchmark-suite";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const PKG_DIR = path.resolve(import.meta.dir, "..");
const DEFAULT_JOBS_DIR = path.join(REPO_ROOT, "runs", "harbor");
const RUNTIME_TOOL_NAMES = new Set([
	"run",
	"check",
	"build",
	"insights",
	"profile",
	"jvm_run",
	"jvm_disassemble",
	"jvm_format",
	"jvm_jar",
	"jvm_deps",
	"jvm_javadoc",
	"project_advice",
]);

export const BASELINE_TOOLS = ["read", "write", "edit", "bash", "grep", "glob"];
export const RUNTIME_TOOLS = [...BASELINE_TOOLS, ...RUNTIME_TOOL_NAMES];

export type BenchmarkArm = "baseline" | "runtime";

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
}

export interface ArmLaunch {
	arm: BenchmarkArm;
	taskId: string;
	jobName: string;
	args: string[];
}

export interface ArmSummary {
	arm: BenchmarkArm;
	tasks: number;
	trials: number;
	pass: number;
	fail: number;
	error: number;
	costUsd: number;
	tokIn: number;
	tokOut: number;
	durationMs: number;
	medianDurationMs: number;
	toolCalls: number;
	runtimeTasks: number;
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
}

export function buildArmLaunches(opts: ArmLaunchOptions): ArmLaunch[] {
	const launches: ArmLaunch[] = [];
	for (const [index, taskId] of opts.taskIds.entries()) {
		const armOrder: BenchmarkArm[] = index % 2 === 0 ? ["baseline", "runtime"] : ["runtime", "baseline"];
		for (const arm of armOrder) {
			const tools = arm === "baseline" ? BASELINE_TOOLS : RUNTIME_TOOLS;
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
			if (opts.hostNetwork) args.push("--host-network");
			launches.push({ arm, taskId, jobName, args });
		}
	}
	return launches;
}

export function countToolCalls(jobDir: string): { total: number; runtimeUsed: boolean } {
	let total = 0;
	let runtimeUsed = false;
	for (const entry of fs.readdirSync(jobDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const transcriptPath = path.join(jobDir, entry.name, "agent", "omp.txt");
		if (!fs.existsSync(transcriptPath)) continue;
		for (const line of fs.readFileSync(transcriptPath, "utf8").split("\n")) {
			if (!line.startsWith("{")) continue;
			try {
				const event = JSON.parse(line) as { type?: string; toolName?: string };
				if (event.type !== "tool_execution_start" || !event.toolName) continue;
				total++;
				if (RUNTIME_TOOL_NAMES.has(event.toolName)) runtimeUsed = true;
			} catch {
				// A transcript may end with a partial JSON line after interruption.
			}
		}
	}
	return { total, runtimeUsed };
}

export function summarizeArm(jobsDir: string, prefix: string, arm: BenchmarkArm, taskIds: string[]): ArmSummary {
	const durations: number[] = [];
	const summary: ArmSummary = {
		arm,
		tasks: taskIds.length,
		trials: 0,
		pass: 0,
		fail: 0,
		error: 0,
		costUsd: 0,
		tokIn: 0,
		tokOut: 0,
		durationMs: 0,
		toolCalls: 0,
		medianDurationMs: 0,
		runtimeTasks: 0,
	};
	for (const taskId of taskIds) {
		const jobDir = path.join(jobsDir, `${prefix}-${arm}-${taskId}`);
		const snapshot = readBenchmarkSnapshot("harbor", jobDir);
		if (snapshot.done !== snapshot.total)
			throw new Error(`${prefix}-${arm}-${taskId} has ${snapshot.done}/${snapshot.total} decided trials`);
		summary.trials += snapshot.total;
		summary.pass += snapshot.pass;
		summary.fail += snapshot.fail;
		summary.error += snapshot.error;
		summary.costUsd += snapshot.costUsd;
		summary.tokIn += snapshot.tokIn;
		summary.tokOut += snapshot.tokOut;
		durations.push(...snapshot.traces.map(trace => trace.durationMs));
		summary.durationMs += snapshot.traces.reduce((sum, trace) => sum + trace.durationMs, 0);
		const tools = countToolCalls(jobDir);
		summary.toolCalls += tools.total;
		if (tools.runtimeUsed) summary.runtimeTasks++;
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

export function formatComparison(
	prefix: string,
	baseline: ArmSummary,
	runtime: ArmSummary,
	micro: MicroResult[],
	adapter: AdapterMicrobenchmarkOutcome = { kind: "skipped", message: ADAPTER_MICROBENCHMARK_SKIPPED },
): string {
	const basePass = percentage(baseline.pass, baseline.trials);
	const runtimePass = percentage(runtime.pass, runtime.trials);
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
		["Input tokens", String(baseline.tokIn), String(runtime.tokIn), signed(runtime.tokIn - baseline.tokIn, "")],
		["Output tokens", String(baseline.tokOut), String(runtime.tokOut), signed(runtime.tokOut - baseline.tokOut, "")],
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
	];
	const lines = [
		`# Runtime capability benchmark — ${prefix}`,
		"",
		"| Metric | Bash baseline | Runtime | Delta |",
		"|---|---:|---:|---:|",
		...rows.map(row => `| ${row.join(" | ")} |`),
	];
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

export async function runMicrobenchmarks(iterations: number): Promise<MicroResult[]> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "aura-runtime-micro-"));
	const service = new RuntimeService(new LocalRuntimeEndpoint({ autoDownload: true }));
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
		await Bun.write(
			path.join(projectDir, "package.json"),
			'{"name":"runtime-micro-project","type":"module","scripts":{"build":"bun build src.ts --outdir=dist"}}\n',
		);
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
			"Project build",
			() => runProcess([bun, "run", "build"], projectDir),
			async () => {
				const result = await service.build({ cwd: projectDir });
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
			case "--embedded-lib": {
				const embeddedLib = take().trim();
				if (embeddedLib === "") throw new Error("--embedded-lib must be a non-empty path");
				opts.embeddedLib = embeddedLib;
				break;
			}
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
	return opts;
}

async function main(): Promise<void> {
	const opts = parseRuntimeBenchmarkCli(process.argv.slice(2));
	const taskRoot = path.join(opts.jobsDir, "_bench", opts.prefix, "tasks");
	let micro: MicroResult[] = [];
	if (opts.mode !== "micro") {
		await materializeRuntimeTasks(taskRoot);
		const launches = buildArmLaunches({ ...opts, taskRoot });
		for (const [index, launch] of launches.entries()) {
			process.stdout.write(`[${index + 1}/${launches.length}] ${launch.arm} · ${launch.taskId}\n`);
			const proc = Bun.spawn(["bun", "src/runner.ts", ...launch.args], {
				cwd: PKG_DIR,
				stdout: "inherit",
				stderr: "inherit",
			});
			const exitCode = await proc.exited;
			if (exitCode !== 0) throw new Error(`${launch.jobName} exited ${exitCode}`);
		}
	}
	if (opts.mode !== "agent") micro = await runMicrobenchmarks(opts.microIterations);
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
				env: process.env,
			}),
		};
	}
	const empty = (arm: BenchmarkArm): ArmSummary => ({
		arm,
		tasks: 0,
		trials: 0,
		pass: 0,
		fail: 0,
		error: 0,
		costUsd: 0,
		tokIn: 0,
		tokOut: 0,
		durationMs: 0,
		toolCalls: 0,
		medianDurationMs: 0,
		runtimeTasks: 0,
	});
	const baseline =
		opts.mode === "micro" ? empty("baseline") : summarizeArm(opts.jobsDir, opts.prefix, "baseline", opts.taskIds);
	const runtime =
		opts.mode === "micro" ? empty("runtime") : summarizeArm(opts.jobsDir, opts.prefix, "runtime", opts.taskIds);
	const reportPath = path.join(opts.jobsDir, "_bench", `${opts.prefix}-runtime-comparison.md`);
	await Bun.write(reportPath, formatComparison(opts.prefix, baseline, runtime, micro, adapter));
	process.stdout.write(`Runtime benchmark report: ${reportPath}\n`);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	});
}
