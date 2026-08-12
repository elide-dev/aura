import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TAB_GROUPS } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { resolveRuntimeEndpointOptions } from "../src/runtime";
import { readRuntimeSettingsValues } from "../src/sdk";
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

	test("AURA_RUNTIME_AUTO_DOWNLOAD from a container environment reaches the resolved endpoint", async () => {
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		// An ambient export in the developer's shell must not decide this test;
		// restoreSettingsTestState puts the original environment back afterwards.
		delete process.env.AURA_RUNTIME_AUTO_DOWNLOAD;

		expect(readRuntimeSettingsValues(settings).autoDownload).toBe(true);

		// The benchmark runner forwards this into the agent container so a campaign
		// can never fetch the runtime it is measuring.
		process.env.AURA_RUNTIME_AUTO_DOWNLOAD = "false";

		expect(readRuntimeSettingsValues(settings).autoDownload).toBe(false);
		expect(resolveRuntimeEndpointOptions(readRuntimeSettingsValues(settings))?.autoDownload).toBe(false);
	});

	test("the Runtime group is registered for the tools tab", () => {
		expect(TAB_GROUPS.tools).toContain("Runtime");
	});
});
