/**
 * Legacy `.omp` project base coherence.
 *
 * The fork renamed the project config dir to `<CONFIG_DIR_NAME>` (`.aura`).
 * Projects that predate the rename keep a `.omp/` directory, so `.omp` is a
 * READ-ONLY legacy base sitting directly below the branded dir in priority:
 * every file surface (`rules/`, `commands/`, `prompts/`, `agents/`, `AGENTS.md`,
 * `RULES.md`, `SYSTEM.md`) still loads from it, the branded dir wins on
 * conflicts, and nothing is ever written there.
 *
 * The one deliberate exception: settings DOCUMENTS (`config.yml`,
 * `settings.json`) are NOT loaded wholesale from the legacy base. A pre-rebrand
 * `.omp/config.yml` was inert for everything but its `modelRoles` slice, so
 * loading it wholesale would newly activate sections like `tools:` (approval
 * policy). Settings compat stays limited to the audited narrow slices
 * (`Settings#loadProjectConfigYaml` → `modelRoles`, `omp-extension-roots` →
 * `extensions`).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ContextFile, contextFileCapability } from "@oh-my-pi/pi-coding-agent/capability/context-file";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { type Hook, hookCapability } from "@oh-my-pi/pi-coding-agent/capability/hook";
import { type MCPServer, mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { type Prompt, promptCapability } from "@oh-my-pi/pi-coding-agent/capability/prompt";
import { type Rule, ruleCapability } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { type Settings, settingsCapability } from "@oh-my-pi/pi-coding-agent/capability/settings";
import { type Skill, skillCapability } from "@oh-my-pi/pi-coding-agent/capability/skill";
import { type SlashCommand, slashCommandCapability } from "@oh-my-pi/pi-coding-agent/capability/slash-command";
import { type SystemPrompt, systemPromptCapability } from "@oh-my-pi/pi-coding-agent/capability/system-prompt";
import { type CustomTool, toolCapability } from "@oh-my-pi/pi-coding-agent/capability/tool";
import { getConfigDirs } from "@oh-my-pi/pi-coding-agent/config";
// Importing discovery registers all providers as a side effect.
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import {
	CONFIG_DIR_NAME,
	getConfigRootDir,
	LEGACY_CONFIG_DIR_NAME,
	removeSyncWithRetries,
	setAgentDir,
} from "@oh-my-pi/pi-utils";

let tempDir: string;
let home: string;
let project: string;

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

function writeFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

/** `<project>/<base>/<...rest>` */
function projectFile(base: string, ...rest: string[]): string {
	return path.join(project, base, ...rest);
}

async function load<T>(id: string): Promise<T[]> {
	const result = await loadCapability<T>(id, { cwd: project, providers: ["native"] });
	return result.items;
}

beforeEach(() => {
	clearCache();
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-legacy-base-"));
	home = path.join(tempDir, "home");
	project = path.join(tempDir, "project");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(path.join(project, ".git"), { recursive: true });
	setAgentDir(path.join(home, CONFIG_DIR_NAME, "agent"));
});

