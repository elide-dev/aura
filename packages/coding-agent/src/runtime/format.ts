import path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type RuntimeErrorCode, type RuntimeExecResult, RuntimeRpcError } from "./protocol";

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

// ── protocol failures ────────────────────────────────────────────────────────
// A `RuntimeRpcError` is the only place a failed *dispatch* explains itself: the
// argv that was invoked, the stderr the toolchain printed, the URL that would
// not answer. Thrown out of a tool that detail is destroyed — the agent loop
// flattens a thrown tool error to `{ content: message, details: {} }`, which is
// how a model ends up staring at "Runtime archive extraction failed." with no
// way to act on it. So runtime tools convert protocol failures into a failed
// tool *result* built here, and the projection below decides what may travel.

/** Details attached to a runtime tool result that failed at the protocol level. */
export type RuntimeErrorDetails = {
	code: RuntimeErrorCode;
	message: string;
	/** Redacted projection of `RuntimeRpcError.data`; see {@link formatRuntimeRpcError}. */
	[field: string]: unknown;
};

/**
 * Whether a settled runtime tool's details are an execution result rather than
 * a {@link RuntimeErrorDetails} projection — i.e. whether the call reached the
 * runtime at all. Non-model callers that drive these tools directly (the local
 * `$` Python shell) need the distinction the model reads off the text.
 */
export function isRuntimeExecResult(details: RuntimeExecResult | RuntimeErrorDetails): details is RuntimeExecResult {
	return typeof (details as RuntimeExecResult).exitCode === "number";
}

/**
 * Tail cap for projected `data` strings. Error payloads are stream-shaped
 * (stderr, a compiler log), and for those the *end* is the diagnosis — the
 * head is the part that scrolled by while things were still fine.
 */
const DATA_TAIL_LIMIT = 2048; // characters — 2 KiB of ASCII, which is what these payloads are

const REDACTED_PATH = "[path outside the project]";

/**
 * Keys whose value is the process environment under any spelling. Environment
 * variables carry tokens and are never a diagnostic the model needs, so the key
 * is dropped outright rather than filtered value-by-value.
 */
const ENV_KEY = /env/i;

/**
 * An absolute path in free text. The lookbehind keeps this off relative
 * fragments (`a/b`) — only a path that starts a token is a candidate. It
 * deliberately does NOT exempt a preceding `:`: JVM and GraalVM diagnostics
 * print locations scheme-prefixed (`file:/home/…`, `jar:file:/home/…`), and
 * those are exactly as revealing as a bare path. URLs are spared by shape
 * instead, in {@link redactPaths}. The trailing class stops at the punctuation
 * diagnostics wrap paths in (`tar: /x/y.tar: Cannot open`).
 */
