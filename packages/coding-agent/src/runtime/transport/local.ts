import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ELIDE_VERSION, MINIMUM_RUNTIME_VERSION } from "../dist";
import { deriveJvmMainClass, JVM_BYTECODE_RELEASE, jvmSourceFile } from "../jvm";
import {
	errorResponse,
	type JvmLanguage,
	okResponse,
	RUNTIME_PROTOCOL_VERSION,
	type RuntimeCheckParams,
	type RuntimeEndpointRule,
	type RuntimeExecResult,
	type RuntimeInsightsParams,
	type RuntimeJvmAction,
	type RuntimeJvmParams,
	type RuntimeJvmResult,
	type RuntimeLanguage,
	type RuntimeLaunchDescriptor,
	type RuntimeProfileParams,
	RuntimeRpcError,
	type RuntimeRpcRequest,
	type RuntimeRpcResponse,
	type RuntimeRunParams,
	type RuntimeSpawnParams,
	type RuntimeStatusResult,
} from "../protocol";
import { provisionRuntime } from "../provision";
import { pythonFileBootstrap } from "../python";
import { managedVersionDir, type ResolvedRuntime, resolveRuntimeBinary } from "../resolve";
import type { RuntimeEndpoint } from "../service";

export interface LocalEndpointOptions {
	explicitPath?: string;
	/**
	 * Managed-install version to use, from the `runtime.version` setting. Absent
	 * means the pinned {@link ELIDE_VERSION}. Only the pinned version carries a
	 * sha256 in {@link RUNTIME_DIST}, so an off-pin version is *selection only* —
	 * see {@link LocalRuntimeEndpoint.missingGuidance}.
	 */
	version?: string;
	/** Managed install root override (tests). */
	managedRoot?: string;
	autoDownload?: boolean;
	/** Environment used for binary resolution and for spawned runtime processes. Defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
	onProgress?: (message: string) => void;
	/** Injectable for tests. */
	provision?: typeof provisionRuntime;
	resolve?: typeof resolveRuntimeBinary;
}

const GUEST_EXT: Record<RuntimeLanguage, string> = { js: "js", ts: "ts", python: "py", java: "java", kotlin: "kt" };

/** Per-invocation spawn knobs. Anything absent falls back to the flow's defaults, then to the endpoint's env. */
export interface RuntimeSpawnOptions {
	stdin?: string;
	timeoutMs?: number;
	cwd?: string;
	/** Full spawn environment; see {@link jvmSpawnEnv}. Defaults to the endpoint's env. */
	env?: NodeJS.ProcessEnv;
}

/** One runtime invocation. The endpoint's own spawn; a parameter so workdir flows are testable without a binary. */
export type RuntimeSpawn = (
	argv: string[],
	opts: RuntimeSpawnOptions,
	signal?: AbortSignal,
) => Promise<RuntimeExecResult>;

/**
 * A temp directory plus a runner bound to it. Handed to a request handler so a
 * single protocol request can be several invocations over one directory
 * (`javac` → `java`, `javac` → `javap`) without the handler owning any
 * filesystem lifecycle. Endpoint-internal: no path ever reaches tool code.
 */
export interface RuntimeWorkdir {
	/** The flow's temp directory. Valid only until the flow returns. */
	readonly dir: string;
	/**
	 * Write `content` to `name` inside the workdir (nested names get their
	 * parents); returns the absolute path. `name` must stay inside the workdir —
	 * names are derived from model-supplied source (class names), so an escape
	 * attempt is `invalid-params`, not a write.
	 */
	write(name: string, content: string): Promise<string>;
	/** Run one invocation. Options merge field-wise over the flow's defaults. */
	run(argv: string[], opts?: RuntimeSpawnOptions): Promise<RuntimeExecResult>;
}

export interface RuntimeWorkdirOptions {
	spawn: RuntimeSpawn;
	/** Cancellation for every invocation in the flow. */
	signal?: AbortSignal;
	/**
	 * Defaults applied to each `run` whose own options omit the field. A default
	 * `cwd` of `undefined` deliberately stays undefined — the child then inherits
	 * the process cwd, which is what the single-shot run/insights/profile flows
	 * have always done. Multi-invocation flows pass `cwd: wd.dir` explicitly.
	 */
	defaults?: RuntimeSpawnOptions;
}

/**
 * Create a temp workdir, hand `fn` a runner bound to it, and remove the
 * directory afterwards — on the throwing path too. This is the endpoint-side
 * equivalent of a session: everything a request materializes lives here and
 * nothing outlives the request.
 */
