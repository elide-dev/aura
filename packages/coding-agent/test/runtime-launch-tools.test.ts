import { describe, expect, test } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { DaemonSnapshot, DaemonState } from "../src/launch/protocol";
import type { RuntimeLaunchDescriptor } from "../src/runtime/protocol";
import { BUILTIN_TOOLS, type ToolSession } from "../src/tools";
import type { LaunchParams, LaunchToolDetails } from "../src/tools/hub/launch";
import { matchRuntimeEndpoint, resolveWaitSeconds } from "../src/tools/runtime-launch";
import { RuntimeServeTool } from "../src/tools/runtime-serve";

// Kept in step with `transport/local.ts` by `runtime-spawn-endpoint.test.ts`,
// which asserts the descriptor the endpoint actually emits and scrapes the real
// 1.4.2 banners through it.
const SERVE_RULES = [{ pattern: "Serving static files on\\s+(\\S+)", group: 1, prefix: "http://" }];

function descriptorFor(overrides: Partial<RuntimeLaunchDescriptor> = {}) {
	return {
		argv: ["/opt/runtime/bin/elide", "serve", "/proj/public", "--no-tui"],
		cwd: "/proj",
		env: { NO_COLOR: "1" },
		endpointPattern: SERVE_RULES,
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

interface SessionGates {
	/** `runtime.enabled`: the fork's own gate on every runtime tool. */
	runtime?: boolean;
	/** `launch.enabled`: upstream's kill switch for process supervision. */
	launch?: boolean;
}

function sessionWith(
	spawn: (params: unknown) => Promise<RuntimeLaunchDescriptor>,
	gates: SessionGates = {},
): ToolSession {
	const { runtime = true, launch = true } = gates;
	return {
		cwd: "/proj",
		settings: {
			get: (key: string) => {
				if (key === "runtime.enabled") return runtime;
				if (key === "launch.enabled") return launch;
				return undefined;
			},
		},
		getRuntimeService: () => ({ spawn }) as never,
	} as unknown as ToolSession;
}

describe("matchRuntimeEndpoint", () => {
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
		expect(matchRuntimeEndpoint("", SERVE_RULES)).toBeUndefined();
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

describe("serve", () => {
	test("is discoverable, exec-approved, and gated on runtime.enabled", () => {
		expect(RuntimeServeTool.createIf(sessionWith(async () => descriptorFor(), { runtime: false }))).toBeNull();
		const tool = RuntimeServeTool.createIf(sessionWith(async () => descriptorFor()));
		expect(tool!.name).toBe("serve");
		expect(tool!.loadMode).toBe("discoverable");
		expect(tool!.approval).toBe("exec");
	});

	/**
	 * `launch.enabled=false` is upstream's kill switch for process supervision, and
	 * hub honors it (`tools/hub/index.ts`). serve starts a hub job through the same
	 * broker, so a session that disabled supervision must not get a second door to
	 * it — the gate belongs on the tool's existence, not on an error at call time.
	 */
	test("is withheld entirely when launch.enabled is false", () => {
		const session = sessionWith(async () => descriptorFor(), { launch: false });
		expect(RuntimeServeTool.createIf(session)).toBeNull();
		// Through the registry the session actually builds from, not just the factory.
		expect(BUILTIN_TOOLS.serve(session)).toBeNull();
	});

	/**
	 * The guidance serve prints names the tool that reads and stops the job. With
	 * supervision disabled, `hub` refuses every launch op, so pointing the model at
	 * `hub {op:"logs"}` is a dead end — the hub-less branch is the honest one.
	 */
	test("never advertises hub when supervision is disabled", async () => {
		const hub = fakeHub({ logs: "Serving static files on 127.0.0.1:8080" });
		const tool = new RuntimeServeTool(
			sessionWith(async () => descriptorFor(), { launch: false }),
			hub.launch,
		);
		const result = await tool.execute("id", { directory: "public" });
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Serving /proj/public at http://127.0.0.1:8080");
		expect(text).not.toContain("hub {op:");
		expect(text).toContain("hub is not reachable in this session");
	});

	test("forwards directory/port/host and reports the scraped URL with the job handle", async () => {
		const hub = fakeHub({ logs: "Serving static files on 127.0.0.1:8080" });
		let spawned: unknown;
		const tool = new RuntimeServeTool(
			sessionWith(async params => {
				spawned = params;
				return descriptorFor();
			}),
			hub.launch,
		);
		const result = await tool.execute("id", { directory: "public", port: 8080, host: "127.0.0.1" });
		expect(spawned).toEqual({ directory: "public", port: 8080, host: "127.0.0.1", cwd: "/proj" });
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Serving /proj/public at http://127.0.0.1:8080");
		expect(text).toContain(`hub {op:"logs", name:"${hub.calls[0]!.name}"}`);
		expect(result.details).toMatchObject({ endpoint: "http://127.0.0.1:8080", timedOut: false });
	});

	test("no URL in the wait window falls back to the startup output", async () => {
		const hub = fakeHub({ logs: "binding socket", state: "running" });
		const tool = new RuntimeServeTool(
			sessionWith(async () => descriptorFor()),
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
			sessionWith(async () => descriptorFor()),
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
