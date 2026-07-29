import { afterAll, describe, expect, it } from "bun:test";
import { renderSegment } from "../src/modes/components/status-line/segments";
import type { SegmentContext } from "../src/modes/components/status-line/types";
import { getThemeByName, initTheme, theme } from "../src/modes/theme/theme";

afterAll(async () => {
	await initTheme();
});

describe("compact Aura brand symbol", () => {
	it("uses the sun mark in Unicode and Nerd presets with an ASCII fallback", async () => {
		for (const [preset, expected] of [
			["unicode", "☉"],
			["nerd", "☉"],
			["ascii", "o"],
		] as const) {
			await initTheme(false, preset);
			expect(theme.icon.pi).toBe(expected);
		}
	});

	it("renders the interactive prompt prefix with the sun mark", async () => {
		await initTheme(false, "unicode");
		const content = renderSegment("pi", { focusedAgentId: undefined } as SegmentContext).content;
		expect(content).toContain("☉ ");
	});

	it("uses the sun mark in bundled Poimandres themes", async () => {
		expect((await getThemeByName("dark-poimandres"))?.symbol("icon.pi")).toBe("☉");
		expect((await getThemeByName("light-poimandres"))?.symbol("icon.pi")).toBe("☉");
	});
});
