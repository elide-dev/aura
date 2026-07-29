import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveRuntimeEndpointOptions } from "../src/runtime";
import { ELIDE_VERSION } from "../src/runtime/dist";
import type { RuntimeStatusResult } from "../src/runtime/protocol";
import { createRequest, RuntimeRpcError, unwrapResponse } from "../src/runtime/protocol";
import type { ProvisionOptions } from "../src/runtime/provision";
import { managedVersionDir, resolveRuntimeBinary } from "../src/runtime/resolve";
import { LocalRuntimeEndpoint } from "../src/runtime/transport/local";

const OFF_PIN = "1.9.9+20990101";

const tmpDirs: string[] = [];
afterEach(async () => {
	for (const d of tmpDirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function makeManagedInstall(version: string): Promise<{ root: string; binary: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "aura-rt-ver-"));
	tmpDirs.push(root);
	const binary = path.join(root, version, "bin", "elide");
	await fs.mkdir(path.dirname(binary), { recursive: true });
	await fs.writeFile(binary, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Elide ${version}"; exit 0; fi\n`, {
		mode: 0o755,
	});
	return { root, binary };
}

describe("runtime.version → endpoint options", () => {
	test("an empty or whitespace version is omitted so the pinned default applies", () => {
		expect(
			resolveRuntimeEndpointOptions({
				enabled: true,
				autoDownload: true,
				path: "",
				version: "",
				adapter: "process",
				embeddedPath: "",
			}),
		).toEqual({
			adapter: "process",
			autoDownload: true,
		});
		expect(
			resolveRuntimeEndpointOptions({
				enabled: true,
				autoDownload: true,
				path: "",
				version: "  ",
				adapter: "process",
				embeddedPath: "",
			}),
		).toEqual({
			adapter: "process",
			autoDownload: true,
		});
	});

	test("a non-empty version is trimmed and passed through", () => {
		expect(
			resolveRuntimeEndpointOptions({
				enabled: true,
				autoDownload: true,
				path: "",
				version: `  ${OFF_PIN}  `,
				adapter: "process",
				embeddedPath: "",
			}),
		).toEqual({ adapter: "process", autoDownload: true, version: OFF_PIN });
	});
});

describe("runtime.version → managed install selection", () => {
	test("managedVersionDir targets the requested version under the given root", () => {
		expect(managedVersionDir(OFF_PIN, "/tmp/root")).toBe(path.join("/tmp/root", OFF_PIN));
	});

	test("resolution finds the install for the requested version", async () => {
		const { root, binary } = await makeManagedInstall(OFF_PIN);
		expect(
			await resolveRuntimeBinary({ version: OFF_PIN, managedRoot: root, env: {}, disablePathLookup: true }),
		).toEqual({ binaryPath: binary, source: "managed" });
	});

	test("resolution does not fall back to another installed version", async () => {
		const { root } = await makeManagedInstall(OFF_PIN);
		expect(
			await resolveRuntimeBinary({ version: "2.0.0", managedRoot: root, env: {}, disablePathLookup: true }),
		).toBeNull();
	});
});

describe("off-pin runtime.version never triggers an unverified download", () => {
	test("a missing off-pin version fails with guidance instead of provisioning", async () => {
		let provisioned = false;
		const ep = new LocalRuntimeEndpoint({
			version: OFF_PIN,
			autoDownload: true,
			resolve: async () => null,
			provision: async (_opts?: ProvisionOptions) => {
				provisioned = true;
				return "/never";
			},
		});
		const res = await ep.request(createRequest("runtime/check", {}));
		expect(provisioned).toBe(false);
		expect("error" in res).toBe(true);
		let thrown: unknown;
		try {
			unwrapResponse(res);
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toBeInstanceOf(RuntimeRpcError);
		const message = (thrown as RuntimeRpcError).message;
		expect(message).toContain(OFF_PIN);
		expect(message).toContain(ELIDE_VERSION);
		expect(message).toContain("checksum");
	});

	test("status on a missing off-pin version reports the same guidance", async () => {
		const ep = new LocalRuntimeEndpoint({ version: OFF_PIN, autoDownload: true, resolve: async () => null });
		const out = unwrapResponse<RuntimeStatusResult>(await ep.request(createRequest("runtime/status", undefined)));
		expect(out.available).toBe(false);
		expect(out.guidance).toContain(OFF_PIN);
		expect(out.guidance).toContain("checksum");
	});

	test("an already-installed off-pin version is used without any download", async () => {
		const { root, binary } = await makeManagedInstall(OFF_PIN);
		let provisioned = false;
		const ep = new LocalRuntimeEndpoint({
			version: OFF_PIN,
			managedRoot: root,
			autoDownload: true,
			env: {},
			provision: async (_opts?: ProvisionOptions) => {
				provisioned = true;
				return "/never";
			},
		});
		const out = unwrapResponse<RuntimeStatusResult>(await ep.request(createRequest("runtime/status", undefined)));
		expect(provisioned).toBe(false);
		expect(out.binaryPath).toBe(binary);
		expect(out.source).toBe("managed");
	});

	test("the pinned version still auto-downloads, and the provision targets that version", async () => {
		let seen: ProvisionOptions | undefined;
		const ep = new LocalRuntimeEndpoint({
			version: ELIDE_VERSION,
			autoDownload: true,
			resolve: async () => null,
			provision: async (opts?: ProvisionOptions) => {
				seen = opts;
				return "/fake/elide";
			},
		});
		// `runtime/spawn` with a bogus mode would fail before provisioning; use a
		// flow that resolves the binary first and let the fake path fail the spawn.
		await ep.request(createRequest("runtime/check", {}));
		expect(seen?.version).toBe(ELIDE_VERSION);
	});
});
