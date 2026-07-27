import { afterEach, describe, expect, test } from "bun:test";
import { getOrCreateRuntimeService, resetRuntimeServiceForTests } from "../src/runtime";

afterEach(() => {
	resetRuntimeServiceForTests();
});

describe("getOrCreateRuntimeService", () => {
	test("returns the same instance for identical options", () => {
		const first = getOrCreateRuntimeService();
		const second = getOrCreateRuntimeService();
		expect(second).toBe(first);
		const third = getOrCreateRuntimeService({ autoDownload: true, explicitPath: "/bin/runtime" });
		expect(getOrCreateRuntimeService({ autoDownload: true, explicitPath: "/bin/runtime" })).toBe(third);
	});

	test("undefined and omitted option fields hash the same", () => {
		const first = getOrCreateRuntimeService({});
		expect(getOrCreateRuntimeService({ explicitPath: undefined })).toBe(first);
		expect(getOrCreateRuntimeService(undefined)).toBe(first);
	});

	test("changed options yield a fresh instance", () => {
		const withDownload = getOrCreateRuntimeService({ autoDownload: true });
		const withoutDownload = getOrCreateRuntimeService({ autoDownload: false });
		expect(withoutDownload).not.toBe(withDownload);

		const explicit = getOrCreateRuntimeService({ autoDownload: false, explicitPath: "/opt/a" });
		expect(explicit).not.toBe(withoutDownload);
		expect(getOrCreateRuntimeService({ autoDownload: false, explicitPath: "/opt/b" })).not.toBe(explicit);

		// Returning to earlier options still rebuilds — the cache holds a single entry.
		expect(getOrCreateRuntimeService({ autoDownload: false })).not.toBe(withoutDownload);
	});

	test("resetRuntimeServiceForTests yields a fresh instance", () => {
		const first = getOrCreateRuntimeService();
		resetRuntimeServiceForTests();
		const second = getOrCreateRuntimeService();
		expect(second).not.toBe(first);
	});
});
