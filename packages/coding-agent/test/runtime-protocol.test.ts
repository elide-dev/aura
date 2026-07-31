import { describe, expect, test } from "bun:test";
import {
	createRequest,
	errorResponse,
	okResponse,
	RUNTIME_PROTOCOL_VERSION,
	RuntimeRpcError,
	resolveRunTarget,
	unwrapResponse,
} from "../src/runtime/protocol";

describe("runtime protocol", () => {
	test("protocol version is 3", () => {
		expect(RUNTIME_PROTOCOL_VERSION).toBe(3);
	});

	test("createRequest produces JSON-RPC 2.0 with unique ids", () => {
		const a = createRequest("runtime/run", { code: "1" });
		const b = createRequest("runtime/status", undefined);
		expect(a.jsonrpc).toBe("2.0");
		expect(a.method).toBe("runtime/run");
		expect(b.id).not.toBe(a.id);
	});

	test("unwrapResponse returns result payloads", () => {
		const req = createRequest("runtime/status", undefined);
		const res = okResponse(req.id, { available: true, protocolVersion: 1 });
		expect(unwrapResponse<{ available: boolean }>(res).available).toBe(true);
	});

	test("unwrapResponse throws typed errors", () => {
		const req = createRequest("runtime/run", {});
		const res = errorResponse(req.id, new RuntimeRpcError("runtime-missing", "no runtime", { hint: "install" }));
		expect(() => unwrapResponse(res)).toThrow(RuntimeRpcError);
		try {
			unwrapResponse(res);
		} catch (e) {
			expect((e as RuntimeRpcError).code).toBe("runtime-missing");
			expect((e as RuntimeRpcError).data).toEqual({ hint: "install" });
		}
	});

	describe("run target resolution", () => {
		test.each([
			[
				{ code: "console.log(1)", language: "js" },
				{ language: "js", engine: "bun" },
			],
			[
				{ code: "console.log(1)", language: "ts" },
				{ language: "ts", engine: "bun" },
			],
			[
				{ code: "print(1)", language: "python" },
				{ language: "python", engine: "elide" },
			],
			[
				{ code: "class Main {}", language: "java" },
				{ language: "java", engine: "elide" },
			],
			[
				{ code: "fun main() {}", language: "kotlin" },
				{ language: "kotlin", engine: "elide" },
			],
			[{ path: "src/task.mts" }, { language: "ts", engine: "bun" }],
			[{ path: "src/task.py" }, { language: "python", engine: "elide" }],
			[{ path: "src/Main.java" }, { language: "java", engine: "elide" }],
			[{ path: "src/main.kt" }, { language: "kotlin", engine: "elide" }],
			[
				{ code: "console.log(1)", language: "js", engine: "elide" },
				{ language: "js", engine: "elide" },
			],
			[
				{ code: "console.log(1)", language: "ts", engine: "elide" },
				{ language: "ts", engine: "elide" },
			],
		] as const)("resolves %j", (params, expected) => {
			expect(resolveRunTarget(params)).toEqual(expected);
		});

		test.each(["python", "java", "kotlin"] as const)("rejects Bun for %s", language => {
			expect(() => resolveRunTarget({ code: "", language, engine: "bun" })).toThrow(
				`Engine "bun" does not support language "${language}".`,
			);
		});

		test("defaults inline source to TypeScript with Bun", () => {
			expect(resolveRunTarget({ code: "const answer = 42" })).toEqual({ language: "ts", engine: "bun" });
		});

		test("rejects mainClass outside Java and Kotlin", () => {
			expect(() => resolveRunTarget({ code: "", language: "ts", mainClass: "Main" })).toThrow(
				"mainClass is only valid for Java and Kotlin.",
			);
		});

		test("rejects unknown path extensions instead of guessing TypeScript", () => {
			expect(() => resolveRunTarget({ path: "program.rb" })).toThrow(
				'Cannot infer a supported language from path "program.rb".',
			);
		});
	});
});
