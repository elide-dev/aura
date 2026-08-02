import { fileURLToPath } from "node:url";

/**
 * Whether the Chromium puppeteer resolves can actually execute on this host.
 * CI runners without Chrome's system libraries (libnspr4 & co.) hold the
 * downloaded binary but cannot exec it — probe with --version and skip
 * instead of failing.
 *
 * The probe runs in a child process rather than as a top-level await here:
 * `bun test --parallel` (how CI runs every coding-agent bucket) evaluates a
 * test file without first settling the top-level await of a module it imports,
 * so an `export const X = await …` gate blows up as
 * "Cannot access 'X' before initialization" at the `describe.skipIf(!X)` call.
 * Keeping this module fully synchronous sidesteps that entirely.
 */
function chromiumCanLaunch(): boolean {
	try {
		const child = fileURLToPath(new URL("./chromium-probe-child.ts", import.meta.url));
		const probe = Bun.spawnSync([process.execPath, "run", child], {
			stdout: "ignore",
			stderr: "ignore",
			// A cold host downloads Chromium inside the child; bound it so a wedged
			// or offline download degrades to "skip these tests", not a hung suite.
			timeout: 300_000,
		});
		return probe.exitCode === 0;
	} catch {
		return false;
	}
}

/** Gate for tests that launch a real Chromium: `describe.skipIf(!CHROMIUM_AVAILABLE)`. */
export const CHROMIUM_AVAILABLE = chromiumCanLaunch();