afterEach(() => {
	clearCache();
	if (originalAgentDirEnv) {
		setAgentDir(originalAgentDirEnv);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	removeSyncWithRetries(tempDir);
});

test("legacy `.omp` is a project-only, non-writable base ranked directly below the branded dir", () => {
	const projectDirs = getConfigDirs("agents", { user: false, cwd: project });
	expect(projectDirs.map(entry => entry.source)).toEqual([
		CONFIG_DIR_NAME,
		LEGACY_CONFIG_DIR_NAME,
		".claude",
		".codex",
		".gemini",
	]);
	expect(projectDirs.find(entry => entry.source === CONFIG_DIR_NAME)?.writable).toBe(true);
	expect(projectDirs.find(entry => entry.source === LEGACY_CONFIG_DIR_NAME)?.writable).toBe(false);

	// The legacy base is project-local only. Pre-rebrand *user* state under
	// `~/.omp/agent` is NOT on any read path (see config.ts); `PI_CONFIG_DIR=.omp`
	// is the workaround until a `config migrate` step exists.
	const userDirs = getConfigDirs("agents", { project: false });
	expect(userDirs.some(entry => entry.source === LEGACY_CONFIG_DIR_NAME)).toBe(false);
	expect(userDirs.every(entry => entry.writable)).toBe(true);
});

test("legacy `.omp/rules/` loads and the branded dir wins on the same rule name", async () => {
	writeFile(projectFile(LEGACY_CONFIG_DIR_NAME, "rules", "legacy-only.md"), "legacy only rule\n");
	writeFile(projectFile(LEGACY_CONFIG_DIR_NAME, "rules", "shared.md"), "legacy shared rule\n");
	writeFile(projectFile(CONFIG_DIR_NAME, "rules", "shared.md"), "branded shared rule\n");

	const rules = await load<Rule>(ruleCapability.id);
	expect(rules.find(rule => rule.name === "legacy-only")?.content).toContain("legacy only rule");
	expect(rules.find(rule => rule.name === "shared")?.content).toContain("branded shared rule");
});

test("legacy `.omp/commands/` and `.omp/prompts/` load, branded wins on conflicts", async () => {
	writeFile(projectFile(LEGACY_CONFIG_DIR_NAME, "commands", "legacy-cmd.md"), "legacy command body\n");
	writeFile(projectFile(LEGACY_CONFIG_DIR_NAME, "commands", "shared.md"), "legacy shared command\n");
	writeFile(projectFile(CONFIG_DIR_NAME, "commands", "shared.md"), "branded shared command\n");
	writeFile(projectFile(LEGACY_CONFIG_DIR_NAME, "prompts", "legacy-prompt.md"), "legacy prompt body\n");

	const commands = await load<SlashCommand>(slashCommandCapability.id);
	expect(commands.find(cmd => cmd.name === "legacy-cmd")?.content).toContain("legacy command body");
	expect(commands.find(cmd => cmd.name === "shared")?.content).toContain("branded shared command");

	const prompts = await load<Prompt>(promptCapability.id);
	expect(prompts.find(p => p.name === "legacy-prompt")?.content).toContain("legacy prompt body");
});

test("legacy `.omp/AGENTS.md` and `.omp/RULES.md` load; branded files win", async () => {
	writeFile(projectFile(LEGACY_CONFIG_DIR_NAME, "AGENTS.md"), "legacy project context\n");
	writeFile(projectFile(LEGACY_CONFIG_DIR_NAME, "RULES.md"), "legacy sticky rule\n");

	const contextFiles = await load<ContextFile>(contextFileCapability.id);
	expect(contextFiles.find(file => file.content.includes("legacy project context"))).toBeDefined();

	const rules = await load<Rule>(ruleCapability.id);
	const stickyRule = rules.find(rule => rule.name === "RULES@project");
	expect(stickyRule?.content).toContain("legacy sticky rule");
	expect(stickyRule?.alwaysApply).toBe(true);

	// Branded file present → it wins, and the legacy content disappears entirely.
	writeFile(projectFile(CONFIG_DIR_NAME, "AGENTS.md"), "branded project context\n");
	writeFile(projectFile(CONFIG_DIR_NAME, "RULES.md"), "branded sticky rule\n");
	clearCache();

	const contextFiles2 = await load<ContextFile>(contextFileCapability.id);
	const projectContext = contextFiles2.filter(file => file._source.level === "project");
	expect(projectContext).toHaveLength(1);
	expect(projectContext[0].content).toContain("branded project context");

	const rules2 = await load<Rule>(ruleCapability.id);
	const sticky2 = rules2.filter(rule => rule.name === "RULES@project");
	expect(sticky2).toHaveLength(1);
	expect(sticky2[0].content).toContain("branded sticky rule");
});

test("a non-empty branded dir does not mask a legacy single-file surface it lacks", async () => {
	// Incremental adoption: the project has started using `.aura/` for one surface
	// but its AGENTS.md / RULES.md / SYSTEM.md still live in `.omp/`. The probe is
	// per FILE, so unrelated branded content cannot hide them.
	writeFile(projectFile(CONFIG_DIR_NAME, "rules", "branded-only.md"), "branded rule\n");
	writeFile(projectFile(LEGACY_CONFIG_DIR_NAME, "AGENTS.md"), "legacy project context\n");
	writeFile(projectFile(LEGACY_CONFIG_DIR_NAME, "RULES.md"), "legacy sticky rule\n");
	writeFile(projectFile(LEGACY_CONFIG_DIR_NAME, "SYSTEM.md"), "legacy system prompt\n");

	const contextFiles = await load<ContextFile>(contextFileCapability.id);
	expect(contextFiles.find(file => file.content.includes("legacy project context"))).toBeDefined();

	const rules = await load<Rule>(ruleCapability.id);
	expect(rules.find(rule => rule.name === "RULES@project")?.content).toContain("legacy sticky rule");

	const systemPrompts = await load<SystemPrompt>(systemPromptCapability.id);
	expect(systemPrompts.find(item => item.content.includes("legacy system prompt"))).toBeDefined();

	// A branded file at the same ancestor still wins over the legacy one.
	writeFile(projectFile(CONFIG_DIR_NAME, "SYSTEM.md"), "branded system prompt\n");
	clearCache();
	const systemPrompts2 = await load<SystemPrompt>(systemPromptCapability.id);
	const projectPrompts = systemPrompts2.filter(item => item._source.level === "project");
	expect(projectPrompts).toHaveLength(1);
	expect(projectPrompts[0].content).toContain("branded system prompt");
});

test("a closer legacy-only config dir does not suppress a further-up branded file", async () => {
	// Only the BRANDED dir terminates the ancestor walk. A stale subpackage `.omp/`
	// (here holding just a rule) must stay additive — it cannot hide the repo's
	// `.aura/AGENTS.md`, which would invert the legacy base's read-only role.
	const sub = path.join(project, "packages", "sub");
	fs.mkdirSync(sub, { recursive: true });
	writeFile(path.join(sub, LEGACY_CONFIG_DIR_NAME, "rules", "sub-rule.md"), "sub legacy rule\n");
	writeFile(projectFile(CONFIG_DIR_NAME, "AGENTS.md"), "branded root context\n");

	const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: sub, providers: ["native"] });
	const projectContext = result.items.filter(file => file._source.level === "project");
	expect(projectContext).toHaveLength(1);
	expect(projectContext[0].path).toBe(projectFile(CONFIG_DIR_NAME, "AGENTS.md"));
});

