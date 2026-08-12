/**
 * Cell execution on an Elide JS kernel.
 *
 * This is the Bun JS executor (`../js/executor.ts`) with exactly one thing
 * changed: the worker the shared context manager drives is an Elide kernel
 * handle instead of the built-in Bun ladder. Everything downstream — the
 * OutputSink wiring, the timeout-control filtering, the errors-as-values result
 * shape — is the same contract, and {@link JsExecutorOptions}/{@link JsResult}
 * are imported rather than restated so the two engines cannot drift apart at
 * the type level.
 *
 * The Bun executor is deliberately left untouched: it is the default path for
 * every user, and threading an engine switch through it would put this
 * milestone's risk on code that ships enabled.
 */
import { DEFAULT_MAX_BYTES, OutputSink } from "../../session/streaming-output";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "../../tools/output-meta";
import { isEvalTimeoutControlEvent } from "../bridge-timeout";
import { executeInVmContext, type JsDisplayOutput } from "../js/context-manager";
import type { JsExecutorOptions, JsResult } from "../js/executor";
import { getElideJsKernelFactory } from "./kernel";
import { spawnElideWorker } from "./worker";

function getExecutionTimeoutMs(options: Pick<JsExecutorOptions, "deadlineMs" | "timeoutMs">): number | undefined {
	if (options.deadlineMs !== undefined) {
		return Math.max(1, options.deadlineMs - Date.now());
	}
	return options.timeoutMs;
}

function isAbortError(error: unknown): boolean {
	return (
		(error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) ||
		(error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
	);
}

function isTimeoutReason(reason: unknown): boolean {
	return (
		(reason instanceof DOMException && reason.name === "TimeoutError") ||
		(reason instanceof Error && reason.name === "TimeoutError")
	);
}

function formatJsTimeoutAnnotation(timeoutMs: number | undefined): string {
	// Timeout cancellation force-kills the worker (the only way to interrupt
	// synchronous user code), which discards the persistent VM state. Say so,
	// or the model will keep referencing variables that no longer exist.
	const reset = "The JS worker was force-killed and its VM state was reset; variables from earlier cells are gone.";
	if (timeoutMs === undefined) return `Command timed out. ${reset}`;
	const secs = Math.max(1, Math.round(timeoutMs / 1000));
	return `Command timed out after ${secs} seconds. ${reset}`;
}

export async function executeElideJs(code: string, options: JsExecutorOptions): Promise<JsResult> {
	const displayOutputs: JsDisplayOutput[] = [];
	const outputSink = new OutputSink({
		artifactPath: options.artifactPath,
		artifactId: options.artifactId,
		spillThreshold: DEFAULT_MAX_BYTES,
		headBytes: resolveOutputSinkHeadBytes(options.session.settings),
		maxColumns: resolveOutputMaxColumns(options.session.settings),
		onChunk: chunk => options.onChunk?.(chunk),
	});
	const legacyTimeoutMs = getExecutionTimeoutMs(options);
	const timeoutSignal =
		typeof legacyTimeoutMs === "number" && Number.isFinite(legacyTimeoutMs) && legacyTimeoutMs > 0
			? AbortSignal.timeout(legacyTimeoutMs)
			: undefined;
	const signal =
		options.signal && timeoutSignal
			? AbortSignal.any([options.signal, timeoutSignal])
			: (options.signal ?? timeoutSignal);
	// The eval tool drives cancellation via its own watchdog `signal` and passes
	// only the runtime-work budget; use it solely as worker cold-start headroom
	// and never derive a competing fixed timer from it.
	const acquireBudgetMs = legacyTimeoutMs ?? options.idleTimeoutMs;
	const cwd = options.cwd ?? options.session.cwd;

	try {
		await executeInVmContext({
			sessionKey: options.sessionId,
			sessionId: options.sessionId,
			ownerId: options.kernelOwnerId,
			cwd,
			session: options.session,
			localRoots: options.localRoots,
			reset: options.reset,
			code,
			filename: `js-cell-${crypto.randomUUID()}.js`,
			timeoutMs: acquireBudgetMs,
			// The only difference from the Bun executor. Read lazily, and only when
			// a context actually has to be built: a warm session never consults the
			// factory, and a slot emptied between cells surfaces as a cell error
			// rather than silently reopening on Bun.
			spawnWorker: () => {
				const factory = getElideJsKernelFactory();
				if (!factory) {
					// Reaches the model as a cell failure, so it names "the runtime".
					throw new Error("No runtime JS kernel is installed; cannot run this cell on the runtime engine.");
				}
				return spawnElideWorker(factory, { cwd, sessionId: options.sessionId });
			},
			runState: {
				signal,
				onText: chunk => outputSink.push(chunk),
				onDisplay: output => {
					if (output.type === "status") {
						// Timeout-control events drive the eval watchdog only; never
						// store or render them as cell output.
						options.onStatus?.(output.event);
						if (isEvalTimeoutControlEvent(output.event)) return;
					}
					displayOutputs.push(output);
				},
			},
		});
		const summary = await outputSink.dump();
		return {
			output: summary.output,
			exitCode: 0,
			cancelled: false,
			truncated: summary.truncated,
			artifactId: summary.artifactId,
			totalLines: summary.totalLines,
			totalBytes: summary.totalBytes,
			outputLines: summary.outputLines,
			outputBytes: summary.outputBytes,
			displayOutputs,
		};
	} catch (error) {
		if (signal?.aborted || isAbortError(error)) {
			const timedOut = Boolean(timeoutSignal?.aborted) || isTimeoutReason(options.signal?.reason);
			if (timedOut) {
				outputSink.push(formatJsTimeoutAnnotation(legacyTimeoutMs ?? options.idleTimeoutMs));
			}
			const summary = await outputSink.dump();
			return {
				output: summary.output,
				exitCode: undefined,
				cancelled: true,
				truncated: summary.truncated,
				artifactId: summary.artifactId,
				totalLines: summary.totalLines,
				totalBytes: summary.totalBytes,
				outputLines: summary.outputLines,
				outputBytes: summary.outputBytes,
				displayOutputs,
			};
		}
		const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
		outputSink.push(message);
		const summary = await outputSink.dump();
		return {
			output: summary.output,
			exitCode: 1,
			cancelled: false,
			truncated: summary.truncated,
			artifactId: summary.artifactId,
			totalLines: summary.totalLines,
			totalBytes: summary.totalBytes,
			outputLines: summary.outputLines,
			outputBytes: summary.outputBytes,
			displayOutputs,
		};
	} finally {
		await outputSink.dispose();
	}
}
