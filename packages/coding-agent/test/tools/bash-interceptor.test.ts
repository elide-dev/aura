import { describe, expect, it } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	activeBashInterceptorRules,
	applyRuntimeShellOptOut,
	type BashInterceptorRule,
	DEFAULT_BASH_INTERCEPTOR_RULES,
	RUNTIME_SHELL_INTERCEPTOR_RULES,
	RUNTIME_SHELL_RULE_KIND,
} from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool, type BashToolInput } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { checkBashInterception } from "@oh-my-pi/pi-coding-agent/tools/bash-interceptor";

function createBashTool(rules: BashInterceptorRule[], overrides: Record<string, unknown> = {}): BashTool {
	const session = {
		settings: {
			get(key: string) {
				if (key in overrides) return overrides[key];
				if (key === "bashInterceptor.enabled") return true;
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				return undefined;
			},
			getBashInterceptorRules() {
				return rules;
			},
		},
	} as unknown as ToolSession;

	return new BashTool(session);
}

describe("BashTool interception", () => {
	it("checks the original command before leading cd normalization", async () => {
		const tool = createBashTool([
			{
				pattern: "^\\s*cd\\s+",
				tool: "bash",
				message: "Do not hide directory changes in the command string.",
			},
		]);

		await expect(
			tool.execute("tool-call", { command: "cd packages/coding-agent && echo ok" }, undefined, undefined, {
				toolNames: ["bash"],
			} as AgentToolContext),
		).rejects.toThrow("Do not hide directory changes");
	});

	it("checks the cwd-normalized command after leading cd normalization", async () => {
		const tool = createBashTool([
			{
				pattern: "^\\s*cat\\s+",
				tool: "read",
				message: "Use read instead.",
			},
		]);

		await expect(
			tool.execute("tool-call", { command: "cd packages/coding-agent && cat package.json" }, undefined, undefined, {
				toolNames: ["read"],
			} as AgentToolContext),
		).rejects.toThrow("Use read instead");
	});
});

/**
 * The interception message for a command, or undefined when it was not
 * intercepted. Interception throws a `Blocked: …` ToolError before anything else
 * runs; any other rejection means the command got past the check and tripped over
 * the stub session, which for these tests is exactly "not intercepted".
 */
async function interceptionFor(tool: BashTool, command: string, toolNames: string[]): Promise<string | undefined> {
	try {
		await tool.execute("tool-call", { command }, undefined, undefined, { toolNames } as AgentToolContext);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return message.startsWith("Blocked: ") ? message : undefined;
	}
	return undefined;
}

describe("runtime rules on a default install (bashInterceptor.enabled off)", () => {
	// The whole point of the group: a fresh install routes direct runtime
	// invocation to the innate tools, while upstream's deliberately-softened
	// cat/grep/sed nudges stay opt-in.
	const defaultInstall = () => createBashTool(DEFAULT_BASH_INTERCEPTOR_RULES, { "bashInterceptor.enabled": false });
	const runtimeTools = ["run", "check", "build", "read"];

	it("intercepts direct runtime invocation with the interceptor toggle off", async () => {
		expect(await interceptionFor(defaultInstall(), "elide run app.ts", runtimeTools)).toContain(
			"Use the innate runtime tools",
		);
	});

	it("leaves the non-runtime rules off with the interceptor toggle off", async () => {
		expect(await interceptionFor(defaultInstall(), "cat package.json", runtimeTools)).toBeUndefined();
	});

	it("stays off for the runtime group when the runtime tools are unregistered", async () => {
		// runtime.enabled off ⇒ no run/check/build in toolNames ⇒ the group stands down.
		expect(await interceptionFor(defaultInstall(), "elide --version", ["read", "grep"])).toBeUndefined();
	});

	it("honors the opt-out even though the group is otherwise always on", async () => {
		const optedOut = createBashTool(applyRuntimeShellOptOut(DEFAULT_BASH_INTERCEPTOR_RULES, true, {}), {
			"bashInterceptor.enabled": false,
		});
		expect(await interceptionFor(optedOut, "elide --version", runtimeTools)).toBeUndefined();
	});

	it("still evaluates both rule groups when the interceptor toggle is on", async () => {
		const tool = createBashTool(DEFAULT_BASH_INTERCEPTOR_RULES, { "bashInterceptor.enabled": true });
		expect(await interceptionFor(tool, "elide run app.ts", runtimeTools)).toContain("Use the innate runtime tools");
		expect(await interceptionFor(tool, "cat package.json", runtimeTools)).toContain("Use the `read` tool");
	});
});

