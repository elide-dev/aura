import { describe, expect, test } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { DaemonSnapshot, DaemonState } from "../src/launch/protocol";
import type { RuntimeLaunchDescriptor } from "../src/runtime/protocol";
import type { ToolSession } from "../src/tools";
import type { LaunchParams, LaunchToolDetails } from "../src/tools/hub/launch";
import { RuntimeDebugTool } from "../src/tools/runtime-debug";
import { matchRuntimeEndpoint, resolveWaitSeconds } from "../src/tools/runtime-launch";
import { RuntimeServeTool } from "../src/tools/runtime-serve";

// Kept in step with `transport/local.ts` by `runtime-spawn-endpoint.test.ts`,
// which asserts the descriptor the endpoint actually emits and scrapes the real
// 1.4.2 banners through it.
const CDP_RULES = [{ pattern: "ws://\\S+" }];
const DAP_RULES = [{ pattern: "listening on\\s+/?(\\S+)", group: 1 }];
const SERVE_RULES = [{ pattern: "Serving static files on\\s+(\\S+)", group: 1, prefix: "http://" }];

function descriptorFor(mode: "debug" | "serve", overrides: Partial<RuntimeLaunchDescriptor> = {}) {
	return {
		argv:
			mode === "debug"
				? ["/opt/runtime/bin/elide", "run", "--debugger=cdp", "-l", "ts", "/proj/app.ts"]
				: ["/opt/runtime/bin/elide", "serve", "/proj/public", "--no-tui"],
		cwd: "/proj",
		env: { NO_COLOR: "1" },
		endpointPattern: mode === "debug" ? CDP_RULES : SERVE_RULES,
		source: "managed" as const,
		...overrides,
	} satisfies RuntimeLaunchDescriptor;
}

function snapshot(state: DaemonState, name: string): DaemonSnapshot {
	return {
		name,
		id: "id",
		state,
		createdAt: 0,
		startedAt: 0,
		restartCount: 0,
		outputBytes: 0,
		persist: false,
		detached: false,
	};
}

interface FakeHub {
	calls: LaunchParams[];
	launch: (
		session: ToolSession,
		params: LaunchParams,
		signal?: AbortSignal,
	) => Promise<AgentToolResult<LaunchToolDetails>>;
}

/**
 * Stand-in for the hub operation: records calls and replays canned log output.
 * It simulates the broker's readiness half faithfully — it applies the `ready.log`
 * pattern the tool supplied (with the `u` flag the broker uses), reports the
 * matched text as `readyMatch`, and reports `timedOut` when nothing matched. A
 * fake that always said "ready" would hide exactly the wiring under test.
 *
 * `readySees` overrides what the readiness buffer saw, standing in for the case
 * where the banner matched there but is not in the startup lines read back.
 */
function fakeHub(opts: { logs: string; state?: DaemonState; readySees?: string }): FakeHub {
	const calls: LaunchParams[] = [];
	return {
		calls,
		launch: async (_session, params) => {
			calls.push(params);
			const state = opts.state ?? "ready";
			if (params.op === "start") {
				const readyRe = params.ready?.log === undefined ? undefined : new RegExp(params.ready.log, "u");
				const matched = readyRe?.exec(opts.readySees ?? opts.logs) ?? null;
				const daemon = snapshot(state, params.name ?? "");
				if (matched) daemon.readyMatch = matched[0].slice(0, 500);
				return {
					content: [{ type: "text", text: `Started ${params.name}: ${state}` }],
					details: { op: "start", daemon, timedOut: readyRe !== undefined && matched === null },
				};
			}
			// hub's own logs op appends a bracketed status marker after the output.
			return {
				content: [{ type: "text", text: `${opts.logs}\n[${params.name}: ${state}; cursor=42]` }],
				details: { op: "logs", state },
			};
		},
	};
}

