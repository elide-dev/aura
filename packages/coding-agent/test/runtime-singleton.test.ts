import { afterEach, describe, expect, test, vi } from "bun:test";
import {
	acquireRuntimeServiceLease,
	disableCachedRuntimeService,
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

	test("final scope release drains a delayed retirement created by a cache swap", async () => {
		const scope = {};
		const release = acquireRuntimeServiceLease(scope);
		const first = getOrCreateRuntimeService({ adapter: "process" }, undefined, scope);
		const firstCloseGate = Promise.withResolvers<void>();
		const firstClose = vi.spyOn(first, "close").mockImplementation(() => firstCloseGate.promise);
		const replacement = getOrCreateRuntimeService({ adapter: "auto" }, undefined, scope);
		const replacementClose = vi.spyOn(replacement, "close");
		expect(firstClose).toHaveBeenCalledTimes(1);

		let released = false;
		const releasing = release().then(() => {
			released = true;
		});
		await Promise.resolve();
		expect(released).toBe(false);
		expect(replacementClose).toHaveBeenCalledTimes(1);

		firstCloseGate.resolve();
		await releasing;
		expect(released).toBe(true);
		await expect(replacement.status()).rejects.toMatchObject({ message: "Runtime service is closed." });
	});

	test("final scope release drains a delayed retirement created by disable", async () => {
		const scope = {};
		const release = acquireRuntimeServiceLease(scope);
		const service = getOrCreateRuntimeService({ adapter: "embedded" }, undefined, scope);
		const closeGate = Promise.withResolvers<void>();
		const close = vi.spyOn(service, "close").mockImplementation(() => closeGate.promise);
		const disabling = disableCachedRuntimeService(scope);
		expect(close).toHaveBeenCalledTimes(1);

		let released = false;
		const releasing = release().then(() => {
			released = true;
		});
		await Promise.resolve();
		expect(released).toBe(false);

		closeGate.resolve();
		await Promise.all([disabling, releasing]);
		expect(released).toBe(true);
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
	test("isolates caches owned by different settings scopes", async () => {
		const firstScope = {};
		const secondScope = {};
		const releaseFirst = acquireRuntimeServiceLease(firstScope);
		const releaseSecond = acquireRuntimeServiceLease(secondScope);
		const first = getOrCreateRuntimeService({ adapter: "process" }, undefined, firstScope);
		const second = getOrCreateRuntimeService({ adapter: "process" }, undefined, secondScope);
		expect(second).not.toBe(first);

		const closeFirst = vi.spyOn(first, "close");
		const closeSecond = vi.spyOn(second, "close");
		const replacement = getOrCreateRuntimeService({ adapter: "auto" }, undefined, firstScope);
		await Promise.resolve();
		expect(replacement).not.toBe(first);
		expect(closeFirst).toHaveBeenCalledTimes(1);
		expect(closeSecond).not.toHaveBeenCalled();
		expect(getOrCreateRuntimeService({ adapter: "process" }, undefined, secondScope)).toBe(second);
		await releaseFirst();
		await releaseSecond();
	});

	test("disabling one scope evicts before close and cannot evict a concurrent replacement", async () => {
		const scope = {};
		const release = acquireRuntimeServiceLease(scope);
		const options = { adapter: "embedded" as const, embeddedPath: "/runtime/lib.so" };
		const first = getOrCreateRuntimeService(options, undefined, scope);
		const closeGate = Promise.withResolvers<void>();
		const close = vi.spyOn(first, "close").mockImplementation(() => closeGate.promise);

		const disabled = disableCachedRuntimeService(scope);
		expect(close).toHaveBeenCalledTimes(1);
		const replacement = getOrCreateRuntimeService(options, undefined, scope);
		expect(replacement).not.toBe(first);
		closeGate.resolve();
		await disabled;
		expect(getOrCreateRuntimeService(options, undefined, scope)).toBe(replacement);
		await release();
	});

	test("same-scope top-level leases close only after the last idempotent release", async () => {
		const scope = {};
		const releaseFirst = acquireRuntimeServiceLease(scope);
		const releaseSecond = acquireRuntimeServiceLease(scope);
		const service = getOrCreateRuntimeService({ adapter: "process" }, undefined, scope);
		const close = vi.spyOn(service, "close");

		await releaseFirst();
		await releaseFirst();
		expect(close).not.toHaveBeenCalled();
		expect(await service.status()).toMatchObject({ protocolVersion: 2 });

		await releaseSecond();
		expect(close).toHaveBeenCalledTimes(1);
		await expect(service.status()).rejects.toMatchObject({ message: "Runtime service is closed." });
	});

	test("a descendant cannot recreate a service after final scope release begins", async () => {
		const scope = {};
		const release = acquireRuntimeServiceLease(scope);
		let created = 0;
		const service = getOrCreateRuntimeService(
			{ adapter: "process" },
			() => {
				created += 1;
			},
			scope,
		);
		const closeGate = Promise.withResolvers<void>();
		vi.spyOn(service, "close").mockImplementation(() => closeGate.promise);

		let released = false;
		const releasing = release().then(() => {
			released = true;
		});
		expect(() => getOrCreateRuntimeService({ adapter: "auto" }, undefined, scope)).toThrow(
			"Runtime service scope is closed.",
		);
		expect(created).toBe(1);
		await Promise.resolve();
		expect(released).toBe(false);

		closeGate.resolve();
		await releasing;
		expect(released).toBe(true);
	});

	test("resetRuntimeServiceForTests yields a fresh instance", () => {
		const first = getOrCreateRuntimeService();
		resetRuntimeServiceForTests();
		const second = getOrCreateRuntimeService();
		expect(second).not.toBe(first);
	});
});
