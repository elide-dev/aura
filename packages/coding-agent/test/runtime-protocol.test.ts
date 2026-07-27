import { describe, expect, test } from "bun:test";
import {
	createRequest,
	errorResponse,
	okResponse,
	RUNTIME_PROTOCOL_VERSION,
	RuntimeRpcError,
	unwrapResponse,
} from "../src/runtime/protocol";

describe("runtime protocol", () => {
	test("protocol version is 1", () => {
		expect(RUNTIME_PROTOCOL_VERSION).toBe(1);
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
});
