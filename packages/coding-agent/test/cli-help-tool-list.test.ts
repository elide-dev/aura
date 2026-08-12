/**
 * `--help` may only advertise tools that exist.
 *
 * The "Available Tools" block is a hand-curated summary, not the registry, so it
 * is allowed to be a subset — but never a superset. A name listed here that no
 * factory answers to sends the model (and the user reading `--tools`) after
 * something uncallable, which is how the retired `run` row survived its own
 * tool. `BUILTIN_TOOL_NAMES` is the authority, so the check derives from it
 * rather than restating a list.
 */
import { describe, expect, test } from "bun:test";
import { getExtraHelpText } from "@oh-my-pi/pi-coding-agent/cli/args";
import { BUILTIN_TOOL_NAMES, HIDDEN_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/builtin-names";

/** The tool names the "Available Tools" block advertises, in listed order. */
function advertisedToolNames(): string[] {
	const help = getExtraHelpText();
	const afterHeader = help.split("Available Tools")[1];
	expect(afterHeader).toBeDefined();
	const block = afterHeader!.split("Plugin Options")[0]!;
	return [...block.matchAll(/^ {2}(\S+)\s+- /gm)].map(match => match[1]!);
}

describe("--help tool list", () => {
	test("advertises only names the builtin registry actually answers to", () => {
		const known = new Set<string>([...BUILTIN_TOOL_NAMES, ...HIDDEN_TOOL_NAMES]);
		expect(advertisedToolNames().filter(name => !known.has(name))).toEqual([]);
	});

	test("advertises the execution surface that replaced the retired run tool", () => {
		const advertised = advertisedToolNames();
		expect(advertised).toContain("eval");
		expect(advertised).not.toContain("run");
		expect(advertised).not.toContain("check");
	});

	test("the block is non-trivially populated, so an empty parse cannot pass it", () => {
		expect(advertisedToolNames().length).toBeGreaterThan(10);
	});
});
