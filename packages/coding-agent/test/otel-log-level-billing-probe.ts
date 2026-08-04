/**
 * Positive-path probe for the OTEL_LOG_LEVEL billing exemption, run as a
 * subprocess by telemetry-export.test.ts. Keeping it out-of-process means the
 * global LoggerProvider singleton that initTelemetryExport() registers never
 * leaks into the test runner, and OTEL_LOG_LEVEL is set only in the
 * subprocess's own environment — nothing to restore in the parent.
 *
 * Regression for the OTEL_LOG_LEVEL gate silently stopping metering
 * (init.ts's emitOtelLog): with OTEL_LOG_LEVEL=error, an ordinary info-level
 * bridged log must still be suppressed (proving the gate still works), while
 * a billable chat.usage event — which emits its aura.usage.tokens record at
 * "info" — must still reach the collector (proving the billing record is
 * exempt from the gate).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChatUsageEvent } from "@oh-my-pi/pi-agent-core";
import {
	AURA_USAGE_TOKENS_EVENT,
	createTelemetryExportConfig,
	flushTelemetryExport,
	initTelemetryExport,
	isTelemetryExportEnabled,
} from "@oh-my-pi/pi-coding-agent/telemetry-export";
import { logger } from "@oh-my-pi/pi-utils";

const logPayloads: Uint8Array[] = [];

interface ProtobufField {
	readonly number: number;
	readonly bytes?: Uint8Array;
}

function readVarint(bytes: Uint8Array, offset: number): [number, number] {
	let value = 0;
	let shift = 0;
	while (offset < bytes.length) {
		const byte = bytes[offset++];
		value += (byte & 0x7f) * 2 ** shift;
		if ((byte & 0x80) === 0) return [value, offset];
		shift += 7;
	}
	throw new Error("Truncated protobuf varint");
}

function protobufFields(bytes: Uint8Array): ProtobufField[] {
	const fields: ProtobufField[] = [];
	for (let offset = 0; offset < bytes.length; ) {
		const [tag, nextOffset] = readVarint(bytes, offset);
		offset = nextOffset;
		const wireType = tag & 7;
		const number = tag >>> 3;
		if (wireType === 0) {
			[, offset] = readVarint(bytes, offset);
			fields.push({ number });
		} else if (wireType === 1) {
			offset += 8;
			fields.push({ number });
		} else if (wireType === 2) {
			const [length, valueOffset] = readVarint(bytes, offset);
			offset = valueOffset;
			const end = offset + length;
			if (end > bytes.length) throw new Error("Truncated protobuf field");
			fields.push({ number, bytes: bytes.slice(offset, end) });
			offset = end;
		} else if (wireType === 5) {
			offset += 4;
			fields.push({ number });
		} else {
			throw new Error(`Unsupported protobuf wire type ${wireType}`);
		}
	}
	return fields;
}

function text(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

/** `LogRecord.event_name` (field 12) via resource_logs(1) -> scope_logs(2) -> log_records(2). */
function logEventNames(payload: Uint8Array): string[] {
	const names: string[] = [];
	for (const resourceLogs of protobufFields(payload)) {
		if (resourceLogs.number !== 1 || !resourceLogs.bytes) continue;
		for (const scopeLogs of protobufFields(resourceLogs.bytes)) {
			if (scopeLogs.number !== 2 || !scopeLogs.bytes) continue;
			for (const record of protobufFields(scopeLogs.bytes)) {
				if (record.number !== 2 || !record.bytes) continue;
				const eventName = protobufFields(record.bytes).find(field => field.number === 12)?.bytes;
				if (eventName) names.push(text(eventName));
			}
		}
	}
	return names;
}

const server = Bun.serve({
	port: 0,
	async fetch(req) {
		const endpoint = new URL(req.url).pathname;
		if (req.method === "POST" && endpoint.endsWith("/v1/logs")) {
			const body = await req.arrayBuffer();
			if (body.byteLength > 0) logPayloads.push(new Uint8Array(body));
			return new Response('{"partialSuccess":{}}', {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response("not found", { status: 404 });
	},
});

process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = `http://localhost:${server.port}/v1/logs`;
process.env.OTEL_SERVICE_NAME = "oh-my-pi-log-level-billing-probe";
// The gate under test: raised well above "info" so an ordinary bridged log is
// suppressed, isolating the billing record's exemption from it.
process.env.OTEL_LOG_LEVEL = "error";

// Sandbox the config root so the probe's `aura.install.id` is minted into a temp
// directory instead of persisting into the developer's real config root.
const configRoot = fs.mkdtempSync(path.join(os.homedir(), ".aura-log-level-billing-probe-"));
process.on("exit", () => fs.rmSync(configRoot, { recursive: true, force: true }));
process.env.PI_CONFIG_DIR = path.basename(configRoot);
const { refreshDirsFromEnv } = await import("@oh-my-pi/pi-utils/dirs");
refreshDirsFromEnv();

await initTelemetryExport();
if (!isTelemetryExportEnabled()) {
	console.error("PROBE: provider did not register");
	await server.stop(true);
	process.exit(2);
}

const config = createTelemetryExportConfig(undefined);
if (!config) {
	console.error("PROBE: export config not produced");
	await server.stop(true);
	process.exit(2);
}

// An ordinary info-level bridged log: must be suppressed under OTEL_LOG_LEVEL=error.
logger.info("probe info log — should be suppressed", { code: "probe_info" });

// A billable chat.usage event: sink-otlp emits its aura.usage.tokens record at
// "info" (sink-otlp.ts), which must still get through despite the gate above.
const usage: ChatUsageEvent = {
	span: undefined as never,
	agent: { id: "main", name: "Main" },
	conversationId: "probe-session",
	stepNumber: 0,
	model: "claude-haiku-4-5",
	provider: "anthropic",
	serviceTier: undefined,
	usage: {
		inputTokens: 1000,
		outputTokens: 200,
		totalTokens: 1200,
		cachedInputTokens: 0,
		cacheWriteTokens: 0,
		reasoningOutputTokens: 0,
	},
	cost: { usd: 0.01 },
	attributes: undefined,
	headers: undefined,
};
await config.onChatUsage?.(usage);

await flushTelemetryExport();
await server.stop(true);

const eventNames = logPayloads.flatMap(logEventNames);
const sawBilling = eventNames.includes(AURA_USAGE_TOKENS_EVENT);
const sawSuppressedInfo = eventNames.includes("aura.log");

if (!sawBilling) {
	console.error(`PROBE: billing record missing (saw ${eventNames.join(",") || "none"})`);
	process.exit(1);
}
if (sawSuppressedInfo) {
	console.error("PROBE: OTEL_LOG_LEVEL=error failed to suppress the ordinary info log — gate is not selective");
	process.exit(1);
}

console.log("PROBE: BILLING EXEMPT FROM LOG LEVEL GATE");
process.exit(0);
