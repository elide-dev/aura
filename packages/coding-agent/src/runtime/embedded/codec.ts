import { Data, type List, Message, utils } from "capnp-es";
import { RuntimeRpcError } from "../protocol";
import { ProtocolVersion } from "./generated/base";
import { CliCommand } from "./generated/cli";
import {
	EmbeddedCallRequest,
	EmbeddedContextCall,
	EmbeddedControl,
	EmbeddedEvalResult_Outcome_Which,
	EmbeddedOpenRequest,
	EmbeddedResponse,
	EmbeddedResponse_Which,
	type EmbeddedCapabilities as WireCapabilities,
	type EmbeddedContextOpen as WireContextOpen,
	type EmbeddedContextOpened as WireContextOpened,
	type EmbeddedDescription as WireDescription,
	EmbeddedEvalMode as WireEvalMode,
	type EmbeddedEvalResult as WireEvalResult,
	EmbeddedFailureCode as WireFailureCode,
	type EmbeddedOutputBatch as WireOutputBatch,
} from "./generated/embed";
import { Language } from "./generated/engine";
import type { ExceptionSummary, SourceLocation, StackFrame } from "./generated/guest";
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
	UNKNOWN_CONTEXT: "unknown-context",
	UNSUPPORTED_OPERATION: "unsupported-operation",
	CONTEXT_POISONED: "context-poisoned",
	OUTPUT_LIMIT_EXCEEDED: "output-limit-exceeded",
	HOST_CALL_REJECTED: "host-call-rejected",
	INTERRUPT_TIMED_OUT: "interrupt-timed-out",
	CONTEXT_LIMIT_EXCEEDED: "context-limit-exceeded",
} as const;
export type EmbeddedFailureCode = (typeof EmbeddedFailureCode)[keyof typeof EmbeddedFailureCode];

/** Languages Aura names on the wire; `unknown` also arrives from the runtime for ids it cannot name. */
export type EmbeddedWireLanguage = EmbeddedRunInvocation["language"] | "wasm" | "ruby" | "unknown";

/** Feature matrix the runtime reports at context open; every false flag answers `unsupported-operation`. */
export interface EmbeddedContextCapabilities {
	streaming: boolean;
	hostCalls: boolean;
	reset: boolean;
	interrupt: boolean;
	mainScriptMode: boolean;
	captureResultValue: boolean;
	threadedContexts: boolean;
	maxContexts: number;
	maxOutputBytes: bigint;
}

export interface EmbeddedGuestSourceLocation {
	file: string;
	line: number;
	col: number;
	endLine: number;
	endCol: number;
}

export interface EmbeddedGuestStackFrame {
	function: string;
	file: string;
	line: number;
	isGuest: boolean;
	language: EmbeddedWireLanguage;
}

/**
 * A guest exception as a value, never a transport failure.
 *
 * `sourceLocation`, `stack`, and `causedBy` are absent exactly when the wire pointer is unset — a
 * present-but-empty stack decodes as `[]`, which is a different fact. The runtime truncates long
 * cause chains and stacks with in-band `<elided>` markers, but a guest can name its own error type
 * or function the same way, so those markers are ADVISORY: this decoder never derives a flag from
 * them and no caller may make a trust or control-flow decision on them.
 */
export interface EmbeddedGuestException {
	typeName: string;
	message: string;
	language: EmbeddedWireLanguage;
	isSyntaxError: boolean;
	isHostWrapped: boolean;
	isInternal: boolean;
	isCancelled: boolean;
	isExit: boolean;
	exitStatus: number;
	sourceLocation?: EmbeddedGuestSourceLocation;
	stack?: EmbeddedGuestStackFrame[];
	causedBy?: EmbeddedGuestException;
}

export type EmbeddedEvalOutcome =
	| { type: "ok" }
	| { type: "error"; error: EmbeddedGuestException }
	| { type: "cancelled" }
	| { type: "interrupted" }
	| { type: "output-limit-exceeded" };

export interface EmbeddedEvalResult {
	outcome: EmbeddedEvalOutcome;
	exitCode: number;
	/** Empty when the context streams output; drain it with `poll-output` instead. */
	stdout: string;
	stderr: string;
	/** High-water mark of streamed chunks; reads 0 unless the host polled mid-eval. */
	outputSeq: bigint;
	durationNanos: bigint;
	/** Cleared only by a poisoned context — never by a guest error and never by a guest exit. */
	contextAlive: boolean;
}

