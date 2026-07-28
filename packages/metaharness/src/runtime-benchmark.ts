#!/usr/bin/env bun
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getOrCreateRuntimeService } from "../../coding-agent/src/runtime";
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

interface CliOptions {
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
	return `${lines.join("\n")}\n`;
}

function median(values: number[]): number {
	const sorted = values.toSorted((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
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
	try {
		const python = Bun.which("python3");
		const bun = Bun.which("bun");
		const javac = Bun.which("javac");
		const java = Bun.which("java");
		if (!python || !bun || !javac || !java)
			throw new Error("microbenchmarks require python3, bun, javac, and java on PATH");
		const service = getOrCreateRuntimeService({ autoDownload: true });
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
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function parseCli(argv: string[]): CliOptions {
	const opts: CliOptions = {
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
	const opts = parseCli(process.argv.slice(2));
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
	await Bun.write(reportPath, formatComparison(opts.prefix, baseline, runtime, micro));
	process.stdout.write(`Runtime benchmark report: ${reportPath}\n`);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	});
}
