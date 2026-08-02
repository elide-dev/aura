import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";

/**
 * Child half of the Chromium launchability probe. Resolves (downloading if
 * needed) the executable puppeteer would launch and execs it with --version;
 * exit 0 means a real headless Chromium can run on this host.
 *
 * This lives in its own process because the parent must answer synchronously —
 * see chromium-probe.ts.
 */
const executable = await ensureChromiumExecutable();
if (!executable) process.exit(1);
process.exit(Bun.spawnSync([executable, "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode ?? 1);