describe("activeBashInterceptorRules", () => {
	it("keeps only the runtime group when the interceptor is disabled", () => {
		const active = activeBashInterceptorRules(DEFAULT_BASH_INTERCEPTOR_RULES, false);
		expect(active).toEqual(RUNTIME_SHELL_INTERCEPTOR_RULES);
	});

	it("keeps every rule when the interceptor is enabled", () => {
		expect(activeBashInterceptorRules(DEFAULT_BASH_INTERCEPTOR_RULES, true)).toEqual(DEFAULT_BASH_INTERCEPTOR_RULES);
	});

	it("yields nothing when the opt-out has already dropped the runtime group", () => {
		const optedOut = applyRuntimeShellOptOut(DEFAULT_BASH_INTERCEPTOR_RULES, true, {});
		expect(activeBashInterceptorRules(optedOut, false)).toEqual([]);
	});
});

describe("default echo/printf redirect rule", () => {
	const tools = ["write"];

	it("blocks unquoted redirects to files", () => {
		expect(checkBashInterception("echo hi > out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception("echo hi >> out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception('printf "%s" foo > /tmp/x', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
	});

	it("blocks clobber and variable-target redirects", () => {
		expect(checkBashInterception("echo hi >| out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception("echo hi > $OUT", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
	});

	it("does not block /dev device sink redirects", () => {
		expect(checkBashInterception("echo result > /dev/null", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception("echo done > /dev/null 2>&1", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(
			false,
		);
		expect(checkBashInterception('echo "" > /dev/tty', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception("echo x > /dev/stdout", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception('echo "marker" > /dev/stderr', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(
			false,
		);
		expect(checkBashInterception('echo x > "/dev/null"', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
	});

	it("still blocks real paths that resemble /dev sinks", () => {
		expect(checkBashInterception("echo data > ./dev/null", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception("echo data > /devices/x", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
	});

	it("keeps scanning after allowed /dev sink redirects", () => {
		expect(
			checkBashInterception("echo data > /dev/null > out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block,
		).toBe(true);
		expect(
			checkBashInterception("printf x > /dev/stdout >> real.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block,
		).toBe(true);
	});

	it("does not block `>` inside quoted text or fd duplication", () => {
		expect(checkBashInterception('echo "a -> b"', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception('echo "<p>hi</p>"', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception("printf 'use 2>&1'", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception('echo "err" >&2', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
	});
});

describe("default hub start rules", () => {
	const tools = ["hub"];

	it.each(["bun run dev", "vite --host 0.0.0.0", "lldb ./app", "bun test --watch", "nohup server", "server &"])(
		"routes %s to hub start",
		command => {
			const result = checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES);
			expect(result.block).toBe(true);
			expect(result.suggestedTool).toBe("hub");
		},
	);

	it.each(["git diff -w", "docker compose up -d", "bun test", "printf 'server &'"])(
		"does not misclassify finite command %s",
		command => {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		},
	);
});

describe("default runtime shell rules", () => {
	// Every innate runtime tool the rules can route to.
	const tools = [
		"run",
		"check",
		"build",
		"insights",
		"profile",
		"serve",
		"runtime_debug",
		"jvm_run",
		"jvm_disassemble",
		"jvm_jar",
		"jvm_deps",
		"jvm_javadoc",
		"project_advice",
	];

	it.each([
		["elide run app.ts", "run"],
		["elide app.ts", "run"],
		["elide", "run"],
		["elide --version", "run"],
		["./elide run app.ts", "run"],
		["/usr/local/bin/elide run app.ts", "run"],
		["elide.exe run app.ts", "run"],
		["cd /tmp && elide run app.ts", "run"],
		["echo hi; elide run app.ts", "run"],
		["cat app.ts | elide run -", "run"],
		["FOO=1 elide run app.ts", "run"],
		["sudo -E elide run app.ts", "run"],
		["env FOO=1 elide run app.ts", "run"],
		["bunx elide run app.ts", "run"],
		["bunx @elide-dev/elide run app.ts", "run"],
		["npx elide run app.ts", "run"],
		["npx @elide-dev/elide run app.ts", "run"],
		["npx -y @elide-dev/elide run app.ts", "run"],
		["pnpm dlx elide run app.ts", "run"],
		["elide build", "build"],
		["elide build :app", "build"],
		["elide serve ./site", "serve"],
		["elide javac -- Main.java", "jvm_run"],
		["elide java -- -cp . Main", "jvm_run"],
		["elide javap -- -c Main", "jvm_disassemble"],
		["elide jar -- --list --file app.jar", "jvm_jar"],
		["elide jdeps -- app.jar", "jvm_deps"],
		["elide javadoc -- -d apidocs Main.java", "jvm_javadoc"],
		["elide project advice", "project_advice"],
	])("routes %s to the %s tool", (command, expected) => {
		const result = checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe(expected);
	});

	it("routes a sibling `project` subcommand to the generic tool, not project_advice", () => {
		// `project advice` is the only subcommand a tool owns; `project info`
		// must not claim to be advice — it falls through to the generic rule.
		const result = checkBashInterception("elide project info", tools, DEFAULT_BASH_INTERCEPTOR_RULES);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).not.toBe("project_advice");
	});

	it.each([
		"for f in *.ts; do elide run $f; done",
		"if [ -f app.ts ]; then elide run app.ts; fi",
		"if [ -f a ]; then echo a; else elide run b; fi",
		"time elide run app.ts",
		"time -p elide run app.ts",
		"out=`elide run app.ts`",
		"echo `elide --version`",
		"out=$(elide run app.ts)",
		"while read f; do elide run $f; done < list",
	])("intercepts the shell lead-in form %s", command => {
		const result = checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("run");
	});

	it("names the innate tools and the opt-out without naming the vendor", () => {
		const result = checkBashInterception("elide run app.ts", tools, DEFAULT_BASH_INTERCEPTOR_RULES);
		expect(result.message).toContain("`run`");
		expect(result.message).toContain("AURA_ALLOW_ELIDE_SHELL=1");
		expect(result.message).toContain("runtime.allowShell");
		// Fork naming rule: rule messages never emit the vendor name. The patterns
		// match the literal command word the user typed, and the echoed original
		// command plus the documented AURA_ALLOW_ELIDE_SHELL compat name are the only
		// places it may appear.
		for (const rule of RUNTIME_SHELL_INTERCEPTOR_RULES) {
			expect(rule.message.replaceAll("AURA_ALLOW_ELIDE_SHELL", "")).not.toMatch(/elide/i);
		}
	});

	it.each([
		"ls /home/elide/projects",
		"cat /opt/elide/notes.txt",
		"cd /home/elide && ls",
		"mytool --elide-comments src",
		"elidefoo run app.ts",
		"myelide run app.ts",
		"git commit -m 'switch to elide'",
		"echo elide",
		"which elide",
		// A separator with no following whitespace reads as in-word, not as a command
		// boundary — quoting is not tracked, so this is the guard that keeps regex
		// alternations safe now that the group runs on every default install.
		'grep -E "aura|elide" notes.md',
		'rg "run;elide" src',
		'echo "a&elide"',
	])("does not intercept %s", command => {
		expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
	});

	it("stands down entirely when the runtime tools are unavailable", () => {
		for (const command of ["elide run app.ts", "elide build", "bunx elide run app.ts", "elide jar -- --list"]) {
			expect(checkBashInterception(command, ["read", "grep", "hub"], DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(
				false,
			);
		}
	});

	it("falls through to the generic run rule when only the specific tool is unavailable", () => {
		const result = checkBashInterception(
			"elide jar -- --list --file app.jar",
			["run"],
			DEFAULT_BASH_INTERCEPTOR_RULES,
		);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("run");
	});
});

describe("runtime shell opt-out", () => {
	const tools = ["run", "build", "read"];

	it("keeps the runtime rules when neither opt-out is set", () => {
		const rules = applyRuntimeShellOptOut(DEFAULT_BASH_INTERCEPTOR_RULES, false, {});
		expect(rules).toEqual(DEFAULT_BASH_INTERCEPTOR_RULES);
		expect(checkBashInterception("elide run app.ts", tools, rules).block).toBe(true);
	});

	it("suppresses the runtime rules via the runtime.allowShell setting", () => {
		const rules = applyRuntimeShellOptOut(DEFAULT_BASH_INTERCEPTOR_RULES, true, {});
		expect(checkBashInterception("elide run app.ts", tools, rules).block).toBe(false);
	});

	it.each(["1", "true", "yes"])("suppresses the runtime rules via AURA_ALLOW_ELIDE_SHELL=%s", value => {
		const rules = applyRuntimeShellOptOut(DEFAULT_BASH_INTERCEPTOR_RULES, false, {
			AURA_ALLOW_ELIDE_SHELL: value,
		});
		expect(checkBashInterception("elide run app.ts", tools, rules).block).toBe(false);
	});

	it("ignores an empty or falsy AURA_ALLOW_ELIDE_SHELL", () => {
		for (const value of ["", "0", "false", "no"]) {
			const rules = applyRuntimeShellOptOut(DEFAULT_BASH_INTERCEPTOR_RULES, false, {
				AURA_ALLOW_ELIDE_SHELL: value,
			});
			expect(checkBashInterception("elide run app.ts", tools, rules).block).toBe(true);
		}
	});

	it("threads the setting through Settings.getBashInterceptorRules", () => {
		expect(Settings.isolated().getBashInterceptorRules()).toEqual(DEFAULT_BASH_INTERCEPTOR_RULES);
		const allowed = Settings.isolated({ "runtime.allowShell": true }).getBashInterceptorRules();
		expect(allowed.some(rule => rule.kind === RUNTIME_SHELL_RULE_KIND)).toBe(false);
		expect(checkBashInterception("elide run app.ts", tools, allowed).block).toBe(false);
	});

	it("leaves the non-runtime rules in force under the opt-out", () => {
		const rules = applyRuntimeShellOptOut(DEFAULT_BASH_INTERCEPTOR_RULES, true, {});
		expect(rules.length).toBe(DEFAULT_BASH_INTERCEPTOR_RULES.length - RUNTIME_SHELL_INTERCEPTOR_RULES.length);
		expect(rules.some(rule => rule.kind === RUNTIME_SHELL_RULE_KIND)).toBe(false);
		expect(checkBashInterception("cat notes.txt", tools, rules).block).toBe(true);
	});
});

describe("BashTool argument validation", () => {
	it("preserves async requests so disabled async mode returns the explicit error", async () => {
		const tool = createBashTool([]);
		const args = validateToolArguments(tool, {
			type: "toolCall",
			id: "tool-call",
			name: tool.name,
			arguments: { command: "echo should-not-run", async: true },
		});

		await expect(tool.execute("tool-call", args as unknown as BashToolInput)).rejects.toThrow(
			"Async bash execution is disabled",
		);
	});
});
