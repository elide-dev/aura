/**
 * `aura runtime <action>` implementation, kept free of oclif plumbing so tests can
 * drive it with a stub service and capture output line-by-line.
 */
import { settings } from "../config/settings";
import {
	RUNTIME_PROTOCOL_VERSION,
	RuntimeService,
	type RuntimeSettingsValues,
	resolveRuntimeEndpointOptions,
	type SelectedEndpointOptions,
	SelectedRuntimeEndpoint,
} from "../runtime";
import type { RuntimeStatusResult } from "../runtime/protocol";
import { formatDisplayPath } from "../utils/display-path";

export interface RuntimeCommandArgs {
	action: "status";
	flags: { json?: boolean };
}

/** Sentinel for `runtime.enabled = false`: there is no service to probe at all. */
export const RUNTIME_DISABLED = { disabled: true } as const;

export type StatusRuntime =
	| (Pick<RuntimeService, "status"> & Partial<Pick<RuntimeService, "close">>)
	| typeof RUNTIME_DISABLED;

function isDisabled(runtime: StatusRuntime): runtime is typeof RUNTIME_DISABLED {
	return "disabled" in runtime;
}

/** Read the `runtime.*` settings the innate tools use, from the settings singleton. */
export function readRuntimeSettings(): RuntimeSettingsValues {
	return {
		enabled: settings.get("runtime.enabled"),
		autoDownload: settings.get("runtime.autoDownload"),
		path: settings.get("runtime.path") ?? "",
		adapter: settings.get("runtime.adapter"),
		embeddedPath: settings.get("runtime.embeddedPath") ?? "",
	};
}

/**
 * Endpoint options for a *diagnostic* probe: the same settings the innate tools
 * resolve (`resolveRuntimeEndpointOptions`), except auto-download is always off —
 * reporting status is read-only and must never provision a runtime as a side
 * effect. `undefined` means `runtime.enabled = false`.
 */
export function resolveStatusEndpointOptions(values: RuntimeSettingsValues): SelectedEndpointOptions | undefined {
	const opts = resolveRuntimeEndpointOptions(values);
	return opts === undefined ? undefined : { ...opts, autoDownload: false };
}

/**
 * Fresh, unshared service for one status probe. Deliberately *not*
 * `getOrCreateRuntimeService`: that memo is keyed on the endpoint options, so
 * probing with `autoDownload: false` would evict the entry the innate tools are
 * using and make them rebuild. Constructing directly keeps the probe invisible.
 */
export function createStatusRuntime(
	values: RuntimeSettingsValues = readRuntimeSettings(),
): RuntimeService | typeof RUNTIME_DISABLED {
	const opts = resolveStatusEndpointOptions(values);
	if (opts === undefined) return RUNTIME_DISABLED;
	return new RuntimeService(new SelectedRuntimeEndpoint(opts));
}

function formatRuntimeSelection(status: RuntimeStatusResult): string[] {
	const lines: string[] = [];
	if (status.adapter) lines.push(`  adapter: ${status.adapter}`);
	if (status.effectiveAdapter) lines.push(`  effective adapter: ${status.effectiveAdapter}`);
	if (status.embeddedLibraryPath) {
		lines.push(`  embedded runtime library: ${formatDisplayPath(status.embeddedLibraryPath)}`);
	}
	if (status.embeddedLibrarySource) {
		lines.push(`  embedded runtime library source: ${status.embeddedLibrarySource}`);
	}
	if (status.embeddedAbiVersion !== undefined) lines.push(`  ABI: ${status.embeddedAbiVersion}`);
	if (status.embeddedSchemaHash !== undefined) lines.push(`  schema: ${status.embeddedSchemaHash}`);
	return lines;
}

/**
 * Human-readable status block. Prose uses only "the runtime"; resolved
 * filesystem paths remain factual and may contain internal artifact names.
 */
export function formatRuntimeStatus(status: RuntimeStatusResult): string {
	const selection = formatRuntimeSelection(status);
	if (!status.available) {
		return ["runtime: unavailable", ...selection, status.guidance ? `  ${status.guidance}` : undefined]
			.filter((line): line is string => line !== undefined)
			.join("\n");
	}
	return [
		"runtime: available",
		`  version:  ${status.version ?? "unknown"}`,
		status.binaryPath ? `  binary:   ${formatDisplayPath(status.binaryPath)}` : undefined,
		status.source ? `  source:   ${status.source}` : undefined,
		...selection,
		`  protocol: v${status.protocolVersion}`,
	]
		.filter((line): line is string => line !== undefined)
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
	try {
		const status = await service.status();
		if (cmd.flags.json) {
			print(JSON.stringify(status, null, 2));
		} else {
			print(formatRuntimeStatus(status));
		}
		return status.available ? 0 : 1;
	} finally {
		await service.close?.();
	}
}
