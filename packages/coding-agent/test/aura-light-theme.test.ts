import { expect, test } from "bun:test";
import { getResolvedThemeColors, getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import auraLight from "../src/modes/theme/aura-light.json" with { type: "json" };
import light from "../src/modes/theme/light.json" with { type: "json" };

const colorsOf = (t: unknown) => (t as { colors: Record<string, unknown> }).colors;

test("aura-light theme declares the same key set as the built-in light theme", () => {
	expect(Object.keys(auraLight as object).sort()).toEqual(Object.keys(light as object).sort());
});

test("aura-light theme declares the same colors sub-keys as the built-in light theme", () => {
	// Top-level parity alone lets a missing or extra color slip through: the TUI
	// resolves every `colors.*` entry, so the sub-key set must match exactly.
	expect(Object.keys(colorsOf(auraLight)).sort()).toEqual(Object.keys(colorsOf(light)).sort());
});

test("aura-light theme constructs through the real theme loader", async () => {
	// Going through the loader (not just reading the JSON) means a schema-invalid
	// edit fails here in CI instead of at TUI startup.
	const loaded = await getThemeByName("aura-light");
	expect(loaded).toBeDefined();
	expect(loaded?.isLight).toBe(true);
	expect(loaded?.statusLineLuminance).toBeDefined();
});

test("aura-light resolves the same color set as light, with every var dereferenced", async () => {
	const auraResolved = await getResolvedThemeColors("aura-light");
	const lightResolved = await getResolvedThemeColors("light");

	expect(Object.keys(auraResolved).sort()).toEqual(Object.keys(lightResolved).sort());

	// A `colors` entry naming a var that `vars` does not define survives JSON
	// key-set parity but cannot resolve to a color — it lands here as a non-hex
	// string instead.
	for (const [key, value] of Object.entries(auraResolved)) {
		expect(value, `aura-light color ${key} did not resolve to a hex color`).toMatch(/^#[0-9a-fA-F]{6}$/);
	}
});

test("aura-light is the default light theme and aura the default dark theme", async () => {
	const { SETTINGS_SCHEMA } = await import("@oh-my-pi/pi-coding-agent/config/settings-schema");
	expect(SETTINGS_SCHEMA["theme.light"].default).toBe("aura-light");
	expect(SETTINGS_SCHEMA["theme.dark"].default).toBe("aura");
});
