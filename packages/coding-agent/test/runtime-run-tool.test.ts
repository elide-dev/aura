import { describe, expect, test, vi } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	acquireRuntimeServiceLease,
	disposeCachedRuntimeService,
	getOrCreateRuntimeService,
	type RuntimeServiceScope,
} from "../src/runtime";
import { formatExecResult } from "../src/runtime/format";
import { type RuntimeExecResult, RuntimeRpcError } from "../src/runtime/protocol";
import type { ToolSession } from "../src/tools";
import { wrapToolWithMetaNotice } from "../src/tools/output-meta";
import { RuntimeRunTool } from "../src/tools/runtime-run";

function sessionWith(overrides: { enabled?: boolean; run?: (p: unknown) => Promise<RuntimeExecResult> }): ToolSession {
	const service = overrides.run ? { run: overrides.run } : undefined;
	return {
		settings: { get: (key: string) => (key === "runtime.enabled" ? (overrides.enabled ?? true) : undefined) },
		getRuntimeService: () => (overrides.enabled === false ? undefined : (service as never)),
	} as unknown as ToolSession;
}

describe("run tool", () => {
	test("createIf returns null when runtime.enabled is false", () => {
		expect(RuntimeRunTool.createIf(sessionWith({ enabled: false }))).toBeNull();
	});

	test("createIf constructs when enabled", () => {
		const tool = RuntimeRunTool.createIf(sessionWith({ enabled: true }));
		expect(tool?.name).toBe("run");
		expect(tool?.loadMode).toBe("essential");
		expect(tool?.approval).toBe("exec");
	});

	test("execute forwards params to the service and formats the result", async () => {
		let received: unknown;
		const tool = RuntimeRunTool.createIf(
			sessionWith({
				run: async p => {
					received = p;
					return { exitCode: 0, stdout: "hello\n", stderr: "", durationMs: 5, killed: false };
				},
			}),
		);
		const result = await tool?.execute(
			"id1",
			{ code: "console.log('hello')", language: "ts" } as never,
			new AbortController().signal,
		);
		expect((received as { code: string }).code).toBe("console.log('hello')");
		const block = result?.content[0] as { type: "text"; text: string } | undefined;
		expect(block?.text).toContain("hello");
		expect(result?.details).toMatchObject({ exitCode: 0 });
	});

	test("evicts an internally failed cached service so the next call gets a fresh runtime", async () => {
		const options = { adapter: "process" as const, autoDownload: false, explicitPath: "/runtime-fixture" };
		const scope: RuntimeServiceScope = {
			readSettings: () => ({
				enabled: true,
				autoDownload: false,
				path: "/runtime-fixture",
				version: "",
				adapter: "process",
				embeddedPath: "",
			}),
		};
		const release = acquireRuntimeServiceLease(scope);
		try {
			const first = getOrCreateRuntimeService(options, undefined, scope);
			const close = vi.spyOn(first, "close").mockResolvedValue();
			vi.spyOn(first, "run").mockRejectedValue(
				new RuntimeRpcError("internal", "Embedded runtime execution worker failed."),
			);
			const session = {
				settings: { get: (key: string) => key === "runtime.enabled" },
				runtimeServiceScope: scope,
				getRuntimeService: () => getOrCreateRuntimeService(options, undefined, scope),
			} as unknown as ToolSession;
			const tool = new RuntimeRunTool(session);

			await expect(tool.execute("id", { code: "print('first')", language: "python" })).rejects.toThrow(
				"Embedded runtime execution worker failed.",
			);
			expect(close).toHaveBeenCalledTimes(1);
			const replacement = getOrCreateRuntimeService(options, undefined, scope);
			expect(replacement).not.toBe(first);
			await disposeCachedRuntimeService(replacement, scope);
		} finally {
			await release();
		}
	});

	test("nonzero exit is surfaced in the formatted output", () => {
		const text = formatExecResult({ exitCode: 2, stdout: "", stderr: "boom", durationMs: 3, killed: false });
		expect(text).toContain("exit code 2");
		expect(text).toContain("boom");
	});
});

