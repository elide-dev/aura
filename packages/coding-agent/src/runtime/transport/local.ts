import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MINIMUM_RUNTIME_VERSION } from "../dist";
import { deriveJvmMainClass, JVM_BYTECODE_RELEASE, jvmClasspath, jvmSourceFile } from "../jvm";
import {
	errorResponse,
	type JvmLanguage,
	okResponse,
	RUNTIME_PROTOCOL_VERSION,
	type RuntimeBuildParams,
	type RuntimeExecResult,
	type RuntimeInsightsParams,
	type RuntimeJvmAction,
	type RuntimeJvmParams,
	type RuntimeJvmResult,
	type RuntimeLanguage,
	type RuntimeProfileParams,
	RuntimeRpcError,
	type RuntimeRpcRequest,
	type RuntimeRpcResponse,
	type RuntimeRunParams,
	type RuntimeStatusResult,
} from "../protocol";
import { provisionRuntime } from "../provision";
import { type ResolvedRuntime, resolveRuntimeBinary } from "../resolve";
import type { RuntimeEndpoint } from "../service";

export interface LocalEndpointOptions {
	explicitPath?: string;
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

const JAR_CREATE_REQUIREMENTS =
	"jvm_jar create requires `language`, `code`, and `output` (cwd-relative path for the built jar).";

function trimTrailingNewlines(text: string): string {
	return text.replace(/\n+$/, "");
}

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
				case "runtime/check":
					return okResponse(req.id, await this.execBuild(req.params as RuntimeBuildParams, [], signal));
				case "runtime/build": {
					const params = req.params as RuntimeBuildParams;
					return okResponse(req.id, await this.execBuild(params, params.targets ?? [], signal));
				}
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
		return this.resolveFn()({ explicitPath: this.opts.explicitPath, env: this.opts.env });
	}

	/** Resolve the binary; auto-provision when allowed. Throws runtime-missing otherwise. */
	private async ensureBinary(): Promise<ResolvedRuntime> {
		const found = await this.locate();
		if (found) return found;
		if (this.opts.autoDownload !== false && !this.opts.explicitPath) {
			const provision = this.opts.provision ?? provisionRuntime;
			const binaryPath = await provision({ onProgress: this.opts.onProgress });
			return { binaryPath, source: "managed" };
		}
		throw new RuntimeRpcError("runtime-missing", MISSING_GUIDANCE);
	}

	private async status(): Promise<RuntimeStatusResult> {
		const found = await this.locate();
		if (!found) {
			return { available: false, guidance: MISSING_GUIDANCE, protocolVersion: RUNTIME_PROTOCOL_VERSION };
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
		if (params.insight === undefined && params.insightPath === undefined) {
			throw new RuntimeRpcError("invalid-params", "insights requires insight (inline JS) or insightPath.");
		}
		return this.withGuestFile(params, signal, async (bin, guestFile, language, wd) => {
			const insightFile = params.insightPath ?? (await wd.write("insight.js", params.insight ?? ""));
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
				return params.path === undefined
					? this.jvmDepsFromSource(params, signal)
					: this.jvmDepsFromPath(params, signal);
			case "javadoc":
				return this.jvmJavadoc(params, signal);
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
			run: (argv: string[]) => Promise<RuntimeExecResult>,
		) => Promise<RuntimeJvmResult>,
	): Promise<RuntimeJvmResult> {
		const { binaryPath } = await this.ensureBinary();
		return withRuntimeWorkdir(
			{ spawn: this.spawner(), signal, defaults: { timeoutMs: params.timeoutMs, env: this.jvmEnv() } },
			wd => fn(wd, binaryPath, argv => wd.run(argv, { cwd: wd.dir })),
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

	private async jvmRun(params: RuntimeJvmParams, signal?: AbortSignal): Promise<RuntimeJvmResult> {
		const { language, code } = this.requireJvmSource(params, "jvm_run requires `language` and `code`.");
		return this.withJvmWorkdir(params, signal, async (wd, bin, run) => {
			const { className, failure } = await this.compileJvm(wd, bin, run, "run", language, code, params.mainClass);
			if (failure) return failure;
			const result = await run([bin, "java", "--", "-cp", jvmClasspath(language), className]);
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
		const dest = path.resolve(this.jvmBaseCwd(params), params.output);
		await refuseExistingOutput(dest, params.overwrite);
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

	private async jvmDepsFromPath(params: RuntimeJvmParams, signal?: AbortSignal): Promise<RuntimeJvmResult> {
		const target = path.resolve(this.jvmBaseCwd(params), params.path ?? "");
		if (!(await pathExists(target))) {
			throw new RuntimeRpcError("invalid-params", `No class file or jar found at ${target}.`, { path: target });
		}
		const { binaryPath } = await this.ensureBinary();
		const result = await this.jvmInCwd(params, [binaryPath, "jdeps", "--", target], signal);
		return { ...result, action: "deps", phase: "deps" };
	}

	private async jvmDepsFromSource(params: RuntimeJvmParams, signal?: AbortSignal): Promise<RuntimeJvmResult> {
		const { language, code } = this.requireJvmSource(
			params,
			"jvm_deps requires either `path` (existing .class/.jar) or `language` + `code`.",
		);
		return this.withJvmWorkdir(params, signal, async (wd, bin, run) => {
			const { className, failure } = await this.compileJvm(wd, bin, run, "deps", language, code, params.mainClass);
			if (failure) return failure;
			const target = language === "java" ? `${className}.class` : "out";
			const result = await run([bin, "jdeps", "--", target]);
			return { ...result, action: "deps", phase: "deps", language, className };
		});
	}

	private async jvmJavadoc(params: RuntimeJvmParams, signal?: AbortSignal): Promise<RuntimeJvmResult> {
		if (params.code === undefined) {
			throw new RuntimeRpcError("invalid-params", "jvm_javadoc requires `code` (Java source to document).");
		}
		const code = params.code;
		const dest = path.resolve(this.jvmBaseCwd(params), params.output ?? "javadoc-out");
		await refuseExistingOutput(dest, params.overwrite);
		return this.withJvmWorkdir(params, signal, async (wd, bin, run) => {
			const className = deriveJvmMainClass("java", code, params.mainClass);
			await wd.write(`${className}.java`, code);
			const result = await run([bin, "javadoc", "--", "-d", "apidocs", `${className}.java`]);
			const base = {
				...result,
				action: "javadoc" as const,
				phase: "javadoc" as const,
				language: "java" as const,
				className,
			};
			if (result.exitCode !== 0 || result.killed) return base;
			await fs.rm(dest, { recursive: true, force: true });
			await fs.mkdir(path.dirname(dest), { recursive: true });
			await fs.cp(path.join(wd.dir, "apidocs"), dest, { recursive: true });
			const entries = await fs.readdir(dest, { recursive: true });
			const topLevel = (await fs.readdir(dest)).sort().slice(0, 12);
			return { ...base, output: dest, entryCount: entries.length, topLevel };
		});
	}

	private async execBuild(
		params: RuntimeBuildParams,
		targets: string[],
		signal?: AbortSignal,
	): Promise<RuntimeExecResult> {
		const { binaryPath } = await this.ensureBinary();
		return this.spawn(
			[binaryPath, "build", "--no-color", ...targets],
			{ cwd: params.cwd, timeoutMs: params.timeoutMs },
			signal,
		);
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
				const guestFile = params.path ?? (await wd.write(`guest.${GUEST_EXT[language]}`, params.code ?? ""));
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
