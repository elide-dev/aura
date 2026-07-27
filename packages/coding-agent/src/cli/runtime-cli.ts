/**
 * `aura runtime <action>` implementation, kept free of oclif plumbing so tests can
 * drive it with a stub service and capture output line-by-line.
 */
import { getOrCreateRuntimeService } from "../runtime";
import type { RuntimeStatusResult } from "../runtime/protocol";
import type { RuntimeService } from "../runtime/service";

export interface RuntimeCommandArgs {
	action: "status";
	flags: { json?: boolean };
}

/**
 * Human-readable status block. Never names the underlying binary vendor: the
 * user-facing noun is "the runtime".
 */
export function formatRuntimeStatus(status: RuntimeStatusResult): string {
	if (!status.available) {
		return ["runtime: unavailable", status.guidance ? `  ${status.guidance}` : undefined].filter(Boolean).join("\n");
	}
	return [
		"runtime: available",
		`  version:  ${status.version ?? "unknown"}`,
		status.binaryPath ? `  binary:   ${status.binaryPath}` : undefined,
		status.source ? `  source:   ${status.source}` : undefined,
		`  protocol: v${status.protocolVersion}`,
	]
		.filter(Boolean)
		.join("\n");
}

export async function runRuntimeCommand(
	cmd: RuntimeCommandArgs,
	service: Pick<RuntimeService, "status"> = getOrCreateRuntimeService(),
	print: (line: string) => void = line => process.stdout.write(`${line}\n`),
): Promise<number> {
	const status = await service.status();
	if (cmd.flags.json) {
		print(JSON.stringify(status, null, 2));
	} else {
		print(formatRuntimeStatus(status));
	}
	return status.available ? 0 : 1;
}
