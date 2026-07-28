import { describe, expect, test } from "bun:test";
import { resolveRuntimeEndpointOptions } from "../src/runtime";

describe("resolveRuntimeEndpointOptions", () => {
	test("returns undefined when the runtime is disabled", () => {
		expect(
			resolveRuntimeEndpointOptions({ enabled: false, autoDownload: true, path: "/opt/aura/runtime", version: "" }),
		).toBe(undefined);
	});

	test("omits explicitPath when runtime.path is empty or whitespace", () => {
		expect(resolveRuntimeEndpointOptions({ enabled: true, autoDownload: true, path: "", version: "" })).toEqual({
			autoDownload: true,
		});
		expect(resolveRuntimeEndpointOptions({ enabled: true, autoDownload: false, path: "   ", version: "" })).toEqual({
			autoDownload: false,
		});
	});

	test("passes a trimmed explicitPath through alongside autoDownload", () => {
		expect(
			resolveRuntimeEndpointOptions({
				enabled: true,
				autoDownload: true,
				path: "  /opt/aura/runtime  ",
				version: "",
			}),
		).toEqual({ autoDownload: true, explicitPath: "/opt/aura/runtime" });
	});
});
