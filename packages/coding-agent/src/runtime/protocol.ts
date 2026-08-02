/**
 * Aura runtime capability protocol — a small JSON-RPC 2.0 contract between
 * the RuntimeService (what tools see) and a RuntimeEndpoint (how dispatch
 * happens). The wire shape is the seam: today's endpoint shells the runtime
 * CLI per call; a stdio broker daemon or an in-process endpoint are drop-ins.
 */

/**
 * Version of this contract, surfaced by `runtime/status` (and printed by
 * `aura runtime status`). Informational today — there is no negotiation and no
 * v1 endpoint left in the tree — but it is the honest answer to "what shape is
 * this seam?", which is what a future stdio-broker or in-process endpoint needs.
 *
 * v2 = the shared-workdir generation: one temp directory per request-handler
 * flow with a bound runner, so a single request can be several invocations.
 * v3 = engine-aware unified run, including Java and Kotlin.
 */
export const RUNTIME_PROTOCOL_VERSION = 3 as const;

export type RuntimeMethod =
	| "runtime/run"
	| "runtime/check"
	| "runtime/insights"
	| "runtime/profile"
	| "runtime/jvm"
	| "runtime/spawn"
	| "runtime/status";

export type RuntimeLanguage = "js" | "ts" | "python" | "java" | "kotlin";

export type RunEngine = "bun" | "elide";

/** The two compiled guest languages, also used by the specialized JVM flows. */
export type JvmLanguage = "java" | "kotlin";

export interface RuntimeRunParams {
	/** Inline source; mutually exclusive with `path`. Written to a temp file (stdin source mode is unsupported by the runtime). */
	code?: string;
	/** Existing file to run; preserves project cwd/imports. */
	path?: string;
	/** Language for inline code (default "ts"); inferred from the extension in path mode. */
	language?: RuntimeLanguage;
	/** Execution engine. Defaults to Bun for JavaScript/TypeScript and Elide otherwise. */
	engine?: RunEngine;
	args?: string[];
	stdin?: string;
	timeoutMs?: number;
	cwd?: string;
	/** Java/Kotlin entrypoint override. Invalid for JavaScript, TypeScript, and Python. */
	mainClass?: string;
}

export interface RuntimeInsightsParams extends RuntimeRunParams {
	/** Inline insight instrumentation script (JS). */
	insight?: string;
	/** Existing insight script path. */
	insightPath?: string;
}

export interface ResolvedRunTarget {
	language: RuntimeLanguage;
	engine: RunEngine;
}

const RUN_ENGINES: Record<RuntimeLanguage, readonly RunEngine[]> = {
	js: ["bun", "elide"],
	ts: ["bun", "elide"],
	python: ["elide"],
	java: ["elide"],
	kotlin: ["elide"],
};

/** Resolve defaults and reject unsupported run combinations before endpoint side effects. */
export function resolveRunTarget(params: RuntimeRunParams): ResolvedRunTarget {
	if (params.code === undefined && params.path === undefined) {
		throw new RuntimeRpcError("invalid-params", "run requires code (inline) or path (existing file).");
	}
	if (params.code !== undefined && params.path !== undefined) {
		throw new RuntimeRpcError("invalid-params", "code and path are mutually exclusive.");
	}
	const language = params.language ?? (params.path === undefined ? "ts" : inferRunLanguage(params.path));
	if (!Object.hasOwn(RUN_ENGINES, language)) {
		throw new RuntimeRpcError("invalid-params", `Unsupported runtime language "${language}".`);
	}
	const engine = params.engine ?? (language === "js" || language === "ts" ? "bun" : "elide");
	if (!RUN_ENGINES[language].includes(engine)) {
		throw new RuntimeRpcError("invalid-params", `Engine "${engine}" does not support language "${language}".`);
	}
	if (params.mainClass !== undefined && language !== "java" && language !== "kotlin") {
		throw new RuntimeRpcError("invalid-params", "mainClass is only valid for Java and Kotlin.");
	}
	return { language, engine };
}

function inferRunLanguage(file: string): RuntimeLanguage {
	const extension = file.slice(file.lastIndexOf(".")).toLowerCase();
	if (extension === ".js" || extension === ".mjs" || extension === ".cjs" || extension === ".jsx") return "js";
	if (extension === ".ts" || extension === ".mts" || extension === ".cts" || extension === ".tsx") return "ts";
	if (extension === ".py") return "python";
	if (extension === ".java") return "java";
	if (extension === ".kt" || extension === ".kts") return "kotlin";
	throw new RuntimeRpcError("invalid-params", `Cannot infer a supported language from path "${file}".`);
}

