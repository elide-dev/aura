import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "../../../config/settings";
import { renderSetupOutro } from "../../setup-wizard/scenes/outro";
import { renderSetupSplash } from "../../setup-wizard/scenes/splash";
import auraTheme from "../../theme/aura.json";
import { getThemeByName, setThemeInstance } from "../../theme/theme";
import { AURA_LOGO, BRAND_GRADIENT_STOPS, gradientEscape, gradientLogo, WelcomeComponent } from "../welcome";

/** Strip SGR colors so assertions see the glyphs only. */
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

/** Any single-color SGR foreground: truecolor or 256-color. */
const SGR_FG = /\x1b\[38;(?:2;\d{1,3};\d{1,3};\d{1,3}|5;\d{1,3})m/;

function hexToRgb(hex: string): [number, number, number] {
	const value = Number.parseInt(hex.replace("#", ""), 16);
	return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** The three wordmark rows, independent of the framing rules. */
const WORDMARK_ROWS = AURA_LOGO.slice(1, 4);

describe("AURA_LOGO", () => {
	it("keeps PI_LOGO's five-row shape so the welcome box height is unchanged", () => {
		expect(AURA_LOGO).toHaveLength(5);
	});

	it("is a rectangular block of terminal-safe glyphs", () => {
		const widths = new Set(AURA_LOGO.map(line => line.length));
		expect(widths.size).toBe(1);
		for (const line of AURA_LOGO) {
			expect(line).toMatch(/^[ ▀▄█]+$/);
		}
	});

	it("spells 'aura' as a four-glyph wordmark framed by two rules", () => {
		expect(WORDMARK_ROWS).toEqual(["▄▄▄ ▄ ▄ ▄▄▄ ▄▄▄", "▄▄█ █ █ █   ▄▄█", "█▄█ █▄█ █   █▄█"]);
		// Framing rules: an upper-half rule above, a lower-half rule below.
		expect(AURA_LOGO[0].trim()).toMatch(/^▀+$/);
		expect(AURA_LOGO[4].trim()).toMatch(/^▄+$/);
		// Four 3-column letter cells on the baseline row, one blank column apart.
		expect(WORDMARK_ROWS[2].split(" ").filter(cell => cell.length > 0)).toHaveLength(4);
	});
});

describe("brand gradient stops", () => {
	it("derives from the aura theme palette", () => {
		const vars = auraTheme.vars as Record<string, string>;
		for (const name of ["purple", "violet", "magenta"] as const) {
			expect(BRAND_GRADIENT_STOPS).toContainEqual(hexToRgb(vars[name]));
		}
	});

	it("is a multi-stop palette of valid 8-bit channels", () => {
		expect(BRAND_GRADIENT_STOPS.length).toBeGreaterThanOrEqual(3);
		for (const stop of BRAND_GRADIENT_STOPS) {
			expect(stop).toHaveLength(3);
			for (const channel of stop) {
				expect(Number.isInteger(channel)).toBe(true);
				expect(channel).toBeGreaterThanOrEqual(0);
				expect(channel).toBeLessThanOrEqual(255);
			}
		}
	});

	it("emits a valid SGR escape across the whole diagonal, with or without shine", () => {
		for (let i = 0; i <= 10; i++) {
			const t = i / 10;
			expect(gradientEscape(t)).toMatch(SGR_FG);
			expect(gradientEscape(t, { pos: 0.5, strength: 1 })).toMatch(SGR_FG);
		}
	});
});

describe("gradientLogo(AURA_LOGO)", () => {
	it("colors the wordmark without changing its glyphs", () => {
		const frame = gradientLogo(AURA_LOGO, 0);
		expect(frame).toHaveLength(AURA_LOGO.length);
		expect(frame.map(stripAnsi)).toEqual([...AURA_LOGO]);
		expect(frame.join("\n")).toMatch(SGR_FG);
	});

	it("animates: advancing the phase repaints the same glyphs differently", () => {
		const rest = gradientLogo(AURA_LOGO, 0).join("\n");
		const swept = gradientLogo(AURA_LOGO, 0.37).join("\n");
		expect(swept).not.toBe(rest);
		expect(stripAnsi(swept)).toBe(stripAnsi(rest));
	});

	it("animates: the shine overlay changes the painted colors", () => {
		const plain = gradientLogo(AURA_LOGO, 0).join("\n");
		const shined = gradientLogo(AURA_LOGO, 0, { pos: 0.5, strength: 1 }).join("\n");
		expect(shined).not.toBe(plain);
	});
});

describe("render sites show the aura wordmark", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("aura");
		if (!loaded) throw new Error("aura theme unavailable");
		setThemeInstance(loaded);
	});

	it("welcome box", () => {
		const rendered = new WelcomeComponent("1.2.3", "some-model", "some-provider").render(100);
		const text = rendered.map(stripAnsi).join("\n");
		for (const row of WORDMARK_ROWS) {
			expect(text).toContain(row);
		}
	});

	it("startup / setup splash (compact fallback)", () => {
		const text = renderSetupSplash(40, 12, 0).map(stripAnsi).join("\n");
		for (const row of WORDMARK_ROWS) {
			expect(text).toContain(row);
		}
		expect(text).toContain("a u r a");
		expect(text).not.toContain("O h   M y   P i");
	});

	it("setup outro", () => {
		const text = renderSetupOutro(80, 24, 0).map(stripAnsi).join("\n");
		for (const row of WORDMARK_ROWS) {
			expect(text).toContain(row);
		}
	});
});
