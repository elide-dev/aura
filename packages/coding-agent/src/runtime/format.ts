import type { RuntimeExecResult } from "./protocol";

const MAX_OUTPUT_CHARS = 60_000;

function cap(text: string): string {
	if (text.length <= MAX_OUTPUT_CHARS) return text;
	return `${text.slice(0, MAX_OUTPUT_CHARS)}\n… output truncated (${text.length} chars total)`;
}

/** Render an exec result for the model: stdout, stderr, and an exit annotation. */
export function formatExecResult(result: RuntimeExecResult): string {
	const parts: string[] = [];
	const stdout = result.stdout.replace(/\n+$/, "");
	const stderr = result.stderr.replace(/\n+$/, "");
	if (stdout) parts.push(cap(stdout));
	if (stderr) parts.push(`--- stderr ---\n${cap(stderr)}`);
	if (result.killed) parts.push("(process was killed: timeout or cancellation)");
	if (result.exitCode !== 0) parts.push(`(exit code ${result.exitCode})`);
	if (parts.length === 0) parts.push(`(no output, exit code ${result.exitCode})`);
	return parts.join("\n");
}
