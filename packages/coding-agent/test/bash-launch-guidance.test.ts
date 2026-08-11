/**
 * `bash`'s description must not order the model to use `hub` when `hub` will
 * refuse.
 *
 * The `hasLaunch` flag renders "Services, watchers, debuggers, and REPLs MUST
 * use `hub`". `launch.enabled=false` makes hub reject every supervision op
 * (`tools/hub/index.ts`), so with the switch off that line is an instruction to
 * call something guaranteed to fail — and it is a MUST, so the model has no
 * sanctioned alternative for starting a service.
 *
 * The gate has two independent halves — does the session have the tool, and is
 * supervision enabled — so they compose with AND. Passing the setting as
 * `isToolActive`'s FALLBACK (what this used to do) applies it only to sessions
 * that have no `isToolActive` at all, which is precisely the case where the
 * question does not arise; every real session went through `createTools` and so
 * ignored the kill switch entirely.
 */
import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";

/** The rendered line the `hasLaunch` flag controls. */
const LAUNCH_GUIDANCE = "MUST use `hub`";

interface SessionShape {
	/** Omitted entirely to model a session that never went through `createTools`. */
	activeTools?: readonly string[];
	launchEnabled?: boolean;
}

function makeSession(shape: SessionShape): ToolSession {
	const { activeTools, launchEnabled = true } = shape;
	return {
		cwd: os.tmpdir(),
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: {
			get(key: string) {
				if (key === "launch.enabled") return launchEnabled;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				return undefined;
			},
			getBashInterceptorRules: () => [],
			getShellConfig: () => ({ shell: "/bin/bash", args: ["-l", "-c"], env: {}, prefix: undefined }),
		},
		...(activeTools === undefined ? {} : { isToolActive: (name: string) => activeTools.includes(name) }),
	} as unknown as ToolSession;
}

describe("bash launch guidance", () => {
	it("tells the model to use hub when the session has it and supervision is on", () => {
		const description = new BashTool(makeSession({ activeTools: ["hub"] })).description;
		expect(description).toContain(LAUNCH_GUIDANCE);
	});

	it("drops the guidance when launch.enabled is false, even though hub is active", () => {
		const description = new BashTool(makeSession({ activeTools: ["hub"], launchEnabled: false })).description;
		expect(description).not.toContain(LAUNCH_GUIDANCE);
	});

	it("drops the guidance when the session has no hub tool", () => {
		const description = new BashTool(makeSession({ activeTools: ["read"] })).description;
		expect(description).not.toContain(LAUNCH_GUIDANCE);
	});

	/**
	 * No `isToolActive` (a bare SDK/test session) keeps assuming the tool is there
	 * — that is what the fallback was always for — but the kill switch still
	 * applies, because it is a setting the session can answer either way.
	 */
	it("assumes hub exists without isToolActive, but still honors the kill switch", () => {
		expect(new BashTool(makeSession({})).description).toContain(LAUNCH_GUIDANCE);
		expect(new BashTool(makeSession({ launchEnabled: false })).description).not.toContain(LAUNCH_GUIDANCE);
	});
});
