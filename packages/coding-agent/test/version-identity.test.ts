import { describe, expect, test } from "bun:test";
import { APP_NAME, VERSION } from "@oh-my-pi/pi-utils/dirs";
import { formatVersionIdentity } from "../src/cli/version-identity";
import { RUNTIME_PROTOCOL_VERSION } from "../src/runtime/protocol";

describe("--version identity", () => {
	test("the first line stays exactly what the CLI runner has always printed", () => {
		const lines = formatVersionIdentity().split("\n");
		expect(lines[0]).toBe(`${APP_NAME}/${VERSION}`);
	});

	test("a second line names the runtime protocol version, matching `aura runtime status`", () => {
		const lines = formatVersionIdentity().split("\n");
		expect(lines[1]).toBe(`runtime protocol v${RUNTIME_PROTOCOL_VERSION}`);
		expect(lines).toHaveLength(2);
	});

	test("the bin name is overridable so a profile alias identifies itself", () => {
		expect(formatVersionIdentity("aura-work").split("\n")[0]).toBe(`aura-work/${VERSION}`);
	});

	test("no product name for the runtime vendor leaks into the identity", () => {
		expect(formatVersionIdentity().toLowerCase()).not.toContain("elide");
	});
});
