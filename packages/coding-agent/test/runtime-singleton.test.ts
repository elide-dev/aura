import { afterEach, describe, expect, test, vi } from "bun:test";
import {
	disposeCachedRuntimeService,
	getOrCreateRuntimeService,
	resetRuntimeServiceForTests,
} from "../src/runtime";

afterEach(async () => {
	await disposeCachedRuntimeService();
	resetRuntimeServiceForTests();
	vi.restoreAllMocks();
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


	test("adapter and both configured paths participate in the cache key", () => {
		const base = getOrCreateRuntimeService({
			adapter: "process",
			autoDownload: false,
			explicitPath: "/runtime/a",
			embeddedPath: "/runtime/lib/a.so",
		});
		const adapter = getOrCreateRuntimeService({
			adapter: "embedded",
			autoDownload: false,
			explicitPath: "/runtime/a",
			embeddedPath: "/runtime/lib/a.so",
		});
		expect(adapter).not.toBe(base);
		const executable = getOrCreateRuntimeService({
			adapter: "embedded",
			autoDownload: false,
			explicitPath: "/runtime/b",
			embeddedPath: "/runtime/lib/a.so",
		});
		expect(executable).not.toBe(adapter);
		const library = getOrCreateRuntimeService({
			adapter: "embedded",
			autoDownload: false,
			explicitPath: "/runtime/b",
			embeddedPath: "/runtime/lib/b.so",
		});
		expect(library).not.toBe(executable);
		const download = getOrCreateRuntimeService({
			adapter: "embedded",
			autoDownload: true,
			explicitPath: "/runtime/b",
			embeddedPath: "/runtime/lib/b.so",
		});
		expect(download).not.toBe(library);
	});

	test("settings changes publish the fresh service before retiring the old one asynchronously", async () => {
		const first = getOrCreateRuntimeService({ adapter: "process", autoDownload: false });
		const closeGate = Promise.withResolvers<void>();
		const close = vi.spyOn(first, "close").mockImplementation(() => closeGate.promise);
		const fresh = getOrCreateRuntimeService({ adapter: "auto", autoDownload: false });
		expect(fresh).not.toBe(first);
		expect(getOrCreateRuntimeService({ adapter: "auto", autoDownload: false })).toBe(fresh);
		expect(close).toHaveBeenCalledTimes(1);
		closeGate.resolve();
		await closeGate.promise;
	});

	test("explicit disposal evicts the matching cache entry before awaiting close", async () => {
		const options = { adapter: "process" as const, autoDownload: false };
		const first = getOrCreateRuntimeService(options);
		const closeGate = Promise.withResolvers<void>();
		const close = vi.spyOn(first, "close").mockImplementation(() => closeGate.promise);
		const disposal = disposeCachedRuntimeService(first);
		await Promise.resolve();
		expect(close).toHaveBeenCalledTimes(1);
		const fresh = getOrCreateRuntimeService(options);
		expect(fresh).not.toBe(first);
		closeGate.resolve();
		await disposal;
		expect(getOrCreateRuntimeService(options)).toBe(fresh);
	});

	test("disposing a retired service never evicts the currently cached replacement", async () => {
		const retired = getOrCreateRuntimeService({ adapter: "process", autoDownload: false });
		const current = getOrCreateRuntimeService({ adapter: "auto", autoDownload: false });
		await disposeCachedRuntimeService(retired);
		expect(getOrCreateRuntimeService({ adapter: "auto", autoDownload: false })).toBe(current);
	});
	test("resetRuntimeServiceForTests yields a fresh instance", () => {
		const first = getOrCreateRuntimeService();
		resetRuntimeServiceForTests();
		const second = getOrCreateRuntimeService();
		expect(second).not.toBe(first);
	});
});