function sessionWith(spawn: (params: unknown) => Promise<RuntimeLaunchDescriptor>, enabled = true): ToolSession {
	return {
		cwd: "/proj",
		settings: { get: (key: string) => (key === "runtime.enabled" ? enabled : undefined) },
		getRuntimeService: () => ({ spawn }) as never,
	} as unknown as ToolSession;
}

describe("matchRuntimeEndpoint", () => {
	test("scrapes a CDP inspector URL whole", () => {
		const out = "Debugger listening. Open ws://127.0.0.1:4242/abc-123 in DevTools.\n";
		expect(matchRuntimeEndpoint(out, CDP_RULES)).toBe("ws://127.0.0.1:4242/abc-123");
	});

	test("scrapes the DAP capture group, not the whole line", () => {
		expect(matchRuntimeEndpoint("DAP server listening on 127.0.0.1:4711\n", DAP_RULES)).toBe("127.0.0.1:4711");
	});

	test("prefixes a bare serve host:port with its scheme", () => {
		expect(matchRuntimeEndpoint("Serving static files on 127.0.0.1:8080\n", SERVE_RULES)).toBe(
			"http://127.0.0.1:8080",
		);
	});

	test("an already-schemed capture is passed through unprefixed", () => {
		expect(matchRuntimeEndpoint("Serving static files on http://0.0.0.0:9000\n", SERVE_RULES)).toBe(
			"http://0.0.0.0:9000",
		);
	});

	test("ANSI colouring in the banner does not defeat the scrape", () => {
		const coloured = "\u001b[32mServing static files on\u001b[0m 127.0.0.1:8080\n";
		expect(matchRuntimeEndpoint(coloured, SERVE_RULES)).toBe("http://127.0.0.1:8080");
	});

	test("output with no endpoint yields undefined rather than a guess", () => {
		expect(matchRuntimeEndpoint("Starting up...\nloading modules\n", SERVE_RULES)).toBeUndefined();
		expect(matchRuntimeEndpoint("", CDP_RULES)).toBeUndefined();
	});

	test("rules are tried in order and an unparseable pattern is skipped, not thrown", () => {
		const rules = [{ pattern: "([" }, ...SERVE_RULES];
		expect(matchRuntimeEndpoint("Serving static files on 127.0.0.1:8080", rules)).toBe("http://127.0.0.1:8080");
	});

	test("a pattern that is only invalid under the `u` flag is skipped too", () => {
		// The broker compiles readiness patterns with "u", so the scraper must agree
		// on validity or the two disagree about which rules exist. (Built from a
		// variable: as a literal this source would not parse at all.)
		const uOnlyInvalid = "\\p{";
		expect(() => new RegExp(uOnlyInvalid)).not.toThrow();
		expect(() => new RegExp(uOnlyInvalid, "u")).toThrow();
		expect(
			matchRuntimeEndpoint("Serving static files on 127.0.0.1:8080", [{ pattern: "\\p{" }, ...SERVE_RULES]),
		).toBe("http://127.0.0.1:8080");
	});

	test("the real Graal DAP banner yields a bare host:port, with the leading slash dropped", () => {
		// 1.4.2 prints Java's InetSocketAddress formatting, which includes a `/`.
		// `/0.0.0.0:4711` is not something a DAP client can attach to.
		const banner = "[Graal DAP] Starting server and listening on /0.0.0.0:4711\n";
		expect(matchRuntimeEndpoint(banner, DAP_RULES)).toBe("0.0.0.0:4711");
	});

	test("a DAP banner without the slash still parses", () => {
		expect(matchRuntimeEndpoint("DAP listening on 127.0.0.1:4711\n", DAP_RULES)).toBe("127.0.0.1:4711");
	});

	test("the real CDP banner still resolves to the ws:// URL, not the surrounding words", () => {
		const banner =
			"Debugger listening on ws://127.0.0.1:9229/0dc12963/inspect\n" +
			"For help, see: https://www.graalvm.org/tools/chrome-debugger\n";
		expect(matchRuntimeEndpoint(banner, CDP_RULES)).toBe("ws://127.0.0.1:9229/0dc12963/inspect");
	});
});

