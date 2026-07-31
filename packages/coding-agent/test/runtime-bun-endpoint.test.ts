import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createRequest, type RuntimeRunResult, unwrapResponse } from "../src/runtime/protocol";
import { BunRuntimeEndpoint } from "../src/runtime/transport/bun";

const cleanup: string[] = [];
afterEach(async () => {
	await Promise.all(cleanup.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aura-bun-run-"));
	cleanup.push(directory);
	return directory;
}

describe("Bun runtime endpoint", () => {
	test("executes inline TypeScript with argv, stdin, cwd, and environment", async () => {
		const cwd = await temporaryDirectory();
		const endpoint = new BunRuntimeEndpoint({ env: { ...process.env, RUN_TOKEN: "present" } });
		const response = await endpoint.request(
			createRequest("runtime/run", {
				code: [
					"const input = await Bun.stdin.text();",
					"console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), input, token: process.env.RUN_TOKEN }));",
				].join("\n"),
				language: "ts",
				args: ["one", "two"],
				stdin: "payload",
				cwd,
			}),
		);
		const result = unwrapResponse<RuntimeRunResult>(response);
		expect(result).toMatchObject({ exitCode: 0, stderr: "", killed: false, engine: "bun", language: "ts" });
		expect(JSON.parse(result.stdout.trim())).toEqual({
			args: ["one", "two"],
			cwd,
			input: "payload",
			token: "present",
		});
	});

	test("executes a file with a sibling TypeScript import", async () => {
		const cwd = await temporaryDirectory();
		await Bun.write(path.join(cwd, "value.ts"), "export const value: number = 42;\n");
		await Bun.write(path.join(cwd, "main.ts"), 'import { value } from "./value"; console.log("value:" + value);\n');
		const endpoint = new BunRuntimeEndpoint();
		const result = unwrapResponse<RuntimeRunResult>(
			await endpoint.request(createRequest("runtime/run", { path: "main.ts", cwd, engine: "bun" })),
		);
		expect(result).toMatchObject({ exitCode: 0, stdout: "value:42\n", stderr: "", engine: "bun", language: "ts" });
	});

	test("surfaces nonzero exits without throwing", async () => {
		const endpoint = new BunRuntimeEndpoint();
		const result = unwrapResponse<RuntimeRunResult>(
			await endpoint.request(
				createRequest("runtime/run", { code: 'console.error("failed"); process.exit(7);', language: "js" }),
			),
		);
		expect(result).toMatchObject({ exitCode: 7, stdout: "", stderr: "failed\n", killed: false });
	});

	test("terminates timed-out execution and remains reusable", async () => {
		const endpoint = new BunRuntimeEndpoint();
		const timedOut = unwrapResponse<RuntimeRunResult>(
			await endpoint.request(
				// A never-settling guest is required to exercise the real subprocess timeout boundary.
				createRequest("runtime/run", {
					code: "await Promise.withResolvers<void>().promise;",
					language: "ts",
					timeoutMs: 25,
				}),
			),
		);
		expect(timedOut.killed).toBe(true);
		const next = unwrapResponse<RuntimeRunResult>(
			await endpoint.request(createRequest("runtime/run", { code: 'console.log("after")', language: "js" })),
		);
		expect(next).toMatchObject({ exitCode: 0, stdout: "after\n", killed: false });
	});

	test("returns cancelled when the caller aborts", async () => {
		const endpoint = new BunRuntimeEndpoint();
		const controller = new AbortController();
		const pending = endpoint.request(
			createRequest("runtime/run", { code: "await Promise.withResolvers<void>().promise;", language: "ts" }),
			controller.signal,
		);
		controller.abort();
		const response = await pending;
		expect("error" in response && response.error.code).toBe("cancelled");
	});
});