export interface EmbeddedOutputChunk {
	stream: "stdout" | "stderr";
	/** Raw bytes: a multi-byte rune may straddle two chunks, so decode text only after joining. */
	data: Uint8Array;
	seq: bigint;
}

export type EmbeddedDecodedResponse =
	| { type: "opened"; requestId: bigint }
	| { type: "completed"; requestId: bigint; result: EmbeddedExecutionResult }
	| { type: "cancelled"; requestId: bigint }
	| { type: "closed"; requestId: bigint }
	| { type: "failure"; requestId: bigint; code: EmbeddedFailureCode; message: string }
	| {
			type: "context-opened";
			requestId: bigint;
			contextId: bigint;
			languages: EmbeddedWireLanguage[];
			capabilities: EmbeddedContextCapabilities;
	  }
	| { type: "eval-result"; requestId: bigint; result: EmbeddedEvalResult }
	| { type: "output-batch"; requestId: bigint; chunks: EmbeddedOutputChunk[]; seq: bigint; complete: boolean }
	| { type: "context-ack"; requestId: bigint }
	| {
			type: "description";
			requestId: bigint;
			contextId: bigint;
			state: string;
			languages: EmbeddedWireLanguage[];
			label: string;
			capabilities: EmbeddedContextCapabilities;
			evalCount: bigint;
			resetCount: bigint;
	  }
	| { type: "host-call"; requestId: bigint; callId: bigint; contextId: bigint; target: string; args: Uint8Array[] };

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
const WIRE_LANGUAGE_NAME: ReadonlyMap<Language, EmbeddedWireLanguage> = new Map([
	[Language.JAVASCRIPT, "js"],
	[Language.TYPESCRIPT, "ts"],
	[Language.PYTHON, "python"],
	[Language.JAVA, "java"],
	[Language.KOTLIN, "kotlin"],
	[Language.WASM, "wasm"],
	[Language.RUBY, "ruby"],
	[Language.UNKNOWN, "unknown"],
]);
const THREAD_HOSTILE_LANGUAGES: ReadonlySet<EmbeddedLanguage> = new Set(["js", "ts"]);

/** Wire envelope ceiling for a context's per-eval output budget: 63 MiB, not 64 (WHIPLASH derives it). */
export const MAX_EMBEDDED_OUTPUT_BYTES = 66_060_288n;
/** `pollOutput.waitMillis` is a park bound, not a deadline; the runtime clamps it on decode. */
export const MAX_EMBEDDED_POLL_WAIT_MILLIS = 1_000;
export const MIN_EMBEDDED_INTERRUPT_MILLIS = 1;
export const MAX_EMBEDDED_INTERRUPT_MILLIS = 60_000;
const DEFAULT_INTERRUPT_MILLIS = 2_000;
const MAX_UINT32 = 0xffff_ffff;
/** The producer emits at most 8 `causedBy` links below the root, the last of them a sentinel. */
const MAX_CAUSE_CHAIN_DEPTH = 8;

/** Immutable configuration for one persistent guest context. Contexts are never deduplicated. */
export interface EmbeddedContextSpecInput {
	languages: readonly EmbeddedLanguage[];
	/** Omitted leaves the wire `unknown`, which the runtime derives from `languages[0]`. */
	primaryLanguage?: EmbeddedLanguage;
	allowThreads?: boolean;
	allowPolyglot?: boolean;
	streamOutput?: boolean;
	workingDir?: string;
	environment?: Readonly<Record<string, string>>;
	outputByteLimit?: bigint;
	outputChunkBytes?: number;
	label?: string;
}

export type EmbeddedEvalMode = "interactive" | "module" | "main-script";

export interface EmbeddedContextInvocation {
	contextId: bigint;
	/** Omitted leaves the wire `unknown`, which the runtime resolves to the context's primary language. */
	language?: EmbeddedLanguage;
	source: { type: "content"; code: string } | { type: "file"; path: string };
	sourceName?: string;
	mode?: EmbeddedEvalMode;
	args?: readonly string[];
	stdin?: Uint8Array;
	captureResultValue?: boolean;
}

/**
 * A non-eval context operation. These run concurrently with an in-flight eval, which is why they
 * ride the control worker rather than the execution worker.
 *
 * `hostCallPoll`/`hostCallResolve` are deliberately absent: the shipped build answers them with
 * `unsupported-operation`, and a host feature-detects on `capabilities.hostCalls` instead.
 */
