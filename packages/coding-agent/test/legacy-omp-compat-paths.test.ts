/**
 * Remaining pre-rebrand `.omp` path compatibility outside the config-dir list.
 *
 * Three surfaces build their paths by hand rather than going through
 * `config.ts`'s base list: project secrets, `agents unpack --project`, and the
 * advisor/watchdog config search path. Each must treat `<CONFIG_DIR_NAME>` as
 * canonical, keep reading a pre-rebrand `.omp` sibling where that is real user
 * data, and never write to the legacy dir.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectConfigCandidates } from "@oh-my-pi/pi-coding-agent/advisor/watchdog";
import { runAgentsCommand } from "@oh-my-pi/pi-coding-agent/cli/agents-cli";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadSecrets } from "@oh-my-pi/pi-coding-agent/secrets";
import {
	CONFIG_DIR_NAME,
	getProjectDir,
	LEGACY_CONFIG_DIR_NAME,
	removeSyncWithRetries,
	setProjectDir,
} from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState } from "./helpers/settings-test-state";

let tempDir: string;
let project: string;
let agentDir: string;

function writeFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-legacy-paths-"));
	project = path.join(tempDir, "project");
	agentDir = path.join(tempDir, "agent");
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
	removeSyncWithRetries(tempDir);
});

test("project secrets read from the branded dir, falling back to a legacy `.omp/secrets.yml`", async () => {
	writeFile(
		path.join(project, LEGACY_CONFIG_DIR_NAME, "secrets.yml"),
		"- type: plain\n  content: legacy-project-secret\n",
	);

	const legacyOnly = await loadSecrets(project, agentDir);
	expect(legacyOnly.map(entry => entry.content)).toEqual(["legacy-project-secret"]);

	// Branded file present → it is the project source and the legacy file is ignored.
	writeFile(path.join(project, CONFIG_DIR_NAME, "secrets.yml"), "- type: plain\n  content: branded-project-secret\n");
	const branded = await loadSecrets(project, agentDir);
	expect(branded.map(entry => entry.content)).toEqual(["branded-project-secret"]);
});

test("`agents unpack --project` writes to the branded agents dir, never the legacy one", async () => {
	const originalProjectDir = getProjectDir();
	const originalWrite = process.stdout.write.bind(process.stdout);
	// A pre-existing legacy dir must not attract the write.
	fs.mkdirSync(path.join(project, LEGACY_CONFIG_DIR_NAME, "agents"), { recursive: true });
	try {
		setProjectDir(project);
		process.stdout.write = (() => true) as typeof process.stdout.write;
		await runAgentsCommand({ action: "unpack", flags: { project: true, json: true } });
	} finally {
		process.stdout.write = originalWrite;
		setProjectDir(originalProjectDir);
	}

	const brandedDir = path.join(project, CONFIG_DIR_NAME, "agents");
	expect(fs.existsSync(brandedDir)).toBe(true);
	expect(fs.readdirSync(brandedDir).some(name => name.endsWith(".md"))).toBe(true);
	expect(fs.readdirSync(path.join(project, LEGACY_CONFIG_DIR_NAME, "agents"))).toEqual([]);
});

test("an invalid legacy `.omp/config.yml` errors without being quarantined — the legacy dir is never written", async () => {
	const settingsState = beginSettingsTest();
	const legacyConfigPath = path.join(project, LEGACY_CONFIG_DIR_NAME, "config.yml");
	const malformed = 'modelRoles:\n  default: "unterminated\n';
	writeFile(legacyConfigPath, malformed);
	try {
		await expect(Settings.init({ cwd: project, agentDir })).rejects.toThrow("Settings config is invalid");
	} finally {
		restoreSettingsTestState(settingsState);
	}

	// The invalid file is reported, not moved aside: no `.broken-` backup, content intact.
	expect(fs.readFileSync(legacyConfigPath, "utf8")).toBe(malformed);
	expect(fs.readdirSync(path.join(project, LEGACY_CONFIG_DIR_NAME))).toEqual(["config.yml"]);
});

test("watchdog config discovery probes the branded project dir alongside the legacy `.omp` dir", async () => {
	writeFile(path.join(project, CONFIG_DIR_NAME, "ADVISOR.md"), "branded advisor config\n");
	writeFile(path.join(project, LEGACY_CONFIG_DIR_NAME, "ADVISOR.md"), "legacy advisor config\n");

	const candidates = await collectConfigCandidates(project, agentDir, ["ADVISOR.md"]);
	const paths = candidates.map(candidate => candidate.path);
	expect(paths).toContain(path.join(project, CONFIG_DIR_NAME, "ADVISOR.md"));
	expect(paths).toContain(path.join(project, LEGACY_CONFIG_DIR_NAME, "ADVISOR.md"));
});
