import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SOURCE_SRC_MOUNT } from "./runner";

export type RuntimeCapabilityGroup = "execution" | "project" | "debugging" | "profiling" | "jvm";

export type TaskRuntimeTool = "insights" | "profile" | "jvm_disassemble" | "jvm_jar" | "jvm_deps";

export interface RuntimeTaskDefinition {
	id: string;
	group: RuntimeCapabilityGroup;
	runtimeTools: readonly TaskRuntimeTool[];
	instruction: string;
	files: Record<string, string>;
	verify: string;
}

export const BENCHMARK_BUN_CONTAINER_PATH = "/opt/runtime-benchmark/bin/bun";
export const BENCHMARK_BUN_VERSION = Bun.version;

const DOCKERFILE = `FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 openjdk-17-jdk-headless ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY benchmark-bun ${BENCHMARK_BUN_CONTAINER_PATH}
RUN chmod 0555 ${BENCHMARK_BUN_CONTAINER_PATH} && test "$(${BENCHMARK_BUN_CONTAINER_PATH} --version)" = "${BENCHMARK_BUN_VERSION}"
ENV PATH="/opt/runtime-benchmark/bin:\${PATH}"
COPY . /app/
`;

export const TYPESCRIPT_VERIFIER_SMOKE_SOURCE = `import { readFile, writeFile } from "node:fs/promises";

interface Graph {
	start: string;
	nodes: string[];
	edges: [string, string][];
}

const graph: Graph = JSON.parse(await readFile("/app/graph.json", "utf8"));
const adjacency = new Map(graph.nodes.map(node => [node, [] as string[]]));
for (const [from, to] of graph.edges) adjacency.get(from)?.push(to);
const distances: Record<string, number | null> = Object.fromEntries(graph.nodes.map(node => [node, null]));
distances[graph.start] = 0;
const queue = [graph.start];
for (const node of queue) {
	for (const next of adjacency.get(node) ?? []) {
		if (distances[next] !== null) continue;
		distances[next] = (distances[node] ?? 0) + 1;
		queue.push(next);
	}
}
const sorted = Object.fromEntries(Object.keys(distances).sort().map(key => [key, distances[key]]));
await writeFile("/app/result.json", JSON.stringify(sorted));
`;

function executeTypeScript(source: string): string {
	return `${BENCHMARK_BUN_CONTAINER_PATH} ${source}`;
}

function verifier(check: string): string {
	return `#!/bin/bash
set +e
mkdir -p /logs/verifier
(
set -euo pipefail
${check}
)
status=$?
if [ "$status" -eq 0 ]; then printf '1\\n' > /logs/verifier/reward.txt; else printf '0\\n' > /logs/verifier/reward.txt; fi
exit 0
`;
}

