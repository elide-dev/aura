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

let probe: boolean | undefined;

/**
 * Gate for tests that launch a real Chromium:
 *
 *     const CHROMIUM_AVAILABLE = await chromiumAvailable();
 *     describe.skipIf(!CHROMIUM_AVAILABLE)(…);
 *
 * A function rather than an awaited `export const`: a module whose exports are
 * initialized by top-level await hands the test runner a binding that is still
 * in its temporal dead zone when a second test file in the same process imports
 * it, and that file dies during registration with "Cannot access
 * 'CHROMIUM_AVAILABLE' before initialization". Awaiting in the importer makes
 * the wait part of that file's own evaluation, which the runner does sequence.
 *
 * The probe itself is synchronous (see {@link chromiumCanLaunch}) and runs once
 * per process; the promise exists only to keep the importer-side `await`.
 */
export function chromiumAvailable(): Promise<boolean> {
	probe ??= chromiumCanLaunch();
	return Promise.resolve(probe);
}