export interface RuntimeProfileParams extends RuntimeRunParams {
	mode: "cputracing" | "cpusampling";
}

/** The five JVM flows behind the single `runtime/jvm` method. */
export type RuntimeJvmAction = "run" | "disassemble" | "format" | "jar" | "deps";

/**
 * Parameters for `runtime/jvm`. One method, one action union: every flow is
 * "materialize source in a workdir, compile, then do one more thing with the
 * result", so they share plumbing rather than six near-identical methods.
 * Which fields are required depends on `action`; the endpoint answers
 * `invalid-params` naming the missing field.
 */
export interface RuntimeJvmParams {
	action: RuntimeJvmAction;
	/** Source language. Required except for `jar`/`deps` in artifact mode. */
	language?: JvmLanguage;
	/** Inline source to compile. */
	code?: string;
	/** Entrypoint/target class override; see `deriveJvmMainClass`. */
	mainClass?: string;
	/** Arguments passed to the Java/Kotlin program for `run`. */
	args?: string[];
	/** Standard input passed to the Java/Kotlin program for `run`. */
	stdin?: string;
	/** `jar` sub-mode: build a jar from source, or list an existing one. Default `create`. */
	mode?: "create" | "inspect";
	/** Destination written by `jar` (create) or `deps`, resolved against `cwd`. */
	output?: string;
	/** Required to replace an existing `output`. */
	overwrite?: boolean;
	/** Existing jar to inspect (`jar`, mode `inspect`), resolved against `cwd`. */
	jar?: string;
	/** Source path for `run`; source, `.class`, `.jar`, or class directory for `deps`; resolved against `cwd`. */
	path?: string;
	/** Base directory for path-bearing fields and the `run` program cwd. */
	cwd?: string;
	timeoutMs?: number;
}

/**
 * Result of a `runtime/jvm` flow. It extends {@link RuntimeExecResult} with the
 * invocation that produced it (`phase`) plus whatever that flow uniquely
 * produced. `exitCode`/`stdout`/`stderr` describe the invocation named by
 * `phase`: the last one the flow reached when it stopped early (a failed compile
 * is reported as the compiler saw it), and otherwise the flow's *defining*
 * invocation — for `jar` create that is the `--create`, not the `--list` that
 * follows it, whose output is reported separately as `listing`.
 */
export interface RuntimeJvmResult extends RuntimeExecResult {
	action: RuntimeJvmAction;
	/** The invocation these streams came from — `compile` means the flow stopped there. */
	phase: "compile" | RuntimeJvmAction;
	language?: JvmLanguage;
	/** Class the flow compiled and targeted. */
	className?: string;
	/** `format`: the formatted source, read back from the workdir. */
	formatted?: string;
	/** `jar`/`deps`: absolute path actually written. */
	output?: string;
	/** `jar` (inspect): absolute path of the archive that was listed. */
	jar?: string;
	/** `jar`: `jar --list` output for the built or inspected archive. */
	listing?: string;
}

// ── runtime/spawn: launch descriptors for long-running processes ─────────────
// The endpoint composes the command line; it deliberately does NOT start the
// process. Lifecycle belongs to the `hub` supervisor, which already owns
// session-scoped naming, log tailing, readiness, stop, and restart. So the
// method's result is a *descriptor* — what to run, where, and how to recognize
// the endpoint the process prints — and nothing in the runtime layer holds a
// process handle.

/** Parameters for composing a supervised static-file server launch. */
export interface RuntimeSpawnParams {
	/** Directory of static files to serve, resolved against `cwd`. */
	directory: string;
	/** TCP port to bind. */
	port?: number;
	/** Interface to bind. */
	host?: string;
	/** Working directory for the launched process and base for `directory`. */
	cwd?: string;
}

/**
 * One endpoint-recognition rule, applied to the accumulated (ANSI-stripped)
 * startup output of a launched process. Rules travel with the descriptor rather
 * than living in tool code so that the layer that composed the argv is also the
 * layer that says what its banner looks like — when the runtime changes its
 * startup line, one file changes.
 */
export interface RuntimeEndpointRule {
	/** `RegExp` source, matched case-sensitively against the whole captured output. */
	pattern: string;
	/** Capture group holding the endpoint. 0 (the default) means the whole match. */
	group?: number;
	/** Scheme to prepend when the captured text is a bare `host:port`. */
	prefix?: string;
}