export const RUNTIME_TASKS: RuntimeTaskDefinition[] = [
	{
		id: "python-execution",
		group: "execution",
		runtimeTools: [],
		instruction:
			"Read /app/events.jsonl. Create and execute a dependency-free Python program that groups amount by user and category, skips malformed records, and writes canonical sorted JSON to /app/summary.json. Keep the program at /app/aggregate.py.",
		files: {
			"events.jsonl":
				'{"user":"ada","category":"build","amount":3}\n{"user":"lin","category":"run","amount":4}\nnot-json\n{"user":"ada","category":"build","amount":2}\n{"user":"ada","category":"run","amount":7}\n',
		},
		verify: verifier(`python3 /app/aggregate.py
python3 - <<'PY'
import json
with open('/app/summary.json') as f: got=json.load(f)
assert got == {'ada': {'build': 5, 'run': 7}, 'lin': {'run': 4}}
PY`),
	},
	{
		id: "typescript-execution",
		group: "execution",
		runtimeTools: [],
		instruction:
			"Create /app/graph.ts and execute it. It must read /app/graph.json, compute deterministic breadth-first distances from start (unreachable nodes are null), and write /app/result.json with keys sorted alphabetically.",
		files: {
			"graph.json":
				'{"start":"a","nodes":["d","c","b","a","z"],"edges":[["a","b"],["a","c"],["b","d"],["c","d"]]}\n',
		},
		verify: verifier(`${executeTypeScript("/app/graph.ts")}
python3 - <<'PY'
import json
with open('/app/result.json') as f: got=json.load(f)
assert got == {'a': 0, 'b': 1, 'c': 1, 'd': 2, 'z': None}
PY`),
	},
	{
		id: "project-validation",
		group: "project",
		runtimeTools: [],
		instruction:
			"Repair the Java project in /app so managed validation succeeds without weakening its manifest. Preserve the public RenderTotal.renderTotal(int[]) contract.",
		files: {
			"elide.pkl":
				'amends "elide:project.pkl"\nimport "elide:Sources.pkl" as Sources\n\nname = "render-total-validation"\n\njvm {\n  target = 17\n}\n\nsources {\n  ["main"] = new Sources.SourceSetSpec {\n    paths {\n      "src/main/java/**/*.java"\n    }\n  }\n}\n',
			"src/main/java/RenderTotal.java":
				'import java.util.Arrays;\n\npublic final class RenderTotal {\n    public static String renderTotal(int[] values) {\n        int total = Arrays.stream(values).sum()\n        return String.format("%.2f", (double) total);\n    }\n\n    public static void main(String[] args) {\n        System.out.println(renderTotal(new int[] {1, 2, 3}));\n    }\n}\n',
		},
		verify: verifier(`cd /app
rm -rf /tmp/runtime-benchmark-validation
mkdir -p /tmp/runtime-benchmark-validation
/usr/bin/javac -d /tmp/runtime-benchmark-validation src/main/java/RenderTotal.java
test "$(/usr/bin/java -cp /tmp/runtime-benchmark-validation RenderTotal)" = "6.00"`),
	},
	{
		id: "project-build",
		group: "project",
		runtimeTools: [],
		instruction:
			"Complete the Java project build in /app by repairing the supplied source. The build must produce .dev/jvm/classes/main/java/SumReport.class, whose entrypoint prints 18.",
		files: {
			"elide.pkl":
				'amends "elide:project.pkl"\nimport "elide:Sources.pkl" as Sources\n\nname = "sum-report-build"\n\njvm {\n  target = 17\n}\n\nsources {\n  ["main"] = new Sources.SourceSetSpec {\n    paths {\n      "src/main/java/**/*.java"\n    }\n  }\n}\n',
			"src/main/java/SumReport.java":
				"public final class SumReport {\n    public static int sum(int[] values) {\n        int total = 0;\n        for (int value : values) total += value\n        return total;\n    }\n\n    public static void main(String[] args) {\n        System.out.println(sum(new int[] {2, 3, 5, 8}));\n    }\n}\n",
		},
		verify: verifier(`cd /app
test -f .dev/jvm/classes/main/java/SumReport.class
test "$(/usr/bin/java -cp .dev/jvm/classes/main/java SumReport)" = "18"`),
	},
	{
		id: "runtime-debugging",
		group: "debugging",
		runtimeTools: [],
		instruction:
			"Reproduce and fix the state-transition bug in /app/counter.py. The program must print 220 and then 55, confirming a negative increment is rejected without mutating state. Keep the public Counter API unchanged.",
		files: {
			"counter.py":
				'class Counter:\n    def __init__(self): self.value = 0\n    def add(self, amount):\n        if amount < 0: raise ValueError("negative")\n        self.value = amount\n        return self.value\n\nc = Counter()\nprint(sum(c.add(i) for i in range(1, 11)))\ntry: c.add(-1)\nexcept ValueError: print(c.value)\n',
		},
		verify: verifier(`test "$(python3 /app/counter.py)" = "220
55"`),
	},
	{
		id: "instrumentation",
		group: "debugging",
		runtimeTools: ["insights"],
		instruction:
			"Diagnose the nested-expression parsing failure in /app/parser.ts and fix it. Preserve the tokenize and evaluate exports. Running the file must print 21 for `mul(add(2,5),3)`.",
		files: {
			"parser.ts":
				'export const tokenize=(s:string)=>s.split(/([()])/).map(x=>x.trim()).filter(Boolean);\nexport function evaluate(tokens:string[]):number { const t=tokens.shift()!; if(/^\\d+$/.test(t)) return +t; tokens.shift(); const a=evaluate(tokens); tokens.shift(); const b=evaluate(tokens); tokens.shift(); return t==="add"?a+b:a*b }\nconsole.log(evaluate(tokenize("mul(add(2,5),3)")));\n',
		},
		verify: verifier(`test "$(${executeTypeScript("/app/parser.ts")})" = "21"`),
	},
	{
		id: "cpu-sampling",
		group: "profiling",
		runtimeTools: ["profile"],
		instruction:
			"Profile or otherwise measure /app/hotspot.py once, then optimize the dominant work without changing its output. It must print 41665416675000 and finish quickly. Verify the optimized output once; do not profile the constant-time result because it is too short to sample.",
		files: {
			"hotspot.py":
				"def total(n):\n    out=0\n    for i in range(n):\n        for j in range(i):\n            out += i\n    return out\nprint(total(50000))\n",
		},
		verify: verifier(`python3 - <<'PY'
import subprocess,time
start=time.monotonic(); p=subprocess.run(['python3','/app/hotspot.py'],capture_output=True,text=True,timeout=3); elapsed=time.monotonic()-start
assert p.returncode == 0 and p.stdout.strip() == '41665416675000'
assert elapsed < 2.0
PY`),
	},
	{
		id: "call-tracing",
		group: "profiling",
		runtimeTools: ["insights"],
		instruction:
			"Reduce redundant calls in /app/fib.ts while preserving its observable output format `<value> <calls>`. For n=30 it must print value 832040 using no more than 100 function calls.",
		files: {
			"fib.ts":
				"let calls=0; function fib(n:number):number { calls++; return n<2?n:fib(n-1)+fib(n-2) } console.log(fib(30),calls);\n",
		},
		verify: verifier(`out=$(${executeTypeScript("/app/fib.ts")})
value=$(printf '%s' "$out" | cut -d' ' -f1)
calls=$(printf '%s' "$out" | cut -d' ' -f2)
test "$value" = "832040"
test "$calls" -le 100`),
	},
	{
		id: "java-execution",
		group: "jvm",
		runtimeTools: [],
		instruction:
			"Fix /app/Main.java, compile it, and verify it prints 55. Preserve the public class and sumInclusive method signature.",
		files: {
			"Main.java":
				"public class Main { static int sumInclusive(int n) { int s=0; for(int i=0;i<n;i++) s+=i; return s; } public static void main(String[] args) { System.out.println(sumInclusive(10)); } }\n",
		},
		verify: verifier(`cd /app
javac --release 17 Main.java
test "$(java Main)" = "55"`),
	},
	{
		id: "bytecode-inspection",
		group: "jvm",
		runtimeTools: ["jvm_disassemble"],
		instruction:
			"Remove avoidable boxing from /app/Boxing.java while preserving output 499500. Compile it and inspect the bytecode to confirm the hot loop no longer calls Integer.valueOf.",
		files: {
			"Boxing.java":
				"public class Boxing { static long sum(int n) { Long s=0L; for(int i=0;i<n;i++) s += Integer.valueOf(i); return s; } public static void main(String[] a){ System.out.println(sum(1000)); } }\n",
		},
		verify: verifier(`cd /app
javac --release 17 Boxing.java
test "$(java Boxing)" = "499500"
! javap -c Boxing | grep -q 'Integer.valueOf'`),
	},
	{
		id: "executable-jar",
		group: "jvm",
		runtimeTools: ["jvm_jar"],
		instruction:
			"Build /app/app.jar from /app/Main.java as an executable JAR whose manifest launches Main. Running `java -jar /app/app.jar 6 7` must print 42.",
		files: {
			"Main.java":
				"public class Main { public static void main(String[] a){ System.out.println(Integer.parseInt(a[0])*Integer.parseInt(a[1])); } }\n",
		},
		verify: verifier(`cd /app
test -f app.jar
test "$(java -jar app.jar 6 7)" = "42"
jar --list --file app.jar | grep -q 'Main.class'`),
	},
	{
		id: "jvm-dependencies",
		group: "jvm",
		runtimeTools: ["jvm_deps"],
		instruction:
			"Compile /app/Report.java, write its real module dependencies to /app/deps.txt, and verify it prints 1970-01-01. Use the most direct available dependency-analysis capability; the report must include java.sql.",
		files: {
			"Report.java":
				'/** Formats a deterministic SQL date. */\npublic class Report { /** Returns the epoch date. */ public static String epoch(){ return java.sql.Date.valueOf("1970-01-01").toString(); } public static void main(String[] a){System.out.println(epoch());} }\n',
		},
		verify: verifier(`cd /app
javac --release 17 Report.java
grep -q 'java.sql' deps.txt
test "$(java Report)" = "1970-01-01"`),
	},
];

