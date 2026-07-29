import { describe, expect, test } from "bun:test";
import { SETTINGS_SCHEMA } from "../src/config/settings-schema";
import { type RuntimeSettingsValues, resolveRuntimeEndpointOptions } from "../src/runtime";

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
