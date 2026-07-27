import { describe, expect, test } from "bun:test";
import { formatRuntimeStatus, runRuntimeCommand } from "../src/cli/runtime-cli";

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
});
