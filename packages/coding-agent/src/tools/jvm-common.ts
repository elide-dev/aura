import { type } from "@oh-my-pi/omptype";
import { callRuntime, formatExecResult, type RuntimeCallOutcome } from "../runtime/format";
import type { RuntimeJvmParams, RuntimeJvmResult } from "../runtime/protocol";
import type { RuntimeService } from "../runtime/service";
import type { ToolSession } from ".";

/** The two compiled languages the JVM tools accept. */
export const jvmLanguage = type("'java' | 'kotlin'");

export const RUNTIME_SERVICE_UNAVAILABLE =
	"The runtime service is unavailable on this session (runtime.enabled may be false, or this host does not provide it).";

/** The session's runtime service, or the standard explanation of why there isn't one. */
export function requireRuntimeService(session: ToolSession): RuntimeService {
	const service = session.getRuntimeService?.();
	if (!service) throw new Error(RUNTIME_SERVICE_UNAVAILABLE);
	return service;
}

/**
 * Dispatch one JVM flow. A protocol failure comes back as the failed tool
 * result to return in place of a value — thrown, its `data` (the compiler argv,
 * the toolchain's stderr) would be flattened away before the model saw it.
 * Everything else, a missing service included, still throws.
 */
export function callJvm(
	session: ToolSession,
	params: RuntimeJvmParams,
	signal?: AbortSignal,
): Promise<RuntimeCallOutcome<RuntimeJvmResult>> {
	return callRuntime(() => requireRuntimeService(session).jvm(params, signal, session.getSessionId?.() ?? undefined), {
		root: session.cwd,
	});
}

/**
 * Render a flow that produced a payload of its own (a disassembly listing,
 * formatted source, a report). Any non-success — including a failed compile,
 * which arrives with `phase: "compile"` — falls back to the shared exec
 * rendering so the model sees the toolchain's own diagnostics verbatim.
 */
export function renderJvmPayload(result: RuntimeJvmResult, payload: string | undefined): string {
	if (result.exitCode !== 0 || result.killed) return formatExecResult(result);
	return payload?.replace(/\n+$/, "") || "(no output)";
}
