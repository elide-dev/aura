import { describe, expect, test } from "bun:test";
import { APP_NAME, CONFIG_DIR_NAME } from "../src/dirs";

describe("aura branding", () => {
	test("app name is aura", () => {
		expect(APP_NAME).toBe("aura");
	});
	test("config dir is .aura", () => {
		expect(CONFIG_DIR_NAME).toBe(".aura");
	});
});