export type EmbeddedControlOperation =
	| { type: "open"; spec: EmbeddedContextSpecInput }
	| { type: "close"; contextId: bigint }
	| { type: "interrupt"; contextId: bigint; timeoutMillis?: number }
	| { type: "cancel"; contextId: bigint }
	| { type: "reset"; contextId: bigint; preserveWarmth?: boolean; reinitPrimary?: boolean }
	| { type: "poll-output"; contextId: bigint; waitMillis?: number; maxBytes?: number }
	| { type: "describe"; contextId: bigint };

const WIRE_EVAL_MODE: Record<EmbeddedEvalMode, WireEvalMode> = {
	interactive: WireEvalMode.INTERACTIVE,
	module: WireEvalMode.MODULE,
	"main-script": WireEvalMode.MAIN_SCRIPT,
};

function assertRequestId(requestId: bigint): void {
	if (typeof requestId !== "bigint" || requestId <= 0n || requestId > MAX_UINT64) {
		throw new RuntimeRpcError("invalid-params", "Embedded runtime request id must be between 1 and 2^64 - 1.", {
			requestId: String(requestId),
		});
	}
}

function assertContextId(contextId: bigint): void {
	if (typeof contextId !== "bigint" || contextId <= 0n || contextId > MAX_UINT64) {
		throw new RuntimeRpcError("invalid-params", "Embedded runtime context id must be between 1 and 2^64 - 1.", {
			contextId: String(contextId),
		});
	}
}

function clampUint32(value: number, minimum: number, maximum: number): number {
	if (!Number.isFinite(value)) return minimum;
	return Math.min(Math.max(Math.trunc(value), minimum), maximum);
}

function encodeContextSpec(spec: EmbeddedContextSpecInput, wire: WireContextOpen): void {
	if (spec.languages.length === 0) {
		throw new RuntimeRpcError("invalid-params", "An embedded context must permit at least one language.");
	}
	// Rejected, never silently downgraded: a JS-bearing context that asks for threads has a bug, and a
	// quiet downgrade would surface later as a mysterious hang instead of a loud invalid request.
	if (spec.allowThreads === true && spec.languages.some(language => THREAD_HOSTILE_LANGUAGES.has(language))) {
		throw new RuntimeRpcError(
			"invalid-params",
			"An embedded context cannot combine allowThreads with JavaScript or TypeScript.",
			{ languages: [...spec.languages] },
		);
	}
	if (spec.primaryLanguage !== undefined && !spec.languages.includes(spec.primaryLanguage)) {
		throw new RuntimeRpcError(
			"invalid-params",
			"An embedded context's primary language must appear in its permitted languages.",
			{ primaryLanguage: spec.primaryLanguage, languages: [...spec.languages] },
		);
	}

	const target = wire._initSpec();
	const languages = target._initLanguages(spec.languages.length);
	for (let index = 0; index < spec.languages.length; index += 1) {
		const language = spec.languages[index];
		if (language !== undefined) languages.set(index, WIRE_LANGUAGE[language]);
	}
	if (spec.primaryLanguage !== undefined) target.primaryLanguage = WIRE_LANGUAGE[spec.primaryLanguage];
	if (spec.allowThreads !== undefined) target.allowThreads = spec.allowThreads;
	if (spec.allowPolyglot !== undefined) target.allowPolyglot = spec.allowPolyglot;
	if (spec.streamOutput !== undefined) target.streamOutput = spec.streamOutput;
	if (spec.workingDir !== undefined) target.workingDir = spec.workingDir;
	if (spec.outputByteLimit !== undefined) {
		const limit = spec.outputByteLimit < 0n ? 0n : spec.outputByteLimit;
		target.outputByteLimit = limit > MAX_EMBEDDED_OUTPUT_BYTES ? MAX_EMBEDDED_OUTPUT_BYTES : limit;
	}
	if (spec.outputChunkBytes !== undefined) target.outputChunkBytes = clampUint32(spec.outputChunkBytes, 0, MAX_UINT32);
	if (spec.label !== undefined) target.label = spec.label;

	const environment = Object.entries(spec.environment ?? {});
	if (environment.length > 0) {
		const wireEnvironment = target._initEnvironment();
		wireEnvironment.size = environment.length;
		const variables = wireEnvironment._initVars(environment.length);
		for (let index = 0; index < environment.length; index += 1) {
			const entry = environment[index];
			if (entry === undefined) continue;
			const variable = variables.get(index);
			variable.key = entry[0];
			variable.value = entry[1];
		}
	}
}

