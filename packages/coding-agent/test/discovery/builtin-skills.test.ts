/**
 * The bundled `builtin-skills` provider ships the runtime skill set embedded in
 * the binary. Because every downstream consumer of a skill (the `skill://`
 * protocol, `/skill:<name>` invocation, autoload) reads the skill body back off
 * disk from `Skill.filePath`, the provider materializes its embedded sources
 * into an agent-owned directory before scanning it — these tests defend that
 * round-trip, the drift repair, the stale-entry prune, and the priority
 * ordering that lets an authored skill of the same name win.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { BUILTIN_SKILLS_PROVIDER_ID, type Skill, skillCapability } from "@oh-my-pi/pi-coding-agent/capability/skill";
import type { LoadContext, LoadResult } from "@oh-my-pi/pi-coding-agent/capability/types";
// Importing discovery registers all providers as a side effect.
import "@oh-my-pi/pi-coding-agent/discovery";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	BUILTIN_SKILL_SOURCES,
	getBuiltinSkillsDir,
	materializeBuiltinSkills,
} from "@oh-my-pi/pi-coding-agent/discovery/builtin-skills";
import { loadSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

/** The five runtime skills this fork ships. */
const EXPECTED_SKILL_NAMES = ["insights", "jvm", "profiling", "runtime", "stateful-debugger"];

let tempDir: string;
let agentDir: string;

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

function skillProvider() {
	const cap = getCapability(skillCapability.id);
	if (!cap) throw new Error("skills capability missing");
	const provider = cap.providers.find(p => p.id === BUILTIN_SKILLS_PROVIDER_ID);
	if (!provider) throw new Error("builtin-skills provider missing");
	return { cap, provider };
}

async function loadBuiltinSkills(): Promise<LoadResult<Skill>> {
	const { provider } = skillProvider();
	const ctx: LoadContext = { cwd: tempDir, home: tempDir, repoRoot: null };
	return await (provider.load as (ctx: LoadContext) => Promise<LoadResult<Skill>>)(ctx);
}

beforeEach(() => {
	clearCache();
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-builtin-skills-"));
	agentDir = path.join(tempDir, ".aura", "agent");
	setAgentDir(agentDir);
});

afterEach(() => {
	clearCache();
	setAgentDir(originalAgentDirEnv || fallbackAgentDir);
	removeSyncWithRetries(tempDir);
});

