import { describe, expect, test } from "bun:test";
import { resolveRuntimeEndpointOptions } from "../src/runtime";

describe("resolveRuntimeEndpointOptions", () => {
	test("returns undefined when the runtime is disabled", () => {
		expect(resolveRuntimeEndpointOptions({ enabled: false, autoDownload: true, path: "/opt/aura/runtime" })).toBe(
			undefined,
		);
	});

	test("omits explicitPath when runtime.path is empty or whitespace", () => {
		expect(resolveRuntimeEndpointOptions({ enabled: true, autoDownload: true, path: "" })).toEqual({
			autoDownload: true,
		});
		expect(resolveRuntimeEndpointOptions({ enabled: true, autoDownload: false, path: "   " })).toEqual({
			autoDownload: false,
		});
	});

	test("passes a trimmed explicitPath through alongside autoDownload", () => {
		expect(
			resolveRuntimeEndpointOptions({ enabled: true, autoDownload: true, path: "  /opt/aura/runtime  " }),
		).toEqual({ autoDownload: true, explicitPath: "/opt/aura/runtime" });
	});
});
