/**
 * Positive-path probe for the OTLP log + metric exporters, run as a subprocess
 * by telemetry-export.test.ts. Keeping it out-of-process means the global
 * LoggerProvider / MeterProvider singletons that initTelemetryExport() registers
 * never leak into the test runner.
 *
 * Stands up a loopback OTLP/proto receiver, points the standard env vars at it,
 * registers the providers, drives a log record through the bridged
 * `@oh-my-pi/pi-utils` logger, metric instruments through the agent telemetry
 * hooks, and one of every telemetry-bus event through the public
 * `emitTelemetryEvent`, flushes, and exits 0 only if the receiver got a
 * non-empty protobuf POST at both /v1/logs and /v1/metrics carrying the
 * expected resource attributes, metric points, and log event names.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentRunCoverage, AgentRunSummary, ChatUsageEvent } from "@oh-my-pi/pi-agent-core";
import { emptyAgentRunCoverage, emptyAgentRunSummary } from "@oh-my-pi/pi-agent-core";
import {
	createTelemetryExportConfig,
	emitTelemetryEvent,
	flushTelemetryExport,
	initTelemetryExport,
	isTelemetryExportEnabled,
} from "@oh-my-pi/pi-coding-agent/telemetry-export";
import { logger } from "@oh-my-pi/pi-utils";

const seen = new Set<string>();
const metricPayloads: Uint8Array[] = [];
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

function pointCountForMetric(bytes: Uint8Array, metricName: string): number | undefined {
	const fields = protobufFields(bytes);
	const isMetric = fields.some(field => field.number === 1 && field.bytes && text(field.bytes) === metricName);
	if (isMetric) {
		// Metric.data oneof: gauge=5, sum=7, histogram=9 — each wrapping repeated
		// data_points at field 1.
		const aggregation = fields.find(field => field.number === 5 || field.number === 7 || field.number === 9)?.bytes;
		if (!aggregation) return undefined;
		return protobufFields(aggregation).filter(field => field.number === 1).length;
	}
	for (const field of fields) {
		if (!field.bytes) continue;
		try {
			const count = pointCountForMetric(field.bytes, metricName);
			if (count !== undefined) return count;
		} catch {
			// This length-delimited field is a scalar string or bytes value, not a nested message.
		}
	}
	return undefined;
}

function assertSingleMetricPoint(metricName: string): void {
	const counts = metricPayloads.map(payload => pointCountForMetric(payload, metricName));
	if (!counts.includes(1)) {
		throw new Error(`${metricName} expected one dimensioned point, got ${counts.join(",")}`);
	}
}

/** Weaker sibling of {@link assertSingleMetricPoint}: any exported point will do. */
function assertMetricExported(metricName: string): void {
	const counts = metricPayloads.map(payload => pointCountForMetric(payload, metricName));
	if (!counts.some(count => count !== undefined && count > 0)) {
		throw new Error(`${metricName} exported no data points (saw ${counts.join(",") || "no payloads"})`);
	}
}

/**
 * `service.name`-style resource attributes carried by an OTLP export request.
 *
 * Walks `resource_{metrics,logs} (1) -> resource (1) -> attributes (1) ->
 * KeyValue{key(1), value(2) -> AnyValue.string_value(1)}`. Non-string values are
 * skipped; every attribute the resource builder mints is a string.
 */
function resourceAttributes(payload: Uint8Array): Record<string, string> {
	const out: Record<string, string> = {};
	for (const resourceSignal of protobufFields(payload)) {
		if (resourceSignal.number !== 1 || !resourceSignal.bytes) continue;
		for (const resource of protobufFields(resourceSignal.bytes)) {
			if (resource.number !== 1 || !resource.bytes) continue;
			for (const keyValue of protobufFields(resource.bytes)) {
				if (keyValue.number !== 1 || !keyValue.bytes) continue;
				const parts = protobufFields(keyValue.bytes);
				const key = parts.find(part => part.number === 1)?.bytes;
				const anyValue = parts.find(part => part.number === 2)?.bytes;
				if (!key || !anyValue) continue;
				const stringValue = protobufFields(anyValue).find(part => part.number === 1)?.bytes;
				if (stringValue) out[text(key)] = text(stringValue);
			}
		}
	}
	return out;
}

