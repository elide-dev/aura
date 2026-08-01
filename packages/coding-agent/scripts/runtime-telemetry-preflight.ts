#!/usr/bin/env bun
import { okResponse } from "../src/runtime/protocol";
import { RuntimeService } from "../src/runtime/service";
import { type RuntimeCallCompletedTelemetry, subscribeTelemetry } from "../src/telemetry/events";

async function main(): Promise<void> {
	const events: RuntimeCallCompletedTelemetry[] = [];
	const unsubscribe = subscribeTelemetry(event => {
		if (event.type === "runtime.call.completed") events.push(event);
	});
	let callIndex = 0;
	const service = new RuntimeService({
		async request(req) {
			callIndex += 1;
			return okResponse(req.id, {
				exitCode: callIndex === 1 ? 0 : 2,
				stdout: "",
				stderr: callIndex === 1 ? "" : "intentional failure",
				durationMs: 1,
				killed: false,
			});
		},
	});
	try {
		await service.run({ code: "print('ok')", language: "python" }, undefined, "benchmark-preflight");
		await service.run({ code: "raise SystemExit(2)", language: "python" }, undefined, "benchmark-preflight");
	} finally {
		unsubscribe();
	}
	const [success, failure] = events;
	if (
		events.length !== 2 ||
		!success ||
		success.sessionId !== "benchmark-preflight" ||
		success.language !== "python" ||
		success.outcome !== "ok" ||
		success.exitCode !== 0 ||
		success.durationMs < 0
	) {
		throw new Error("runtime telemetry success preflight failed");
	}
	if (
		failure?.sessionId !== "benchmark-preflight" ||
		failure.language !== "python" ||
		failure.outcome !== "error" ||
		failure.exitCode !== 2 ||
		failure.errorType !== "non_zero_exit" ||
		failure.durationMs < 0
	) {
		throw new Error("runtime telemetry failure preflight failed");
	}
	process.stdout.write(`${JSON.stringify({ success, failure })}\n`);
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
