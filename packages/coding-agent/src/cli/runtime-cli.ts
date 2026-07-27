/**
 * `aura runtime <action>` implementation, kept free of oclif plumbing so tests can
 * drive it with a stub service and capture output line-by-line.
 */
import { settings } from "../config/settings";
import {
	type LocalEndpointOptions,
	LocalRuntimeEndpoint,
	RUNTIME_PROTOCOL_VERSION,
	RuntimeService,
	type RuntimeSettingsValues,
	resolveRuntimeEndpointOptions,
} from "../runtime";
import type { RuntimeStatusResult } from "../runtime/protocol";

export interface RuntimeCommandArgs {
	action: "status";
	flags: { json?: boolean };
}

/** Sentinel for `runtime.enabled = false`: there is no service to probe at all. */
export const RUNTIME_DISABLED = { disabled: true } as const;

export type StatusRuntime = Pick<RuntimeService, "status"> | typeof RUNTIME_DISABLED;

function isDisabled(runtime: StatusRuntime): runtime is typeof RUNTIME_DISABLED {
	return "disabled" in runtime;
}

/** Read the `runtime.*` settings the innate tools use, from the settings singleton. */
export function readRuntimeSettings(): RuntimeSettingsValues {
	return {
		enabled: settings.get("runtime.enabled"),
		autoDownload: settings.get("runtime.autoDownload"),
		path: settings.get("runtime.path") ?? "",
	};
}

/**
 * Endpoint options for a *diagnostic* probe: the same settings the innate tools
 * resolve (`resolveRuntimeEndpointOptions`), except auto-download is always off —
 * reporting status is read-only and must never provision a runtime as a side
 * effect. `undefined` means `runtime.enabled = false`.
 */
export function resolveStatusEndpointOptions(values: RuntimeSettingsValues): LocalEndpointOptions | undefined {
	const opts = resolveRuntimeEndpointOptions(values);
	return opts === undefined ? undefined : { ...opts, autoDownload: false };
}

/**
 * Fresh, unshared service for one status probe. Deliberately *not*
 * `getOrCreateRuntimeService`: that memo is keyed on the endpoint options, so
 * probing with `autoDownload: false` would evict the entry the innate tools are
 * using and make them rebuild. Constructing directly keeps the probe invisible.
 */
export function createStatusRuntime(values: RuntimeSettingsValues = readRuntimeSettings()): StatusRuntime {
	const opts = resolveStatusEndpointOptions(values);
	if (opts === undefined) return RUNTIME_DISABLED;
	return new RuntimeService(new LocalRuntimeEndpoint(opts));
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
	service: StatusRuntime = createStatusRuntime(),
	print: (line: string) => void = line => process.stdout.write(`${line}\n`),
): Promise<number> {
	if (isDisabled(service)) {
		print(
			cmd.flags.json
				? JSON.stringify(
						{
							available: false,
							disabled: true,
							guidance: "Set runtime.enabled to true to use the innate runtime tools.",
							protocolVersion: RUNTIME_PROTOCOL_VERSION,
						},
						null,
						2,
					)
				: "runtime: disabled (runtime.enabled = false)",
		);
		return 1;
	}
	const status = await service.status();
	if (cmd.flags.json) {
		print(JSON.stringify(status, null, 2));
	} else {
		print(formatRuntimeStatus(status));
	}
	return status.available ? 0 : 1;
}