const ABSOLUTE_PATH = /(?<![\w\\])(?:[A-Za-z]:[\\/]|\/)[^\s'"`:,;)\]}]+/g;

/** Sentence punctuation that trails a path in prose rather than belonging to it. */
const TRAILING_PUNCTUATION = /[.!?]+$/;

/** Whether `candidate` is `root` itself or lives under it. */
function isInsideRoot(root: string, candidate: string): boolean {
	const resolved = path.resolve(candidate);
	return resolved === root || resolved.startsWith(root + path.sep);
}

/**
 * Replace absolute paths that fall outside the project root. Runtime
 * diagnostics routinely name cache, staging, and temp locations, which map the
 * host's filesystem (and its username) into the transcript for no diagnostic
 * gain. Paths *inside* the project survive — those are what a fix acts on.
 *
 * Replacing rather than deleting is deliberate: the reader still sees that an
 * argument was a path and where it sat in the command line, without learning
 * where it pointed.
 *
 * A URL is not a location on this host, so `//host/p` (whatever scheme preceded
 * it — the match starts at the slashes) is kept. `///p` is not an authority: it
 * is the `file:///path` spelling, and its path is redacted like any other.
 */
function redactPaths(text: string, root: string): string {
	return text.replace(ABSOLUTE_PATH, match => {
		if (match.startsWith("//") && !match.startsWith("///")) return match;
		const trailing = TRAILING_PUNCTUATION.exec(match)?.[0] ?? "";
		const candidate = match.slice(0, match.length - trailing.length).replace(/^\/+/, "/");
		return isInsideRoot(root, candidate) ? match : `${REDACTED_PATH}${trailing}`;
	});
}

/** Keep the last {@link DATA_TAIL_LIMIT} characters of an oversized value. */
function capTail(text: string): string {
	return text.length <= DATA_TAIL_LIMIT ? text : text.slice(text.length - DATA_TAIL_LIMIT);
}

/**
 * Render a protocol failure for the model, with a redacted projection of its
 * `data` payload.
 *
 * What travels: `code`, the message, scalars, and string arrays — `argv` joined
 * with spaces, the way it would be typed. What does not: environment variables
 * (see {@link ENV_KEY}), absolute paths outside `root` (see {@link redactPaths}),
 * anything past the {@link DATA_TAIL_LIMIT} tail cap, and every nested object —
 * dropping those wholesale is the second guard on environment snapshots, and a
 * nested structure has no honest one-line rendering anyway. The message is
 * redacted on the same terms as the data, and `data` fields named `code`,
 * `message`, or `exitCode` are skipped so they cannot shadow this projection's
 * own contract or {@link isRuntimeExecResult}'s discriminator.
 *
 * @param root Project root paths are judged against; defaults to the process cwd.
 */
export function formatRuntimeRpcError(
	error: RuntimeRpcError,
	root?: string,
): { text: string; details: RuntimeErrorDetails } {
	const base = path.resolve(root ?? process.cwd());
	// The message gets the same treatment as the data: an error routinely names in
	// prose the very path it also attaches (`provision.ts` reports the install
	// directory both ways), and scrubbing one while printing the other is no
	// redaction at all.
	const message = redactPaths(error.message, base);
	const details: RuntimeErrorDetails = { code: error.code, message };
	const fields: string[] = [];
	const blocks: string[] = [];

	for (const [key, raw] of Object.entries(error.data ?? {})) {
		if (ENV_KEY.test(key)) continue;
		// `code` and `message` are this projection's own contract — callers narrow on
		// them (the `$` Python shell reads `code === "cancelled"`). A same-named data
		// field must not shadow them. `exitCode` is reserved for the same reason one
		// step further out: it is `isRuntimeExecResult`'s discriminator, so a numeric
		// `exitCode` in an error payload would make a failed call read as a completed
		// execution. No producer supplies one today; this keeps it that way.
		if (key === "code" || key === "message" || key === "exitCode") continue;
		if (typeof raw === "number" || typeof raw === "boolean") {
			details[key] = raw;
			fields.push(`${key}: ${raw}`);
			continue;
		}
		const text =
			typeof raw === "string"
				? raw
				: Array.isArray(raw) && raw.every(entry => typeof entry === "string")
					? raw.join(" ")
					: undefined;
		if (text === undefined) continue;
		const redacted = redactPaths(text, base);
		const value = capTail(redacted);
		details[key] = value;
		const elided = value.length < redacted.length ? ` (last ${value.length} of ${redacted.length} chars)` : "";
		// Stream-shaped values get their own block; a one-line value reads better inline.
		if (elided || value.includes("\n")) blocks.push(`--- ${key}${elided} ---\n${value}`);
		else fields.push(`${key}: ${value}`);
	}

	const header = `The runtime call failed (${error.code}): ${message}`;
	return { text: [header, ...fields, ...blocks].join("\n"), details };
}

/** A protocol failure as a failed tool result, carrying the detail the throw would have lost. */
export function runtimeRpcErrorResult(error: RuntimeRpcError, root?: string): AgentToolResult<RuntimeErrorDetails> {
	const { text, details } = formatRuntimeRpcError(error, root);
	return { content: [{ type: "text", text }], details, isError: true };
}

/** Outcome of {@link callRuntime}: the service's value, or the result to return in its place. */
export type RuntimeCallOutcome<T> =
	| { ok: true; value: T }
	| { ok: false; result: AgentToolResult<RuntimeErrorDetails> };

/**
 * Run one runtime RPC on behalf of a tool, converting protocol failures into a
 * failed tool result. Anything that is not a `RuntimeRpcError` — a missing
 * service, a bug in the tool — still throws: those are not runtime diagnostics
 * and the loop's own error path is the right place for them.
 *
 * `onRpcError` runs before the result is built, so a tool that must react to a
 * failure (retiring a poisoned service, say) still does so on the way out. No
 * shipped tool passes it right now: `run` was its only caller and retired with
 * the fork's execution surface, so an `internal` failure currently leaves the
 * cached service in place for `insights`/`profile`/`jvm_*`. The hook keeps its
 * contract test — closing that gap means giving this helper the service and
 * scope so every runtime tool inherits the retirement, not re-adding a private
 * method to each one.
 */
export async function callRuntime<T>(
	invoke: () => Promise<T>,
	options: { root?: string; onRpcError?: (error: RuntimeRpcError) => Promise<void> | void } = {},
): Promise<RuntimeCallOutcome<T>> {
	try {
		return { ok: true, value: await invoke() };
	} catch (error) {
		if (!(error instanceof RuntimeRpcError)) throw error;
		await options.onRpcError?.(error);
		return { ok: false, result: runtimeRpcErrorResult(error, options.root) };
	}
}
