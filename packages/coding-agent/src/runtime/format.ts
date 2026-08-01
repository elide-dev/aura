import type { RuntimeExecResult } from "./protocol";

/** Whether an execution result represents a failed, timed out, or cancelled tool call. */
export function execResultFailed(result: RuntimeExecResult): boolean {
	return result.exitCode !== 0 || result.killed;
}

/**
 * Render an exec result for the model: stdout, stderr, and an exit annotation.
 *
 * This function does NOT truncate. Every runtime tool is constructed through
 * `wrapToolWithMetaNotice` (see `tools/index.ts` → `tools/output-meta.ts`), whose
 * wrapper spills any result past `tools.artifactSpillThreshold` (default 50KB) to a
 * session artifact and replaces the inline content with a head/tail preview plus an
 * `artifact://` reference — the same head/tail-plus-artifact convention `bash` presents
 * (though `bash` reaches it via its own `OutputSink` rather than this central spill).
 * That spill is the single truncation authority for runtime tool output.
 *
 * Caveat: the spill is a no-op when the session supplies no artifact manager, so a very
 * large result would then reach the model whole. Every real session provides one (the
 * in-memory `SessionManager` fallback included), so this only bites synthetic callers.
 *
 * An earlier revision capped each stream here (`MAX_OUTPUT_CHARS`, 400k chars) as
 * context-blowout protection. Removing it does not regress that protection: the central
 * threshold is ~8x stricter than the old cap, so it engages far sooner *and* preserves
 * the full text as an artifact, whereas anything truncated in here was destroyed before
 * the spill could ever see it. Two truncation points also meant two "truncated" notices
 * for one elision. Keep this function purely structural.
 */
export function formatExecResult(result: RuntimeExecResult): string {
	const parts: string[] = [];
	const stdout = result.stdout.replace(/\n+$/, "");
	const stderr = result.stderr.replace(/\n+$/, "");
	if (stdout) parts.push(stdout);
	if (stderr) parts.push(`--- stderr ---\n${stderr}`);
	if (result.killed) parts.push("(process was killed: timeout or cancellation)");
	if (result.exitCode !== 0) parts.push(`(exit code ${result.exitCode})`);
	if (parts.length === 0) parts.push(`(no output, exit code ${result.exitCode})`);
	return parts.join("\n");
}