describe("resolveWaitSeconds", () => {
	test("defaults, clamps, and rounds", () => {
		expect(resolveWaitSeconds(undefined)).toBe(15);
		expect(resolveWaitSeconds(Number.NaN)).toBe(15);
		expect(resolveWaitSeconds(0)).toBe(1);
		expect(resolveWaitSeconds(-5)).toBe(1);
		expect(resolveWaitSeconds(2.4)).toBe(2);
		expect(resolveWaitSeconds(10_000)).toBe(300);
	});
});

describe("runtime_debug", () => {
	test("is discoverable, exec-approved, gated on runtime.enabled, and not named `debug`", () => {
		const session = sessionWith(async () => descriptorFor("debug"));
		expect(RuntimeDebugTool.createIf(sessionWith(async () => descriptorFor("debug"), false))).toBeNull();
		const tool = RuntimeDebugTool.createIf(session);
		expect(tool).not.toBeNull();
		expect(tool!.name).toBe("runtime_debug");
		expect(tool!.name).not.toBe("debug");
		expect(tool!.loadMode).toBe("discoverable");
		expect(tool!.approval).toBe("exec");
	});

	test("starts the descriptor through hub, without a PTY, and returns the scraped endpoint", async () => {
		const hub = fakeHub({ logs: "Debugger listening on ws://127.0.0.1:4242/tab-1" });
		let spawned: unknown;
		const tool = new RuntimeDebugTool(
			sessionWith(async params => {
				spawned = params;
				return descriptorFor("debug");
			}),
			hub.launch,
		);
		const result = await tool.execute("id", { path: "app.ts" });
		expect(spawned).toMatchObject({ mode: "debug", path: "app.ts", protocol: "cdp", cwd: "/proj" });

		const start = hub.calls[0]!;
		expect(start.op).toBe("start");
		expect(start.application).toBe("/opt/runtime/bin/elide");
		expect(start.args).toEqual(["run", "--debugger=cdp", "-l", "ts", "/proj/app.ts"]);
		expect(start.cwd).toBe("/proj");
		expect(start.env).toEqual({ NO_COLOR: "1" });
		expect(start.pty).toBe(false);
		// hub's own readiness wait does the waiting; the pattern is the descriptor's.
		expect(start.ready).toEqual({ log: "(?:ws://\\S+)", timeout: 15 });
		expect(hub.calls[1]).toMatchObject({ op: "logs", name: start.name, head: true });

		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("ws://127.0.0.1:4242/tab-1");
		expect(text).toContain("Chrome DevTools");
		expect(text).toContain(`hub {op:"stop", name:"${start.name}"}`);
		expect(result.details).toMatchObject({
			mode: "debug",
			jobName: start.name,
			endpoint: "ws://127.0.0.1:4242/tab-1",
			timedOut: false,
		});
		// The startup output the model sees is the process's own, without hub's marker.
		expect(result.details?.startupOutput).not.toContain("cursor=42");
	});

	test("the dap protocol threads through and uses the dap attach hint", async () => {
		const hub = fakeHub({ logs: "DAP listening on 127.0.0.1:4711" });
		const tool = new RuntimeDebugTool(
			sessionWith(async () => descriptorFor("debug", { endpointPattern: DAP_RULES })),
			hub.launch,
		);
		const result = await tool.execute("id", { path: "app.ts", protocol: "dap" });
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("DAP debugger listening at 127.0.0.1:4711");
		expect(text).toContain("VS Code");
	});

	test("no endpoint in the wait window returns the job plus startup output, not an error", async () => {
		const hub = fakeHub({ logs: "warming up\nresolving imports", state: "running" });
		const tool = new RuntimeDebugTool(
			sessionWith(async () => descriptorFor("debug")),
			hub.launch,
		);
		const result = await tool.execute("id", { path: "app.ts", waitSeconds: 3 });
		const text = (result.content[0] as { text: string }).text;
		expect(result.isError).toBeUndefined();
		expect(text).toContain("did not report an endpoint within the wait window (3s)");
		expect(text).toContain("it may still be starting");
		expect(text).toContain("Startup output:\nwarming up\nresolving imports");
		expect(text).toContain(hub.calls[0]!.name!);
		expect(result.details).toMatchObject({ timedOut: true, state: "running" });
		expect(result.details?.endpoint).toBeUndefined();
	});

	test("the endpoint comes from hub's matched line even when the banner is not in the log read", async () => {
		// The readiness buffer saw the banner; the startup lines read back did not
		// (a busy process scrolls it past the first 200 lines).
		const hub = fakeHub({
			logs: "line1\nline2\nline3",
			readySees: "Debugger listening on ws://127.0.0.1:9229/deep/inspect",
		});
		const tool = new RuntimeDebugTool(
			sessionWith(async () => descriptorFor("debug")),
			hub.launch,
		);
		const result = await tool.execute("id", { path: "app.ts" });
		expect(result.details?.endpoint).toBe("ws://127.0.0.1:9229/deep/inspect");
		expect(result.details?.readyMatch).toBe("ws://127.0.0.1:9229/deep/inspect");
		expect(result.details?.timedOut).toBe(false);
	});

	test("a banner that matches but yields no endpoint is reported as a stale rule, not a timeout", async () => {
		// A rule whose capture group can match empty: readiness fires, extraction
		// does not. Conflating this with a timeout is what hides a bad rule.
		const rules = [{ pattern: "listening(.*)", group: 1 }];
		const hub = fakeHub({ logs: "listening" });
		const tool = new RuntimeDebugTool(
			sessionWith(async () => descriptorFor("debug", { endpointPattern: rules })),
			hub.launch,
		);
		const result = await tool.execute("id", { path: "app.ts" });
		const text = (result.content[0] as { text: string }).text;
		expect(result.details?.endpoint).toBeUndefined();
		expect(result.details?.timedOut).toBe(false);
		expect(result.details?.readyMatch).toBe("listening");
		expect(text).toContain("no endpoint could be extracted");
		expect(text).toContain("scraping rule is probably stale");
		expect(text).not.toContain("wait window");
	});

	test("without the hub tool the guidance names only remedies that actually exist", async () => {
		const hub = fakeHub({ logs: "Debugger listening on ws://127.0.0.1:9229/x" });
		const session = sessionWith(async () => descriptorFor("debug"));
		(session as { isToolActive?: (name: string) => boolean }).isToolActive = name => name !== "hub";
		const result = await new RuntimeDebugTool(session, hub.launch).execute("id", { path: "app.ts" });
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("no hub tool");
		// Must not name a tool the session lacks...
		expect(text).not.toContain('hub {op:"stop"');
		// ...and must not name `/jobs`, which lists async tool jobs (read-only) and
		// never broker daemons — it can neither show nor stop this job.
		expect(text).not.toContain("/jobs");
		// The remedies that are true: the broker takes non-detached daemons down with
		// it, and a session with hub can stop it.
		expect(text).toContain("background broker exits");
		expect(text).toContain("session that has hub");
		expect(text).toMatch(/out of band/);
		// The endpoint is still reported — only the lifecycle advice changes.
		expect(result.details?.endpoint).toBe("ws://127.0.0.1:9229/x");
	});

	test("the hub-less caveat also reaches the no-endpoint and failed-launch bodies", async () => {
		const session = sessionWith(async () => descriptorFor("debug"));
		(session as { isToolActive?: (name: string) => boolean }).isToolActive = name => name !== "hub";
		for (const hub of [fakeHub({ logs: "warming up", state: "running" }), fakeHub({ logs: "", state: "failed" })]) {
			const result = await new RuntimeDebugTool(session, hub.launch).execute("id", { path: "app.ts" });
			const text = (result.content[0] as { text: string }).text;
			expect(text).not.toContain("/jobs");
			expect(text).toContain("background broker exits");
		}
	});

	test("a failed launch is reported as an error, with the job name kept", async () => {
		const hub = fakeHub({ logs: "", state: "failed" });
		const tool = new RuntimeDebugTool(
			sessionWith(async () => descriptorFor("debug")),
			hub.launch,
		);
		const result = await tool.execute("id", { path: "app.ts" });
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text).toContain(hub.calls[0]!.name!);
		// No log read is attempted for a process that never started.
		expect(hub.calls.map(c => c.op)).toEqual(["start"]);
	});

	test("a PATH-resolved binary surfaces the shim note", async () => {
		const hub = fakeHub({ logs: "ws://127.0.0.1:4242/x" });
		const tool = new RuntimeDebugTool(
			sessionWith(async () => descriptorFor("debug", { source: "path", shimWarning: "wrapper script warning" })),
			hub.launch,
		);
		const result = await tool.execute("id", { path: "app.ts" });
		expect((result.content[0] as { text: string }).text).toContain("Note: wrapper script warning");
	});

	test("throws the standard explanation when the session has no runtime service", async () => {
		const tool = new RuntimeDebugTool({
			cwd: "/proj",
			settings: { get: () => true },
			getRuntimeService: () => undefined,
		} as unknown as ToolSession);
		await expect(tool.execute("id", { path: "app.ts" })).rejects.toThrow(/runtime service is unavailable/);
	});
});