async function installBenchmarkBun(environmentPath: string): Promise<void> {
	const destination = path.join(environmentPath, "benchmark-bun");
	await fs.rm(destination, { force: true });
	try {
		await fs.link(process.execPath, destination);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
		await fs.copyFile(process.execPath, destination);
	}
	await fs.chmod(destination, 0o555);
}

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");

/**
 * Container path of a repository artifact under the `--install=source` bind
 * mount. Injected runtime artifacts must live inside the repository because
 * that read-only mount is all a task container sees of the host.
 */
export function sourceMountedRuntimePath(hostPath: string): string {
	const relative = path.relative(REPO_ROOT, path.resolve(hostPath));
	if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`Runtime benchmark artifact must be inside the source-mounted repository: ${hostPath}`);
	}
	return path.posix.join(SOURCE_SRC_MOUNT, ...relative.split(path.sep));
}

/** Raw docker outcome. The runtime-arm preflight inspects failures rather than only throwing on them. */
export interface DockerRunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export async function spawnDocker(args: string[]): Promise<DockerRunResult> {
	const proc = Bun.spawn(["docker", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

async function runDocker(args: string[]): Promise<string> {
	const { exitCode, stdout, stderr } = await spawnDocker(args);
	if (exitCode !== 0) {
		throw new Error(`docker ${args[0]} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`);
	}
	return stdout.trim();
}

export async function smokeTypeScriptTaskVerifier(root: string): Promise<void> {
	const taskPath = path.join(root, "typescript-execution");
	const smokeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-verifier-smoke-"));
	let image = "";
	try {
		const appPath = path.join(smokeRoot, "app");
		const logsPath = path.join(smokeRoot, "logs");
		await fs.mkdir(appPath);
		await fs.mkdir(logsPath);
		await Bun.write(path.join(appPath, "graph.ts"), TYPESCRIPT_VERIFIER_SMOKE_SOURCE);
		await fs.copyFile(path.join(taskPath, "environment", "graph.json"), path.join(appPath, "graph.json"));
		image = (await runDocker(["build", "--quiet", path.join(taskPath, "environment")])).split("\n").at(-1) ?? "";
		if (image === "") throw new Error("docker build returned no image identifier");
		await runDocker([
			"run",
			"--rm",
			"--user",
			`${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
			"--volume",
			`${appPath}:/app`,
			"--volume",
			`${path.join(taskPath, "tests", "test.sh")}:/tests/test.sh:ro`,
			"--volume",
			`${logsPath}:/logs`,
			image,
			"bash",
			"/tests/test.sh",
		]);
		const reward = (await Bun.file(path.join(logsPath, "verifier", "reward.txt")).text()).trim();
		if (reward !== "1") throw new Error("generated TypeScript verifier rejected the deterministic smoke source");
	} finally {
		if (image !== "") await runDocker(["image", "rm", "--force", image]).catch(() => undefined);
		await fs.rm(smokeRoot, { recursive: true, force: true });
	}
}

// ── runtime arm preflight ────────────────────────────────────────────────────
// A campaign whose runtime artifacts never reached the task containers once
// measured plain bash and reported 100% pass (docs/aura/ACTIONS_CONSOLIDATE.md).
// This probe is the gate that makes that failure loud: it executes a language
// the fallback cannot serve, through the very artifacts the runtime arm injects,
// inside the very image the tasks run in.

/**
 * What the probe must print. Deliberately distinctive: no shell fallback, and no
 * runtime error path, produces this string by accident. Keep in sync with
 * {@link RUNTIME_ARM_PROBE_SOURCE} — `6 * 7` is the `:42` suffix.
 */
export const RUNTIME_ARM_PROBE_SENTINEL = "aura-runtime-arm-probe:42";

/**
 * Python, never TypeScript: TS/JS route to the Bun adapter and succeed even when
 * the packaged runtime is entirely absent (pinned by the adapter-selection matrix
 * in `packages/coding-agent/test/runtime-embedded-endpoint.test.ts`), so a TS probe
 * cannot distinguish an injected runtime from a missing one. Python only executes
 * through Elide, which is exactly the artifact under test.
 *
 * Single-quote free so it embeds in the single-quoted shell literal below.
 */
const RUNTIME_ARM_PROBE_SOURCE = `print("aura-runtime-arm-probe:" + str(6 * 7))`;

const RUNTIME_ARM_PROBE_GUEST_FILE = "/tmp/aura-runtime-arm-probe.py";

export interface RuntimeArmProbeOptions {
	/** Root of the materialized task tree; the probe reuses the `python-execution` task image. */
	taskRoot: string;
	/** Host path of the packaged process binary injected as `AURA_RUNTIME_BIN`. */
	runtimeBinary?: string;
	/** Host path of the packaged embedded library injected as `AURA_RUNTIME_EMBEDDED_LIB`. */
	embeddedLib?: string;
	/** Injected so the decision logic is testable without a docker daemon. */
	runDocker: (args: string[]) => Promise<DockerRunResult>;
	/** `--allow-missing-runtime`: report the failure instead of aborting the campaign. */
	allowMissingRuntime?: boolean;
	warn?: (message: string) => void;
}

/**
 * A `test` that says what it was looking for: an anonymous failed `test` would
 * tell the operator only that something, somewhere, was missing.
 */
function probeGuard(check: "-x" | "-r", artifactPath: string, missing: string): string {
	return `test ${check} '${artifactPath}' || { echo "${missing}: ${artifactPath}" >&2; exit 1; }`;
}

/** The command the probe runs inside the task container. Mirrors the process adapter's own run argv. */
function runtimeArmProbeScript(binaryPath: string, libraryPath: string | undefined): string {
	const guards = [probeGuard("-x", binaryPath, "missing or non-executable process binary")];
	if (libraryPath !== undefined) {
		guards.push(probeGuard("-r", libraryPath, "missing or unreadable embedded library"));
	}
	return [
		"set -eu",
		...guards,
		`printf '%s\\n' '${RUNTIME_ARM_PROBE_SOURCE}' > '${RUNTIME_ARM_PROBE_GUEST_FILE}'`,
		`'${binaryPath}' run --error-format=plain --no-color -l python '${RUNTIME_ARM_PROBE_GUEST_FILE}'`,
	].join("\n");
}

/**
 * Prove the runtime arm can actually run guest code before spending a campaign on
 * it: build the standard task image, mount the repository the way `--install=source`
 * does, and execute Python through the injected artifacts at their container paths.
 *
 * No-ops when no artifacts are injected — a baseline-only run has no runtime arm to
 * verify. Any other outcome (build failure aside) names the artifact paths involved,
 * and aborts unless `allowMissingRuntime` downgrades it to a warning.
 */
export async function smokeRuntimeArmExecution(opts: RuntimeArmProbeOptions): Promise<void> {
	if (!opts.runtimeBinary && !opts.embeddedLib) return;
	const warn = opts.warn ?? ((message: string) => void process.stderr.write(`warning: ${message}\n`));
	const binaryPath = opts.runtimeBinary === undefined ? undefined : sourceMountedRuntimePath(opts.runtimeBinary);
	const libraryPath = opts.embeddedLib === undefined ? undefined : sourceMountedRuntimePath(opts.embeddedLib);
	const artifacts = [
		binaryPath === undefined ? "process binary (none supplied)" : `process binary ${binaryPath}`,
		libraryPath === undefined ? "embedded library (none supplied)" : `embedded library ${libraryPath}`,
	].join(", ");
	const fail = (detail: string): void => {
		const message = `Runtime arm preflight failed: ${detail} [${artifacts}]. The runtime arm would measure bash fallback; pass --allow-missing-runtime only if that is what you intend to measure.`;
		if (opts.allowMissingRuntime) {
			warn(message);
			return;
		}
		throw new Error(message);
	};
	if (binaryPath === undefined) {
		fail("no packaged process binary accompanies the injected embedded library");
		return;
	}

	const environment = path.join(opts.taskRoot, "python-execution", "environment");
	const built = await opts.runDocker(["build", "--quiet", environment]);
	if (built.exitCode !== 0) {
		throw new Error(
			`Runtime arm preflight could not build the task image from ${environment}: ${built.stderr.trim() || built.stdout.trim()}`,
		);
	}
	const image = built.stdout.trim().split("\n").at(-1) ?? "";
	if (image === "") throw new Error("Runtime arm preflight: docker build returned no image identifier");
	try {
		const probe = await opts.runDocker([
			"run",
			"--rm",
			// A benchmark must never reach the network to acquire its own subject:
			// the probe passes only if the artifacts already mounted below can run.
			"--network",
			"none",
			"--user",
			`${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
			// That uid has no passwd entry in the image, so give the runtime a
			// writable home rather than letting a missing HOME fail the gate.
			"--env",
			"HOME=/tmp",
			"--volume",
			`${REPO_ROOT}:${SOURCE_SRC_MOUNT}:ro`,
			image,
			"bash",
			"-c",
			runtimeArmProbeScript(binaryPath, libraryPath),
		]);
		if (probe.exitCode !== 0) {
			fail(
				`the injected runtime could not execute Python inside the task container (exit ${probe.exitCode}): ${probe.stderr.trim() || probe.stdout.trim()}`,
			);
			return;
		}
		const printed = probe.stdout.trim();
		if (printed !== RUNTIME_ARM_PROBE_SENTINEL) {
			fail(
				`the Python probe printed ${JSON.stringify(printed)} instead of ${JSON.stringify(RUNTIME_ARM_PROBE_SENTINEL)}`,
			);
		}
	} finally {
		await opts.runDocker(["image", "rm", "--force", image]).catch(() => undefined);
	}
}

function taskToml(task: RuntimeTaskDefinition): string {
	return `schema_version = "1.3"
artifacts = []

[task]
name = "aura/${task.id}"
description = "Runtime capability benchmark: ${task.group}"
authors = []
keywords = ["runtime", "${task.group}"]

[verifier]
timeout_sec = 120.0
collect = []

[agent]
timeout_sec = 600.0

[environment]
network_mode = "public"
build_timeout_sec = 600.0
os = "linux"
mcp_servers = []
`;
}

export async function materializeRuntimeTasks(root: string): Promise<string[]> {
	const taskPaths: string[] = [];
	for (const task of RUNTIME_TASKS) {
		const taskPath = path.join(root, task.id);
		await Bun.write(path.join(taskPath, "task.toml"), taskToml(task));
		await Bun.write(path.join(taskPath, "instruction.md"), `${task.instruction.trim()}\n`);
		await Bun.write(path.join(taskPath, "environment", "Dockerfile"), DOCKERFILE);
		await installBenchmarkBun(path.join(taskPath, "environment"));
		for (const [file, content] of Object.entries(task.files)) {
			await Bun.write(path.join(taskPath, "environment", file), content);
		}
		await Bun.write(path.join(taskPath, "tests", "test.sh"), task.verify);
		taskPaths.push(taskPath);
	}
	return taskPaths;
}
