/**
 * `--help` documents the canonical profile env var.
 *
 * `AURA_PROFILE` is the canonical variable since the rebrand (`OMP_PROFILE` and
 * `PI_PROFILE` are legacy fallbacks), so it must be listed first. The
 * `agents unpack` examples must name the branded config dir, which is the only
 * dir that command writes to.
 */
import { expect, test } from "bun:test";
import { getExtraHelpText } from "@oh-my-pi/pi-coding-agent/cli/args";
import { CONFIG_DIR_NAME, LEGACY_CONFIG_DIR_NAME } from "@oh-my-pi/pi-utils";

test("help lists AURA_PROFILE before the legacy OMP_PROFILE", () => {
	const help = getExtraHelpText();
	const aura = help.indexOf("AURA_PROFILE");
	const omp = help.indexOf("OMP_PROFILE");
	expect(aura).toBeGreaterThan(-1);
	expect(omp).toBeGreaterThan(-1);
	expect(aura).toBeLessThan(omp);
});

test("help documents the branded agents-unpack targets, not the legacy dir", () => {
	const help = getExtraHelpText();
	expect(help).toContain(`${CONFIG_DIR_NAME}/agent/agents`);
	expect(help).toContain(`./${CONFIG_DIR_NAME}/agents`);
	expect(help).not.toContain(`${LEGACY_CONFIG_DIR_NAME}/agents`);
});
