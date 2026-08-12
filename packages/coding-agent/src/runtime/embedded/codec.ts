import { Data, Message, utils } from "capnp-es";
import { RuntimeRpcError } from "../protocol";
import { ProtocolVersion } from "./generated/base";
import { CliCommand } from "./generated/cli";
import {
	EmbeddedCallRequest,
	EmbeddedOpenRequest,
	EmbeddedResponse,
	EmbeddedResponse_Which,
	EmbeddedFailureCode as WireFailureCode,
} from "./generated/embed";
import { Language } from "./generated/engine";
import {
	EngineInvocation_CliInvocation_RunMode,
	EngineInvocation_CliInvocation_SourceLanguage,
} from "./generated/invocation";

export interface EmbeddedOpenConfig {
	languages: Array<"js" | "ts" | "python" | "java" | "kotlin">;
}

export interface EmbeddedRunInvocation {
	source: { type: "content"; code: string; name: string } | { type: "file"; path: string };
	language: "js" | "ts" | "python" | "java" | "kotlin";
	args: string[];
	cwd: string;
	environment: Readonly<Record<string, string>>;
	stdin: Uint8Array;
}

export interface EmbeddedExecutionResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	killed: boolean;
}

export const EmbeddedFailureCode = {
	INVALID_REQUEST: "invalid-request",
	INCOMPATIBLE_PROTOCOL: "incompatible-protocol",
	UNSUPPORTED_LANGUAGE: "unsupported-language",
	BUSY: "busy",
	REQUEST_NOT_ACTIVE: "request-not-active",
	CLOSED: "closed",
	INTERNAL: "internal",
} as const;
export type EmbeddedFailureCode = (typeof EmbeddedFailureCode)[keyof typeof EmbeddedFailureCode];

export type EmbeddedDecodedResponse =
	| { type: "opened"; requestId: bigint }
	| { type: "completed"; requestId: bigint; result: EmbeddedExecutionResult }
	| { type: "cancelled"; requestId: bigint }
	| { type: "closed"; requestId: bigint }
	| { type: "failure"; requestId: bigint; code: EmbeddedFailureCode; message: string };

type EmbeddedLanguage = EmbeddedRunInvocation["language"];

const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_PROCESS_EXIT_CODE = 255;
const ARGUMENT_SLICE_OFFSET = 1;
export const MAX_EMBEDDED_ARGUMENT_COUNT = 0xffff;
const WIRE_LANGUAGE: Record<EmbeddedLanguage, Language> = {
	js: Language.JAVASCRIPT,
	ts: Language.TYPESCRIPT,
	python: Language.PYTHON,
	java: Language.JAVA,
	kotlin: Language.KOTLIN,
};
const WIRE_SOURCE_LANGUAGE: Record<EmbeddedLanguage, EngineInvocation_CliInvocation_SourceLanguage> = {
	js: EngineInvocation_CliInvocation_SourceLanguage.JAVASCRIPT,
	ts: EngineInvocation_CliInvocation_SourceLanguage.TYPESCRIPT,
	python: EngineInvocation_CliInvocation_SourceLanguage.PYTHON,
	java: EngineInvocation_CliInvocation_SourceLanguage.JAVA,
	kotlin: EngineInvocation_CliInvocation_SourceLanguage.KOTLIN,
};
const INLINE_SOURCE_NAME: Record<EmbeddedLanguage, string> = {
	js: "[eval].js",
	ts: "[eval].ts",
	python: "[eval].py",
	java: "[eval].java",
	kotlin: "[eval].kt",
};
const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export function encodeOpenRequest(config: EmbeddedOpenConfig): Uint8Array {
	const message = new Message();
	const request = message.initRoot(EmbeddedOpenRequest);
	request.protocolVersion = ProtocolVersion.V2;
	const languages = request._initLanguages(config.languages.length);
	for (let index = 0; index < config.languages.length; index += 1) {
		const language = config.languages[index];
		if (language !== undefined) languages.set(index, WIRE_LANGUAGE[language]);
	}
	return new Uint8Array(message.toArrayBuffer());
}

