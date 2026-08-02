import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { trace } from "@opentelemetry/api";
import {
	emitTelemetryEvent,
	type RuntimeCallCompletedTelemetry,
	type RuntimeCallErrorType,
	type RuntimeCallOutcome,
} from "../telemetry/events";
import {
	type RuntimeExecResult,
	type RuntimeJvmAction,
	type RuntimeLanguage,
	type RuntimeMethod,
	RuntimeRpcError,
	type RuntimeRunParams,
	resolveRunTarget,
} from "./protocol";

const RUNTIME_LANGUAGES: Readonly<Record<string, true>> = {
	js: true,
	ts: true,
	python: true,
	java: true,
	kotlin: true,
};
const JVM_ACTIONS: Readonly<Record<string, RuntimeJvmAction>> = {
	run: "run",
	disassemble: "disassemble",
	format: "format",
	jar: "jar",
	deps: "deps",
};

interface RuntimeCallClassification {
	action?: RuntimeJvmAction;
	language?: RuntimeLanguage;
	outcome: RuntimeCallOutcome;
	exitCode?: number;
	killed?: boolean;
	errorType?: RuntimeCallErrorType;
}

/** Observe one protocol request without changing its result or failure. */
export async function observeRuntimeCall<T>(
	method: RuntimeMethod,
	params: unknown,
	signal: AbortSignal | undefined,
	sessionId: string | undefined,
	call: () => Promise<T>,
): Promise<T> {
	const startedAt = performance.now();
	let result: T | undefined;
	let failure: unknown;
	let failed = false;
	try {
		result = await call();
		return result;
	} catch (error) {
		failed = true;
		failure = error;
		throw error;
	} finally {
		const durationMs = Math.max(0, performance.now() - startedAt);
		const classification = classifyRuntimeCall(method, params, result, failed, failure, signal);
		const event: RuntimeCallCompletedTelemetry = {
			type: "runtime.call.completed",
			sessionId,
			method,
			durationMs,
			...classification,
		};
		annotateActiveSpan(event);
		emitTelemetryEvent(event);
	}
}

function classifyRuntimeCall(
	method: RuntimeMethod,
	params: unknown,
	result: unknown,
	failed: boolean,
	failure: unknown,
	signal: AbortSignal | undefined,
): RuntimeCallClassification {
	const action = runtimeAction(method, params);
	const language = runtimeLanguage(method, params, result);
	if (failed) {
		const errorType = runtimeErrorType(failure, signal);
		return {
			action,
			language,
			outcome: errorType === "timeout" ? "timeout" : errorType === "cancelled" ? "cancelled" : "error",
			errorType,
		};
	}
	const exec = runtimeExecResult(result);
	if (!exec) return { action, language, outcome: "ok" };
	if (exec.killed) {
		return {
			action,
			language,
			outcome: signal?.aborted ? "cancelled" : "timeout",
			exitCode: exec.exitCode,
			killed: true,
			errorType: "killed",
		};
	}
	if (exec.exitCode !== 0) {
		return {
			action,
			language,
			outcome: "error",
			exitCode: exec.exitCode,
			killed: false,
			errorType: "non_zero_exit",
		};
	}
	return { action, language, outcome: "ok", exitCode: exec.exitCode, killed: false };
}

function runtimeAction(method: RuntimeMethod, params: unknown): RuntimeJvmAction | undefined {
	if (!isRecord(params)) return undefined;
	if (method === "runtime/jvm" && typeof params.action === "string") return JVM_ACTIONS[params.action];
	return undefined;
}

function runtimeLanguage(method: RuntimeMethod, params: unknown, result: unknown): RuntimeLanguage | undefined {
	if (isRecord(result) && isRuntimeLanguage(result.language)) return result.language;
	if (method === "runtime/jvm" && isRecord(params)) {
		if (isRuntimeLanguage(params.language)) return params.language;
		return undefined;
	}
	if (method === "runtime/run" || method === "runtime/insights" || method === "runtime/profile") {
		try {
			return resolveRunTarget(params as RuntimeRunParams).language;
		} catch {
			return isRecord(params) && isRuntimeLanguage(params.language) ? params.language : undefined;
		}
	}
	return undefined;
}

function runtimeExecResult(value: unknown): RuntimeExecResult | undefined {
	if (
		!isRecord(value) ||
		typeof value.exitCode !== "number" ||
		typeof value.durationMs !== "number" ||
		typeof value.killed !== "boolean"
	) {
		return undefined;
	}
	return value as unknown as RuntimeExecResult;
}

function runtimeErrorType(failure: unknown, signal: AbortSignal | undefined): RuntimeCallErrorType {
	if (failure instanceof RuntimeRpcError) return failure.code;
	if (signal?.aborted) return "cancelled";
	return "unknown";
}

function isRuntimeLanguage(value: unknown): value is RuntimeLanguage {
	return typeof value === "string" && RUNTIME_LANGUAGES[value] === true;
}

function annotateActiveSpan(event: RuntimeCallCompletedTelemetry): void {
	const span = trace.getActiveSpan();
	if (!span) return;
	try {
		span.setAttribute("aura.runtime.method", event.method);
		if (event.action !== undefined) span.setAttribute("aura.runtime.action", event.action);
		if (event.language !== undefined) span.setAttribute("aura.runtime.language", event.language);
		span.setAttribute("aura.runtime.outcome", event.outcome);
		span.setAttribute("aura.runtime.duration_ms", event.durationMs);
		if (event.exitCode !== undefined) span.setAttribute("aura.runtime.exit_code", event.exitCode);
		if (event.killed !== undefined) span.setAttribute("aura.runtime.killed", event.killed);
	} catch (error) {
		logger.debug("Failed to annotate runtime telemetry span", { error: String(error) });
	}
}
