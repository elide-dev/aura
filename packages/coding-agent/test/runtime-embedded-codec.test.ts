import { describe, expect, test } from "bun:test";
import { Message, utils } from "capnp-es";
import {
	decodeEmbeddedResponse,
	type EmbeddedContextInvocation,
	type EmbeddedContextSpecInput,
	type EmbeddedControlOperation,
	EmbeddedFailureCode,
	type EmbeddedRunInvocation,
	encodeContextCall,
	encodeContextControl,
	encodeOpenRequest,
	encodeRunRequest,
	MAX_EMBEDDED_INTERRUPT_MILLIS,
	MAX_EMBEDDED_OUTPUT_BYTES,
	MAX_EMBEDDED_POLL_WAIT_MILLIS,
	MIN_EMBEDDED_INTERRUPT_MILLIS,
} from "../src/runtime/embedded/codec";
import { ProtocolVersion } from "../src/runtime/embedded/generated/base";
import { Argument_Value_Which, ArgumentSuite_Args_Which, CliCommand } from "../src/runtime/embedded/generated/cli";
import {
	EmbeddedCallRequest,
	EmbeddedContextCall,
	EmbeddedContextCall_Source_Which,
	EmbeddedControl,
	EmbeddedControl_Op_Which,
	EmbeddedEvalMode,
	EmbeddedExecutionResult,
	EmbeddedOpenRequest,
	EmbeddedResponse,
	EmbeddedFailureCode as WireFailureCode,
} from "../src/runtime/embedded/generated/embed";
import { Language } from "../src/runtime/embedded/generated/engine";
import {
	EngineInvocation_CliInvocation_Command_Which,
	EngineInvocation_CliInvocation_RunInvocation_SourceCode_Which,
	EngineInvocation_CliInvocation_RunMode,
	EngineInvocation_CliInvocation_SourceLanguage,
	EngineInvocation_Invocation_Which,
} from "../src/runtime/embedded/generated/invocation";
import { EMBEDDED_RUNTIME_ABI_VERSION, EMBEDDED_RUNTIME_SCHEMA_SHA256 } from "../src/runtime/embedded/schema";
import { RuntimeRpcError } from "../src/runtime/protocol";

const encoder = new TextEncoder();

