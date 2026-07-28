import { describe, expect, test } from "bun:test";
import { Message, utils } from "capnp-es";
import {
	decodeEmbeddedResponse,
	EmbeddedFailureCode,
	encodeOpenRequest,
	encodeRunRequest,
	type EmbeddedRunInvocation,
} from "../src/runtime/embedded/codec";
import { EMBEDDED_RUNTIME_ABI_VERSION, EMBEDDED_RUNTIME_SCHEMA_SHA256 } from "../src/runtime/embedded/schema";
import { ProtocolVersion } from "../src/runtime/embedded/generated/base";
import { ArgumentSuite_Args_Which, Argument_Value_Which, CliCommand } from "../src/runtime/embedded/generated/cli";
import {
	EmbeddedCallRequest,
	EmbeddedFailureCode as WireFailureCode,
	EmbeddedOpenRequest,
	EmbeddedResponse,
} from "../src/runtime/embedded/generated/embed";
import { Language } from "../src/runtime/embedded/generated/engine";
import {
	EngineInvocation_CliInvocation_Command_Which,
	EngineInvocation_CliInvocation_RunInvocation_SourceCode_Which,
	EngineInvocation_CliInvocation_RunMode,
	EngineInvocation_CliInvocation_SourceLanguage,
	EngineInvocation_Invocation_Which,
} from "../src/runtime/embedded/generated/invocation";
import { RuntimeRpcError } from "../src/runtime/protocol";

const encoder = new TextEncoder();

function serializeResponse(
	requestId: bigint,
	build: (response: EmbeddedResponse) => void,
	protocolVersion = ProtocolVersion.V2,
): Uint8Array {
	const message = new Message();
	const response = message.initRoot(EmbeddedResponse);
	response.protocolVersion = protocolVersion;
	response.requestId = requestId;
	build(response);
	return new Uint8Array(message.toArrayBuffer());
}

