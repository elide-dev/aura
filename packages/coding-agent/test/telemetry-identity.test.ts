import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// `PI_CONFIG_DIR` names the config root *relative to the home directory*, so the
// sandbox has to live under `$HOME` rather than `os.tmpdir()` — an absolute
// value would be re-joined onto home and leak files outside the temp dir.
let tmpDir: string;
let savedConfigDir: string | undefined;
let savedServiceName: string | undefined;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.homedir(), ".aura-telemetry-id-"));
	savedConfigDir = process.env.PI_CONFIG_DIR;
	savedServiceName = process.env.OTEL_SERVICE_NAME;
	process.env.PI_CONFIG_DIR = path.basename(tmpDir);
	delete process.env.OTEL_SERVICE_NAME;
});

afterEach(async () => {
	if (savedConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
	else process.env.PI_CONFIG_DIR = savedConfigDir;
	if (savedServiceName === undefined) delete process.env.OTEL_SERVICE_NAME;
	else process.env.OTEL_SERVICE_NAME = savedServiceName;
	const { refreshDirsFromEnv } = await import("@oh-my-pi/pi-utils/dirs");
	refreshDirsFromEnv();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("telemetry identity", () => {
	it("generates a stable install id and persists it", async () => {
		const { refreshDirsFromEnv } = await import("@oh-my-pi/pi-utils/dirs");
		refreshDirsFromEnv();
		const { getOrCreateInstallId } = await import("../src/telemetry/identity");
		const first = getOrCreateInstallId();
		const second = getOrCreateInstallId();
		expect(first).toMatch(/^[0-9a-f-]{36}$/);
		expect(second).toBe(first);
		// The in-memory cache alone would satisfy the equality above; assert the
		// on-disk copy too so a future process gets the same id.
		expect(fs.readFileSync(path.join(tmpDir, "telemetry-install-id"), "utf8").trim()).toBe(first);
	});

	it("default resource attributes are pseudonymous", async () => {
		const { refreshDirsFromEnv } = await import("@oh-my-pi/pi-utils/dirs");
		refreshDirsFromEnv();
		const { buildResourceAttributes } = await import("../src/telemetry/identity");
		const attrs = buildResourceAttributes();
		expect(attrs["service.name"]).toBe("aura");
		expect(attrs["service.version"]).toBeString();
		expect(attrs["aura.install.id"]).toMatch(/^[0-9a-f-]{36}$/);
		expect(attrs["host.name"]).toBeUndefined();
		expect(attrs["aura.workspace.path"]).toBeUndefined();
	});

	it("adds hostname and workspace only when the telemetry.identity.* opt-ins are on", async () => {
		const { refreshDirsFromEnv } = await import("@oh-my-pi/pi-utils/dirs");
		refreshDirsFromEnv();
		const { buildResourceAttributes } = await import("../src/telemetry/identity");
		const settings = (values: Record<string, unknown>) => ({ get: (p: string) => values[p] }) as never;

		const off = buildResourceAttributes({
			settings: settings({ "telemetry.identity.hostname": false, "telemetry.identity.workspace": false }),
		});
		expect(off["host.name"]).toBeUndefined();
		expect(off["aura.workspace.path"]).toBeUndefined();

		const on = buildResourceAttributes({
			settings: settings({ "telemetry.identity.hostname": true, "telemetry.identity.workspace": true }),
		});
		expect(on["host.name"]).toBe(os.hostname());
		expect(on["aura.workspace.path"]).toBe(process.cwd());
	});
});
