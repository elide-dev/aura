import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import {
	createStatusRuntime,
	formatRuntimeStatus,
	RUNTIME_DISABLED,
	resolveStatusEndpointOptions,
	runRuntimeCommand,
} from "../src/cli/runtime-cli";
import { RUNTIME_PROTOCOL_VERSION, type RuntimeSettingsValues } from "../src/runtime";
import type { RuntimeStatusResult } from "../src/runtime/protocol";

const DEFAULT_RUNTIME_SETTINGS: RuntimeSettingsValues = {
	enabled: true,
	autoDownload: true,
	path: "",
	adapter: "process",
	embeddedPath: "",
};

describe("aura runtime status", () => {
	test("available runtime renders version, path, source and exits 0", async () => {
		const lines: string[] = [];
		const code = await runRuntimeCommand(
			{ action: "status", flags: {} },
			{
				status: async () => ({
					available: true,
					version: "1.4.1",
					binaryPath: "/x/bin/elide",
					source: "managed",
					protocolVersion: 1,
				}),
			},
			line => lines.push(line),
		);
		expect(code).toBe(0);
		const out = lines.join("\n");
		expect(out).toContain("available");
		expect(out).toContain("1.4.1");
		expect(out).toContain("managed");
	});

	test("missing runtime prints guidance and exits 1", async () => {
		const lines: string[] = [];
		const code = await runRuntimeCommand(
			{ action: "status", flags: {} },
			{
				status: async () => ({
					available: false,
					guidance: "point AURA_RUNTIME_BIN at a binary",
					protocolVersion: 1,
				}),
			},
			line => lines.push(line),
		);
		expect(code).toBe(1);
		expect(lines.join("\n")).toContain("AURA_RUNTIME_BIN");
	});

	test("--json preserves every internal adapter-selection and compatibility field exactly", async () => {
		const lines: string[] = [];
		const status: RuntimeStatusResult = {
			available: true,
			version: "1.4.1",
			binaryPath: "/opt/aura/bin/runtime",
			source: "managed",
			protocolVersion: 1,
			adapter: "auto",
			effectiveAdapter: "embedded",
			embeddedLibraryPath: "/opt/aura/lib/libelide_embed.so",
			embeddedLibrarySource: "env",
			embeddedAbiVersion: 1,
			embeddedSchemaHash: "8a6b5aa3",
		};
		await runRuntimeCommand(
			{ action: "status", flags: { json: true } },
			{ status: async () => status },
			line => lines.push(line),
		);
		expect(JSON.parse(lines.join("\n"))).toEqual(status);
	});

	test("plain status renders adapter and embedded library metadata with a safe shortened path", () => {
		const libraryPath = `${path.join(os.homedir(), ".aura", "runtime", "lib", "libelide_embed.so")}\u001b[31m`;
		const text = formatRuntimeStatus({
			available: true,
			version: "1.4.1",
			protocolVersion: 1,
			adapter: "auto",
			effectiveAdapter: "embedded",
			embeddedLibraryPath: libraryPath,
			embeddedLibrarySource: "env",
			embeddedAbiVersion: 1,
			embeddedSchemaHash: "8a6b5aa3",
		});
		expect(text).toContain("adapter: auto");
		expect(text).toContain("effective adapter: embedded");
		expect(text).toContain("embedded runtime library: ~/.aura/runtime/lib/libelide_embed.so");
		expect(text).toContain("embedded runtime library source: env");
		expect(text).toContain("ABI: 1");
		expect(text).toContain("schema: 8a6b5aa3");
		expect(text).not.toContain("\u001b");
		expect(text).not.toContain(os.homedir());
	});

	test("unavailable status still explains the selected adapter and embedded library", () => {
		const text = formatRuntimeStatus({
			available: false,
			guidance: "configure the embedded runtime library",
			protocolVersion: 1,
			adapter: "embedded",
			effectiveAdapter: "embedded",
			embeddedLibraryPath: "/opt/aura/lib/runtime.so",
			embeddedLibrarySource: "setting",
		});
		expect(text).toContain("runtime: unavailable");
		expect(text).toContain("adapter: embedded");
		expect(text).toContain("embedded runtime library: /opt/aura/lib/runtime.so");
	});

	test("formatRuntimeStatus never mentions elide", () => {
		const text = formatRuntimeStatus({ available: false, guidance: "install the runtime", protocolVersion: 1 });
		expect(text.toLowerCase()).not.toContain("elide");
	});

	test("formatRuntimeStatus never mentions elide on the available branch either", () => {
		const text = formatRuntimeStatus({ available: true, version: "1.4.1", source: "managed", protocolVersion: 1 });
		expect(text.toLowerCase()).not.toContain("elide");
	});

	// A read-only diagnostic must never provision: whatever `runtime.autoDownload`
	// says, the status probe resolves with auto-download off.
	test("status options force autoDownload off regardless of settings", () => {
		expect(resolveStatusEndpointOptions(DEFAULT_RUNTIME_SETTINGS)).toEqual({
			autoDownload: false,
		});
		expect(resolveStatusEndpointOptions({ ...DEFAULT_RUNTIME_SETTINGS, path: " /opt/bin/rt " })).toEqual({
			autoDownload: false,
			explicitPath: "/opt/bin/rt",
		});
		expect(resolveStatusEndpointOptions({ ...DEFAULT_RUNTIME_SETTINGS, enabled: false })).toBeUndefined();
	});

	test("createStatusRuntime yields the disabled sentinel when runtime.enabled is false", () => {
		expect(createStatusRuntime({ ...DEFAULT_RUNTIME_SETTINGS, enabled: false })).toBe(RUNTIME_DISABLED);
	});

	test("disabled runtime prints the disabled line and exits 1", async () => {
		const lines: string[] = [];
		const code = await runRuntimeCommand({ action: "status", flags: {} }, RUNTIME_DISABLED, line => lines.push(line));
		expect(code).toBe(1);
		expect(lines.join("\n")).toBe("runtime: disabled (runtime.enabled = false)");
	});

	test("disabled runtime --json reports available:false with disabled:true", async () => {
		const lines: string[] = [];
		const code = await runRuntimeCommand({ action: "status", flags: { json: true } }, RUNTIME_DISABLED, line =>
			lines.push(line),
		);
		expect(code).toBe(1);
		expect(JSON.parse(lines.join("\n"))).toEqual({
			available: false,
			disabled: true,
			guidance: "Set runtime.enabled to true to use the innate runtime tools.",
			protocolVersion: RUNTIME_PROTOCOL_VERSION,
		});
	});
});