describe("builtin-skills provider", () => {
	it("ships exactly the five runtime skills, each with a name and description", async () => {
		const { items, warnings } = await loadBuiltinSkills();
		expect(warnings ?? []).toEqual([]);
		expect(items.map(s => s.name).sort()).toEqual(EXPECTED_SKILL_NAMES);
		for (const skill of items) {
			expect(skill._source.provider, skill.name).toBe(BUILTIN_SKILLS_PROVIDER_ID);
			expect(skill.frontmatter?.name, skill.name).toBe(skill.name);
			expect((skill.frontmatter?.description ?? "").length, skill.name).toBeGreaterThan(20);
			expect(skill.content.length, skill.name).toBeGreaterThan(200);
		}
	});

	it("materializes each skill to <agentDir>/builtin-skills/<name>/SKILL.md so filePath reads back", async () => {
		const { items } = await loadBuiltinSkills();
		const dir = getBuiltinSkillsDir(agentDir);
		for (const skill of items) {
			expect(skill.path).toBe(path.join(dir, skill.name, "SKILL.md"));
			// Downstream consumers (skill://, /skill:<name>) re-read the file itself.
			const onDisk = fs.readFileSync(skill.path, "utf8");
			const source = BUILTIN_SKILL_SOURCES.find(s => s.name === skill.name);
			expect(source, skill.name).toBeDefined();
			expect(onDisk).toBe(source?.content ?? "");
		}
	});

	it("repairs a materialized skill that drifted from the embedded source", async () => {
		await loadBuiltinSkills();
		const target = path.join(getBuiltinSkillsDir(agentDir), "runtime", "SKILL.md");
		fs.writeFileSync(target, "---\nname: runtime\ndescription: tampered\n---\n\ngone\n");

		const { items } = await loadBuiltinSkills();
		const runtime = items.find(s => s.name === "runtime");
		expect(runtime?.frontmatter?.description).not.toBe("tampered");
		expect(fs.readFileSync(target, "utf8")).toBe(
			BUILTIN_SKILL_SOURCES.find(s => s.name === "runtime")?.content ?? "",
		);
	});

	it("prunes only skills the manifest claims — a retired one goes, a user-authored one stays", async () => {
		await loadBuiltinSkills();
		const dir = getBuiltinSkillsDir(agentDir);
		const manifestPath = path.join(dir, ".bundled.json");

		// Stand in for a previous release that also shipped "retired-skill": the
		// manifest claims it, so it is ours to reclaim.
		const retired = path.join(dir, "retired-skill");
		fs.mkdirSync(retired, { recursive: true });
		fs.writeFileSync(path.join(retired, "SKILL.md"), "---\nname: retired-skill\ndescription: old\n---\n\nold\n");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { names: string[] };
		expect(manifest.names.sort()).toEqual(EXPECTED_SKILL_NAMES);
		fs.writeFileSync(manifestPath, JSON.stringify({ names: [...manifest.names, "retired-skill"] }));

		// Shape-identical to a bundled skill, but the manifest never claimed it:
		// this is a user-authored skill parked in the same root and MUST survive.
		const userOwned = path.join(dir, "hand-written");
		fs.mkdirSync(userOwned, { recursive: true });
		fs.writeFileSync(path.join(userOwned, "SKILL.md"), "---\nname: hand-written\ndescription: mine\n---\n\nmine\n");

		const { items, warnings } = await loadBuiltinSkills();
		expect(fs.existsSync(retired)).toBe(false);
		expect(fs.existsSync(path.join(userOwned, "SKILL.md"))).toBe(true);
		expect(items.map(s => s.name)).toContain("hand-written");
		expect(items.map(s => s.name)).not.toContain("retired-skill");
		// Deletions are reported, never silent.
		expect((warnings ?? []).join("\n")).toInclude('Pruned retired bundled skill "retired-skill"');
		// The manifest no longer claims the retired name.
		expect((JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { names: string[] }).names).not.toContain(
			"retired-skill",
		);
	});

	it("keeps a retired skill the user has since added files to, and says so", async () => {
		await loadBuiltinSkills();
		const dir = getBuiltinSkillsDir(agentDir);
		const manifestPath = path.join(dir, ".bundled.json");

		const retired = path.join(dir, "retired-skill");
		fs.mkdirSync(retired, { recursive: true });
		fs.writeFileSync(path.join(retired, "SKILL.md"), "---\nname: retired-skill\ndescription: old\n---\n\nold\n");
		fs.writeFileSync(path.join(retired, "notes.md"), "keep me");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { names: string[] };
		fs.writeFileSync(manifestPath, JSON.stringify({ names: [...manifest.names, "retired-skill"] }));

		const { warnings } = await loadBuiltinSkills();
		expect(fs.existsSync(path.join(retired, "notes.md"))).toBe(true);
		expect((warnings ?? []).join("\n")).toInclude('Kept retired bundled skill "retired-skill"');
	});

	it("survives two materializations racing: no truncated SKILL.md is ever left behind", async () => {
		const dir = getBuiltinSkillsDir(agentDir);
		// Both passes rewrite every file (nothing on disk yet), so they contend on
		// the same targets. A shared staging name would let one rename a partial
		// write into place under the other.
		const [first, second] = await Promise.all([materializeBuiltinSkills(dir), materializeBuiltinSkills(dir)]);
		// A shared staging name shows up here first: one pass deletes the other's
		// staging file, and the losing rename fails with ENOENT.
		expect([...first, ...second]).toEqual([]);

		for (const source of BUILTIN_SKILL_SOURCES) {
			expect(fs.readFileSync(path.join(dir, source.name, "SKILL.md"), "utf8"), source.name).toBe(source.content);
			// No staging files survive a successful pass.
			expect(fs.readdirSync(path.join(dir, source.name)), source.name).toEqual(["SKILL.md"]);
		}
	});

	it("is the lowest-priority skill provider so any authored skill of the same name wins", () => {
		const { cap, provider } = skillProvider();
		const others = cap.providers.filter(p => p.id !== BUILTIN_SKILLS_PROVIDER_ID);
		expect(others.length).toBeGreaterThan(0);
		expect(others.every(p => p.priority > provider.priority)).toBe(true);
	});
});

