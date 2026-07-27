import { expect, test } from "bun:test";
import { getResolvedThemeColors, getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import aura from "../src/modes/theme/aura.json" with { type: "json" };
import dark from "../src/modes/theme/dark.json" with { type: "json" };

const colorsOf = (t: unknown) => (t as { colors: Record<string, unknown> }).colors;

test("aura theme declares the same key set as the built-in dark theme", () => {
	expect(Object.keys(aura as object).sort()).toEqual(Object.keys(dark as object).sort());
});

test("aura theme declares the same colors sub-keys as the built-in dark theme", () => {
	// Top-level parity alone lets a missing or extra color slip through: the TUI
	// resolves every `colors.*` entry, so the sub-key set must match exactly.
	expect(Object.keys(colorsOf(aura)).sort()).toEqual(Object.keys(colorsOf(dark)).sort());
});

test("aura theme constructs through the real theme loader", async () => {
	// Going through the loader (not just reading the JSON) means a schema-invalid
	// edit fails here in CI instead of at TUI startup.
	const loaded = await getThemeByName("aura");
	expect(loaded).toBeDefined();
	expect(loaded?.isLight).toBe(false);
	expect(loaded?.statusLineLuminance).toBeDefined();
});

test("aura resolves the same color set as dark, with every var dereferenced", async () => {
	const auraResolved = await getResolvedThemeColors("aura");
	const darkResolved = await getResolvedThemeColors("dark");

	expect(Object.keys(auraResolved).sort()).toEqual(Object.keys(darkResolved).sort());

	// A `colors` entry naming a var that `vars` does not define survives JSON
	// key-set parity but cannot resolve to a color — it lands here as a non-hex
	// string instead.
	for (const [key, value] of Object.entries(auraResolved)) {
		expect(value, `aura color ${key} did not resolve to a hex color`).toMatch(/^#[0-9a-fA-F]{6}$/);
	}
});
