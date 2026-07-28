/**
 * Positive-path probe for the *settings*-driven OTLP export path, run as a
 * subprocess by telemetry-settings.test.ts. Out-of-process for the same reason
 * as otel-export-probe.ts: initTelemetryExport() registers global providers.
 *
 * Every OTEL_* env var is cleared first — the endpoint, headers, and identity
 * opt-ins arrive purely through a fake Settings instance, reaching the exporter
 * via its constructor config. Exits 0 only when a protobuf POST carrying the
 * settings-supplied header lands at /v1/traces (proving the base endpoint was
 * joined to the per-signal path) and no OTEL_* key was written back to
 * process.env.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
		const endpoint = new URL(req.url).pathname;
		if (req.method === "POST" && endpoint.endsWith("/v1/traces")) {
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

// Sandbox the config root so the probe's `aura.install.id` is minted into a temp
// directory instead of persisting into the developer's real config root.
// `PI_CONFIG_DIR` is resolved relative to $HOME, so the sandbox must live there.
const configRoot = fs.mkdtempSync(path.join(os.homedir(), ".aura-settings-probe-"));
process.on("exit", () => fs.rmSync(configRoot, { recursive: true, force: true }));
process.env.PI_CONFIG_DIR = path.basename(configRoot);
const { refreshDirsFromEnv } = await import("@oh-my-pi/pi-utils/dirs");
refreshDirsFromEnv();

const values: Record<string, unknown> = {
	"telemetry.enabled": true,
	"telemetry.endpoint": `http://localhost:${server.port}`,
	"telemetry.headers": { "x-probe-key": "sekrit" },
	"telemetry.signals": ["traces"],
	"telemetry.identity.hostname": true,
};
const settings = { get: (key: string) => values[key] } as never;

await initTelemetryExport({ settings });
if (!isTelemetryExportEnabled()) {
	console.error("PROBE: provider did not register from settings");
	await server.stop(true);
	process.exit(2);
}

// The settings path configures the exporters through their constructors, never
// by writing back into the environment. Every OTEL_* key was cleared above, so
// any endpoint/header key present here would be a process.env mutation.
const leaked = Object.keys(process.env).filter(k => k.startsWith("OTEL_") && k !== "OTEL_SERVICE_NAME");
if (leaked.length > 0) {
	console.error(`PROBE: settings leaked into process.env: ${leaked.join(", ")}`);
	await server.stop(true);
	process.exit(3);
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
