import { type } from "@oh-my-pi/omptype";
import { formatExecResult } from "../runtime/format";
import type { RuntimeJvmResult } from "../runtime/protocol";
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
 * Render a flow that produced a payload of its own (a disassembly listing,
 * formatted source, a report). Any non-success — including a failed compile,
 * which arrives with `phase: "compile"` — falls back to the shared exec
 * rendering so the model sees the toolchain's own diagnostics verbatim.
 */
export function renderJvmPayload(result: RuntimeJvmResult, payload: string | undefined): string {
	if (result.exitCode !== 0 || result.killed) return formatExecResult(result);
	return payload?.replace(/\n+$/, "") || "(no output)";
}