describe("serve", () => {
	test("is discoverable, exec-approved, and gated on runtime.enabled", () => {
		expect(RuntimeServeTool.createIf(sessionWith(async () => descriptorFor("serve"), false))).toBeNull();
		const tool = RuntimeServeTool.createIf(sessionWith(async () => descriptorFor("serve")));
		expect(tool!.name).toBe("serve");
		expect(tool!.loadMode).toBe("discoverable");
		expect(tool!.approval).toBe("exec");
	});

	test("forwards directory/port/host and reports the scraped URL with the job handle", async () => {
		const hub = fakeHub({ logs: "Serving static files on 127.0.0.1:8080" });
		let spawned: unknown;
		const tool = new RuntimeServeTool(
			sessionWith(async params => {
				spawned = params;
				return descriptorFor("serve");
			}),
			hub.launch,
		);
		const result = await tool.execute("id", { directory: "public", port: 8080, host: "127.0.0.1" });
		expect(spawned).toMatchObject({ mode: "serve", directory: "public", port: 8080, host: "127.0.0.1" });
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Serving /proj/public at http://127.0.0.1:8080");
		expect(text).toContain(`hub {op:"logs", name:"${hub.calls[0]!.name}"}`);
		expect(result.details).toMatchObject({ mode: "serve", endpoint: "http://127.0.0.1:8080", timedOut: false });
	});

	test("no URL in the wait window falls back to the startup output", async () => {
		const hub = fakeHub({ logs: "binding socket", state: "running" });
		const tool = new RuntimeServeTool(
			sessionWith(async () => descriptorFor("serve")),
			hub.launch,
		);
		const result = await tool.execute("id", { directory: "public" });
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("The static file server did not report an endpoint within the wait window (15s)");
		expect(text).toContain("Startup output:\nbinding socket");
		expect(result.isError).toBeUndefined();
	});

	test("job names are distinct per call, so concurrent servers never collide", async () => {
		const hub = fakeHub({ logs: "Serving static files on 127.0.0.1:8080" });
		const tool = new RuntimeServeTool(
			sessionWith(async () => descriptorFor("serve")),
			hub.launch,
		);
		const a = await tool.execute("id", { directory: "public" });
		const b = await tool.execute("id", { directory: "public" });
		expect(a.details?.jobName).not.toBe(b.details?.jobName);
		for (const name of [a.details?.jobName, b.details?.jobName]) {
			expect(name).toMatch(/^runtime-serve-[0-9a-f]{8}$/);
			// hub caps launch names at 48 characters.
			expect(name!.length).toBeLessThanOrEqual(48);
		}
	});
});
