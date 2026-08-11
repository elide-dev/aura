/**
 * A runtime RPC failure carries the diagnostic the model needs — the argv that
 * was invoked, the stderr the tool printed — on `RuntimeRpcError.data`. Thrown
 * out of a tool, that detail is destroyed: the agent loop flattens any thrown
 * tool error to `{ content: message, details: {} }` (packages/agent, upstream,
 * not ours to change). So the runtime tools catch protocol failures and RETURN
 * a failed tool result carrying a redacted projection of the detail instead.
 *
 * These tests pin that boundary: what survives (argv, stderr tail, code,
 * message), what never does (the host's filesystem layout, the environment),
 * and what still throws (anything that is not a RuntimeRpcError).
 */

import { describe, expect, test, vi } from "bun:test";
import path from "node:path";
import {
	acquireRuntimeServiceLease,
	disposeCachedRuntimeService,
	getOrCreateRuntimeService,
	type RuntimeServiceScope,
} from "../src/runtime";
import { formatRuntimeRpcError } from "../src/runtime/format";
import { RuntimeRpcError } from "../src/runtime/protocol";
import type { ToolSession } from "../src/tools";
import { JvmJarTool } from "../src/tools/jvm-jar";
import { RuntimeCheckTool } from "../src/tools/runtime-check";
import { RuntimeRunTool } from "../src/tools/runtime-run";

/** The package root stands in for the project root the tools redact against. */
const PROJECT_ROOT = path.resolve(import.meta.dir, "..");

/** Every runtime method on a stub service fails the same way. */
function sessionThrowing(error: unknown, cwd = PROJECT_ROOT): ToolSession {
	const fail = async (): Promise<never> => {
		throw error;
	};
	return {
		cwd,
		settings: {
			get: (key: string) => key === "runtime.enabled" || key === "python.enabled" || key === "python.embedded",
		},
		getRuntimeService: () => ({ run: fail, check: fail, insights: fail, profile: fail, jvm: fail }) as never,
		getSessionId: () => "session-err",
	} as unknown as ToolSession;
}

const textOf = (result: { content: Array<{ type: string; text?: string }> }): string =>
	result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");

describe("runtime RPC failures reach the model as detailed tool results", () => {
	test("a failed run carries argv and stderr in both the text and the details", async () => {
		const error = new RuntimeRpcError("download-failed", "Runtime archive extraction failed.", {
			argv: ["tar", "-xJf", "archive.tar.xz", "-C", "extract"],
			stderr: "tar: unexpected end of file\n",
		});
		const tool = RuntimeRunTool.createIf(sessionThrowing(error));

		const result = await tool!.execute("id", { code: "console.log(1)" } as never);

		expect(result.isError).toBe(true);
		const text = textOf(result);
		expect(text).toContain("Runtime archive extraction failed.");
		expect(text).toContain("tar -xJf archive.tar.xz -C extract");
		expect(text).toContain("tar: unexpected end of file");
		// The whole point: details is NOT the empty object the agent loop would leave.
		expect(Object.keys(result.details ?? {})).not.toHaveLength(0);
		expect(result.details).toMatchObject({
			code: "download-failed",
			message: "Runtime archive extraction failed.",
			argv: "tar -xJf archive.tar.xz -C extract",
		});
	});

	test("the sibling tools share the conversion (check, jvm_jar)", async () => {
		const error = new RuntimeRpcError("timeout", "The runtime call timed out.", { timeoutMs: 5000 });

		const check = await RuntimeCheckTool.createIf(sessionThrowing(error))!.execute("id", {} as never);
		expect(check.isError).toBe(true);
		expect(textOf(check)).toContain("The runtime call timed out.");
		expect(check.details).toMatchObject({ code: "timeout", timeoutMs: 5000 });

		const jar = await JvmJarTool.createIf(sessionThrowing(error))!.execute("id", {
			action: "inspect",
			jar: "app.jar",
		} as never);
		expect(jar.isError).toBe(true);
		expect(textOf(jar)).toContain("The runtime call timed out.");
		expect(jar.details).toMatchObject({ code: "timeout" });
	});

	test("a 10 KiB stderr is tail-capped at 2 KiB — the tail, not the head", async () => {
		const stderr = `HEAD-MARKER${"e".repeat(10 * 1024)}TAIL-MARKER`;
		const tool = RuntimeRunTool.createIf(
			sessionThrowing(new RuntimeRpcError("internal", "The runtime aborted.", { stderr })),
		);

		const result = await tool!.execute("id", { code: "boom()" } as never);

		const capped = (result.details as { stderr?: string } | undefined)?.stderr;
		expect(capped).toBeDefined();
		expect(capped!.length).toBe(2048);
		expect(capped!.endsWith("TAIL-MARKER")).toBe(true);
		expect(capped).not.toContain("HEAD-MARKER");
		const text = textOf(result);
		expect(text).toContain("TAIL-MARKER");
		expect(text).not.toContain("HEAD-MARKER");
	});

	test("an error with no data still produces a non-empty message", async () => {
		const bare = new RuntimeRpcError("runtime-missing", "No runtime binary is available.");

		const projection = formatRuntimeRpcError(bare, PROJECT_ROOT);
		expect(projection.text).toContain("No runtime binary is available.");
		expect(projection.details).toMatchObject({ code: "runtime-missing", message: "No runtime binary is available." });

		const result = await RuntimeCheckTool.createIf(sessionThrowing(bare))!.execute("id", {} as never);
		expect(result.isError).toBe(true);
		expect(textOf(result).trim().length).toBeGreaterThan(0);
		expect(textOf(result)).toContain("No runtime binary is available.");
	});

	test("an internal failure still retires the cached service before returning the result", async () => {
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
				new RuntimeRpcError("internal", "Embedded runtime execution worker failed.", {
					stderr: "worker exited with signal SIGSEGV",
				}),
			);
			const session = {
				settings: {
					get: (key: string) => key === "runtime.enabled" || key === "python.enabled" || key === "python.embedded",
				},
				runtimeServiceScope: scope,
				getRuntimeService: () => getOrCreateRuntimeService(options, undefined, scope),
			} as unknown as ToolSession;

			const result = await new RuntimeRunTool(session).execute("id", { code: "print('first')", language: "python" });

			// Retirement happened during execute, so it is already observable here.
			expect(close).toHaveBeenCalledTimes(1);
			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain("Embedded runtime execution worker failed.");
			expect(result.details).toMatchObject({ code: "internal", stderr: "worker exited with signal SIGSEGV" });
			const replacement = getOrCreateRuntimeService(options, undefined, scope);
			expect(replacement).not.toBe(first);
			await disposeCachedRuntimeService(replacement, scope);
		} finally {
			await release();
		}
	});

	test("a failure that is not a RuntimeRpcError still propagates as a throw", async () => {
		const tool = RuntimeRunTool.createIf(sessionThrowing(new TypeError("service.run is not a function")));

		await expect(tool!.execute("id", { code: "console.log(1)" } as never)).rejects.toThrow(
			"service.run is not a function",
		);
	});
});