/** Encode one `EmbeddedControl` op. `open` ignores `contextId`; every other op requires a live one. */
export function encodeContextControl(requestId: bigint, operation: EmbeddedControlOperation): Uint8Array {
	assertRequestId(requestId);
	if (operation.type !== "open") assertContextId(operation.contextId);

	const message = new Message();
	const request = message.initRoot(EmbeddedControl);
	request.protocolVersion = ProtocolVersion.V2;
	request.requestId = requestId;
	if (operation.type !== "open") request.contextId = operation.contextId;
	const op = request._initOp();

	switch (operation.type) {
		case "open":
			encodeContextSpec(operation.spec, op._initOpen());
			break;
		case "close":
			op.close = true;
			break;
		case "interrupt":
			op._initInterrupt().timeoutMillis = clampUint32(
				operation.timeoutMillis ?? DEFAULT_INTERRUPT_MILLIS,
				MIN_EMBEDDED_INTERRUPT_MILLIS,
				MAX_EMBEDDED_INTERRUPT_MILLIS,
			);
			break;
		case "cancel":
			op.cancel = true;
			break;
		case "reset": {
			const reset = op._initReset();
			if (operation.preserveWarmth !== undefined) reset.preserveWarmth = operation.preserveWarmth;
			if (operation.reinitPrimary !== undefined) reset.reinitPrimary = operation.reinitPrimary;
			break;
		}
		case "poll-output": {
			// 0 is the wire default: an unparked poll that answers immediately. That is almost never what
			// a drain wants — `pumpEmbeddedContextOutput` supplies a real park bound for exactly that reason.
			const poll = op._initPollOutput();
			poll.waitMillis = clampUint32(operation.waitMillis ?? 0, 0, MAX_EMBEDDED_POLL_WAIT_MILLIS);
			poll.maxBytes = clampUint32(operation.maxBytes ?? 0, 0, MAX_UINT32);
			break;
		}
		case "describe":
			op.describe = true;
			break;
	}
	return new Uint8Array(message.toArrayBuffer());
}

