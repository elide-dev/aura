import { expect, test } from "bun:test";
import pkg from "../package.json" with { type: "json" };

test("aura bin entry exists and matches omp's target", () => {
	const bin = pkg.bin as Record<string, string>;
	expect(bin.aura).toBeDefined();
	expect(bin.aura).toBe(bin.omp);
});
