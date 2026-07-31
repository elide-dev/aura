import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type RuntimeCapabilityGroup = "execution" | "project" | "debugging" | "profiling" | "jvm";

export type TaskRuntimeTool = "insights" | "profile" | "jvm_disassemble" | "jvm_jar" | "jvm_deps" | "jvm_javadoc";

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
		id: "jvm-dependency-docs",
		group: "jvm",
		runtimeTools: ["jvm_deps", "jvm_javadoc"],
		instruction:
			"Compile /app/Report.java, write its real module dependencies to /app/deps.txt using dependency analysis, and generate Javadoc under /app/api-docs. Both outputs must describe the supplied source rather than placeholders.",
		files: {
			"Report.java":
				'/** Formats a deterministic SQL date. */\npublic class Report { /** Returns the epoch date. */ public static String epoch(){ return java.sql.Date.valueOf("1970-01-01").toString(); } public static void main(String[] a){System.out.println(epoch());} }\n',
		},
		verify: verifier(`cd /app
javac --release 17 Report.java
grep -q 'java.sql' deps.txt
test -f api-docs/index.html
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

async function runDocker(args: string[]): Promise<string> {
	const proc = Bun.spawn(["docker", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
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
