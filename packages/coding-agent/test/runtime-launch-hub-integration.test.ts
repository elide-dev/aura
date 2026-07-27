/**
 * End-to-end coverage of the P4 claim: a `runtime/spawn` descriptor started
 * through the real `hub` supervisor, with the endpoint scraped out of hub's own
 * log stream, and `hub stop` as the only lifecycle control needed.
 *
 * The runtime binary is faked (a shell script that prints a serve banner and
 * then waits), because what is under test is the wiring, not the runtime. The
 * broker is real: it is keyed to a temp project directory, and every test stops
 * its job and shuts the broker down.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeDaemonClients, daemonClientForProject } from "../src/launch/client";
import { RuntimeService } from "../src/runtime/service";
import { LocalRuntimeEndpoint } from "../src/runtime/transport/local";
import type { ToolSession } from "../src/tools";
import { executeLaunch } from "../src/tools/hub/launch";
import { RuntimeServeTool } from "../src/tools/runtime-serve";

const projectDirs: string[] = [];

afterEach(async () => {
	for (const dir of projectDirs) {
		try {
			const client = await daemonClientForProject(dir);
			await client.request({ op: "shutdown" });
		} catch {
			// Already gone; the last-client shutdown may have raced us.
		}
	}
	await closeDaemonClients();
	for (const dir of projectDirs) await fs.rm(dir, { recursive: true, force: true });
	projectDirs.length = 0;
});

/**
 * A stand-in runtime: prints `banner` (with `$PORT` substituted from the argv it
 * was handed) and then waits, the way a real server does.
 */
async function fakeRuntime(dir: string, banner: string): Promise<string> {
	const bin = path.join(dir, "elide");
	await fs.writeFile(
		bin,
		`#!/bin/sh\nport=""\nwhile [ $# -gt 0 ]; do\n  if [ "$1" = "--port" ]; then port="$2"; fi\n  shift\ndone\n` +
			`printf '%s\\n' "${banner}"\nwhile true; do sleep 1; done\n`,
		{ mode: 0o755 },
	);
	return bin;
}

async function scenario(banner: string): Promise<{ session: ToolSession; tool: RuntimeServeTool; dir: string }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aura-hub-serve-"));
	projectDirs.push(dir);
	await fs.mkdir(path.join(dir, "public"));
	const bin = await fakeRuntime(dir, banner);
	const service = new RuntimeService(new LocalRuntimeEndpoint({ explicitPath: bin, autoDownload: false }));
	const session = {
		cwd: dir,
		settings: { get: (key: string) => key === "runtime.enabled" },
		getRuntimeService: () => service,
		getSessionId: () => "runtime-launch-integration",
	} as unknown as ToolSession;
	return { session, tool: new RuntimeServeTool(session), dir };
}

describe("serve through the real hub broker", () => {
	test("scrapes the endpoint from hub's log stream and stops with hub stop", async () => {
		const { session, tool, dir } = await scenario("Serving static files on 127.0.0.1:$port");
		const result = await tool.execute("id", { directory: "public", port: 45_711, waitSeconds: 30 });
		const jobName = result.details?.jobName;
		expect(jobName).toBeDefined();
		expect(result.isError).toBeUndefined();
		expect(result.details?.endpoint).toBe("http://127.0.0.1:45711");
		expect(result.details?.timedOut).toBe(false);
		expect((result.content[0] as { text: string }).text).toContain(`Serving ${path.join(dir, "public")} at`);

		// The handle is a hub job name, so the ordinary hub ops work on it.
		const described = await executeLaunch(session, { op: "describe", name: jobName! });
		expect((described.content[0] as { text: string }).text).toContain("serve");
		const stopped = await executeLaunch(session, { op: "stop", name: jobName! });
		expect((stopped.content[0] as { text: string }).text).toContain("Stopped");
		const listed = await executeLaunch(session, { op: "list" });
		expect((listed.content[0] as { text: string }).text).not.toContain("running");
	}, 120_000);

	test("a banner the rules do not match returns the job plus its startup output", async () => {
		const { session, tool } = await scenario("still warming up, no url yet");
		const result = await tool.execute("id", { directory: "public", port: 45_712, waitSeconds: 2 });
		const jobName = result.details?.jobName;
		expect(result.isError).toBeUndefined();
		expect(result.details?.endpoint).toBeUndefined();
		expect(result.details?.timedOut).toBe(true);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("did not report an endpoint within the wait window (2s)");
		expect(text).toContain("still warming up, no url yet");
		// Still a live job: the fallback is a report, not a failure.
		expect(result.details?.state).toBe("starting");
		await executeLaunch(session, { op: "stop", name: jobName! });
	}, 120_000);
});