describe("settings suppression", () => {
	afterEach(() => {
		resetSettingsForTest();
	});

	it("offers nothing and reclaims the tree when runtime.enabled is off", async () => {
		// Materialize first with settings uninitialized (the enabled default), then
		// turn the runtime off and reload: the whole thing must go.
		await loadBuiltinSkills();
		const dir = getBuiltinSkillsDir(agentDir);
		expect(fs.existsSync(path.join(dir, "runtime", "SKILL.md"))).toBe(true);

		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "runtime.enabled": false } });

		const { items } = await loadBuiltinSkills();
		expect(items).toEqual([]);
		expect(fs.existsSync(dir)).toBe(false);
	});

	it("offers nothing when skills.enableBundled is off", async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "skills.enableBundled": false } });

		const { items } = await loadBuiltinSkills();
		expect(items).toEqual([]);
		expect(fs.existsSync(getBuiltinSkillsDir(agentDir))).toBe(false);
	});

	it("leaves a user-authored skill (and the directory) alone when suppressed", async () => {
		await loadBuiltinSkills();
		const dir = getBuiltinSkillsDir(agentDir);
		const userOwned = path.join(dir, "hand-written");
		fs.mkdirSync(userOwned, { recursive: true });
		fs.writeFileSync(path.join(userOwned, "SKILL.md"), "---\nname: hand-written\ndescription: mine\n---\n\nmine\n");

		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "runtime.enabled": false } });
		await loadBuiltinSkills();

		expect(fs.existsSync(path.join(userOwned, "SKILL.md"))).toBe(true);
		expect(fs.existsSync(path.join(dir, "runtime"))).toBe(false);
	});

	it("still materializes when the runtime is on and the toggle is left at its default", async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });

		const { items } = await loadBuiltinSkills();
		expect(items.map(s => s.name).sort()).toEqual(EXPECTED_SKILL_NAMES);
	});
});

describe("bundled runtime skills through loadSkills", () => {
	it("surfaces every bundled skill by default, attributed to the bundled provider", async () => {
		const { skills } = await loadSkills({ cwd: tempDir });
		const bundled = skills.filter(skill => skill.source === `${BUILTIN_SKILLS_PROVIDER_ID}:user`);
		expect(bundled.map(skill => skill.name).sort()).toEqual(EXPECTED_SKILL_NAMES);
		for (const skill of bundled) {
			expect(skill.description.length, skill.name).toBeGreaterThan(20);
			expect(skill.hide ?? false, skill.name).toBe(false);
		}
	});

	it("drops them when skills.enableBundled is off", async () => {
		const { skills } = await loadSkills({ cwd: tempDir, enableBundled: false });
		expect(skills.some(skill => skill.source === `${BUILTIN_SKILLS_PROVIDER_ID}:user`)).toBe(false);
	});

	it("drops one named in ignoredSkills", async () => {
		const { skills } = await loadSkills({ cwd: tempDir, ignoredSkills: ["profiling"] });
		const bundled = skills.filter(skill => skill.source === `${BUILTIN_SKILLS_PROVIDER_ID}:user`);
		expect(bundled.map(skill => skill.name)).not.toContain("profiling");
		expect(bundled.map(skill => skill.name)).toContain("runtime");
	});
});

describe("bundled runtime skill content", () => {
	const byName = new Map(BUILTIN_SKILL_SOURCES.map(source => [source.name, source.content]));

	it("never names the vendor runtime — the noun is 'the runtime'", () => {
		for (const [name, content] of byName) {
			expect(content.toLowerCase(), name).not.toInclude("elide");
		}
	});

	it("teaches the innate tool names", () => {
		expect(byName.get("runtime")).toInclude("`run`");
		expect(byName.get("runtime")).toInclude("`check`");
		expect(byName.get("runtime")).toInclude("`build`");
		expect(byName.get("insights")).toInclude("`insights`");
		expect(byName.get("profiling")).toInclude("`profile`");
		expect(byName.get("jvm")).toInclude("`jvm_run`");
		expect(byName.get("stateful-debugger")).toInclude("`runtime_debug`");
	});

	it("keeps the hub-owned lifecycle for runtime_debug and serve (no separate stop tool)", () => {
		const debugger_ = byName.get("stateful-debugger") ?? "";
		expect(debugger_).toInclude("hub");
		expect(debugger_).toInclude("no separate stop tool");
		expect(debugger_.toLowerCase()).not.toInclude("stop_runtime_process");
	});
});