export function encodeRunRequest(requestId: bigint, invocation: EmbeddedRunInvocation): Uint8Array {
	if (requestId <= 0n || requestId > MAX_UINT64) {
		throw new RuntimeRpcError("invalid-params", "Embedded runtime call request id must be between 1 and 2^64 - 1.", {
			requestId: requestId.toString(),
		});
	}
	if (invocation.args.length > MAX_EMBEDDED_ARGUMENT_COUNT) {
		throw new RuntimeRpcError("invalid-params", "Embedded runtime invocation has too many arguments.", {
			argumentCount: invocation.args.length,
		});
	}
	if (invocation.source.type === "content" && invocation.source.name !== INLINE_SOURCE_NAME[invocation.language]) {
		throw new RuntimeRpcError(
			"invalid-params",
			`Embedded inline ${invocation.language} source must use the name ${INLINE_SOURCE_NAME[invocation.language]}.`,
			{ name: invocation.source.name },
		);
	}

	const message = new Message();
	const request = message.initRoot(EmbeddedCallRequest);
	request.protocolVersion = ProtocolVersion.V2;
	request.requestId = requestId;
	request._initStdin(invocation.stdin.byteLength).copyBuffer(invocation.stdin);

	const wireInvocation = request._initInvocation();
	const argumentsList = wireInvocation
		._initArgs()
		._initArgs()
		._initList(invocation.args.length + ARGUMENT_SLICE_OFFSET);
	const delimiter = argumentsList.get(0);
	delimiter.key = "--";
	delimiter.value.noValue = true;
	for (let index = 0; index < invocation.args.length; index += 1) {
		const argument = argumentsList.get(index + ARGUMENT_SLICE_OFFSET);
		argument.key = invocation.args[index] ?? "";
		argument.value.noValue = true;
	}

	const environment = Object.entries(invocation.environment);
	const wireEnvironment = wireInvocation._initEnv();
	wireEnvironment.size = environment.length;
	const variables = wireEnvironment._initVars(environment.length);
	for (let index = 0; index < environment.length; index += 1) {
		const entry = environment[index];
		if (entry === undefined) continue;
		const variable = variables.get(index);
		variable.key = entry[0];
		variable.value = entry[1];
	}

	// EngineConfig.shared / .caching / .flags are intentionally left at their
	// capnp defaults: the embedded runtime's codec (WHIPLASH EmbeddedCodec.kt)
	// reads engineConfig only for directories.workingDir — the other fields are
	// never consulted, and a 4-cell shared×caching sweep measured no effect
	// (2026-08-10, docs/aura/ACTIONS_CONSOLIDATE.md "Phase 0.5"). Do not wire
	// them to env/settings again without a WHIPLASH-side change that reads them.
	wireInvocation
		._initMeta()
		._initEngineConfig()
		._initDirectories()
		._initWorkingDir()
		._initPath()
		._initPathString().path = invocation.cwd;

	const cli = wireInvocation._initInvocation()._initCli();
	cli.subcommand = CliCommand.RUN;
	const run = cli._initCommand()._initRun();
	run.mode = EngineInvocation_CliInvocation_RunMode.STANDARD;
	run.sourceLanguage = WIRE_SOURCE_LANGUAGE[invocation.language];
	const scriptArgs = run._initScriptArgs();
	scriptArgs.offset = ARGUMENT_SLICE_OFFSET;
	scriptArgs.count = invocation.args.length;
	const source = run._initSourceCode();
	if (invocation.source.type === "content") {
		source.code = invocation.source.code;
	} else {
		source._initFile()._initFilepath()._initPathString().path = invocation.source.path;
	}

	return new Uint8Array(message.toArrayBuffer());
}

