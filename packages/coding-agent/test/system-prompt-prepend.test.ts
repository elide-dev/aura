import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";
import { parseArgs } from "../src/cli/args";
import { flagConsumesValue, STRING_VALUE_FLAGS } from "../src/cli/flag-tables";
import { discoverPrependSystemPromptFile } from "../src/main";
import { buildSystemPrompt } from "../src/system-prompt";

const PREPEND = "PREPENDED-POSTURE-MARKER";

describe("--prepend-system-prompt flag", () => {
	test("the flag parses like its append counterpart", () => {
		expect(parseArgs(["--prepend-system-prompt", "be terse"]).prependSystemPrompt).toBe("be terse");
		expect(parseArgs(["--prepend-system-prompt=be terse"]).prependSystemPrompt).toBe("be terse");
		expect(STRING_VALUE_FLAGS.has("--prepend-system-prompt")).toBe(true);
		// Like --system-prompt / --append-system-prompt, a flag-looking successor is
		// literal prompt text rather than a fresh flag.
		expect(flagConsumesValue("--prepend-system-prompt", "--foo")).toBe(true);
	});
});

describe("prepend composition", () => {
	test("the prepended text is the first block, ahead of the harness prompt", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			resolvedPrependSystemPrompt: PREPEND,
			toolNames: ["read"],
			contextFiles: [],
			skills: [],
			includeWorkspaceTree: false,
		});
		expect(systemPrompt[0]).toBe(PREPEND);
		expect(systemPrompt.length).toBeGreaterThan(1);
		// The harness prompt is still there, after the prepended block.
		expect(systemPrompt.slice(1).join("\n")).not.toContain(PREPEND);
	});

	test("prepend and append land on opposite ends of the same prompt", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			resolvedPrependSystemPrompt: PREPEND,
			resolvedAppendSystemPrompt: "APPENDED-MARKER",
			toolNames: ["read"],
			contextFiles: [],
			skills: [],
			includeWorkspaceTree: false,
		});
		expect(systemPrompt[0]).toBe(PREPEND);
		const joined = systemPrompt.join("\n");
		expect(joined.indexOf(PREPEND)).toBeLessThan(joined.indexOf("APPENDED-MARKER"));
	});

	test("no prepend leaves the block list untouched", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			toolNames: ["read"],
			contextFiles: [],
			skills: [],
			includeWorkspaceTree: false,
		});
		expect(systemPrompt[0]).not.toBe(PREPEND);
		expect(systemPrompt[0]?.length).toBeGreaterThan(0);
	});

	test("an empty prepend adds no block", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			resolvedPrependSystemPrompt: "",
			toolNames: ["read"],
			contextFiles: [],
			skills: [],
			includeWorkspaceTree: false,
		});
		expect(systemPrompt[0]).not.toBe("");
	});
});

describe("PREPEND_SYSTEM.md discovery", () => {
	const originalProjectDir = getProjectDir();
	const tmpDirs: string[] = [];
	afterEach(async () => {
		setProjectDir(originalProjectDir);
		for (const d of tmpDirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
	});

	test("a project-level PREPEND_SYSTEM.md is discovered", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aura-prepend-"));
		tmpDirs.push(dir);
		const file = path.join(dir, CONFIG_DIR_NAME, "PREPEND_SYSTEM.md");
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, PREPEND);
		setProjectDir(dir);
		expect(discoverPrependSystemPromptFile()).toBe(file);
	});

	test("no file means no prepend", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aura-prepend-"));
		tmpDirs.push(dir);
		setProjectDir(dir);
		expect(discoverPrependSystemPromptFile()).toBeUndefined();
	});
});
