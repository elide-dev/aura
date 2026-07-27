import { describe, expect, test } from "bun:test";
import {
	createStatusRuntime,
	formatRuntimeStatus,
	RUNTIME_DISABLED,
	resolveStatusEndpointOptions,
	runRuntimeCommand,
} from "../src/cli/runtime-cli";
import { RUNTIME_PROTOCOL_VERSION } from "../src/runtime";

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

	test("--json emits machine-readable status", async () => {
		const lines: string[] = [];
		await runRuntimeCommand(
			{ action: "status", flags: { json: true } },
			{ status: async () => ({ available: true, version: "1.4.1", protocolVersion: 1 }) },
			line => lines.push(line),
		);
		const parsed = JSON.parse(lines.join("\n"));
		expect(parsed).toMatchObject({ available: true, version: "1.4.1", protocolVersion: 1 });
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
		expect(resolveStatusEndpointOptions({ enabled: true, autoDownload: true, path: "" })).toEqual({
			autoDownload: false,
		});
		expect(resolveStatusEndpointOptions({ enabled: true, autoDownload: true, path: " /opt/bin/rt " })).toEqual({
			autoDownload: false,
			explicitPath: "/opt/bin/rt",
		});
		expect(resolveStatusEndpointOptions({ enabled: false, autoDownload: true, path: "" })).toBeUndefined();
	});

	test("createStatusRuntime yields the disabled sentinel when runtime.enabled is false", () => {
		expect(createStatusRuntime({ enabled: false, autoDownload: true, path: "" })).toBe(RUNTIME_DISABLED);
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
			protocolVersion: RUNTIME_PROTOCOL_VERSION,
		});
	});
});