test("a closer branded-only config dir masks a further-up legacy file (upstream terminator)", async () => {
	// Upstream's rule, unchanged by the fork: the nearest ancestor owning a
	// non-empty branded config dir ends the walk even when it lacks the file.
	const sub = path.join(project, "packages", "sub");
	fs.mkdirSync(sub, { recursive: true });
	writeFile(path.join(sub, CONFIG_DIR_NAME, "rules", "sub-rule.md"), "sub branded rule\n");
	writeFile(projectFile(LEGACY_CONFIG_DIR_NAME, "AGENTS.md"), "legacy root context\n");

	const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: sub, providers: ["native"] });
	expect(result.items.filter(file => file._source.level === "project")).toHaveLength(0);
});

test("legacy `.omp` executable surfaces load too — hooks and custom tools", async () => {
	// Deliberate and documented: the legacy base carries the same trust as the
	// branded dir (and as `.claude`/`.codex`/`.gemini`), so `hooks/`, `tools/`,
	// `extensions/` and TS-backed commands run from it. Pinned so the decision
	// cannot be reversed by accident.
	writeFile(projectFile(LEGACY_CONFIG_DIR_NAME, "hooks", "pre", "bash.sh"), "#!/bin/sh\nexit 0\n");
	writeFile(
		projectFile(LEGACY_CONFIG_DIR_NAME, "tools", "legacy-tool.ts"),
		"export default { name: 'legacy_tool', description: 'legacy tool', parameters: {}, execute: async () => 'ok' };\n",
	);

	const hooks = await load<Hook>(hookCapability.id);
	const legacyHook = hooks.find(hook => hook.path === projectFile(LEGACY_CONFIG_DIR_NAME, "hooks", "pre", "bash.sh"));
	expect(legacyHook).toBeDefined();
	expect(legacyHook?.type).toBe("pre");
	expect(legacyHook?.tool).toBe("bash");

	const tools = await load<CustomTool>(toolCapability.id);
	expect(tools.some(tool => tool.path === projectFile(LEGACY_CONFIG_DIR_NAME, "tools", "legacy-tool.ts"))).toBe(true);
});