/**
 * `LogRecord.event_name` (field 12) values in an OTLP logs request, via
 * `resource_logs (1) -> scope_logs (2) -> log_records (2)`.
 */
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

function assertLogEventName(eventName: string): void {
	const seenNames = logPayloads.flatMap(logEventNames);
	if (!seenNames.includes(eventName)) {
		throw new Error(`no log record with eventName ${eventName} (saw ${seenNames.join(",") || "none"})`);
	}
}

/**
 * Every export must carry the pseudonymous identity the collector groups by.
 * `OTEL_SERVICE_NAME` is deliberately left unset above so this also pins the
 * built-in default rather than whatever the environment happened to supply.
 */
function assertResourceIdentity(kind: string, payloads: readonly Uint8Array[]): void {
	if (payloads.length === 0) throw new Error(`${kind}: no payloads to check resource attributes on`);
	for (const payload of payloads) {
		const attrs = resourceAttributes(payload);
		if (attrs["service.name"] !== "aura") {
			throw new Error(`${kind}: service.name expected "aura", got ${JSON.stringify(attrs["service.name"])}`);
		}
		if (!attrs["service.version"]) throw new Error(`${kind}: service.version missing`);
		if (!/^[0-9a-f-]{36}$/.test(attrs["aura.install.id"] ?? "")) {
			throw new Error(`${kind}: aura.install.id expected a UUID, got ${JSON.stringify(attrs["aura.install.id"])}`);
		}
	}
}