/** Encode one `EmbeddedContextCall` — an eval against an already-open context. */
export function encodeContextCall(requestId: bigint, invocation: EmbeddedContextInvocation): Uint8Array {
	assertRequestId(requestId);
	assertContextId(invocation.contextId);
	const args = invocation.args ?? [];
	if (args.length > MAX_EMBEDDED_ARGUMENT_COUNT) {
		throw new RuntimeRpcError("invalid-params", "Embedded runtime context invocation has too many arguments.", {
			argumentCount: args.length,
		});
	}

	const message = new Message();
	const request = message.initRoot(EmbeddedContextCall);
	request.protocolVersion = ProtocolVersion.V2;
	request.requestId = requestId;
	request.contextId = invocation.contextId;
	if (invocation.language !== undefined) request.language = WIRE_LANGUAGE[invocation.language];
	const source = request._initSource();
	if (invocation.source.type === "content") source.code = invocation.source.code;
	else source.file = invocation.source.path;
	if (invocation.sourceName !== undefined) request.sourceName = invocation.sourceName;
	request.mode = WIRE_EVAL_MODE[invocation.mode ?? "interactive"];
	if (args.length > 0) {
		const wireArgs = request._initArgs(args.length);
		for (let index = 0; index < args.length; index += 1) wireArgs.set(index, args[index] ?? "");
	}
	const stdin = invocation.stdin ?? new Uint8Array();
	request._initStdin(stdin.byteLength).copyBuffer(stdin);
	if (invocation.captureResultValue !== undefined) request.captureResultValue = invocation.captureResultValue;
	return new Uint8Array(message.toArrayBuffer());
}

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
			case EmbeddedResponse_Which.CONTEXT_OPENED: {
				assertPositiveContextRequestId(expectedRequestId, "context-opened");
				assertExactRequestId(requestId, expectedRequestId);
				return { type: "context-opened", requestId, ...decodeContextOpened(response.contextOpened) };
			}
			case EmbeddedResponse_Which.EVAL_RESULT:
				assertPositiveContextRequestId(expectedRequestId, "eval-result");
				assertExactRequestId(requestId, expectedRequestId);
				return { type: "eval-result", requestId, result: decodeEvalResult(response.evalResult) };
			case EmbeddedResponse_Which.OUTPUT_BATCH:
				assertPositiveContextRequestId(expectedRequestId, "output-batch");
				assertExactRequestId(requestId, expectedRequestId);
				return { type: "output-batch", requestId, ...decodeOutputBatch(response.outputBatch) };
			case EmbeddedResponse_Which.CONTEXT_ACK:
				assertPositiveContextRequestId(expectedRequestId, "context-ack");
				assertExactRequestId(requestId, expectedRequestId);
				return { type: "context-ack", requestId };
			case EmbeddedResponse_Which.DESCRIPTION:
				assertPositiveContextRequestId(expectedRequestId, "description");
				assertExactRequestId(requestId, expectedRequestId);
				return { type: "description", requestId, ...decodeDescription(response.description) };
			case EmbeddedResponse_Which.HOST_CALL: {
				assertPositiveContextRequestId(expectedRequestId, "host-call");
				assertExactRequestId(requestId, expectedRequestId);
				const hostCall = response.hostCall;
				return {
					type: "host-call",
					requestId,
					callId: hostCall.callId,
					contextId: hostCall.contextId,
					target: hostCall.target,
					args: listOf(hostCall.args).map(argument => new Uint8Array(argument.toArrayBuffer())),
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

function assertPositiveContextRequestId(requestId: bigint, responseType: string): void {
	if (requestId <= 0n) {
		throw new RuntimeRpcError(
			"internal",
			`Embedded runtime ${responseType} response requires a positive request id; received ${requestId}.`,
		);
	}
}

function listOf<T>(list: List<T>): T[] {
	return Array.from({ length: list.length }, (_, index) => list.get(index));
}

function decodeLanguage(language: Language): EmbeddedWireLanguage {
	// Unnameable ids fold to `unknown` on the runtime's encode side; mirror that instead of failing.
	return WIRE_LANGUAGE_NAME.get(language) ?? "unknown";
}

function decodeCapabilities(capabilities: WireCapabilities): EmbeddedContextCapabilities {
	return {
		streaming: capabilities.streaming,
		hostCalls: capabilities.hostCalls,
		reset: capabilities.reset,
		interrupt: capabilities.interrupt,
		mainScriptMode: capabilities.mainScriptMode,
		captureResultValue: capabilities.captureResultValue,
		threadedContexts: capabilities.threadedContexts,
		maxContexts: capabilities.maxContexts,
		maxOutputBytes: capabilities.maxOutputBytes,
	};
}

function decodeContextOpened(
	opened: WireContextOpened,
): Omit<Extract<EmbeddedDecodedResponse, { type: "context-opened" }>, "type" | "requestId"> {
	return {
		contextId: opened.contextId,
		languages: listOf(opened.languages).map(decodeLanguage),
		capabilities: decodeCapabilities(opened.capabilities),
	};
}

function decodeSourceLocation(location: SourceLocation): EmbeddedGuestSourceLocation {
	return {
		file: location.file,
		line: location.line,
		col: location.col,
		endLine: location.endLine,
		endCol: location.endCol,
	};
}

function decodeStackFrame(frame: StackFrame): EmbeddedGuestStackFrame {
	return {
		function: frame.function,
		file: frame.file,
		line: frame.line,
		isGuest: frame.isGuest,
		language: decodeLanguage(frame.language),
	};
}

function decodeException(summary: ExceptionSummary, depth = 0): EmbeddedGuestException {
	// An unset pointer means "the runtime had nothing to say"; a present-but-empty one means
	// "it looked and found nothing". They are different facts, so absent stays absent here.
	//
	// The chain is capped so the decoder is total: the producer emits at most 8 links below the root
	// plus a sentinel, so anything deeper is a malformed or hostile message and is simply not walked.
	const walkCause = summary._hasCausedBy() && depth < MAX_CAUSE_CHAIN_DEPTH;
	return {
		typeName: summary.typeName,
		message: summary.message,
		language: decodeLanguage(summary.language),
		isSyntaxError: summary.isSyntaxError,
		isHostWrapped: summary.isHostWrapped,
		isInternal: summary.isInternal,
		isCancelled: summary.isCancelled,
		isExit: summary.isExit,
		exitStatus: summary.exitStatus,
		...(summary._hasSourceLocation() ? { sourceLocation: decodeSourceLocation(summary.sourceLocation) } : {}),
		...(summary._hasStack() ? { stack: listOf(summary.stack).map(decodeStackFrame) } : {}),
		...(walkCause ? { causedBy: decodeException(summary.causedBy, depth + 1) } : {}),
	};
}

function decodeEvalOutcome(result: WireEvalResult): EmbeddedEvalOutcome {
	switch (result.outcome.which()) {
		case EmbeddedEvalResult_Outcome_Which.OK:
			return { type: "ok" };
		case EmbeddedEvalResult_Outcome_Which.ERROR:
			return { type: "error", error: decodeException(result.outcome.error) };
		case EmbeddedEvalResult_Outcome_Which.CANCELLED:
			return { type: "cancelled" };
		case EmbeddedEvalResult_Outcome_Which.INTERRUPTED:
			return { type: "interrupted" };
		case EmbeddedEvalResult_Outcome_Which.OUTPUT_LIMIT_EXCEEDED:
			return { type: "output-limit-exceeded" };
		default:
			throw new RuntimeRpcError(
				"internal",
				`Unknown embedded runtime eval outcome discriminant: ${result.outcome.which()}.`,
			);
	}
}

function decodeEvalResult(result: WireEvalResult): EmbeddedEvalResult {
	return {
		outcome: decodeEvalOutcome(result),
		exitCode: result.exitCode,
		stdout: decodeDataAsUtf8(result.stdout, "stdout"),
		stderr: decodeDataAsUtf8(result.stderr, "stderr"),
		outputSeq: result.outputSeq,
		durationNanos: result.durationNanos,
		contextAlive: result.contextAlive,
	};
}

function decodeOutputBatch(
	batch: WireOutputBatch,
): Omit<Extract<EmbeddedDecodedResponse, { type: "output-batch" }>, "type" | "requestId"> {
	const chunks = listOf(batch.chunks).map<EmbeddedOutputChunk>(chunk => {
		if (chunk.stream !== 0 && chunk.stream !== 1) {
			throw new RuntimeRpcError(
				"internal",
				`Embedded runtime output stream discriminator ${chunk.stream} is neither stdout nor stderr.`,
			);
		}
		return {
			stream: chunk.stream === 0 ? "stdout" : "stderr",
			data: new Uint8Array(chunk.data.toArrayBuffer()),
			seq: chunk.seq,
		};
	});
	return { chunks, seq: batch.seq, complete: batch.complete };
}

function decodeDescription(
	description: WireDescription,
): Omit<Extract<EmbeddedDecodedResponse, { type: "description" }>, "type" | "requestId"> {
	// `describe` carries no primaryLanguage — a known schema gap. A host that opened with `unknown`
	// cannot learn what it got, and this decoder does not invent one.
	return {
		contextId: description.contextId,
		state: description.state,
		languages: listOf(description.languages).map(decodeLanguage),
		label: description.label,
		capabilities: decodeCapabilities(description.capabilities),
		evalCount: description.evalCount,
		resetCount: description.resetCount,
	};
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
		case WireFailureCode.UNKNOWN_CONTEXT:
			return EmbeddedFailureCode.UNKNOWN_CONTEXT;
		case WireFailureCode.UNSUPPORTED_OPERATION:
			return EmbeddedFailureCode.UNSUPPORTED_OPERATION;
		case WireFailureCode.CONTEXT_POISONED:
			return EmbeddedFailureCode.CONTEXT_POISONED;
		case WireFailureCode.OUTPUT_LIMIT_EXCEEDED:
			return EmbeddedFailureCode.OUTPUT_LIMIT_EXCEEDED;
		case WireFailureCode.HOST_CALL_REJECTED:
			return EmbeddedFailureCode.HOST_CALL_REJECTED;
		case WireFailureCode.INTERRUPT_TIMED_OUT:
			return EmbeddedFailureCode.INTERRUPT_TIMED_OUT;
		case WireFailureCode.CONTEXT_LIMIT_EXCEEDED:
			return EmbeddedFailureCode.CONTEXT_LIMIT_EXCEEDED;
		default:
			throw new RuntimeRpcError("internal", `Unknown embedded runtime failure code: ${code}.`);
	}
}
