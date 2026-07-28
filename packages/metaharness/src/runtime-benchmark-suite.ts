import * as path from "node:path";

export type RuntimeCapabilityGroup = "execution" | "project" | "debugging" | "profiling" | "jvm";

export interface RuntimeTaskDefinition {
	id: string;
	group: RuntimeCapabilityGroup;
	instruction: string;
	files: Record<string, string>;
	verify: string;
}

const DOCKERFILE = `FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 openjdk-17-jdk-headless ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . /app/
`;

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
		instruction:
			"Create /app/graph.ts and execute it. It must read /app/graph.json, compute deterministic breadth-first distances from start (unreachable nodes are null), and write /app/result.json with keys sorted alphabetically.",
		files: {
			"graph.json":
				'{"start":"a","nodes":["d","c","b","a","z"],"edges":[["a","b"],["a","c"],["b","d"],["c","d"]]}\n',
		},
		verify: verifier(`/opt/omp/bin/bun /app/graph.ts
python3 - <<'PY'
import json
with open('/app/result.json') as f: got=json.load(f)
assert got == {'a': 0, 'b': 1, 'c': 1, 'd': 2, 'z': None}
PY`),
	},
	{
		id: "project-validation",
		group: "project",
		instruction:
			"Repair the TypeScript project in /app so validation succeeds without weakening compiler settings. Preserve the exported renderTotal contract and verify the project without running unrelated scripts.",
		files: {
			"package.json":
				'{"scripts":{"check":"bun /opt/omp/src/node_modules/@typescript/native-preview/bin/tsgo --noEmit -p tsconfig.json"},"type":"module"}\n',
			"tsconfig.json":
				'{"compilerOptions":{"strict":true,"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","noEmit":true},"include":["src/**/*.ts"]}\n',
			"src/index.ts":
				"export function renderTotal(values: number[]): string {\n\tconst total: string = values.reduce((sum, value) => sum + value, 0);\n\treturn total.toFixed(2);\n}\n",
		},
		verify: verifier(`cd /app
/opt/omp/bin/bun run check
/opt/omp/bin/bun -e 'import { renderTotal } from "./src/index.ts"; if (renderTotal([1,2,3]) !== "6.00") process.exit(1)'`),
	},
	{
		id: "project-build",
		group: "project",
		instruction:
			"Complete the project build in /app. `bun run build` must produce /app/dist/report.json containing the exact aggregate described by input.json. Do not hand-write the final artifact; fix the build source.",
		files: {
			"package.json": '{"scripts":{"build":"bun run build.ts"},"type":"module"}\n',
			"input.json": '{"values":[2,3,5,8]}\n',
			"build.ts":
				'const input = await Bun.file("input.json").json();\nawait Bun.write("dist/report.json", JSON.stringify({ count: input.values.length, sum: 0 }));\n',
		},
		verify: verifier(`cd /app
rm -rf dist
/opt/omp/bin/bun run build
python3 - <<'PY'
import json
with open('/app/dist/report.json') as f: got=json.load(f)
assert got == {'count': 4, 'sum': 18}
PY`),
	},
	{
		id: "runtime-debugging",
		group: "debugging",
		instruction:
			"Reproduce and fix the state-transition bug in /app/counter.py. The program must print 220 for ten cumulative increments and still reject a negative increment. Keep the public Counter API unchanged.",
		files: {
			"counter.py":
				'class Counter:\n    def __init__(self): self.value = 0\n    def add(self, amount):\n        if amount < 0: raise ValueError("negative")\n        self.value = amount\n        return self.value\n\nc = Counter()\nprint(sum(c.add(i) for i in range(1, 11)))\n',
		},
		verify: verifier(`test "$(python3 /app/counter.py)" = "220"
python3 - <<'PY'
import runpy
ns=runpy.run_path('/app/counter.py')
c=ns['Counter']()
try: c.add(-1)
except ValueError: pass
else: raise AssertionError('negative increment accepted')
PY`),
	},
	{
		id: "instrumentation",
		group: "debugging",
		instruction:
			"Diagnose the nested-expression parsing failure in /app/parser.ts and fix it. Preserve the tokenize and evaluate exports. Running the file must print 21 for `mul(add(2,5),3)`.",
		files: {
			"parser.ts":
				'export const tokenize=(s:string)=>s.split(/([()])/).map(x=>x.trim()).filter(Boolean);\nexport function evaluate(tokens:string[]):number { const t=tokens.shift()!; if(/^\\d+$/.test(t)) return +t; tokens.shift(); const a=evaluate(tokens); tokens.shift(); const b=evaluate(tokens); tokens.shift(); return t==="add"?a+b:a*b }\nif(import.meta.main) console.log(evaluate(tokenize("mul(add(2,5),3)")));\n',
		},
		verify: verifier(`test "$(/opt/omp/bin/bun /app/parser.ts)" = "21"`),
	},
	{
		id: "cpu-sampling",
		group: "profiling",
		instruction:
			"Profile or otherwise measure /app/hotspot.py, then optimize the dominant work without changing its output. It must print 41665416675000 and finish quickly for the supplied workload.",
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
		instruction:
			"Reduce redundant calls in /app/fib.ts while preserving its observable output format `<value> <calls>`. For n=30 it must print value 832040 using no more than 100 function calls.",
		files: {
			"fib.ts":
				"let calls=0; function fib(n:number):number { calls++; return n<2?n:fib(n-1)+fib(n-2) } console.log(fib(30),calls);\n",
		},
		verify: verifier(`out=$(/opt/omp/bin/bun /app/fib.ts)
value=$(printf '%s' "$out" | cut -d' ' -f1)
calls=$(printf '%s' "$out" | cut -d' ' -f2)
test "$value" = "832040"
test "$calls" -le 100`),
	},
	{
		id: "java-execution",
		group: "jvm",
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
		instruction:
			"Compile /app/Report.java, write its real module dependencies to /app/deps.txt using dependency analysis, and generate Javadoc under /app/api-docs. Both outputs must describe the supplied source rather than placeholders.",
		files: {
			"Report.java":
				'/** Formats a deterministic SQL date. */\npublic class Report { /** Returns the epoch date. */ public static String epoch(){ return java.sql.Date.valueOf("1970-01-01").toString(); } public static void main(String[] a){System.out.println(epoch());} }\n',
		},
		verify: verifier(`cd /app
test -f Report.class
grep -q 'java.sql' deps.txt
test -f api-docs/index.html
test "$(java Report)" = "1970-01-01"`),
	},
];

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
		for (const [file, content] of Object.entries(task.files)) {
			await Bun.write(path.join(taskPath, "environment", file), content);
		}
		await Bun.write(path.join(taskPath, "tests", "test.sh"), task.verify);
		taskPaths.push(taskPath);
	}
	return taskPaths;
}