export function decodeEmbeddedResponse(bytes: Uint8Array, expectedRequestId: bigint): EmbeddedDecodedResponse {
	try {
		if (typeof expectedRequestId !== "bigint" || expectedRequestId < 0n || expectedRequestId > MAX_UINT64) {
			throw new RuntimeRpcError("internal", `Invalid expected embedded runtime request id: ${expectedRequestId}.`);
		}
		const message = new Message(bytes, false);
		const response = message.getRoot(EmbeddedResponse);
		if (response.protocolVersion !== ProtocolVersion.V2) {
			throw new RuntimeRpcError(
				"internal",
				`Embedded runtime response uses protocol version ${response.protocolVersion}; expected ${ProtocolVersion.V2}.`,
			);
		}

		const requestId = response.requestId;

		switch (response.which()) {
			case EmbeddedResponse_Which.OPENED:
				if (expectedRequestId !== 0n || requestId !== 0n) {
					throw new RuntimeRpcError(
						"internal",
						`Embedded runtime opened response requires expected and actual request id 0; received expected ${expectedRequestId}, actual ${requestId}.`,
					);
				}
				return { type: "opened", requestId };
			case EmbeddedResponse_Which.COMPLETED: {
				assertPositiveCallRequestId(expectedRequestId, "completed");
				assertExactRequestId(requestId, expectedRequestId);
				const completed = response.completed;
				if (
					!Number.isInteger(completed.exitCode) ||
					completed.exitCode < 0 ||
					completed.exitCode > MAX_PROCESS_EXIT_CODE
				) {
					throw new RuntimeRpcError(
						"internal",
						`Embedded runtime response exit code ${completed.exitCode} is outside the supported range 0-${MAX_PROCESS_EXIT_CODE}.`,
					);
				}
				return {
					type: "completed",
					requestId,
					result: {
						exitCode: completed.exitCode,
						stdout: decodeDataAsUtf8(completed.stdout, "stdout"),
						stderr: decodeDataAsUtf8(completed.stderr, "stderr"),
						killed: completed.killed,
					},
				};
			}
			case EmbeddedResponse_Which.CANCELLED:
				assertPositiveCallRequestId(expectedRequestId, "cancelled");
				assertExactRequestId(requestId, expectedRequestId);
				return { type: "cancelled", requestId };
			case EmbeddedResponse_Which.CLOSED:
				if (expectedRequestId !== 0n || requestId !== 0n) {
					throw new RuntimeRpcError(
						"internal",
						`Embedded runtime closed response requires expected and actual request id 0; received expected ${expectedRequestId}, actual ${requestId}.`,
					);
				}
				return { type: "closed", requestId };
			case EmbeddedResponse_Which.FAILURE: {
				assertExactRequestId(requestId, expectedRequestId);
				const failure = response.failure;
				return {
					type: "failure",
					requestId,
					code: decodeFailureCode(failure.code),
					message: decodeFailureMessage(failure),
				};
			}
			default:
				throw new RuntimeRpcError(
					"internal",
					`Unknown embedded runtime response union discriminant: ${response.which()}.`,
				);
		}
	} catch (error) {
		if (error instanceof RuntimeRpcError) throw error;
		throw new RuntimeRpcError("internal", "Failed to decode Cap'n Proto embedded runtime response.", {
			cause: error instanceof Error ? error.message : String(error),
		});
	}
}

function assertPositiveCallRequestId(requestId: bigint, responseType: "completed" | "cancelled"): void {
	if (requestId <= 0n) {
		throw new RuntimeRpcError(
			"internal",
			`Embedded runtime ${responseType} response requires a positive request id; received ${requestId}.`,
		);
	}
}

function assertExactRequestId(actualRequestId: bigint, expectedRequestId: bigint): void {
	if (actualRequestId !== expectedRequestId) {
		throw new RuntimeRpcError(
			"internal",
			`Embedded runtime response request id ${actualRequestId} does not match submitted request id ${expectedRequestId}.`,
		);
	}
}

function decodeDataAsUtf8(data: Data, field: "stdout" | "stderr"): string {
	const copy = new Uint8Array(data.toArrayBuffer());
	try {
		return FATAL_UTF8_DECODER.decode(copy);
	} catch (cause) {
		throw new RuntimeRpcError("internal", `Embedded runtime ${field} is not valid UTF-8.`, {
			cause: cause instanceof Error ? cause.message : String(cause),
		});
	}
}

function decodeFailureMessage(failure: EmbeddedResponse["failure"]): string {
	const copy = new Uint8Array(Data.fromPointer(utils.getPointer(0, failure)).toArrayBuffer());
	if (copy.byteLength === 0) return "";
	if (copy[copy.byteLength - 1] !== 0) {
		throw new RuntimeRpcError("internal", "Embedded runtime failure message is not NUL-terminated Text.");
	}
	try {
		return FATAL_UTF8_DECODER.decode(copy.subarray(0, copy.byteLength - 1));
	} catch (cause) {
		throw new RuntimeRpcError("internal", "Embedded runtime failure message is not valid UTF-8.", {
			cause: cause instanceof Error ? cause.message : String(cause),
		});
	}
}

function decodeFailureCode(code: WireFailureCode): EmbeddedFailureCode {
	switch (code) {
		case WireFailureCode.INVALID_REQUEST:
			return EmbeddedFailureCode.INVALID_REQUEST;
		case WireFailureCode.INCOMPATIBLE_PROTOCOL:
			return EmbeddedFailureCode.INCOMPATIBLE_PROTOCOL;
		case WireFailureCode.UNSUPPORTED_LANGUAGE:
			return EmbeddedFailureCode.UNSUPPORTED_LANGUAGE;
		case WireFailureCode.BUSY:
			return EmbeddedFailureCode.BUSY;
		case WireFailureCode.REQUEST_NOT_ACTIVE:
			return EmbeddedFailureCode.REQUEST_NOT_ACTIVE;
		case WireFailureCode.CLOSED:
			return EmbeddedFailureCode.CLOSED;
		case WireFailureCode.INTERNAL:
			return EmbeddedFailureCode.INTERNAL;
		default:
			throw new RuntimeRpcError("internal", `Unknown embedded runtime failure code: ${code}.`);
	}
}
