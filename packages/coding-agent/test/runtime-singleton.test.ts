import { afterEach, describe, expect, test } from "bun:test";
import { getOrCreateRuntimeService, resetRuntimeServiceForTests } from "../src/runtime";

afterEach(() => {
	resetRuntimeServiceForTests();
});

describe("getOrCreateRuntimeService", () => {
	test("returns the same instance across calls", () => {
		const first = getOrCreateRuntimeService();
		const second = getOrCreateRuntimeService();
		expect(second).toBe(first);
	});

	test("resetRuntimeServiceForTests yields a fresh instance", () => {
		const first = getOrCreateRuntimeService();
		resetRuntimeServiceForTests();
		const second = getOrCreateRuntimeService();
		expect(second).not.toBe(first);
	});
});