function serializeResponse(
	requestId: bigint,
	build: (response: EmbeddedResponse) => void,
	protocolVersion: ProtocolVersion = ProtocolVersion.V2,
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
		expect(EMBEDDED_RUNTIME_ABI_VERSION).toBe(2);
		expect(EMBEDDED_RUNTIME_SCHEMA_SHA256).toBe("4549e32d356420ee189474ceac795687016367bb0e261f7cde995e833a029ecf");
	});

	test("encodes an open request with protocol v2 and requested engine languages in order", () => {
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
		expect(wireArgs.map(argument => argument.key)).toEqual(["--", "--flag", "two words", ""]);
		expect(wireArgs.map(argument => argument.value.which())).toEqual([
			Argument_Value_Which.NO_VALUE,
			Argument_Value_Which.NO_VALUE,
			Argument_Value_Which.NO_VALUE,
			Argument_Value_Which.NO_VALUE,
		]);
		expect(run.scriptArgs.offset).toBe(1);
		expect(run.scriptArgs.count).toBe(3);
		expect(
			wireArgs
				.slice(run.scriptArgs.offset, run.scriptArgs.offset + run.scriptArgs.count)
				.map(argument => argument.key),
		).toEqual(invocation.args);

		expect(wireInvocation.meta.engineConfig.directories.workingDir.path.pathString.path).toBe("/workspace/project");
		expect(wireInvocation.env.size).toBe(3);
		expect(listValues(wireInvocation.env.vars).map(variable => [variable.key, variable.value])).toEqual([
			["ALPHA", "one"],
			["EMPTY", ""],
			["NO_COLOR", "1"],
		]);
	});

	test("encodes inline Kotlin for the native run invocation", () => {
		const invocation: EmbeddedRunInvocation = {
			source: { type: "content", code: "fun main() = println(42)", name: "[eval].kt" },
			language: "kotlin",
			args: [],
			cwd: "/workspace/project",
			environment: { NO_COLOR: "1" },
			stdin: new Uint8Array(),
		};

		const request = decodeCall(encodeRunRequest(43n, invocation));
		const run = request.invocation.invocation.cli.command.run;
		expect(run.sourceLanguage).toBe(EngineInvocation_CliInvocation_SourceLanguage.KOTLIN);
		expect(run.sourceCode.code).toBe("fun main() = println(42)");
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
		expect(
			allArgs
				.slice(run.scriptArgs.offset, run.scriptArgs.offset + run.scriptArgs.count)
				.map(argument => argument.key),
		).toEqual(invocation.args);
	});

	test("decodes every response union arm", () => {
		expect(
			decodeEmbeddedResponse(
				serializeResponse(0n, response => (response.opened = true)),
				0n,
			),
		).toEqual({
			type: "opened",
			requestId: 0n,
		});

		const completed = serializeResponse(7n, response => {
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

		expect(
			decodeEmbeddedResponse(
				serializeResponse(8n, response => (response.cancelled = true)),
				8n,
			),
		).toEqual({
			type: "cancelled",
			requestId: 8n,
		});
		expect(
			decodeEmbeddedResponse(
				serializeResponse(0n, response => (response.closed = true)),
				0n,
			),
		).toEqual({
			type: "closed",
			requestId: 0n,
		});

		const failure = serializeResponse(9n, response => {
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
		const bytes = serializeResponse(70n, response => {
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
		const bytes = serializeResponse(0n, response => (response.opened = true), ProtocolVersion.V1);
		expectInternalError(() => decodeEmbeddedResponse(bytes, 0n), "protocol version");
	});

	test("requires zero request ids for open and close responses", () => {
		expectInternalError(
			() =>
				decodeEmbeddedResponse(
					serializeResponse(1n, response => (response.opened = true)),
					1n,
				),
			"request id 0",
		);
		expectInternalError(
			() =>
				decodeEmbeddedResponse(
					serializeResponse(2n, response => (response.closed = true)),
					2n,
				),
			"request id 0",
		);
	});

	test("rejects call and cancellation responses whose ids do not match the submitted request", () => {
		const completed = serializeResponse(12n, response => {
			const result = response._initCompleted();
			result.exitCode = 0;
			result._initStdout(0);
			result._initStderr(0);
		});
		expectInternalError(() => decodeEmbeddedResponse(completed, 11n), "request id");
		expectInternalError(
			() =>
				decodeEmbeddedResponse(
					serializeResponse(13n, response => (response.cancelled = true)),
					14n,
				),
			"request id",
		);
	});

	test("requires positive request ids for completed and cancelled responses", () => {
		const completed = serializeResponse(0n, response => {
			const result = response._initCompleted();
			result.exitCode = 0;
			result._initStdout(0);
			result._initStderr(0);
		});
		expectInternalError(() => decodeEmbeddedResponse(completed, 0n), "positive request id");
		expectInternalError(
			() =>
				decodeEmbeddedResponse(
					serializeResponse(0n, response => (response.cancelled = true)),
					0n,
				),
			"positive request id",
		);
	});

	test("rejects failure responses whose ids do not match the submitted request", () => {
		const failure = serializeResponse(30n, response => {
			const detail = response._initFailure();
			detail.code = WireFailureCode.INTERNAL;
			detail.message = "dispatch failed";
		});
		expectInternalError(() => decodeEmbeddedResponse(failure, 31n), "request id");
	});

	test("rejects malformed and truncated messages as internal RPC errors", () => {
		expectInternalError(() => decodeEmbeddedResponse(Uint8Array.of(0, 1, 2), 0n), "Cap'n Proto");
		const valid = serializeResponse(0n, response => (response.opened = true));
		expectInternalError(() => decodeEmbeddedResponse(valid.subarray(0, valid.length - 3), 0n), "Cap'n Proto");
	});

	test("rejects unknown response unions", () => {
		const bytes = serializeResponse(22n, response => {
			utils.setUint16(2, 99, response);
		});
		expectInternalError(() => decodeEmbeddedResponse(bytes, 22n), "response union");
	});

	test("rejects exit codes outside the process-compatible byte range", () => {
		for (const exitCode of [-1, 256]) {
			const bytes = serializeResponse(23n, response => {
				const result = response._initCompleted();
				result.exitCode = exitCode;
				result._initStdout(0);
				result._initStderr(0);
			});
			expectInternalError(() => decodeEmbeddedResponse(bytes, 23n), "exit code");
		}
	});

	test("rejects invalid UTF-8 in captured output", () => {
		const bytes = serializeResponse(24n, response => {
			const result = response._initCompleted();
			result.exitCode = 0;
			result._initStdout(2).copyBuffer(Uint8Array.of(0xc3, 0x28));
			result._initStderr(0);
		});
		expectInternalError(() => decodeEmbeddedResponse(bytes, 24n), "UTF-8");
	});
});

/**
 * The ABI 2 repin is a strict superset: the one-shot RUN path's wire bytes must not move.
 * Every constant below was captured from the ABI 1 generated closure (commit before the repin)
 * and must stay byte-identical forever — a diff here means the one-shot path silently changed.
 */
describe("embedded runtime one-shot golden bytes", () => {
	const GOLDEN_OPEN_REQUEST = "000000000400000000000000010001000200000000000000010000001b0000000400010002000000";
	const GOLDEN_INLINE_RUN_REQUEST =
		"0000000054000000000000000200020002000000000000002a000000000000000800000001000500010000002a00000000017f80ff000000010000000000000000000000000000000c000000010001005800000001000100a000000001000100ec000000010003000000000000000000010000006700000010000000010002000000000000000000290000001a00000000000000000000000000000000000000210000003a00000000000000000000000000000000000000190000005200000000000000000000000000000000000000150000000a00000000000000000000002d2d0000000000002d2d666c6167000074776f20776f7264730000000000000000000000000000000300000000000000010000004f0000000c000000000003002100000032000000210000002200000000000000000000001d000000320000001d0000000a0000000000000000000000190000004a0000001d000000120000000000000000000000414c5048410000006f6e650000000000454d50545900000000000000000000004e4f5f434f4c4f52000000000000000031000000000000000000000000000000000000000100050000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000050010000000000002000000000000000000000000000000000000000000000000000000000000000000040000000000010000000000000000000000000000000100010000009a0000002f776f726b73706163652f70726f6a6563740000000000000300000000000000000000000000000000000000000000000000000001000400010001000200000011000000ba0000000000000000000000040000000100000000000000000000000100030000000000676c6f62616c546869732e616e73776572203d2034320000";
	const GOLDEN_FILE_RUN_REQUEST =
		"000000004e00000000000000020002000200000000000000010000000000200004000000010005000100000002000000010000000000000000000000000000000c0000000100010058000000010001007800000001000100c4000000010003000000000000000000010000006700000010000000010002000000000000000000290000001a00000000000000000000000000000000000000210000003200000000000000000000000000000000000000190000005200000000000000000000000000000000000000150000002a00000000000000000000002d2d00000000000066697273740000002d2d6c69746572616c000000000000006c617374000000000100000000000000010000001f0000000400000000000300090000004a0000000d0000001200000000000000000000004e4f5f434f4c4f52000000000000000031000000000000000000000000000000000000000100050000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000050010000000000002000000000000000000000000000000000000000000000000000000000000000000040000000000010000000000000000000000000000000100010000009a0000002f776f726b73706163652f70726f6a656374000000000000030000000000000000000000000000000000000000000000000000000100040000000100030000001000000000000100000000000000000004000000010000000000000000000000010003000000000000000000000001000000000000000100010000001a0100002f776f726b73706163652f70726f6a6563742f736372697074732f6d61696e2e7079000000000000";
	const GOLDEN_OPENED_RESPONSE = "00000000040000000000000002000100020000000000000000000000000000000000000000000000";
	const GOLDEN_COMPLETED_RESPONSE =
		"000000000900000000000000020001000200010000000000070000000000000000000000010002001100000000000000050000003a00000005000000220000006f757420e29c93006572722100000000";
	const GOLDEN_FAILURE_RESPONSE =
		"00000000090000000000000002000100020004000000000009000000000000000000000001000100030000000000000001000000ba000000616e6f746865722063616c6c206973206163746976650000";

	function hex(bytes: Uint8Array): string {
		return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
	}

	function bytesOf(encoded: string): Uint8Array {
		const bytes = new Uint8Array(encoded.length / 2);
		for (let index = 0; index < bytes.length; index += 1) {
			bytes[index] = Number.parseInt(encoded.slice(index * 2, index * 2 + 2), 16);
		}
		return bytes;
	}

	test("encodes the ABI 1 open request byte for byte", () => {
		expect(hex(encodeOpenRequest({ languages: ["python", "js", "ts"] }))).toBe(GOLDEN_OPEN_REQUEST);
	});

	test("encodes the ABI 1 inline run request byte for byte", () => {
		const bytes = encodeRunRequest(42n, {
			source: { type: "content", code: "globalThis.answer = 42", name: "[eval].ts" },
			language: "ts",
			args: ["--flag", "two words", ""],
			cwd: "/workspace/project",
			environment: { ALPHA: "one", EMPTY: "", NO_COLOR: "1" },
			stdin: Uint8Array.of(0, 1, 127, 128, 255),
		});
		expect(hex(bytes)).toBe(GOLDEN_INLINE_RUN_REQUEST);
	});

	test("encodes the ABI 1 file run request byte for byte", () => {
		const bytes = encodeRunRequest(9007199254740993n, {
			source: { type: "file", path: "/workspace/project/scripts/main.py" },
			language: "python",
			args: ["first", "--literal", "last"],
			cwd: "/workspace/project",
			environment: { NO_COLOR: "1" },
			stdin: new Uint8Array(),
		});
		expect(hex(bytes)).toBe(GOLDEN_FILE_RUN_REQUEST);
	});

	test("decodes ABI 1 response frames unchanged", () => {
		expect(decodeEmbeddedResponse(bytesOf(GOLDEN_OPENED_RESPONSE), 0n)).toEqual({ type: "opened", requestId: 0n });
		expect(decodeEmbeddedResponse(bytesOf(GOLDEN_COMPLETED_RESPONSE), 7n)).toEqual({
			type: "completed",
			requestId: 7n,
			result: { exitCode: 17, stdout: "out ✓", stderr: "err!", killed: false },
		});
		expect(decodeEmbeddedResponse(bytesOf(GOLDEN_FAILURE_RESPONSE), 9n)).toEqual({
			type: "failure",
			requestId: 9n,
			code: EmbeddedFailureCode.BUSY,
			message: "another call is active",
		});
	});
});

describe("embedded runtime Tier 2 context codec", () => {
	function decodeControl(bytes: Uint8Array): EmbeddedControl {
		return new Message(bytes, false).getRoot(EmbeddedControl);
	}

	function decodeContextCall(bytes: Uint8Array): EmbeddedContextCall {
		return new Message(bytes, false).getRoot(EmbeddedContextCall);
	}

	function control(requestId: bigint, operation: EmbeddedControlOperation): EmbeddedControl {
		return decodeControl(encodeContextControl(requestId, operation));
	}

	const spec: EmbeddedContextSpecInput = { languages: ["python"] };

	test("encodes a context open with the requested spec and protocol envelope", () => {
		const request = control(5n, {
			type: "open",
			spec: {
				languages: ["python", "java"],
				primaryLanguage: "python",
				allowThreads: true,
				allowPolyglot: true,
				streamOutput: true,
				workingDir: "/workspace/project",
				environment: { ALPHA: "one", NO_COLOR: "1" },
				outputByteLimit: 1024n,
				outputChunkBytes: 4096,
				label: "kernel-1",
			},
		});

		expect(request.protocolVersion).toBe(ProtocolVersion.V2);
		expect(request.requestId).toBe(5n);
		expect(request.contextId).toBe(0n);
		expect(request.op.which()).toBe(EmbeddedControl_Op_Which.OPEN);
		const opened = request.op.open.spec;
		expect(listValues(opened.languages)).toEqual([Language.PYTHON, Language.JAVA]);
		expect(opened.primaryLanguage).toBe(Language.PYTHON);
		expect(opened.allowThreads).toBe(true);
		expect(opened.allowPolyglot).toBe(true);
		expect(opened.streamOutput).toBe(true);
		expect(opened.hostCalls).toBe(false);
		expect(opened.workingDir).toBe("/workspace/project");
		expect(opened.environment.size).toBe(2);
		expect(listValues(opened.environment.vars).map(entry => [entry.key, entry.value])).toEqual([
			["ALPHA", "one"],
			["NO_COLOR", "1"],
		]);
		expect(opened.outputByteLimit).toBe(1024n);
		expect(opened.outputChunkBytes).toBe(4096);
		expect(opened.label).toBe("kernel-1");
	});

	test("leaves an unset primary language at the wire default rather than guessing", () => {
		const opened = control(6n, { type: "open", spec: { languages: ["js", "ts"] } }).op.open.spec;
		expect(opened.primaryLanguage).toBe(Language.UNKNOWN);
		expect(opened.allowThreads).toBe(false);
		expect(opened.streamOutput).toBe(false);
	});

	test("rejects an empty language list, threads with JS or TS, and a primary outside the set", () => {
		expect(() => encodeContextControl(1n, { type: "open", spec: { languages: [] } })).toThrow(
			/at least one language/i,
		);
		for (const language of ["js", "ts"] as const) {
			expect(() =>
				encodeContextControl(1n, { type: "open", spec: { languages: [language], allowThreads: true } }),
			).toThrow(/allowThreads/);
		}
		expect(() =>
			encodeContextControl(1n, { type: "open", spec: { languages: ["python"], primaryLanguage: "js" } }),
		).toThrow(/primary language/i);
	});

	test("clamps the output byte limit to the runtime envelope", () => {
		const opened = control(7n, {
			type: "open",
			spec: { languages: ["js"], outputByteLimit: MAX_EMBEDDED_OUTPUT_BYTES + 1n },
		}).op.open.spec;
		expect(opened.outputByteLimit).toBe(MAX_EMBEDDED_OUTPUT_BYTES);
	});

	test("encodes close, cancel, and describe as their bare union arms", () => {
		for (const [type, which] of [
			["close", EmbeddedControl_Op_Which.CLOSE],
			["cancel", EmbeddedControl_Op_Which.CANCEL],
			["describe", EmbeddedControl_Op_Which.DESCRIBE],
		] as const) {
			const request = control(11n, { type, contextId: 3n });
			expect(request.contextId).toBe(3n);
			expect(request.op.which()).toBe(which);
		}
	});

	test("clamps an interrupt wait into the runtime's one-millisecond to one-minute band", () => {
		expect(control(12n, { type: "interrupt", contextId: 3n }).op.interrupt.timeoutMillis).toBe(2000);
		expect(control(12n, { type: "interrupt", contextId: 3n, timeoutMillis: 0 }).op.interrupt.timeoutMillis).toBe(
			MIN_EMBEDDED_INTERRUPT_MILLIS,
		);
		expect(
			control(12n, { type: "interrupt", contextId: 3n, timeoutMillis: 10_000_000 }).op.interrupt.timeoutMillis,
		).toBe(MAX_EMBEDDED_INTERRUPT_MILLIS);
	});

	test("encodes reset flags and defaults them to the warm rebuild", () => {
		const defaults = control(13n, { type: "reset", contextId: 4n }).op.reset;
		expect(defaults.preserveWarmth).toBe(true);
		expect(defaults.reinitPrimary).toBe(true);
		const explicit = control(13n, {
			type: "reset",
			contextId: 4n,
			preserveWarmth: true,
			reinitPrimary: false,
		}).op.reset;
		expect(explicit.reinitPrimary).toBe(false);
	});

	test("clamps a poll wait to one second so a host cannot park an isolate thread", () => {
		const poll = control(14n, { type: "poll-output", contextId: 5n, waitMillis: 90_000, maxBytes: 4096 }).op
			.pollOutput;
		expect(poll.waitMillis).toBe(MAX_EMBEDDED_POLL_WAIT_MILLIS);
		expect(poll.maxBytes).toBe(4096);
		expect(control(14n, { type: "poll-output", contextId: 5n }).op.pollOutput.waitMillis).toBe(0);
	});

	test("encodes an inline context eval with mode, args, stdin, and language", () => {
		const invocation: EmbeddedContextInvocation = {
			contextId: 9n,
			language: "python",
			source: { type: "content", code: "print(1)" },
			sourceName: "cell-1.py",
			mode: "interactive",
			args: ["--one", "two"],
			stdin: Uint8Array.of(1, 2, 3),
			captureResultValue: false,
		};
		const request = decodeContextCall(encodeContextCall(21n, invocation));

		expect(request.protocolVersion).toBe(ProtocolVersion.V2);
		expect(request.requestId).toBe(21n);
		expect(request.contextId).toBe(9n);
		expect(request.language).toBe(Language.PYTHON);
		expect(request.source.which()).toBe(EmbeddedContextCall_Source_Which.CODE);
		expect(request.source.code).toBe("print(1)");
		expect(request.sourceName).toBe("cell-1.py");
		expect(request.mode).toBe(EmbeddedEvalMode.INTERACTIVE);
		expect(listValues(request.args)).toEqual(["--one", "two"]);
		expect(Array.from(request.stdin.toUint8Array())).toEqual([1, 2, 3]);
		expect(request.captureResultValue).toBe(false);
	});

	test("encodes a mainScript file eval and leaves an unspecified language to the context default", () => {
		const request = decodeContextCall(
			encodeContextCall(22n, {
				contextId: 9n,
				source: { type: "file", path: "/workspace/main.py" },
				mode: "main-script",
			}),
		);
		expect(request.language).toBe(Language.UNKNOWN);
		expect(request.mode).toBe(EmbeddedEvalMode.MAIN_SCRIPT);
		expect(request.source.which()).toBe(EmbeddedContextCall_Source_Which.FILE);
		expect(request.source.file).toBe("/workspace/main.py");
		expect(request.args.length).toBe(0);
	});

	test("rejects request ids outside the positive uint64 range on both roots", () => {
		expect(() => encodeContextCall(0n, { contextId: 1n, source: { type: "content", code: "" } })).toThrow(
			/request id/,
		);
		expect(() => encodeContextControl(0n, { type: "open", spec })).toThrow(/request id/);
		expect(() => encodeContextControl(1n, { type: "close", contextId: 0n })).toThrow(/context id/);
	});
});

describe("embedded runtime Tier 2 response decoding", () => {
	test("decodes a context-opened payload with its capability matrix", () => {
		const bytes = serializeResponse(31n, response => {
			const opened = response._initContextOpened();
			opened.contextId = 4n;
			const languages = opened._initLanguages(2);
			languages.set(0, Language.PYTHON);
			languages.set(1, Language.JAVA);
			const capabilities = opened._initCapabilities();
			capabilities.streaming = true;
			capabilities.reset = true;
			capabilities.interrupt = true;
			capabilities.mainScriptMode = true;
			capabilities.threadedContexts = true;
			capabilities.hostCalls = false;
			capabilities.captureResultValue = false;
			capabilities.maxContexts = 64;
			capabilities.maxOutputBytes = 66_060_288n;
		});

		expect(decodeEmbeddedResponse(bytes, 31n)).toEqual({
			type: "context-opened",
			requestId: 31n,
			contextId: 4n,
			languages: ["python", "java"],
			capabilities: {
				streaming: true,
				hostCalls: false,
				reset: true,
				interrupt: true,
				mainScriptMode: true,
				captureResultValue: false,
				threadedContexts: true,
				maxContexts: 64,
				maxOutputBytes: 66_060_288n,
			},
		});
	});

	test("decodes an ok eval result with buffered output and liveness", () => {
		const bytes = serializeResponse(32n, response => {
			const result = response._initEvalResult();
			result.outcome.ok = true;
			result.exitCode = 0;
			result._initStdout(3).copyBuffer(encoder.encode("hi\n"));
			result._initStderr(0);
			result.outputSeq = 0n;
			result.durationNanos = 1234n;
			result.contextAlive = true;
		});

		expect(decodeEmbeddedResponse(bytes, 32n)).toEqual({
			type: "eval-result",
			requestId: 32n,
			result: {
				outcome: { type: "ok" },
				exitCode: 0,
				stdout: "hi\n",
				stderr: "",
				outputSeq: 0n,
				durationNanos: 1234n,
				contextAlive: true,
			},
		});
	});

	test("decodes a guest exit as an error outcome that keeps the context alive", () => {
		const bytes = serializeResponse(33n, response => {
			const result = response._initEvalResult();
			const error = result.outcome._initError();
			error.typeName = "SystemExit";
			error.message = "3";
			error.language = Language.PYTHON;
			error.isExit = true;
			error.exitStatus = 3;
			result.exitCode = 3;
			result._initStdout(0);
			result._initStderr(0);
			result.contextAlive = true;
		});

		const decoded = decodeEmbeddedResponse(bytes, 33n);
		expect(decoded).toMatchObject({ type: "eval-result", requestId: 33n });
		if (decoded.type !== "eval-result") throw new Error("expected an eval result");
		expect(decoded.result.contextAlive).toBe(true);
		expect(decoded.result.exitCode).toBe(3);
		expect(decoded.result.outcome).toEqual({
			type: "error",
			error: {
				typeName: "SystemExit",
				message: "3",
				language: "python",
				isSyntaxError: false,
				isHostWrapped: false,
				isInternal: false,
				isCancelled: false,
				isExit: true,
				exitStatus: 3,
			},
		});
	});

	test("distinguishes an unset source location, stack, and cause from present-but-empty ones", () => {
		const withUnset = serializeResponse(34n, response => {
			const result = response._initEvalResult();
			const error = result.outcome._initError();
			error.typeName = "TypeError";
			error.message = "boom";
			error.language = Language.JAVASCRIPT;
			result._initStdout(0);
			result._initStderr(0);
			result.contextAlive = true;
		});
		const unset = decodeEmbeddedResponse(withUnset, 34n);
		if (unset.type !== "eval-result" || unset.result.outcome.type !== "error") throw new Error("expected an error");
		expect(unset.result.outcome.error.sourceLocation).toBeUndefined();
		expect(unset.result.outcome.error.stack).toBeUndefined();
		expect(unset.result.outcome.error.causedBy).toBeUndefined();

		const withEmpty = serializeResponse(35n, response => {
			const result = response._initEvalResult();
			const error = result.outcome._initError();
			error.typeName = "TypeError";
			error.message = "boom";
			error.language = Language.JAVASCRIPT;
			error._initSourceLocation();
			error._initStack(0);
			result._initStdout(0);
			result._initStderr(0);
			result.contextAlive = true;
		});
		const empty = decodeEmbeddedResponse(withEmpty, 35n);
		if (empty.type !== "eval-result" || empty.result.outcome.type !== "error") throw new Error("expected an error");
		expect(empty.result.outcome.error.sourceLocation).toEqual({ file: "", line: 0, col: 0, endLine: 0, endCol: 0 });
		expect(empty.result.outcome.error.stack).toEqual([]);
	});

	test("decodes a stack and a cause chain, treating elision markers as ordinary advisory text", () => {
		const bytes = serializeResponse(36n, response => {
			const result = response._initEvalResult();
			const error = result.outcome._initError();
			error.typeName = "Error";
			error.message = "outer";
			error.language = Language.JAVASCRIPT;
			const location = error._initSourceLocation();
			location.file = "cell.js";
			location.line = 2;
			location.col = 7;
			location.endLine = 2;
			location.endCol = 9;
			const stack = error._initStack(2);
			const first = stack.get(0);
			first.function = "inner";
			first.file = "cell.js";
			first.line = 2;
			first.isGuest = true;
			first.language = Language.JAVASCRIPT;
			const marker = stack.get(1);
			marker.function = "<elided: 5 more frames>";
			const cause = error._initCausedBy();
			cause.typeName = "<elided>";
			cause.message = "cause chain truncated at 8 links; next was Error";
			cause.language = Language.JAVASCRIPT;
			result._initStdout(0);
			result._initStderr(0);
			result.contextAlive = true;
		});

		const decoded = decodeEmbeddedResponse(bytes, 36n);
		if (decoded.type !== "eval-result" || decoded.result.outcome.type !== "error") {
			throw new Error("expected an error outcome");
		}
		const error = decoded.result.outcome.error;
		expect(error.sourceLocation).toEqual({ file: "cell.js", line: 2, col: 7, endLine: 2, endCol: 9 });
		expect(error.stack).toEqual([
			{ function: "inner", file: "cell.js", line: 2, isGuest: true, language: "js" },
			{ function: "<elided: 5 more frames>", file: "", line: 0, isGuest: false, language: "unknown" },
		]);
		// The markers are guest-spoofable, so they decode as plain frames and links: no flag is derived from them.
		expect(error.causedBy?.typeName).toBe("<elided>");
		expect(error.causedBy).not.toHaveProperty("causedBy");
		expect(error.causedBy).not.toHaveProperty("stack");
	});

	test("decodes the cancelled, interrupted, and output-limit outcome arms", () => {
		const arms = [
			["cancelled", (outcome: { cancelled: true }) => (outcome.cancelled = true)],
			["interrupted", (outcome: { interrupted: true }) => (outcome.interrupted = true)],
			["output-limit-exceeded", (outcome: { outputLimitExceeded: true }) => (outcome.outputLimitExceeded = true)],
		] as const;
		for (const [type, set] of arms) {
			const bytes = serializeResponse(37n, response => {
				const result = response._initEvalResult();
				set(result.outcome as never);
				result._initStdout(0);
				result._initStderr(0);
				result.contextAlive = true;
			});
			const decoded = decodeEmbeddedResponse(bytes, 37n);
			if (decoded.type !== "eval-result") throw new Error("expected an eval result");
			expect(decoded.result.outcome).toEqual({ type });
			expect(decoded.result.contextAlive).toBe(true);
		}
	});

	test("decodes an output batch as raw ordered chunks so multi-byte runes may straddle a boundary", () => {
		const bytes = serializeResponse(38n, response => {
			const batch = response._initOutputBatch();
			const chunks = batch._initChunks(3);
			const first = chunks.get(0);
			first.stream = 0;
			first._initData(2).copyBuffer(Uint8Array.of(0x6f, 0xe2));
			first.seq = 1n;
			const second = chunks.get(1);
			second.stream = 0;
			second._initData(2).copyBuffer(Uint8Array.of(0x9c, 0x93));
			second.seq = 2n;
			const third = chunks.get(2);
			third.stream = 1;
			third._initData(3).copyBuffer(encoder.encode("err"));
			third.seq = 3n;
			batch.seq = 3n;
			batch.complete = true;
		});

		expect(decodeEmbeddedResponse(bytes, 38n)).toEqual({
			type: "output-batch",
			requestId: 38n,
			seq: 3n,
			complete: true,
			chunks: [
				{ stream: "stdout", data: Uint8Array.of(0x6f, 0xe2), seq: 1n },
				{ stream: "stdout", data: Uint8Array.of(0x9c, 0x93), seq: 2n },
				{ stream: "stderr", data: Uint8Array.of(0x65, 0x72, 0x72), seq: 3n },
			],
		});
	});

	test("rejects an output chunk whose stream discriminator is neither stdout nor stderr", () => {
		const bytes = serializeResponse(39n, response => {
			const batch = response._initOutputBatch();
			const chunk = batch._initChunks(1).get(0);
			chunk.stream = 7;
			chunk._initData(0);
			chunk.seq = 1n;
			batch.seq = 1n;
		});
		expectInternalError(() => decodeEmbeddedResponse(bytes, 39n), "output stream");
	});

	test("decodes a context acknowledgement and a description", () => {
		expect(
			decodeEmbeddedResponse(
				serializeResponse(40n, response => (response.contextAck = true)),
				40n,
			),
		).toEqual({ type: "context-ack", requestId: 40n });

		const described = serializeResponse(41n, response => {
			const description = response._initDescription();
			description.contextId = 6n;
			description.state = "Idle";
			const languages = description._initLanguages(1);
			languages.set(0, Language.JAVASCRIPT);
			description.label = "kernel-1";
			description._initCapabilities().streaming = true;
			description.evalCount = 3n;
			description.resetCount = 1n;
		});
		const decoded = decodeEmbeddedResponse(described, 41n);
		// describe carries no primaryLanguage: a known schema gap the host must not synthesize.
		expect(decoded).toMatchObject({
			type: "description",
			requestId: 41n,
			contextId: 6n,
			state: "Idle",
			languages: ["js"],
			label: "kernel-1",
			evalCount: 3n,
			resetCount: 1n,
		});
		expect(decoded).not.toHaveProperty("primaryLanguage");
	});

	test("decodes every Tier 2 failure code, including the ones only contexts can raise", () => {
		const codes = [
			[WireFailureCode.UNKNOWN_CONTEXT, EmbeddedFailureCode.UNKNOWN_CONTEXT],
			[WireFailureCode.UNSUPPORTED_OPERATION, EmbeddedFailureCode.UNSUPPORTED_OPERATION],
			[WireFailureCode.CONTEXT_POISONED, EmbeddedFailureCode.CONTEXT_POISONED],
			[WireFailureCode.OUTPUT_LIMIT_EXCEEDED, EmbeddedFailureCode.OUTPUT_LIMIT_EXCEEDED],
			[WireFailureCode.HOST_CALL_REJECTED, EmbeddedFailureCode.HOST_CALL_REJECTED],
			[WireFailureCode.INTERRUPT_TIMED_OUT, EmbeddedFailureCode.INTERRUPT_TIMED_OUT],
			[WireFailureCode.CONTEXT_LIMIT_EXCEEDED, EmbeddedFailureCode.CONTEXT_LIMIT_EXCEEDED],
		] as const;
		for (const [wire, expected] of codes) {
			const bytes = serializeResponse(42n, response => {
				const failure = response._initFailure();
				failure.code = wire;
				failure.message = "context failure";
			});
			expect(decodeEmbeddedResponse(bytes, 42n)).toEqual({
				type: "failure",
				requestId: 42n,
				code: expected,
				message: "context failure",
			});
		}
	});

	test("requires context responses to echo the submitted positive request id", () => {
		const bytes = serializeResponse(43n, response => {
			response._initEvalResult()._initStdout(0);
		});
		expectInternalError(() => decodeEmbeddedResponse(bytes, 44n), "request id");
		const zero = serializeResponse(0n, response => {
			response._initEvalResult()._initStdout(0);
		});
		expectInternalError(() => decodeEmbeddedResponse(zero, 0n), "positive request id");
	});

	test("decodes a host-call payload the build never emits, so a staged rollout stays legible", () => {
		const bytes = serializeResponse(45n, response => {
			const call = response._initHostCall();
			call.callId = 2n;
			call.contextId = 6n;
			call.target = "tool.read";
			const scratch = new Message().initRoot(EmbeddedExecutionResult);
			const argument = scratch._initStdout(2);
			argument.copyBuffer(encoder.encode("{}"));
			call._initArgs(1).set(0, argument);
		});
		expect(decodeEmbeddedResponse(bytes, 45n)).toEqual({
			type: "host-call",
			requestId: 45n,
			callId: 2n,
			contextId: 6n,
			target: "tool.read",
			args: [Uint8Array.of(0x7b, 0x7d)],
		});
	});
});
