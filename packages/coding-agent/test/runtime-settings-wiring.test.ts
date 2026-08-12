import { describe, expect, test } from "bun:test";
import { SETTINGS_SCHEMA } from "../src/config/settings-schema";
import {
	type RuntimeSettingsValues,
	resolveRuntimeEndpointOptions,
	runtimeAdapterFromEnvironment,
	runtimeAutoDownloadFromEnvironment,
} from "../src/runtime";

describe("runtime settings wiring", () => {
	const defaults: RuntimeSettingsValues = {
		enabled: true,
		autoDownload: true,
		path: "",
		version: "",
		adapter: "process",
		embeddedPath: "",
	};

	test("registers process as the default adapter and no explicit embedded library", () => {
		expect(SETTINGS_SCHEMA["runtime.adapter"]).toMatchObject({
			type: "enum",
			values: ["process", "embedded", "auto"],
			default: "process",
		});
		expect(SETTINGS_SCHEMA["runtime.embeddedPath"]).toMatchObject({
			type: "string",
			default: "",
		});
	});

	test("AURA_RUNTIME_ADAPTER selects the benchmark adapter explicitly", () => {
		expect(runtimeAdapterFromEnvironment("process", { AURA_RUNTIME_ADAPTER: " embedded " })).toBe("embedded");
		expect(runtimeAdapterFromEnvironment("process", { AURA_RUNTIME_ADAPTER: "" })).toBe("process");
		expect(() => runtimeAdapterFromEnvironment("process", { AURA_RUNTIME_ADAPTER: "invalid" })).toThrow(
			"AURA_RUNTIME_ADAPTER",
		);
	});

	test("AURA_RUNTIME_AUTO_DOWNLOAD forces the download policy for one process", () => {
		expect(runtimeAutoDownloadFromEnvironment(true, { AURA_RUNTIME_AUTO_DOWNLOAD: " false " })).toBe(false);
		expect(runtimeAutoDownloadFromEnvironment(true, { AURA_RUNTIME_AUTO_DOWNLOAD: "OFF" })).toBe(false);
		expect(runtimeAutoDownloadFromEnvironment(true, { AURA_RUNTIME_AUTO_DOWNLOAD: "0" })).toBe(false);
		expect(runtimeAutoDownloadFromEnvironment(true, { AURA_RUNTIME_AUTO_DOWNLOAD: "no" })).toBe(false);
		expect(runtimeAutoDownloadFromEnvironment(false, { AURA_RUNTIME_AUTO_DOWNLOAD: "true" })).toBe(true);
		expect(runtimeAutoDownloadFromEnvironment(false, { AURA_RUNTIME_AUTO_DOWNLOAD: "1" })).toBe(true);
		expect(runtimeAutoDownloadFromEnvironment(false, { AURA_RUNTIME_AUTO_DOWNLOAD: "Yes" })).toBe(true);
		expect(runtimeAutoDownloadFromEnvironment(false, { AURA_RUNTIME_AUTO_DOWNLOAD: "on" })).toBe(true);
	});

	test("an unset, empty, or whitespace AURA_RUNTIME_AUTO_DOWNLOAD defers to the setting", () => {
		expect(runtimeAutoDownloadFromEnvironment(true, {})).toBe(true);
		expect(runtimeAutoDownloadFromEnvironment(false, {})).toBe(false);
		expect(runtimeAutoDownloadFromEnvironment(true, { AURA_RUNTIME_AUTO_DOWNLOAD: "" })).toBe(true);
		expect(runtimeAutoDownloadFromEnvironment(true, { AURA_RUNTIME_AUTO_DOWNLOAD: " \t " })).toBe(true);
	});

	test("an unrecognized AURA_RUNTIME_AUTO_DOWNLOAD fails loudly instead of guessing", () => {
		expect(() => runtimeAutoDownloadFromEnvironment(true, { AURA_RUNTIME_AUTO_DOWNLOAD: "maybe" })).toThrow(
			"AURA_RUNTIME_AUTO_DOWNLOAD",
		);
		// Silent coercion of a near-miss is what would let a benchmark download its
		// own subject anyway, so the value is reported verbatim.
		expect(() => runtimeAutoDownloadFromEnvironment(true, { AURA_RUNTIME_AUTO_DOWNLOAD: "falsey" })).toThrow(
			'"falsey"',
		);
	});

	test("returns undefined when the runtime is disabled", () => {
		expect(
			resolveRuntimeEndpointOptions({
				...defaults,
				enabled: false,
				path: "/opt/aura/runtime",
				adapter: "embedded",
				embeddedPath: "/opt/aura/lib/libelide_embed.so",
			}),
		).toBe(undefined);
	});

	test("omits explicitPath when runtime.path is empty or whitespace", () => {
		expect(resolveRuntimeEndpointOptions(defaults)).toEqual({
			adapter: "process",
			autoDownload: true,
		});
		expect(resolveRuntimeEndpointOptions({ ...defaults, autoDownload: false, path: "   " })).toEqual({
			adapter: "process",
			autoDownload: false,
		});
	});

	test("maps trimmed process and embedded paths with the selected adapter and download policy", () => {
		expect(
			resolveRuntimeEndpointOptions({
				...defaults,
				path: "  /opt/aura/runtime  ",
				adapter: "auto",
				embeddedPath: " /opt/aura/lib/libelide_embed.so ",
			}),
		).toEqual({
			adapter: "auto",
			autoDownload: true,
			explicitPath: "/opt/aura/runtime",
			embeddedPath: "/opt/aura/lib/libelide_embed.so",
		});
	});
});
