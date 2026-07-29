import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "../src/cli/args";
import { flagConsumesValue, STRING_VALUE_FLAGS } from "../src/cli/flag-tables";
import {
	createStatusRuntime,
	RUNTIME_DISABLED,
	readRuntimeSettings,
	resolveStatusEndpointOptions,
} from "../src/cli/runtime-cli";
import { Settings } from "../src/config/settings";

describe("--runtime flag parsing", () => {
	test("--runtime <path> lands on Args.runtime", () => {
		expect(parseArgs(["--runtime", "/opt/aura/elide"]).runtime).toBe("/opt/aura/elide");
	});

	test("--runtime=<path> lands on Args.runtime", () => {
		expect(parseArgs(["--runtime=/opt/aura/elide"]).runtime).toBe("/opt/aura/elide");
	});

	test("the flag is a known string-valued flag, so the profile bootstrap skips its value", () => {
		expect(STRING_VALUE_FLAGS.has("--runtime")).toBe(true);
		expect(flagConsumesValue("--runtime", "/opt/aura/elide")).toBe(true);
	});

	test("a message after --runtime <path> is still the prompt, not a stolen positional", () => {
		const parsed = parseArgs(["--runtime", "/opt/aura/elide", "hello"]);
		expect(parsed.runtime).toBe("/opt/aura/elide");
		expect(parsed.messages).toEqual(["hello"]);
	});
});

describe("--runtime threads into endpoint resolution as explicitPath", () => {
	test("the resolved status options carry explicitPath and never auto-download", () => {
		expect(
			resolveStatusEndpointOptions({
				enabled: true,
				autoDownload: true,
				path: "/opt/aura/elide",
				version: "",
				adapter: "process",
				embeddedPath: "",
			}),
		).toEqual({ adapter: "process", autoDownload: false, explicitPath: "/opt/aura/elide" });
	});

	test("readRuntimeSettings lets --runtime override the runtime.path setting", async () => {
		await Settings.init({ inMemory: true });
		expect(readRuntimeSettings().path).toBe("");
		expect(readRuntimeSettings({ path: "/opt/aura/elide" })).toMatchObject({ path: "/opt/aura/elide" });
	});

	test("aura runtime status reports source:flag for a --runtime-provided binary", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aura-rt-flag-"));
		try {
			const bin = path.join(dir, "elide");
			// A binary that answers `--version` the way the real one does, so status
			// exercises the whole locate → spawn → report path.
			await fs.writeFile(bin, "#!/bin/sh\necho 'Elide 1.4.1 (build test)'\n", { mode: 0o755 });
			const runtime = createStatusRuntime({
				enabled: true,
				autoDownload: true,
				path: bin,
				version: "",
				adapter: "process",
				embeddedPath: "",
			});
			expect(runtime).not.toBe(RUNTIME_DISABLED);
			if ("disabled" in runtime) throw new Error("runtime unexpectedly disabled");
			const status = await runtime.status();
			expect(status.source).toBe("flag");
			expect(status.binaryPath).toBe(bin);
			expect(status.available).toBe(true);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
