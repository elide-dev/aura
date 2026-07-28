/**
 * Positive-path probe for the *settings*-driven OTLP export path, run as a
 * subprocess by telemetry-settings.test.ts. Out-of-process for the same reason
 * as otel-export-probe.ts: initTelemetryExport() registers global providers.
 *
 * No `OTEL_EXPORTER_OTLP_*` endpoint env var is set — the endpoint, headers,
 * and identity opt-ins arrive purely through a fake Settings instance. Exits 0
 * only when a protobuf POST carrying the settings-supplied header lands at
 * /v1/traces.
 */

import * as os from "node:os";
import {
	flushTelemetryExport,
	initTelemetryExport,
	isTelemetryExportEnabled,
} from "@oh-my-pi/pi-coding-agent/telemetry-export";
import { trace } from "@opentelemetry/api";

let received = false;
let sawHeader = false;
let sawHostname = false;

const server = Bun.serve({
	port: 0,
	async fetch(req) {
		const path = new URL(req.url).pathname;
		if (req.method === "POST" && path.endsWith("/v1/traces")) {
			const body = await req.arrayBuffer();
			if (body.byteLength > 0 && req.headers.get("content-type") === "application/x-protobuf") {
				received = true;
				sawHeader = req.headers.get("x-probe-key") === "sekrit";
				// Resource attribute keys/values are plain UTF-8 strings inside the
				// protobuf envelope, so a substring scan is enough to prove the
				// telemetry.identity.hostname opt-in reached the resource — i.e.
				// that registerProviders threaded its options into
				// buildResourceAttributes rather than dropping them.
				const text = new TextDecoder().decode(body);
				sawHostname = text.includes("host.name") && text.includes(os.hostname());
			}
			return new Response('{"partialSuccess":{}}', {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response("not found", { status: 404 });
	},
});

for (const key of Object.keys(process.env)) {
	if (key.startsWith("OTEL_")) delete process.env[key];
}
process.env.OTEL_SERVICE_NAME = "aura-settings-probe";

const values: Record<string, unknown> = {
	"telemetry.enabled": true,
	"telemetry.endpoint": `http://localhost:${server.port}`,
	"telemetry.headers": { "x-probe-key": "sekrit" },
	"telemetry.signals": ["traces"],
	"telemetry.identity.hostname": true,
};
const settings = { get: (path: string) => values[path] } as never;

await initTelemetryExport({ settings });
if (!isTelemetryExportEnabled()) {
	console.error("PROBE: provider did not register from settings");
	await server.stop(true);
	process.exit(2);
}

const span = trace.getTracer("@oh-my-pi/pi-agent-core").startSpan("agent.llm_call");
span.setAttribute("gen_ai.system", "probe");
span.end();

await flushTelemetryExport();
await server.stop(true);

if (!sawHeader) console.error("PROBE: settings headers did not reach the exporter");
if (!sawHostname) console.error("PROBE: identity opt-in did not reach the resource");
const ok = received && sawHeader && sawHostname;
console.log(ok ? "PROBE: RECEIVED" : "PROBE: NO_EXPORT");
process.exit(ok ? 0 : 1);
