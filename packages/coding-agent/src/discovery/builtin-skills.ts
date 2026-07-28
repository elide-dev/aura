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
 * Because that directory is also somewhere a user can drop a skill of their
 * own, the provider records what it wrote in a `.bundled.json` manifest and
 * deletes only names that manifest claims. Nothing else in there is ever a
 * deletion candidate.
 *
 * Registered at the lowest skill priority so an authored skill of the same name
 * from any other provider wins the capability dedup. Users disable the set with
 * `skills.enableBundled` (or the whole runtime surface with `runtime.enabled`),
 * and a single skill via `skills.ignoredSkills` / a `skill:<name>` entry in
 * `disabledExtensions`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent, logger } from "@oh-my-pi/pi-utils";
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

/**
 * Record of exactly which skill directories THIS provider materialized. It is
 * the sole authority for what may be deleted: a directory the manifest never
 * named was authored by someone else and is never touched. Dot-prefixed so
 * `scanSkillsFromDir` (which only descends into non-dotted directories) cannot
 * mistake it for a skill.
 */
const MANIFEST_FILE = ".bundled.json";

interface BundledManifest {
	/** Skill directory names this provider wrote, as of the last successful pass. */
	names: string[];
}

async function readIfPresent(filePath: string): Promise<string | undefined> {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

/** Names this provider previously materialized; empty when there is no readable manifest. */
async function readManifest(dir: string): Promise<string[]> {
	const raw = await readIfPresent(path.join(dir, MANIFEST_FILE));
	if (raw === undefined) return [];
	try {
		const parsed = JSON.parse(raw) as BundledManifest;
		return Array.isArray(parsed.names) ? parsed.names.filter(name => typeof name === "string") : [];
	} catch {
		// A corrupt manifest means "we no longer know what we own" — the safe
		// reading is that we own nothing, so nothing gets pruned this pass.
		return [];
	}
}

/**
 * Unique staging name. `pid` alone collides between two discovery passes racing
 * inside ONE process (parallel providers, concurrent subagent sessions), which
 * would let one pass rename a half-written file into place under the other.
 * Matches the entropy the fork already uses in `runtime/provision.ts` and
 * `utils/markit-cache.ts`.
 */
function stagingPath(target: string): string {
	return `${target}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
}

/**
 * Write one bundled skill if the on-disk copy is missing or has drifted.
 * Written to a unique temp sibling and renamed, so a concurrent reader never
 * scans a half-written `SKILL.md` and two concurrent writers cannot interleave.
 */
async function writeSkillSource(dir: string, source: BuiltinSkillSource, warnings: string[]): Promise<void> {
	const skillDir = path.join(dir, source.name);
	const target = path.join(skillDir, "SKILL.md");
	try {
		if ((await readIfPresent(target)) === source.content) return;
		await fs.mkdir(skillDir, { recursive: true });
		const staging = stagingPath(target);
		try {
			await fs.writeFile(staging, source.content, "utf8");
			await fs.rename(staging, target);
		} finally {
			// A failed rename would otherwise leave the staging file behind. It is
			// invisible to the scanner (only `<name>/SKILL.md` is read), but it would
			// accumulate and it would defeat the lone-`SKILL.md` shape check below.
			await fs.rm(staging, { force: true }).catch(() => {});
		}
	} catch (error) {
		warnings.push(`Failed to materialize bundled skill "${source.name}" at ${target} (${String(error)})`);
	}
}

/**
 * Reclaim directories for bundled skills an EARLIER version shipped and this one
 * no longer does — otherwise a retired skill surfaces forever.
 *
 * Deletion is gated on the manifest, not on shape: `retired` is exactly
 * `previous manifest − current source set`. This directory is also a place a
 * user can legitimately drop a skill of their own (the provider scans whatever
 * it finds), and a bare user-authored `SKILL.md` is shape-identical to one we
 * wrote — so a name the manifest never claimed must never be a deletion
 * candidate. Every prune is reported as a warning rather than done silently,
 * and a retired directory the user has since added files to is kept.
 */
async function pruneRetiredSkills(dir: string, retired: readonly string[], warnings: string[]): Promise<void> {
	await Promise.all(
		retired.map(async name => {
			const target = path.join(dir, name);
			try {
				const children = await fs.readdir(target).catch(error => {
					if (isEnoent(error)) return undefined;
					throw error;
				});
				if (children === undefined) return;
				if (children.length !== 1 || children[0] !== "SKILL.md") {
					warnings.push(
						`Kept retired bundled skill "${name}" at ${target}: it holds files this provider did not write`,
					);
					return;
				}
				await fs.rm(target, { recursive: true, force: true });
				warnings.push(`Pruned retired bundled skill "${name}" from ${target}`);
			} catch (error) {
				warnings.push(`Failed to prune retired bundled skill at ${target} (${String(error)})`);
			}
		}),
	);
}

async function writeManifest(dir: string, names: readonly string[], warnings: string[]): Promise<void> {
	const target = path.join(dir, MANIFEST_FILE);
	const body = `${JSON.stringify({ names: [...names] }, null, 2)}\n`;
	try {
		if ((await readIfPresent(target)) === body) return;
		const staging = stagingPath(target);
		try {
			await fs.writeFile(staging, body, "utf8");
			await fs.rename(staging, target);
		} finally {
			await fs.rm(staging, { force: true }).catch(() => {});
		}
	} catch (error) {
		warnings.push(`Failed to record the bundled skills manifest at ${target} (${String(error)})`);
	}
}

/**
 * Bring `<agentDir>/builtin-skills` in line with the embedded sources.
 * Returns warnings rather than throwing: a read-only or otherwise unwritable
 * agent directory must degrade to "no bundled skills", never fail discovery.
 */
export async function materializeBuiltinSkills(dir: string): Promise<string[]> {
	const warnings: string[] = [];
	const names = BUILTIN_SKILL_SOURCES.map(source => source.name);
	try {
		await fs.mkdir(dir, { recursive: true });
		const previous = await readManifest(dir);
		const current = new Set(names);
		await Promise.all(BUILTIN_SKILL_SOURCES.map(source => writeSkillSource(dir, source, warnings)));
		await pruneRetiredSkills(
			dir,
			previous.filter(name => !current.has(name)),
			warnings,
		);
		await writeManifest(dir, names, warnings);
	} catch (error) {
		warnings.push(`Failed to prepare the bundled skills directory ${dir} (${String(error)})`);
	}
	return warnings;
}

/**
 * Remove what this provider materialized once it is switched off, so a disabled
 * bundled set leaves no tree behind. Manifest-gated like the retirement prune:
 * only names we recorded are removed, and only when they still look like ours.
 * The directory itself goes only if it ends up empty — a user skill parked in
 * there keeps it (and its manifest) alive.
 */
async function unmaterializeBuiltinSkills(dir: string): Promise<void> {
	const previous = await readManifest(dir).catch(() => []);
	if (previous.length === 0) return;
	// The provider returns no items in this branch, so its warnings would go
	// nowhere — log them instead, keeping every deletion accounted for.
	const warnings: string[] = [];
	await pruneRetiredSkills(dir, previous, warnings);
	for (const warning of warnings) logger.debug(`builtin-skills: ${warning}`);
	await fs.rm(path.join(dir, MANIFEST_FILE), { force: true }).catch(() => {});
	await fs.rmdir(dir).catch(() => {});
}

async function loadBuiltinSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	const dir = getBuiltinSkillsDir();
	if (!bundledSkillsEnabled()) {
		await unmaterializeBuiltinSkills(dir);
		return { items: [] };
	}
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