/**
 * What to launch for a long-running runtime flow. `argv[0]` is the resolved
 * runtime binary; everything else is its command line.
 */
export interface RuntimeLaunchDescriptor {
	argv: string[];
	/** Working directory for the process; absolute. */
	cwd: string;
	/**
	 * Environment *overlay*, not a full environment: the supervisor that starts
	 * the process merges these over its own inherited environment. Passing a
	 * whole snapshot of `process.env` here would bake this session's secrets into
	 * a persisted launch spec, so only the variables the runtime needs travel.
	 */
	env: Record<string, string>;
	/** Rules tried in order against the startup output; the first match wins. */
	endpointPattern: RuntimeEndpointRule[];
	/** How the binary in `argv[0]` was found; see {@link RuntimeLaunchDescriptor.shimWarning}. */
	source: RuntimeSource;
	/**
	 * Set when `source` is `"path"`: a runtime found on `PATH` may be an npm `.bin`
	 * wrapper that execs or forks the real binary, so the supervised process is
	 * not necessarily the one holding the port. Advisory — the caller surfaces it
	 * rather than refusing the launch.
	 */
	shimWarning?: string;
}

/** Validation-only project compilation; never emits build artifacts. */
export interface RuntimeCheckParams {
	cwd?: string;
	timeoutMs?: number;
}

export interface RuntimeExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
	killed: boolean;
}

export interface RuntimeRunResult extends RuntimeExecResult {
	engine: RunEngine;
	language: RuntimeLanguage;
}

export type RuntimeAdapter = "process" | "embedded" | "auto";
export type RuntimeEffectiveAdapter = "process" | "embedded";
export type RuntimeEmbeddedSource = "setting" | "env" | "managed" | "binary-adjacent";

export type RuntimeSource = "flag" | "env" | "managed" | "path";

export interface RuntimeStatusResult {
	available: boolean;
	version?: string;
	binaryPath?: string;
	source?: RuntimeSource;
	guidance?: string;
	protocolVersion: number;
	/** Requested adapter from settings. `auto` is preserved rather than collapsed. */
	adapter?: RuntimeAdapter;
	/** Adapter selected after resolving and validating the embedded runtime library. */
	effectiveAdapter?: RuntimeEffectiveAdapter;
	embeddedLibraryPath?: string;
	embeddedLibrarySource?: RuntimeEmbeddedSource;
	embeddedAbiVersion?: number;
	embeddedSchemaHash?: string;
}

export type RuntimeErrorCode =
	| "runtime-missing"
	| "download-failed"
	| "timeout"
	| "invalid-params"
	| "cancelled"
	| "internal";

export class RuntimeRpcError extends Error {
	constructor(
		readonly code: RuntimeErrorCode,
		message: string,
		readonly data?: Record<string, unknown>,
	) {
		super(message);
		this.name = "RuntimeRpcError";
	}
}

/** Preserve protocol errors and normalize unknown transport failures at the endpoint boundary. */
export function toRuntimeRpcError(error: unknown): RuntimeRpcError {
	if (error instanceof RuntimeRpcError) return error;
	return new RuntimeRpcError("internal", error instanceof Error ? error.message : String(error));
}

export interface RuntimeRpcRequest {
	jsonrpc: "2.0";
	id: number;
	method: RuntimeMethod;
	params: unknown;
}

export type RuntimeRpcResponse =
	| { jsonrpc: "2.0"; id: number; result: unknown }
	| { jsonrpc: "2.0"; id: number; error: { code: RuntimeErrorCode; message: string; data?: Record<string, unknown> } };

let nextRequestId = 1;

export function createRequest(method: RuntimeMethod, params: unknown): RuntimeRpcRequest {
	return { jsonrpc: "2.0", id: nextRequestId++, method, params };
}

export function okResponse(id: number, result: unknown): RuntimeRpcResponse {
	return { jsonrpc: "2.0", id, result };
}

export function errorResponse(id: number, err: RuntimeRpcError): RuntimeRpcResponse {
	return { jsonrpc: "2.0", id, error: { code: err.code, message: err.message, data: err.data } };
}

export function unwrapResponse<T>(res: RuntimeRpcResponse): T {
	if ("error" in res) {
		throw new RuntimeRpcError(res.error.code, res.error.message, res.error.data);
	}
	return res.result as T;
}
