import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

describe("runtime settings", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-runtime-settings-test-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	afterEach(async () => {
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await tempDir?.remove();
	});

	test("defaults: enabled + autoDownload on, no explicit path", async () => {
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		expect(settings.get("runtime.enabled")).toBe(true);
		expect(settings.get("runtime.autoDownload")).toBe(true);
		expect(settings.get("runtime.path")).toBe("");
	});
});