describe("formatExecResult truncation authority", () => {
	// The central artifact spill (`tools.artifactSpillThreshold`, default 50KB,
	// applied in tools/output-meta.ts) is the ONLY truncation authority for runtime
	// tool output. formatExecResult must hand the full text out of `execute` so the
	// spill can preserve all of it as an artifact.
	test("does not truncate large stdout", () => {
		const big = "x".repeat(200_000);
		const text = formatExecResult({ exitCode: 0, stdout: big, stderr: "", durationMs: 1, killed: false });
		expect(text).toBe(big);
	});

	test("does not truncate stdout far beyond the old 400k cap, and emits no truncation notice", () => {
		const huge = "y".repeat(1_000_000);
		const text = formatExecResult({ exitCode: 0, stdout: huge, stderr: "", durationMs: 1, killed: false });
		expect(text).toBe(huge);
		expect(text).not.toContain("output truncated");
	});

	test("does not truncate large stderr and keeps the section structure", () => {
		const out = "o".repeat(600_000);
		const err = "e".repeat(600_000);
		const text = formatExecResult({ exitCode: 1, stdout: out, stderr: err, durationMs: 1, killed: false });
		expect(text).toBe(`${out}\n--- stderr ---\n${err}\n(exit code 1)`);
		expect(text).not.toContain("output truncated");
	});

	test("still structures killed and empty results", () => {
		expect(formatExecResult({ exitCode: 0, stdout: "a\n\n", stderr: "b\n", durationMs: 1, killed: true })).toBe(
			"a\n--- stderr ---\nb\n(process was killed: timeout or cancellation)",
		);
		expect(formatExecResult({ exitCode: 3, stdout: "", stderr: "", durationMs: 1, killed: false })).toBe(
			"(exit code 3)",
		);
		expect(formatExecResult({ exitCode: 0, stdout: "", stderr: "", durationMs: 1, killed: false })).toBe(
			"(no output, exit code 0)",
		);
	});
});

describe("run tool output spill", () => {
	test("oversized stdout spills the COMPLETE text to an artifact with a preview inline", async () => {
		// 500KB of stdout: well over the 50KB default spill threshold, and over the old
		// 400k-char inner cap, so this pins that nothing pre-truncates the spill.
		const line = `${"z".repeat(99)}\n`;
		const stdout = line.repeat(5_000); // 500KB
		const tool = RuntimeRunTool.createIf(
			sessionWith({
				run: async () => ({ exitCode: 0, stdout, stderr: "", durationMs: 1, killed: false }),
			}),
		);
		// The wrapper installs `wrappedExecute`, whose signature carries the tool context
		// the spill needs; the class's own `execute` declares only three parameters.
		const wrapped = wrapToolWithMetaNotice(tool as NonNullable<typeof tool>) as unknown as AgentTool;

		let saved: string | undefined;
		const context = {
			sessionManager: {
				saveArtifact: (full: string) => {
					saved = full;
					return Promise.resolve("42");
				},
			},
		} as never;

		const result = await wrapped.execute("id1", { code: "x" } as never, undefined, undefined, context);
		const text = (result.content.find(b => b.type === "text") as { text: string }).text;

		// The model-facing content is a trimmed preview carrying the artifact reference.
		expect(text).toContain("artifact://42");
		expect(text.length).toBeLessThan(stdout.length / 2);
		// The artifact holds the complete output, byte-for-byte.
		expect(saved).toBe(stdout.replace(/\n+$/, ""));
		expect(saved).not.toContain("output truncated");
		// Exactly one truncation notice — no double-notice from a tool-local cap:
		// only the central artifact reference, and no leftover tool-local cap wording.
		expect(text.split("artifact://").length - 1).toBe(1);
		expect(text).not.toContain("output truncated");
	});
});
