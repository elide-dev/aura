/**
 * `doctor` must be a real subcommand, not an argv that leaks to the model as a
 * prompt (the #1496 class of regression the command table guards against).
 */
import { describe, expect, test } from "bun:test";
import { commands, isSubcommand, resolveCliArgv } from "@oh-my-pi/pi-coding-agent/cli-commands";

describe("doctor command registration", () => {
	test("doctor is registered in the command table", () => {
		expect(commands.some(entry => entry.name === "doctor")).toBe(true);
	});

	test("the command table stays alphabetical around doctor", () => {
		const names = commands.map(entry => entry.name);
		expect(names.indexOf("doctor")).toBeGreaterThan(names.indexOf("config"));
		expect(names.indexOf("doctor")).toBeLessThan(names.indexOf("dry-balance"));
	});

	test("`doctor` routes to the subcommand instead of launch", () => {
		expect(isSubcommand("doctor")).toBe(true);
		expect(resolveCliArgv(["doctor"])).toEqual({ argv: ["doctor"] });
		expect(resolveCliArgv(["doctor", "--json"])).toEqual({ argv: ["doctor", "--json"] });
	});

	test("the doctor module exposes a Command with json and check flags", async () => {
		const entry = commands.find(e => e.name === "doctor");
		if (!entry) throw new Error("doctor entry missing");
		const command = (await entry.load()) as { flags: Record<string, unknown>; description: string };
		expect(Object.keys(command.flags)).toEqual(["json", "check"]);
		expect(command.description.toLowerCase()).not.toContain("elide");
	});
});