test("legacy `.omp/agents/` is discovered; branded `.aura/agents/` wins on the same agent name", async () => {
	const agentBody = (name: string, marker: string) =>
		`---\nname: ${name}\ndescription: ${marker} agent\n---\n\n${marker} body\n`;
	writeFile(projectFile(LEGACY_CONFIG_DIR_NAME, "agents", "legacy-only.md"), agentBody("legacy-only", "legacy"));
	writeFile(projectFile(LEGACY_CONFIG_DIR_NAME, "agents", "shared.md"), agentBody("shared", "legacy"));

	const legacyResult = await discoverAgents(project, home);
	expect(legacyResult.agents.find(agent => agent.name === "legacy-only")?.systemPrompt).toContain("legacy body");

	writeFile(projectFile(CONFIG_DIR_NAME, "agents", "shared.md"), agentBody("shared", "branded"));
	clearCache();

	const brandedResult = await discoverAgents(project, home);
	expect(brandedResult.agents.find(agent => agent.name === "shared")?.systemPrompt).toContain("branded body");
});

test("legacy `.omp/skills/` and `.omp/.mcp.json` load; branded entries win", async () => {
	writeFile(
		projectFile(LEGACY_CONFIG_DIR_NAME, "skills", "legacy-skill", "SKILL.md"),
		"---\nname: legacy-skill\ndescription: legacy skill for compat\n---\n\nlegacy skill body\n",
	);
	writeFile(
		projectFile(LEGACY_CONFIG_DIR_NAME, ".mcp.json"),
		JSON.stringify({ mcpServers: { "legacy-server": { command: "legacy-cmd" } } }),
	);

	const skills = await load<Skill>(skillCapability.id);
	expect(skills.find(skill => skill.name === "legacy-skill")).toBeDefined();

	const servers = await load<MCPServer>(mcpCapability.id);
	expect(servers.find(server => server.name === "legacy-server")?.command).toBe("legacy-cmd");

	// Branded entries take precedence for the same name.
	writeFile(
		projectFile(CONFIG_DIR_NAME, ".mcp.json"),
		JSON.stringify({ mcpServers: { "legacy-server": { command: "branded-cmd" } } }),
	);
	clearCache();
	const servers2 = await load<MCPServer>(mcpCapability.id);
	expect(servers2.find(server => server.name === "legacy-server")?.command).toBe("branded-cmd");
});

test("a legacy `.omp` settings document NEVER becomes live settings", async () => {
	// Both documents carry a `tools:` block. Pre-rebrand these were inert for
	// everything but `modelRoles`, and they must stay inert: an approval policy
	// must not activate just because the legacy dir is now on the read path.
	writeFile(
		projectFile(LEGACY_CONFIG_DIR_NAME, "config.yml"),
		"tools:\n  approvalMode: yolo\nmodelRoles:\n  main: legacy-model\n",
	);
	writeFile(projectFile(LEGACY_CONFIG_DIR_NAME, "settings.json"), JSON.stringify({ tools: { approvalMode: "yolo" } }));

	const items = await load<Settings>(settingsCapability.id);
	expect(items.map(item => item.path)).not.toContain(projectFile(LEGACY_CONFIG_DIR_NAME, "config.yml"));
	expect(items.map(item => item.path)).not.toContain(projectFile(LEGACY_CONFIG_DIR_NAME, "settings.json"));
	for (const item of items) {
		expect((item.data as { tools?: unknown }).tools).toBeUndefined();
	}

	// The branded documents are still loaded wholesale.
	writeFile(projectFile(CONFIG_DIR_NAME, "config.yml"), "tools:\n  approvalMode: yolo\n");
	clearCache();
	const items2 = await load<Settings>(settingsCapability.id);
	const branded = items2.find(item => item.path === projectFile(CONFIG_DIR_NAME, "config.yml"));
	expect(branded).toBeDefined();
	const brandedData = branded?.data as { tools?: { approvalMode?: string } };
	expect(brandedData.tools?.approvalMode).toBe("yolo");
});