function expectInternalError(action: () => unknown, messageFragment: string): void {
	let thrown: unknown;
	try {
		action();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(RuntimeRpcError);
	if (!(thrown instanceof RuntimeRpcError)) throw new Error("expected RuntimeRpcError");
	expect(thrown.code).toBe("internal");
	expect(thrown.message).toContain(messageFragment);
}

function decodeCall(bytes: Uint8Array): EmbeddedCallRequest {
	return new Message(bytes, false).getRoot(EmbeddedCallRequest);
}

function decodeOpen(bytes: Uint8Array): EmbeddedOpenRequest {
	return new Message(bytes, false).getRoot(EmbeddedOpenRequest);
}

function listValues<T>(list: { length: number; get(index: number): T }): T[] {
	return Array.from({ length: list.length }, (_, index) => list.get(index));
}

describe("embedded runtime protocol codec", () => {
	test("pins the generated ABI and canonical WHIPLASH schema fingerprint", () => {
		expect(EMBEDDED_RUNTIME_ABI_VERSION).toBe(1);
		expect(EMBEDDED_RUNTIME_SCHEMA_SHA256).toBe("8a6b5aa3d4fcc72fda099f9df9f519ca3edc89b2527bb864057a530836718e06");
	});

	test("encodes an open request with protocol v2 and requested languages in order", () => {
		const request = decodeOpen(encodeOpenRequest({ languages: ["python", "js", "ts"] }));

		expect(request.protocolVersion).toBe(ProtocolVersion.V2);
		expect(listValues(request.languages)).toEqual([Language.PYTHON, Language.JAVASCRIPT, Language.TYPESCRIPT]);
	});

	test("encodes an inline invocation with source identity, cwd, environment, args, and stdin", () => {
		const invocation: EmbeddedRunInvocation = {
			source: { type: "content", code: "globalThis.answer = 42", name: "[eval].ts" },
			language: "ts",
			args: ["--flag", "two words", ""],
			cwd: "/workspace/project",
			environment: Object.freeze({ ALPHA: "one", EMPTY: "", NO_COLOR: "1" }),
			stdin: Uint8Array.of(0, 1, 127, 128, 255),
		};

		const request = decodeCall(encodeRunRequest(42n, invocation));
		expect(request.protocolVersion).toBe(ProtocolVersion.V2);
		expect(request.requestId).toBe(42n);
		expect(Array.from(request.stdin.toUint8Array())).toEqual([0, 1, 127, 128, 255]);

		const wireInvocation = request.invocation;
		expect(wireInvocation.invocation.which()).toBe(EngineInvocation_Invocation_Which.CLI);
		const cli = wireInvocation.invocation.cli;
		expect(cli.subcommand).toBe(CliCommand.RUN);
		expect(cli.command.which()).toBe(EngineInvocation_CliInvocation_Command_Which.RUN);
		const run = cli.command.run;
		expect(run.mode).toBe(EngineInvocation_CliInvocation_RunMode.STANDARD);
		expect(run.sourceLanguage).toBe(EngineInvocation_CliInvocation_SourceLanguage.TYPESCRIPT);
		expect(run.sourceCode.which()).toBe(EngineInvocation_CliInvocation_RunInvocation_SourceCode_Which.CODE);
		expect(run.sourceCode.code).toBe("globalThis.answer = 42");

		const argsUnion = wireInvocation.args.args;
		expect(argsUnion.which()).toBe(ArgumentSuite_Args_Which.LIST);
		const wireArgs = listValues(argsUnion.list);
		expect(wireArgs.map((argument) => argument.key)).toEqual(["--", "--flag", "two words", ""]);
		expect(wireArgs.map((argument) => argument.value.which())).toEqual([
			Argument_Value_Which.NO_VALUE,
			Argument_Value_Which.NO_VALUE,
			Argument_Value_Which.NO_VALUE,
			Argument_Value_Which.NO_VALUE,
		]);
		expect(run.scriptArgs.offset).toBe(1);
		expect(run.scriptArgs.count).toBe(3);
		expect(wireArgs.slice(run.scriptArgs.offset, run.scriptArgs.offset + run.scriptArgs.count).map((argument) => argument.key)).toEqual(invocation.args);

		expect(wireInvocation.meta.engineConfig.directories.workingDir.path.pathString.path).toBe("/workspace/project");
		expect(wireInvocation.env.size).toBe(3);
		expect(listValues(wireInvocation.env.vars).map((variable) => [variable.key, variable.value])).toEqual([
			["ALPHA", "one"],
			["EMPTY", ""],
			["NO_COLOR", "1"],
		]);
	});

	test("encodes an absolute file invocation without changing its path or argument order", () => {
		const invocation: EmbeddedRunInvocation = {
			source: { type: "file", path: "/workspace/project/scripts/main.py" },
			language: "python",
			args: ["first", "--literal", "last"],
			cwd: "/workspace/project",
			environment: { NO_COLOR: "1" },
			stdin: new Uint8Array(),
		};

		const request = decodeCall(encodeRunRequest(9007199254740993n, invocation));
		const run = request.invocation.invocation.cli.command.run;
		expect(request.requestId).toBe(9007199254740993n);
		expect(run.sourceLanguage).toBe(EngineInvocation_CliInvocation_SourceLanguage.PYTHON);
		expect(run.sourceCode.which()).toBe(EngineInvocation_CliInvocation_RunInvocation_SourceCode_Which.FILE);
		expect(run.sourceCode.file.filepath.pathString.path).toBe("/workspace/project/scripts/main.py");
		const allArgs = listValues(request.invocation.args.args.list);
		expect(allArgs.slice(run.scriptArgs.offset, run.scriptArgs.offset + run.scriptArgs.count).map((argument) => argument.key)).toEqual(invocation.args);
	});

	test("decodes every response union arm", () => {
		expect(decodeEmbeddedResponse(serializeResponse(0n, (response) => (response.opened = true)), 0n)).toEqual({
			type: "opened",
			requestId: 0n,
		});

		const completed = serializeResponse(7n, (response) => {
			const result = response._initCompleted();
			result.exitCode = 17;
			const stdout = encoder.encode("out ✓");
			result._initStdout(stdout.byteLength).copyBuffer(stdout);
			result._initStderr(4).copyBuffer(encoder.encode("err!"));
			result.killed = false;
		});
		expect(decodeEmbeddedResponse(completed, 7n)).toEqual({
			type: "completed",
			requestId: 7n,
			result: { exitCode: 17, stdout: "out ✓", stderr: "err!", killed: false },
		});

		expect(decodeEmbeddedResponse(serializeResponse(8n, (response) => (response.cancelled = true)), 8n)).toEqual({
			type: "cancelled",
			requestId: 8n,
		});
		expect(decodeEmbeddedResponse(serializeResponse(0n, (response) => (response.closed = true)), 0n)).toEqual({
			type: "closed",
			requestId: 0n,
		});

		const failure = serializeResponse(9n, (response) => {
			const detail = response._initFailure();
			detail.code = WireFailureCode.BUSY;
			detail.message = "another call is active";
		});
		expect(decodeEmbeddedResponse(failure, 9n)).toEqual({
			type: "failure",
			requestId: 9n,
			code: EmbeddedFailureCode.BUSY,
			message: "another call is active",
		});
	});

	test("preserves nonzero guest exits as completed results", () => {
		const bytes = serializeResponse(70n, (response) => {
			const result = response._initCompleted();
			result.exitCode = 126;
			result._initStdout(0);
			result._initStderr(0);
			result.killed = false;
		});

		expect(decodeEmbeddedResponse(bytes, 70n)).toMatchObject({
			type: "completed",
			requestId: 70n,
			result: { exitCode: 126, killed: false },
		});
	});

	test("rejects incompatible protocol versions", () => {
		const bytes = serializeResponse(0n, (response) => (response.opened = true), ProtocolVersion.V1);
		expectInternalError(() => decodeEmbeddedResponse(bytes, 0n), "protocol version");
	});

	test("requires zero request ids for open and close responses", () => {
		expectInternalError(
			() => decodeEmbeddedResponse(serializeResponse(1n, (response) => (response.opened = true)), 1n),
			"request id 0",
		);
		expectInternalError(
			() => decodeEmbeddedResponse(serializeResponse(2n, (response) => (response.closed = true)), 2n),
			"request id 0",
		);
	});

	test("rejects call and cancellation responses whose ids do not match the submitted request", () => {
		const completed = serializeResponse(12n, (response) => {
			const result = response._initCompleted();
			result.exitCode = 0;
			result._initStdout(0);
			result._initStderr(0);
		});
		expectInternalError(() => decodeEmbeddedResponse(completed, 11n), "request id");
		expectInternalError(
			() => decodeEmbeddedResponse(serializeResponse(13n, (response) => (response.cancelled = true)), 14n),
			"request id",
		);
	});

	test("rejects malformed and truncated messages as internal RPC errors", () => {
		expectInternalError(() => decodeEmbeddedResponse(Uint8Array.of(0, 1, 2)), "Cap'n Proto");
		const valid = serializeResponse(0n, (response) => (response.opened = true));
		expectInternalError(() => decodeEmbeddedResponse(valid.subarray(0, valid.length - 3)), "Cap'n Proto");
	});

	test("rejects unknown response unions", () => {
		const bytes = serializeResponse(22n, (response) => {
			utils.setUint16(2, 99, response);
		});
		expectInternalError(() => decodeEmbeddedResponse(bytes, 22n), "response union");
	});

	test("rejects exit codes outside the process-compatible byte range", () => {
		for (const exitCode of [-1, 256]) {
			const bytes = serializeResponse(23n, (response) => {
				const result = response._initCompleted();
				result.exitCode = exitCode;
				result._initStdout(0);
				result._initStderr(0);
			});
			expectInternalError(() => decodeEmbeddedResponse(bytes, 23n), "exit code");
		}
	});

	test("rejects invalid UTF-8 in captured output", () => {
		const bytes = serializeResponse(24n, (response) => {
			const result = response._initCompleted();
			result.exitCode = 0;
			result._initStdout(2).copyBuffer(Uint8Array.of(0xc3, 0x28));
			result._initStderr(0);
		});
		expectInternalError(() => decodeEmbeddedResponse(bytes, 24n), "UTF-8");
	});
});