const server = Bun.serve({
	port: 0,
	async fetch(req) {
		const endpoint = new URL(req.url).pathname;
		if (req.method === "POST" && req.headers.get("content-type")?.startsWith("application/x-protobuf")) {
			const body = await req.arrayBuffer();
			// Empty bodies are not collected: they carry no resource block, so a
			// stray one would fail the resource assertions for no real reason.
			if (body.byteLength > 0) {
				if (endpoint.endsWith("/v1/logs")) {
					logPayloads.push(new Uint8Array(body));
					seen.add("logs");
				}
				if (endpoint.endsWith("/v1/metrics")) {
					metricPayloads.push(new Uint8Array(body));
					seen.add("metrics");
				}
			}
		}
		return new Response('{"partialSuccess":{}}', {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	},
});

const base = `http://localhost:${server.port}`;
process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = `${base}/v1/logs`;
process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = `${base}/v1/metrics`;
// OTEL_SERVICE_NAME is left unset on purpose: the resource assertions below pin
// aura's built-in default service name, which an override would mask.
delete process.env.OTEL_SERVICE_NAME;
// Force a short metric export interval so the periodic reader flushes fast.
process.env.OTEL_METRIC_EXPORT_INTERVAL = "500";

// Sandbox the config root so the probe's `aura.install.id` is minted into a temp
// directory instead of persisting into the developer's real config root.
// `PI_CONFIG_DIR` is resolved relative to $HOME, so the sandbox must live there.
const configRoot = fs.mkdtempSync(path.join(os.homedir(), ".aura-signals-probe-"));
process.on("exit", () => fs.rmSync(configRoot, { recursive: true, force: true }));
process.env.PI_CONFIG_DIR = path.basename(configRoot);
const { refreshDirsFromEnv } = await import("@oh-my-pi/pi-utils/dirs");
refreshDirsFromEnv();

await initTelemetryExport();
if (!isTelemetryExportEnabled()) {
	console.error("PROBE: providers did not register");
	await server.stop(true);
	process.exit(2);
}

const config = createTelemetryExportConfig(undefined);
if (!config) {
	console.error("PROBE: export config not produced");
	await server.stop(true);
	process.exit(2);
}

// Bridged utility logger -> OTel log record.
logger.error("probe error", { code: "probe" });

// Metric instruments via the agent telemetry hooks.
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

const summary: AgentRunSummary = {
	...emptyAgentRunSummary(),
	chats: { total: 1, byStopReason: { end_turn: 1 }, totalLatencyMs: 1500 },
	tools: {
		total: 1,
		ok: 1,
		error: 0,
		skipped: 0,
		blocked: 0,
		timeout: 0,
		aborted: 0,
		totalLatencyMs: 42,
		byName: {
			read: { total: 1, ok: 1, error: 0, skipped: 0, blocked: 0, timeout: 0, aborted: 0, totalLatencyMs: 42 },
		},
	},
	stepCount: 1,
};
const coverage: AgentRunCoverage = {
	...emptyAgentRunCoverage(),
	toolsAvailable: ["read", "write"],
	toolsInvoked: ["read"],
	toolsUnused: ["write"],
	modelsUsed: ["claude-haiku-4-5"],
	providersUsed: ["anthropic"],
};
config.onRunEnd?.(summary, coverage);

// One of every remaining bus event, straight through the public emitter, so the
// session / compaction / usage-limit / error signals are covered end to end.
// `turn.completed` is not emitted here: `onRunEnd` above publishes it (with the
// active session id stamped by the host, `undefined` in this process).
emitTelemetryEvent({ type: "session.started", sessionId: "probe", mode: "print", resumed: false });
emitTelemetryEvent({
	type: "session.ended",
	sessionId: "probe",
	mode: "print",
	durationMs: 1000,
	activeMs: 500,
	turns: 1,
	tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
	estimatedCostUsd: 0,
	endReason: "probe",
});
emitTelemetryEvent({
	type: "compaction.completed",
	sessionId: "probe",
	// The auto path's strategy vocabulary (`AutoCompactionEndEvent.action`).
	strategy: "context-full",
	trigger: "manual",
	outcome: "ok",
	tokensBefore: 1000,
	tokensAfter: 100,
	durationMs: 50,
});
emitTelemetryEvent({ type: "compaction.savings", provider: "anthropic", model: "probe-model", savedTokens: 42 });
emitTelemetryEvent({
	type: "usage_limit.snapshot",
	entry: {
		recordedAt: 1,
		provider: "anthropic",
		accountKey: "acct",
		limitId: "l1",
		label: "5h",
		windowLabel: "5h",
		usedFraction: 0.4,
	},
});
emitTelemetryEvent({ type: "error.reported", phase: "session", errorType: "probe_error", message: "probe" });

await flushTelemetryExport();
// The metric reader exports on its own interval; wait one cycle then flush.
await Bun.sleep(700);
await flushTelemetryExport();
assertSingleMetricPoint("aura.agent.chat.calls");
assertSingleMetricPoint("aura.agent.tool.calls");
assertSingleMetricPoint("aura.agent.tool.duration");
assertMetricExported("aura.session.duration");
assertMetricExported("aura.compaction.count");
assertMetricExported("aura.compaction.tokens_saved");
assertMetricExported("aura.snapcompact.tokens_saved");
assertMetricExported("aura.usage_limit.utilization");
assertMetricExported("aura.agent.errors");
assertLogEventName("aura.session.ended");
assertResourceIdentity("metrics", metricPayloads);
assertResourceIdentity("logs", logPayloads);
console.log("PROBE: SIGNALS OK");
await server.stop(true);

const ok = seen.has("logs") && seen.has("metrics");
console.log(ok ? "PROBE: RECEIVED" : `PROBE: MISSING ${["logs", "metrics"].filter(s => !seen.has(s)).join(",")}`);
process.exit(ok ? 0 : 1);
