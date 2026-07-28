import { afterEach, describe, expect, it } from "bun:test";
import {
	emitTelemetryEvent,
	getActiveTelemetrySessionId,
	setActiveTelemetrySessionId,
	subscribeTelemetry,
	type TelemetryEvent,
} from "../src/telemetry/events";

describe("telemetry event bus", () => {
	it("delivers events to subscribers and supports unsubscribe", () => {
		const seen: TelemetryEvent[] = [];
		const unsubscribe = subscribeTelemetry(event => seen.push(event));
		emitTelemetryEvent({ type: "session.started", sessionId: "s1", mode: "print", resumed: false });
		unsubscribe();
		emitTelemetryEvent({ type: "session.started", sessionId: "s2", mode: "print", resumed: false });
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ type: "session.started", sessionId: "s1" });
	});

	it("swallows subscriber throws and still delivers to other subscribers", () => {
		const seen: string[] = [];
		const u1 = subscribeTelemetry(() => {
			throw new Error("boom");
		});
		const u2 = subscribeTelemetry(event => seen.push(event.type));
		expect(() =>
			emitTelemetryEvent({ type: "compaction.savings", provider: "anthropic", model: "m", savedTokens: 10 }),
		).not.toThrow();
		expect(seen).toEqual(["compaction.savings"]);
		u1();
		u2();
	});
});

describe("active telemetry session id", () => {
	afterEach(() => {
		setActiveTelemetrySessionId(undefined);
	});

	it("defaults to undefined and round-trips", () => {
		expect(getActiveTelemetrySessionId()).toBeUndefined();
		setActiveTelemetrySessionId("s1");
		expect(getActiveTelemetrySessionId()).toBe("s1");
		setActiveTelemetrySessionId(undefined);
		expect(getActiveTelemetrySessionId()).toBeUndefined();
	});

	it("treats blank ids as unattributed", () => {
		setActiveTelemetrySessionId("   ");
		expect(getActiveTelemetrySessionId()).toBeUndefined();
	});
});