export async function withRuntimeWorkdir<T>(
	opts: RuntimeWorkdirOptions,
	fn: (wd: RuntimeWorkdir) => Promise<T>,
): Promise<T> {
	const defaults = opts.defaults ?? {};
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aura-runtime-"));
	const wd: RuntimeWorkdir = {
		dir,
		write: async (name, content) => {
			const file = containedPath(dir, name);
			await fs.mkdir(path.dirname(file), { recursive: true });
			await fs.writeFile(file, content);
			return file;
		},
		run: (argv, o = {}) =>
			opts.spawn(
				argv,
				{
					stdin: o.stdin ?? defaults.stdin,
					timeoutMs: o.timeoutMs ?? defaults.timeoutMs,
					cwd: o.cwd ?? defaults.cwd,
					env: o.env ?? defaults.env,
				},
				opts.signal,
			),
	};
	try {
		return await fn(wd);
	} finally {
		// Best-effort: a cleanup failure (a locked file, a vanished tmpdir) must
		// never replace the flow's real result or its real error.
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

/**
 * Resolve `name` inside `dir`, refusing anything that escapes it. Guest file
 * names come from model-supplied source (a Java class name becomes a file
 * name), so containment is enforced rather than assumed.
 */
function containedPath(dir: string, name: string): string {
	const file = path.resolve(dir, name);
	if (file !== dir && !file.startsWith(dir + path.sep)) {
		throw new RuntimeRpcError("invalid-params", `Refusing to write outside the runtime workdir: ${name}`);
	}
	return file;
}

/**
 * Spawn environment for JVM-flavored invocations: `JAVA_HOME` and `JDK_HOME`
 * are removed. The runtime's `java` honors those variables while its `javac`
 * always compiles against the embedded JDK, so a host with an older preset JDK
 * (CI images commonly pin 17) splits the two halves and running a freshly
 * compiled class dies with `UnsupportedClassVersionError`. The tools promise
 * the embedded JVM, so the host's JDK never reaches the child.
 */
export function jvmSpawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const { JAVA_HOME: _javaHome, JDK_HOME: _jdkHome, ...rest } = base;
	return rest;
}

async function pathExists(target: string): Promise<boolean> {
	return await fs
		.stat(target)
		.then(() => true)
		.catch(() => false);
}

/**
 * The write guard for the two JVM flows that put files in the user's project.
 * They are the only runtime surfaces that write outside a temp dir, so an
 * existing destination is refused by name, and the error names the flag that
 * authorizes the replacement.
 */
async function refuseExistingOutput(dest: string, overwrite: boolean | undefined): Promise<void> {
	if (overwrite === true) return;
	if (!(await pathExists(dest))) return;
	throw new RuntimeRpcError("invalid-params", `Refusing to overwrite ${dest} — pass overwrite: true to replace it.`, {
		output: dest,
	});
}

/** True when `dest` is strictly below `cwd`, comparing the two paths as given. */
function isStrictlyInside(cwd: string, dest: string): boolean {
	const rel = path.relative(cwd, dest);
	if (rel === "" || path.isAbsolute(rel)) return false;
	return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

/**
 * `fs.realpath` of the deepest existing ancestor of `target`, with the
 * not-yet-existing tail re-appended. `realpath` on the whole path would fail for
 * a destination that does not exist yet, which is the normal case here.
 */
async function realpathExistingPrefix(target: string): Promise<string> {
	const tail: string[] = [];
	let current = target;
	for (;;) {
		const real = await fs.realpath(current).catch(() => null);
		if (real !== null) return path.join(real, ...tail.reverse());
		const parent = path.dirname(current);
		if (parent === current) return target;
		tail.push(path.basename(current));
		current = parent;
	}
}

/**
 * Resolve a project-writing destination and bound it strictly inside the
 * working directory. The project root, its parents, and outside absolute paths
 * are never valid file outputs.
 *
 * Check both lexical and resolved paths. `path.relative` does not follow
 * symlinks, so either a parent or an existing destination symlink could
 * otherwise redirect a write outside the project.
 */
async function resolveOutputDest(baseCwd: string, output: string): Promise<string> {
	const cwd = path.resolve(baseCwd);
	const dest = path.resolve(cwd, output);
	const refuse = () => {
		throw new RuntimeRpcError(
			"invalid-params",
			`Refusing to write output to ${dest} — output must be a path inside the working directory (${cwd}), ` +
				"not the directory itself or one of its parents.",
			{ output: dest },
		);
	};
	if (!isStrictlyInside(cwd, dest)) refuse();
	const realCwd = await realpathExistingPrefix(cwd);
	if ((await fs.lstat(dest).catch(() => null))?.isSymbolicLink()) refuse();
	const realDest = await realpathExistingPrefix(dest);
	if (!isStrictlyInside(realCwd, realDest)) refuse();
	return dest;
}

/** A file output may not replace a directory, even when overwrite was authorized. */
async function assertNotDirectory(dest: string, label = "jar"): Promise<void> {
	const stat = await fs.stat(dest).catch(() => null);
	if (stat?.isDirectory() !== true) return;
	throw new RuntimeRpcError(
		"invalid-params",
		`Refusing to write the ${label} to ${dest} — it is an existing directory.`,
		{
			output: dest,
		},
	);
}

const JAR_CREATE_REQUIREMENTS =
	"jvm_jar create requires `language`, `code`, and `output` (cwd-relative path for the built jar).";

function trimTrailingNewlines(text: string): string {
	return text.replace(/\n+$/, "");
}

/**
 * Instrumentation used when the caller supplies neither `insight` nor
 * `insightPath`: source loads, the first call of every root with its location,
 * and logarithmic hot-function milestones (x10, x100, …). Insight on this
 * runtime has no end-of-run event (verified against the shipped CLI — a
 * `close` handler never fires), so the script must print as it observes; the
 * milestone ladder is what keeps a hot loop from flooding stdout while still
 * surfacing where the time goes.
 */
export const DEFAULT_INSIGHT_SCRIPT = `const counts = new Map();
insight.on("source", function (src) {
	print("[insights] load " + src.name + " (" + src.language + ")");
});
insight.on("enter", function (ctx) {
	const key = (ctx.name || "<anonymous>") + " (" + ctx.source.name + ":" + ctx.line + ")";
	const n = (counts.get(key) || 0) + 1;
	counts.set(key, n);
	if (n === 1) print("[insights] call " + key);
	else if (n === 10 || n === 100 || n === 1000 || n === 10000 || n === 100000) print("[insights] hot  " + key + " x" + n);
}, { roots: true });
`;

const MISSING_GUIDANCE =
	"The runtime is not installed. It downloads automatically on first use when runtime.autoDownload is on; " +
	"or point AURA_RUNTIME_BIN (or the runtime.path setting) at an existing binary. Requires runtime >= 1.4.";

/** Per-call subprocess endpoint: services protocol requests by shelling the runtime CLI. */
export class LocalRuntimeEndpoint implements RuntimeEndpoint {
	constructor(private readonly opts: LocalEndpointOptions = {}) {}

	async request(req: RuntimeRpcRequest, signal?: AbortSignal): Promise<RuntimeRpcResponse> {
		try {
			switch (req.method) {
				case "runtime/status":
					return okResponse(req.id, await this.status());
				case "runtime/run":
					return okResponse(req.id, await this.execRun(req.params as RuntimeRunParams, signal));
				case "runtime/insights":
					return okResponse(req.id, await this.execInsights(req.params as RuntimeInsightsParams, signal));
				case "runtime/profile":
					return okResponse(req.id, await this.execProfile(req.params as RuntimeProfileParams, signal));
				case "runtime/jvm":
					return okResponse(req.id, await this.execJvm(req.params as RuntimeJvmParams, signal));
				case "runtime/spawn":
					return okResponse(req.id, await this.describeSpawn(req.params as RuntimeSpawnParams));
				case "runtime/check":
					return okResponse(req.id, await this.execCheck(req.params as RuntimeCheckParams, signal));
				default:
					return errorResponse(req.id, new RuntimeRpcError("invalid-params", `Unknown method ${req.method}`));
			}
		} catch (e) {
			if (e instanceof RuntimeRpcError) return errorResponse(req.id, e);
			return errorResponse(req.id, new RuntimeRpcError("internal", String(e)));
		}
	}

	private resolveFn(): typeof resolveRuntimeBinary {
		return this.opts.resolve ?? resolveRuntimeBinary;
	}

	private async locate(): Promise<ResolvedRuntime | null> {
		return this.resolveFn()({
			explicitPath: this.opts.explicitPath,
			version: this.opts.version,
			managedRoot: this.opts.managedRoot,
			env: this.opts.env,
		});
	}

	/** True when `runtime.version` names something other than the version this build pins. */
	private offPinVersion(): string | undefined {
		const version = this.opts.version;
		return version !== undefined && version !== "" && version !== ELIDE_VERSION ? version : undefined;
	}

	/**
	 * What to say when no binary was found. An off-pin `runtime.version` gets its
	 * own answer: only {@link ELIDE_VERSION} has a pinned sha256, so downloading
	 * some other version would be an unverified fetch — which this never does.
	 */
	private missingGuidance(): string {
		const offPin = this.offPinVersion();
		if (offPin === undefined) return MISSING_GUIDANCE;
		return (
			`runtime.version is set to ${offPin}, but this build pins ${ELIDE_VERSION} — only the pinned version ` +
			"has a published checksum, so an off-pin version is never downloaded automatically (an unverified " +
			`download is not something the harness will do silently). Install it yourself under ` +
			`${managedVersionDir(offPin)}, point runtime.path (or AURA_RUNTIME_BIN) at a binary, or clear ` +
			"runtime.version to use the pinned one."
		);
	}

	/**
	 * Resolve the binary; auto-provision when allowed. Throws runtime-missing
	 * otherwise, carrying {@link missingGuidance}.
	 *
	 * Public because it is the only place the provisioning preconditions live —
	 * `runtime.autoDownload`, an explicit path, an off-pin version — and
	 * `aura setup runtime` drives the same install the first tool call would,
	 * rather than keeping a second copy of those rules.
	 */
	async ensureBinary(): Promise<ResolvedRuntime> {
		const found = await this.locate();
		if (found) return found;
		if (this.opts.autoDownload !== false && !this.opts.explicitPath && this.offPinVersion() === undefined) {
			const provision = this.opts.provision ?? provisionRuntime;
			const binaryPath = await provision({
				version: this.opts.version,
				targetRoot: this.opts.managedRoot,
				onProgress: this.opts.onProgress,
			});
			return { binaryPath, source: "managed" };
		}
		throw new RuntimeRpcError("runtime-missing", this.missingGuidance());
	}

	private async status(): Promise<RuntimeStatusResult> {
		const found = await this.locate();
		if (!found) {
			return { available: false, guidance: this.missingGuidance(), protocolVersion: RUNTIME_PROTOCOL_VERSION };
		}
		const result = await this.spawn([found.binaryPath, "--version"], {});
		const version = parseVersion(result.stdout);
		const tooOld = version !== undefined && !meetsMinimumVersion(version);
		return {
			available: result.exitCode === 0 && !tooOld,
			version,
			binaryPath: found.binaryPath,
			source: found.source,
			guidance: tooOld ? belowFloorGuidance(version) : undefined,
			protocolVersion: RUNTIME_PROTOCOL_VERSION,
		};
	}

	private async execRun(params: RuntimeRunParams, signal?: AbortSignal): Promise<RuntimeExecResult> {
		return this.withGuestFile(params, signal, async (bin, guestFile, language, wd) => {
			const argv = [bin, "run", "--error-format=plain", "--no-color", "-l", language, guestFile];
			if (params.args?.length) argv.push("--", ...params.args);
			return wd.run(argv);
		});
	}

	private async execInsights(params: RuntimeInsightsParams, signal?: AbortSignal): Promise<RuntimeExecResult> {
		return this.withGuestFile(params, signal, async (bin, guestFile, language, wd) => {
			const insightFile =
				params.insightPath ?? (await wd.write("insight.js", params.insight ?? DEFAULT_INSIGHT_SCRIPT));
			const argv = [
				bin,
				"run",
				"--error-format=plain",
				"--no-color",
				`--insights=${insightFile}`,
				"-l",
				language,
				guestFile,
			];
			if (params.args?.length) argv.push("--", ...params.args);
			return wd.run(argv);
		});
	}

	private async execProfile(params: RuntimeProfileParams, signal?: AbortSignal): Promise<RuntimeExecResult> {
		return this.withGuestFile(params, signal, async (bin, guestFile, language, wd) => {
			const argv = [
				bin,
				"run",
				"--error-format=plain",
				"--no-color",
				`--profiler=${params.mode}`,
				"-l",
				language,
				guestFile,
			];
			if (params.args?.length) argv.push("--", ...params.args);
			return wd.run(argv);
		});
	}

	// ── JVM flows ────────────────────────────────────────────────────────────
	// Every one is "materialize source in a workdir, compile, then do one more
	// thing with the result" — the multi-invocation shape the shared workdir
	// exists for. Nothing here leaks a path to tool code except the destinations
	// the caller itself named (`output`, `jar`, `path`).

	private async execJvm(params: RuntimeJvmParams, signal?: AbortSignal): Promise<RuntimeJvmResult> {
		switch (params.action) {
			case "run":
				return this.jvmRun(params, signal);
			case "disassemble":
				return this.jvmDisassemble(params, signal);
			case "format":
				return this.jvmFormat(params, signal);
			case "jar":
				return (params.mode ?? "create") === "inspect"
					? this.jvmJarInspect(params, signal)
					: this.jvmJarCreate(params, signal);
			case "deps":
				return this.jvmDeps(params, signal);
			default:
				throw new RuntimeRpcError("invalid-params", `Unknown jvm action ${String(params.action)}.`);
		}
	}

	/** Spawn environment for JVM invocations: the host's preset JDK never reaches the child. */
	private jvmEnv(): NodeJS.ProcessEnv {
		return jvmSpawnEnv(this.opts.env ?? process.env);
	}

	/** Base directory for resolving the caller's `output`/`jar`/`path`. */
	private jvmBaseCwd(params: RuntimeJvmParams): string {
		return params.cwd ?? process.cwd();
	}

	private async jvmRunClasspath(language: JvmLanguage, binaryPath: string, workdir?: string): Promise<string> {
		const output = workdir === undefined ? "out" : path.join(workdir, "out");
		if (language === "java") return workdir ?? ".";
		const kotlinRoot = path.resolve(path.dirname(binaryPath), "..", "lib", "resources", "kotlin");
		try {
			const versions = (await fs.readdir(kotlinRoot, { withFileTypes: true }))
				.filter(entry => entry.isDirectory())
				.sort((left, right) => right.name.localeCompare(left.name));
			for (const version of versions) {
				const lib = path.join(kotlinRoot, version.name, "lib");
				try {
					const libraries = await fs.readdir(lib);
					if (libraries.includes("kotlin-stdlib.jar")) {
						return `${output}${path.delimiter}${path.join(lib, "*")}`;
					}
				} catch {
					// Try another installed Kotlin version.
				}
			}
		} catch {
			// Non-bundled runtimes may not expose adjacent resources.
		}
		return output;
	}

	/**
	 * Resolve the binary and open a workdir for a JVM flow. `fn` gets a `run`
	 * bound to the workdir as its cwd — the JVM toolchain compiles and reads
	 * relative to it, unlike the single-shot guest flows which stay in the
	 * caller's directory.
	 */
	private async withJvmWorkdir(
		params: RuntimeJvmParams,
		signal: AbortSignal | undefined,
		fn: (
			wd: RuntimeWorkdir,
			bin: string,
			run: (argv: string[], options?: RuntimeSpawnOptions) => Promise<RuntimeExecResult>,
		) => Promise<RuntimeJvmResult>,
	): Promise<RuntimeJvmResult> {
		const { binaryPath } = await this.ensureBinary();
		return withRuntimeWorkdir(
			{ spawn: this.spawner(), signal, defaults: { timeoutMs: params.timeoutMs, env: this.jvmEnv() } },
			wd => fn(wd, binaryPath, (argv, options) => wd.run(argv, { ...options, cwd: options?.cwd ?? wd.dir })),
		);
	}

	/** One JVM invocation outside a workdir (artifact modes), in the caller's directory. */
	private async jvmInCwd(params: RuntimeJvmParams, argv: string[], signal?: AbortSignal): Promise<RuntimeExecResult> {
		return this.spawn(
			argv,
			{ cwd: this.jvmBaseCwd(params), timeoutMs: params.timeoutMs, env: this.jvmEnv() },
			signal,
		);
	}

	/**
	 * Write the inline guest into the workdir and compile it. Returns the derived
	 * class name plus, when the compile did not succeed, the result to hand back
	 * verbatim so the model sees what the compiler said.
	 */
	private async compileJvm(
		wd: RuntimeWorkdir,
		bin: string,
		run: (argv: string[]) => Promise<RuntimeExecResult>,
		action: RuntimeJvmAction,
		language: JvmLanguage,
		code: string,
		mainClass: string | undefined,
	): Promise<{ className: string; failure?: RuntimeJvmResult }> {
		const className = deriveJvmMainClass(language, code, mainClass);
		await wd.write(jvmSourceFile(language, className), code);
		const argv =
			language === "java"
				? [bin, "javac", "--", "--release", JVM_BYTECODE_RELEASE, `${className}.java`]
				: [bin, "kotlinc", "--", "Main.kt", "-cp", ".", "-d", "out"];
		const compile = await run(argv);
		if (compile.exitCode !== 0 || compile.killed) {
			return { className, failure: { ...compile, action, phase: "compile", language, className } };
		}
		return { className };
	}

	/** `language` + `code`, or `invalid-params` naming what the action needs. */
	private requireJvmSource(params: RuntimeJvmParams, message: string): { language: JvmLanguage; code: string } {
		if (params.language === undefined || params.code === undefined) {
			throw new RuntimeRpcError("invalid-params", message);
		}
		return { language: params.language, code: params.code };
	}

	private async requireJvmRunSource(params: RuntimeJvmParams): Promise<{ language: JvmLanguage; code: string }> {
		if (params.language === undefined) {
			throw new RuntimeRpcError("invalid-params", "run requires `language` and code or path.");
		}
		if (params.code === undefined && params.path === undefined) {
			throw new RuntimeRpcError("invalid-params", "run requires `language` and code or path.");
		}
		if (params.code !== undefined && params.path !== undefined) {
			throw new RuntimeRpcError("invalid-params", "code and path are mutually exclusive.");
		}
		if (params.code !== undefined) return { language: params.language, code: params.code };
		const sourcePath = path.resolve(this.jvmBaseCwd(params), params.path as string);
		try {
			return { language: params.language, code: await fs.readFile(sourcePath, "utf8") };
		} catch {
			throw new RuntimeRpcError("invalid-params", `Runtime source file does not exist: ${sourcePath}.`, {
				path: sourcePath,
			});
		}
	}

	private async jvmRun(params: RuntimeJvmParams, signal?: AbortSignal): Promise<RuntimeJvmResult> {
		const { language, code } = await this.requireJvmRunSource(params);
		if (
			params.args !== undefined &&
			(!Array.isArray(params.args) || params.args.some(arg => typeof arg !== "string"))
		) {
			throw new RuntimeRpcError("invalid-params", "args must be an array of strings.");
		}
		if (params.stdin !== undefined && typeof params.stdin !== "string") {
			throw new RuntimeRpcError("invalid-params", "stdin must be a string.");
		}
		return this.withJvmWorkdir(params, signal, async (wd, bin, run) => {
			const { className, failure } = await this.compileJvm(wd, bin, run, "run", language, code, params.mainClass);
			if (failure) return failure;
			const programCwd = params.cwd === undefined ? undefined : this.jvmBaseCwd(params);
			const classpath = await this.jvmRunClasspath(language, bin, programCwd === undefined ? undefined : wd.dir);
			const result = await run([bin, "java", "--", "-cp", classpath, className, ...(params.args ?? [])], {
				cwd: programCwd,
				stdin: params.stdin,
			});
			return { ...result, action: "run", phase: "run", language, className };
		});
	}

	private async jvmDisassemble(params: RuntimeJvmParams, signal?: AbortSignal): Promise<RuntimeJvmResult> {
		const { language, code } = this.requireJvmSource(params, "jvm_disassemble requires `language` and `code`.");
		return this.withJvmWorkdir(params, signal, async (wd, bin, run) => {
			const { className, failure } = await this.compileJvm(
				wd,
				bin,
				run,
				"disassemble",
				language,
				code,
				params.mainClass,
			);
			if (failure) return failure;
			const argv =
				language === "java"
					? [bin, "javap", "--", "-c", className]
					: [bin, "javap", "--", "-c", "-classpath", "out", className];
			const result = await run(argv);
			return { ...result, action: "disassemble", phase: "disassemble", language, className };
		});
	}

	private async jvmFormat(params: RuntimeJvmParams, signal?: AbortSignal): Promise<RuntimeJvmResult> {
		const { language, code } = this.requireJvmSource(params, "jvm_format requires `language` and `code`.");
		return this.withJvmWorkdir(params, signal, async (wd, bin, run) => {
			// The formatters rewrite in place: the runtime gates guest writes behind
			// --allow-write, and Google Java Format needs -i to write rather than
			// print. So the formatted source is read back out of the workdir.
			const file = language === "java" ? "Source.java" : "Source.kt";
			const written = await wd.write(file, code);
			const argv =
				language === "java"
					? [bin, "javaformat", "--allow-write", "--", "-i", file]
					: [bin, "ktfmt", "--allow-write", "--", file];
			const result = await run(argv);
			const base = { ...result, action: "format" as const, phase: "format" as const, language };
			if (result.exitCode !== 0 || result.killed) return base;
			const formatted = await fs.readFile(written, "utf8");
			return { ...base, formatted: formatted.replace(/\n+$/, "") };
		});
	}

	private async jvmJarInspect(params: RuntimeJvmParams, signal?: AbortSignal): Promise<RuntimeJvmResult> {
		if (params.jar === undefined) {
			throw new RuntimeRpcError("invalid-params", "jvm_jar inspect requires `jar` (path to an existing .jar).");
		}
		const jarPath = path.resolve(this.jvmBaseCwd(params), params.jar);
		if (!(await pathExists(jarPath))) {
			throw new RuntimeRpcError("invalid-params", `No jar found at ${jarPath}.`, { jar: jarPath });
		}
		const { binaryPath } = await this.ensureBinary();
		const result = await this.jvmInCwd(params, [binaryPath, "jar", "--", "--list", "--file", jarPath], signal);
		return { ...result, action: "jar", phase: "jar", jar: jarPath, listing: trimTrailingNewlines(result.stdout) };
	}

	private async jvmJarCreate(params: RuntimeJvmParams, signal?: AbortSignal): Promise<RuntimeJvmResult> {
		const { language, code } = this.requireJvmSource(params, JAR_CREATE_REQUIREMENTS);
		if (params.output === undefined) throw new RuntimeRpcError("invalid-params", JAR_CREATE_REQUIREMENTS);
		const dest = await resolveOutputDest(this.jvmBaseCwd(params), params.output);
		await refuseExistingOutput(dest, params.overwrite);
		await assertNotDirectory(dest);
		return this.withJvmWorkdir(params, signal, async (wd, bin, run) => {
			const { className, failure } = await this.compileJvm(wd, bin, run, "jar", language, code, params.mainClass);
			if (failure) return failure;
			const jarName = "aura-out.jar";
			const jarArgs = [bin, "jar", "--", "--create", "--file", jarName, "--main-class", className];
			if (language === "java") {
				jarArgs.push(...(await fs.readdir(wd.dir)).filter(f => f.endsWith(".class")).sort());
			} else {
				jarArgs.push("-C", "out", ".");
			}
			const result = await run(jarArgs);
			const base = { ...result, action: "jar" as const, phase: "jar" as const, language, className };
			if (result.exitCode !== 0 || result.killed) return base;
			await fs.mkdir(path.dirname(dest), { recursive: true });
			await fs.copyFile(path.join(wd.dir, jarName), dest);
			const list = await run([bin, "jar", "--", "--list", "--file", jarName]);
			return { ...base, output: dest, listing: trimTrailingNewlines(list.stdout) };
		});
	}

	private async jvmDeps(params: RuntimeJvmParams, signal?: AbortSignal): Promise<RuntimeJvmResult> {
		const dest = params.output ? await resolveOutputDest(this.jvmBaseCwd(params), params.output) : undefined;
		if (dest) {
			await refuseExistingOutput(dest, params.overwrite);
			await assertNotDirectory(dest, "dependency report");
		}
		// Truthiness, not presence: an empty `path` must not resolve to the
		// working directory and quietly analyze the whole project.
		const result = params.path
			? await this.jvmDepsFromPath(params, signal)
			: await this.jvmDepsFromSource(params, signal);
		if (!dest || result.exitCode !== 0 || result.killed) return result;
		await Bun.write(dest, result.stdout);
		return { ...result, output: dest };
	}

	private async jvmDepsFromPath(params: RuntimeJvmParams, signal?: AbortSignal): Promise<RuntimeJvmResult> {
		const target = path.resolve(this.jvmBaseCwd(params), params.path ?? "");
		if (!(await pathExists(target))) {
			throw new RuntimeRpcError(
				"invalid-params",
				`No JVM source, class, JAR, or class directory found at ${target}.`,
				{
					path: target,
				},
			);
		}
		const extension = path.extname(target).toLowerCase();
		if (extension === ".java" || extension === ".kt") {
			const code = await Bun.file(target).text();
			return this.jvmDepsFromSource(
				{
					...params,
					path: undefined,
					language: extension === ".java" ? "java" : "kotlin",
					code,
				},
				signal,
			);
		}
		const { binaryPath } = await this.ensureBinary();
		const result = await this.jvmInCwd(params, [binaryPath, "jdeps", "--", target], signal);
		return { ...result, action: "deps", phase: "deps" };
	}

	private async jvmDepsFromSource(params: RuntimeJvmParams, signal?: AbortSignal): Promise<RuntimeJvmResult> {
		const { language, code } = this.requireJvmSource(
			params,
			"jvm_deps requires `path` (source, .class, .jar, or class directory) or `language` + `code`.",
		);
		return this.withJvmWorkdir(params, signal, async (wd, bin, run) => {
			const { className, failure } = await this.compileJvm(wd, bin, run, "deps", language, code, params.mainClass);
			if (failure) return failure;
			const target = language === "java" ? `${className}.class` : "out";
			const result = await run([bin, "jdeps", "--", target]);
			return { ...result, action: "deps", phase: "deps", language, className };
		});
	}

	// ── runtime/spawn ────────────────────────────────────────────────────────
	// Composition only: resolve the binary, validate the caller's paths, and
	// return the command line plus the rules for recognizing the endpoint the
	// process will print. No process is started here and no temp directory is
	// created — a long-running process outlives its request, so anything the
	// endpoint materialized for it would be deleted out from under it. That is
	// also why `debug` has no inline-code mode, and why the JVM env hygiene and
	// the shared workdir do not apply: these flows run the user's own files, in
	// the user's own directory, in place.

	private async describeSpawn(params: RuntimeSpawnParams): Promise<RuntimeLaunchDescriptor> {
		const cwd = path.resolve(params.cwd ?? process.cwd());
		// Compose (and therefore validate) before resolving the binary: `ensureBinary`
		// can trigger a multi-hundred-megabyte download, and a bad mode or a
		// nonexistent path must not pay for one just to be told `invalid-params`.
		const composed = await composeSpawn(params, cwd);
		const { binaryPath, source } = await this.ensureBinary();
		return {
			argv: [binaryPath, ...composed.args],
			cwd,
			// An overlay, not a snapshot: the supervisor merges it over its own
			// environment. Only the colour suppression the scraping relies on travels.
			env: { NO_COLOR: "1" },
			endpointPattern: composed.endpointPattern,
			source,
			shimWarning: source === "path" ? PATH_SHIM_WARNING : undefined,
		};
	}

	private async execCheck(params: RuntimeCheckParams, signal?: AbortSignal): Promise<RuntimeExecResult> {
		const { binaryPath } = await this.ensureBinary();
		return this.spawn([binaryPath, "build", "--no-color"], { cwd: params.cwd, timeoutMs: params.timeoutMs }, signal);
	}

	/** The endpoint's spawn as a {@link RuntimeSpawn}, for workdir-bound flows. */
	private spawner(): RuntimeSpawn {
		return (argv, opts, signal) => this.spawn(argv, opts, signal);
	}

	/**
	 * Shared inline-code plumbing: resolve the binary, materialize `code` into a
	 * workdir guest file, and hand the handler a runner bound to that workdir.
	 * Single-shot by nature today, but it goes through the same workdir as the
	 * multi-invocation flows so there is one lifecycle to reason about.
	 */
	private async withGuestFile(
		params: RuntimeRunParams,
		signal: AbortSignal | undefined,
		fn: (bin: string, guestFile: string, language: RuntimeLanguage, wd: RuntimeWorkdir) => Promise<RuntimeExecResult>,
	): Promise<RuntimeExecResult> {
		if (params.code === undefined && params.path === undefined) {
			throw new RuntimeRpcError("invalid-params", "run requires code (inline) or path (existing file).");
		}
		if (params.code !== undefined && params.path !== undefined) {
			throw new RuntimeRpcError("invalid-params", "code and path are mutually exclusive.");
		}
		const { binaryPath } = await this.ensureBinary();
		const language: RuntimeLanguage = params.language ?? (params.path ? inferLanguage(params.path) : "ts");
		return withRuntimeWorkdir(
			{
				spawn: this.spawner(),
				signal,
				// cwd stays the request's (usually undefined → the process cwd): inline
				// guests have always run in the user's directory, not the workdir.
				defaults: { stdin: params.stdin, timeoutMs: params.timeoutMs, cwd: params.cwd },
			},
			async wd => {
				const guestFile =
					params.path && language === "python"
						? await wd.write(
								"python-file.py",
								pythonFileBootstrap(path.resolve(params.cwd ?? process.cwd(), params.path)),
							)
						: (params.path ?? (await wd.write(`guest.${GUEST_EXT[language]}`, params.code ?? "")));
				return fn(binaryPath, guestFile, language, wd);
			},
		);
	}

	private async spawn(argv: string[], params: RuntimeSpawnOptions, signal?: AbortSignal): Promise<RuntimeExecResult> {
		if (signal?.aborted) throw new RuntimeRpcError("cancelled", "Runtime execution was cancelled.");
		const start = performance.now();
		const proc = Bun.spawn(argv, {
			cwd: params.cwd,
			stdin: params.stdin !== undefined ? new TextEncoder().encode(params.stdin) : undefined,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...(params.env ?? this.opts.env ?? process.env), NO_COLOR: "1" },
		});
		let killed = false;
		const timers: ReturnType<typeof setTimeout>[] = [];
		if (params.timeoutMs) {
			timers.push(
				setTimeout(() => {
					killed = true;
					proc.kill();
				}, params.timeoutMs),
			);
		}
		const onAbort = () => {
			killed = true;
			proc.kill();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			if (signal?.aborted) throw new RuntimeRpcError("cancelled", "Runtime execution was cancelled.");
			return { exitCode, stdout, stderr, durationMs: Math.round(performance.now() - start), killed };
		} finally {
			for (const t of timers) clearTimeout(t);
			signal?.removeEventListener("abort", onAbort);
		}
	}
}

/**
 * Advisory attached to descriptors whose binary came from `PATH`. A packaged
 * runtime is often installed as a small `.bin` wrapper, and a wrapper that
 * *forks* rather than `exec`s leaves the supervised pid holding no port: stopping
 * it may leave the real server behind. The managed install resolves to a real
 * binary, so this is the one resolution source where the caller should say so.
 * (The supervisor terminates the process *group*, which covers a forking wrapper
 * in the common case — hence advisory rather than a refusal.)
 */
const PATH_SHIM_WARNING =
	"The runtime binary was resolved from PATH, where it may be a wrapper script that runs the real " +
	"binary as a child process. Stopping this job terminates the process group, which normally covers " +
	"it; if a listener survives, check for a leftover process holding the port. To launch a real binary " +
	"directly, point runtime.path (or AURA_RUNTIME_BIN) at one, or take the wrapper off PATH so the " +
	"managed install is used — resolution prefers a binary on PATH over auto-downloading, so a wrapper " +
	"there always wins.";

/** `serve` prints a bare `host:port`; the scheme is implied. */
const SERVE_ENDPOINT_RULES: RuntimeEndpointRule[] = [
	{ pattern: "Serving static files on\\s+(\\S+)", group: 1, prefix: "http://" },
];

interface ComposedLaunch {
	/** Command line after the binary. */
	args: string[];
	endpointPattern: RuntimeEndpointRule[];
}

/** `stat` of `target`, or null when it does not exist. */
async function statOrNull(target: string): Promise<Stats | null> {
	return await fs.stat(target).catch(() => null);
}

async function requireExistingDirectory(base: string, value: string | undefined, label: string): Promise<string> {
	if (!value) throw new RuntimeRpcError("invalid-params", `${label} is required.`);
	const resolved = path.resolve(base, value);
	const stat = await statOrNull(resolved);
	if (stat === null) throw new RuntimeRpcError("invalid-params", `${label} does not exist: ${resolved}`, { resolved });
	if (!stat.isDirectory()) {
		throw new RuntimeRpcError("invalid-params", `${label} is not a directory: ${resolved}`, { resolved });
	}
	return resolved;
}

/**
 * Validate the caller's parameters and compose the command line. Deliberately
 * independent of binary resolution so it can run first — see `describeSpawn`.
 */
async function composeSpawn(params: RuntimeSpawnParams, cwd: string): Promise<ComposedLaunch> {
	if ("mode" in params) {
		throw new RuntimeRpcError(
			"invalid-params",
			"runtime/spawn no longer accepts a mode; only static serving remains.",
		);
	}
	return serveArgv(params, cwd);
}

/** `serve <dir> --no-tui [--port p] [--host h]`. `--no-tui` keeps the output scrapable. */
async function serveArgv(params: RuntimeSpawnParams, cwd: string): Promise<ComposedLaunch> {
	const dir = await requireExistingDirectory(cwd, params.directory, "serve `directory`");
	const args = ["serve", dir, "--no-tui"];
	if (params.port !== undefined) {
		if (!Number.isInteger(params.port) || params.port < 1 || params.port > 65_535) {
			throw new RuntimeRpcError("invalid-params", "port must be an integer from 1 to 65535.");
		}
		args.push("--port", String(params.port));
	}
	if (params.host) args.push("--host", params.host);
	return { args, endpointPattern: SERVE_ENDPOINT_RULES };
}

/**
 * Extract a semver-ish version from `--version` output, tolerating a name prefix
 * (e.g. `Elide 9.9.9-fake (build abc)`) so no product name surfaces to users.
 */
function parseVersion(stdout: string): string | undefined {
	return /\d+\.\d+[^\s]*/.exec(stdout)?.[0];
}

/** Leading numeric components of a version, ignoring any `-rc1` / `+build` tail. */
function numericParts(version: string): number[] {
	const core = /^\d+(?:\.\d+)*/.exec(version)?.[0] ?? "";
	return core.split(".").map(Number);
}

/** True when `version` is at least {@link MINIMUM_RUNTIME_VERSION} (numeric, component-wise). */
function meetsMinimumVersion(version: string): boolean {
	const found = numericParts(version);
	const floor = numericParts(MINIMUM_RUNTIME_VERSION);
	for (let i = 0; i < Math.max(found.length, floor.length); i++) {
		const a = found[i] ?? 0;
		const b = floor[i] ?? 0;
		if (a !== b) return a > b;
	}
	return true;
}

function belowFloorGuidance(version: string): string {
	return (
		`The installed runtime is version ${version}, older than the required ${MINIMUM_RUNTIME_VERSION}. ` +
		"Upgrade it, or unset AURA_RUNTIME_BIN / runtime.path so a supported runtime is downloaded automatically."
	);
}

function inferLanguage(file: string): RuntimeLanguage {
	const ext = path.extname(file).toLowerCase();
	if (ext === ".py") return "python";
	if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return "js";
	return "ts";
}