describe("runtime RPC detail redaction", () => {
	test("argv is joined with spaces", () => {
		const { text, details } = formatRuntimeRpcError(
			new RuntimeRpcError("internal", "Runtime invocation failed.", {
				argv: ["elide", "run", "--js", "main.ts"],
			}),
			PROJECT_ROOT,
		);

		expect(details.argv).toBe("elide run --js main.ts");
		expect(text).toContain("elide run --js main.ts");
	});

	test("absolute paths outside the project root are dropped; paths inside it survive", () => {
		const inside = path.join(PROJECT_ROOT, "src", "runtime", "format.ts");
		const outside = "/home/someone-else/.cache/aura/staging/runtime.tar.xz";
		const { text, details } = formatRuntimeRpcError(
			new RuntimeRpcError("download-failed", "Runtime archive extraction failed.", {
				argv: ["tar", "-xJf", outside, "-C", inside],
				stderr: `tar: ${outside}: Cannot open`,
				versionDir: outside,
			}),
			PROJECT_ROOT,
		);

		const serialized = `${text}\n${JSON.stringify(details)}`;
		expect(serialized).not.toContain(outside);
		expect(serialized).not.toContain("someone-else");
		// The shape of the diagnostic survives the redaction.
		expect(text).toContain("tar -xJf");
		expect(text).toContain(inside);
		expect(details.argv).toContain(inside);
	});

	test("environment variables are never emitted", () => {
		const { text, details } = formatRuntimeRpcError(
			new RuntimeRpcError("internal", "The runtime process failed to start.", {
				env: { AWS_SECRET_ACCESS_KEY: "s3cr3t-value", PATH: "/usr/bin" },
				environment: { GITHUB_TOKEN: "ghp_hunter2" },
				argv: ["elide", "run", "main.ts"],
			}),
			PROJECT_ROOT,
		);

		const serialized = `${text}\n${JSON.stringify(details)}`;
		expect(serialized).not.toContain("AWS_SECRET_ACCESS_KEY");
		expect(serialized).not.toContain("s3cr3t-value");
		expect(serialized).not.toContain("GITHUB_TOKEN");
		expect(serialized).not.toContain("ghp_hunter2");
		expect(details.env).toBeUndefined();
		expect(details.environment).toBeUndefined();
		// The useful neighbour still made it through.
		expect(details.argv).toBe("elide run main.ts");
	});
});
