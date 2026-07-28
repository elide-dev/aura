/**
 * Builtin Skills Provider
 *
 * Ships the runtime skill set (`skill://runtime`, `insights`, `profiling`,
 * `jvm`, `stateful-debugger`) embedded into the binary, so every session
 * discovers them without the user authoring anything.
 *
 * Why this materializes to disk instead of serving embedded text the way the
 * `builtin-defaults` rule provider does: a `Rule` carries its body in memory
 * and `rule://` serves that, but a `Skill` is a *path*. Every consumer —
 * `buildSkillPromptMessage`, the `skill://` protocol and its sub-path reads —
 * re-reads `Skill.filePath` off disk. So the provider writes its embedded
 * sources into an agent-owned directory (`<agentDir>/builtin-skills/<name>/
 * SKILL.md`) and then scans that directory like any other skill root. The
 * embedded text stays the authority: a file that drifts is rewritten on the
 * next load.
 *
 * Registered at the lowest skill priority so an authored skill of the same name
 * from any other provider wins the capability dedup. Users disable the set with
 * `skills.enableBundled` (or the whole runtime surface with `runtime.enabled`),
 * and a single skill via `skills.ignoredSkills` / a `skill:<name>` entry in
 * `disabledExtensions`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";
import { registerProvider } from "../capability";
import { BUILTIN_SKILLS_PROVIDER_ID, type Skill, skillCapability } from "../capability/skill";
import type { LoadContext, LoadResult } from "../capability/types";
import { isSettingsInitialized, settings } from "../config/settings";
import { BUILTIN_SKILL_SOURCES, type BuiltinSkillSource } from "./builtin-skill-sources";
import { scanSkillsFromDir } from "./helpers";

export { BUILTIN_SKILL_SOURCES, type BuiltinSkillSource } from "./builtin-skill-sources";

const DISPLAY_NAME = "Bundled Runtime Skills";
// Lowest skill priority: below the managed auto-learn provider (5) and every
// authored source, so any same-named skill anywhere overrides a bundled one.
const PRIORITY = 3;

/** Where the bundled sources are materialized (`<agentDir>/builtin-skills`). */
export function getBuiltinSkillsDir(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "builtin-skills");
}

/**
 * Whether the bundled set should be materialized and offered at all.
 *
 * Reads the settings singleton directly — discovery providers get no settings
 * in their `LoadContext`, and `claude.ts` establishes the same fallback: assume
 * enabled when settings are not initialized (discovery unit tests run without
 * `Settings.init()`). The bundled skills document the innate runtime tools, so
 * `runtime.enabled = false` (which unregisters those tools) also retires them.
 */
function bundledSkillsEnabled(): boolean {
	if (!isSettingsInitialized()) return true;
	return settings.get("runtime.enabled") !== false && settings.get("skills.enableBundled") !== false;
}

async function readIfPresent(filePath: string): Promise<string | undefined> {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

/**
 * Write one bundled skill if the on-disk copy is missing or has drifted.
 * Written to a temp sibling and renamed so a concurrent session never scans a
 * half-written `SKILL.md`.
 */
async function writeSkillSource(dir: string, source: BuiltinSkillSource, warnings: string[]): Promise<void> {
	const skillDir = path.join(dir, source.name);
	const target = path.join(skillDir, "SKILL.md");
	try {
		if ((await readIfPresent(target)) === source.content) return;
		await fs.mkdir(skillDir, { recursive: true });
		const staging = `${target}.${process.pid}.tmp`;
		await fs.writeFile(staging, source.content, "utf8");
		await fs.rename(staging, target);
	} catch (error) {
		warnings.push(`Failed to materialize bundled skill "${source.name}" at ${target} (${String(error)})`);
	}
}

/**
 * Drop directories left behind by a bundled skill an earlier version shipped —
 * otherwise a retired skill keeps surfacing forever. Confined to entries that
 * look exactly like something this provider wrote (a lone `SKILL.md`), so a
 * directory the user added anything to is never reclaimed.
 */
async function pruneRetiredSkills(dir: string, expected: ReadonlySet<string>, warnings: string[]): Promise<void> {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	await Promise.all(
		entries.map(async entry => {
			if (!entry.isDirectory() || expected.has(entry.name)) return;
			const retired = path.join(dir, entry.name);
			try {
				const children = await fs.readdir(retired);
				if (children.length !== 1 || children[0] !== "SKILL.md") return;
				await fs.rm(retired, { recursive: true, force: true });
			} catch (error) {
				warnings.push(`Failed to prune retired bundled skill at ${retired} (${String(error)})`);
			}
		}),
	);
}

/**
 * Bring `<agentDir>/builtin-skills` in line with the embedded sources.
 * Returns warnings rather than throwing: a read-only or otherwise unwritable
 * agent directory must degrade to "no bundled skills", never fail discovery.
 */
export async function materializeBuiltinSkills(dir: string): Promise<string[]> {
	const warnings: string[] = [];
	try {
		await fs.mkdir(dir, { recursive: true });
		await Promise.all(BUILTIN_SKILL_SOURCES.map(source => writeSkillSource(dir, source, warnings)));
		await pruneRetiredSkills(dir, new Set(BUILTIN_SKILL_SOURCES.map(source => source.name)), warnings);
	} catch (error) {
		warnings.push(`Failed to prepare the bundled skills directory ${dir} (${String(error)})`);
	}
	return warnings;
}

async function loadBuiltinSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	if (!bundledSkillsEnabled()) return { items: [] };
	const dir = getBuiltinSkillsDir();
	const warnings = await materializeBuiltinSkills(dir);
	const scan = await scanSkillsFromDir(ctx, {
		dir,
		providerId: BUILTIN_SKILLS_PROVIDER_ID,
		level: "user",
		requireDescription: true,
	});
	return { items: scan.items, warnings: [...warnings, ...(scan.warnings ?? [])] };
}

registerProvider<Skill>(skillCapability.id, {
	id: BUILTIN_SKILLS_PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Runtime skills shipped with the agent (disable via skills.enableBundled)",
	priority: PRIORITY,
	load: loadBuiltinSkills,
});
