import { expect, test } from "bun:test";
import aura from "../src/modes/theme/aura.json" with { type: "json" };
import dark from "../src/modes/theme/dark.json" with { type: "json" };

test("aura theme declares the same key set as the built-in dark theme", () => {
	expect(Object.keys(aura as object).sort()).toEqual(Object.keys(dark as object).sort());
});
