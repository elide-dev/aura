import { describe, expect, test } from "bun:test";
import { RuntimeService } from "../src/runtime/service";
import { LocalRuntimeEndpoint } from "../src/runtime/transport/local";

const realBin = process.env.AURA_RUNTIME_BIN ?? process.env.ELIDE_BIN ?? Bun.which("elide") ?? undefined;

describe.skipIf(!realBin)("runtime integration (real binary)", () => {
	const svc = new RuntimeService(new LocalRuntimeEndpoint({ explicitPath: realBin, autoDownload: false }));

	test("status reports an available runtime >= 1.4", async () => {
		const s = await svc.status();
		expect(s.available).toBe(true);
		const [major = 0, minor = 0] = (s.version ?? "").split(".").map(n => Number.parseInt(n, 10));
		expect(major > 1 || (major === 1 && minor >= 4)).toBe(true);
	}, 180_000);

	test("runs inline TypeScript", async () => {
		const r = await svc.run({ code: 'console.log("aura" + ":" + (40 + 2))', language: "ts", timeoutMs: 120_000 });
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("aura:42");
	}, 180_000);

	test("runs inline Python (GraalPy)", async () => {
		const r = await svc.run({ code: 'print("py:" + str(21 * 2))', language: "python", timeoutMs: 120_000 });
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("py:42");
	}, 180_000);

	test("nonzero exit is reported, not thrown", async () => {
		const r = await svc.run({ code: "process.exit(3)", language: "js", timeoutMs: 120_000 });
		expect(r.exitCode).toBe(3);
	}, 180_000);
});
