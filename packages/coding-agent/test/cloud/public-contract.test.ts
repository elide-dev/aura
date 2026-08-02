import { describe, expect, test } from "bun:test";
import { inspect } from "node:util";
import * as cloud from "../../src/cloud";
import {
	AURA_CLOUD_ERROR_CODES,
	AuraCloudError,
	auraCloudErrorCause,
	classifyHost,
	isAuraCloudError,
} from "../../src/cloud/errors";

/** Every code the plan pins for the cloud client, in plan order. */
const EXPECTED_CODES = [
	"not_configured",
	"invalid_configuration",
	"login_required",
	"relogin_required",
	"access_denied",
	"expired",
	"unauthorized",
	"forbidden",
	"conflict",
	"rate_limited",
	"payload_too_large",
	"unsupported",
	"unavailable",
	"invalid_response",
	"aborted",
] as const;

/** Surface owned by the identity/server siblings — must never appear on the client barrel. */
const FORBIDDEN_EXPORT_PATTERNS = [
	/worker[-_]?auth/i,
	/^AUTH$/,
	/usage[-_]?ingest/i,
	/remote[-_]?session/i,
	/oauth/i,
	/jwks/i,
	/device[-_]?code/i,
];

const SECRET = "sk-live-DEADBEEFCAFE";

/**
 * A realistic `fetch` TypeError message: the full request URL, credentials and all.
 *
 * Declared here, far from any construction site, on purpose. `Bun.inspect` prints a window
 * of *source lines* around where an error was constructed, so a sensitive literal sitting
 * next to the `new AuraCloudError(...)` call would show up in the dump as source text and
 * make the assertions below fail for a reason that has nothing to do with redaction.
 */
const CAUSE_MESSAGE = `fetch failed: https://cloud.example.dev/v1/token?access_token=${SECRET}`;

describe("cloud barrel public contract", () => {
	test("re-exports the error taxonomy", () => {
		expect(cloud.AuraCloudError).toBe(AuraCloudError);
		expect(cloud.isAuraCloudError).toBe(isAuraCloudError);
		expect(cloud.AURA_CLOUD_ERROR_CODES).toBe(AURA_CLOUD_ERROR_CODES);
	});

	test("exports nothing identity/server-owned", () => {
		for (const name of Object.keys(cloud)) {
			for (const pattern of FORBIDDEN_EXPORT_PATTERNS) {
				expect({ name, pattern: pattern.source, matched: pattern.test(name) }).toEqual({
					name,
					pattern: pattern.source,
					matched: false,
				});
			}
		}
	});
});

describe("AuraCloudError taxonomy", () => {
	test("pins the exact code list", () => {
		expect([...AURA_CLOUD_ERROR_CODES]).toEqual([...EXPECTED_CODES]);
	});

	test("every code is constructible and round-trips through `code`", () => {
		for (const code of EXPECTED_CODES) {
			const err = new AuraCloudError(code);
			expect(err.code).toBe(code);
			expect(err).toBeInstanceOf(Error);
			expect(err.name).toBe("AuraCloudError");
			expect(isAuraCloudError(err)).toBe(true);
		}
	});

	test("isAuraCloudError rejects foreign errors and non-errors", () => {
		expect(isAuraCloudError(new Error("nope"))).toBe(false);
		expect(isAuraCloudError(undefined)).toBe(false);
		expect(isAuraCloudError({ code: "expired" })).toBe(false);
	});

	test("carries status and a host class, never the host itself", () => {
		const err = new AuraCloudError("rate_limited", { status: 429, host: "https://cloud.example.dev/v1/deploy" });
		expect(err.status).toBe(429);
		expect(err.hostClass).toBe("public");
		expect(new AuraCloudError("unavailable", { host: "http://127.0.0.1:8787/x" }).hostClass).toBe("loopback");
		expect(new AuraCloudError("unavailable", { host: "https://10.1.2.3/x" }).hostClass).toBe("private");
		expect(new AuraCloudError("unavailable").hostClass).toBe("unknown");
		expect(new AuraCloudError("unavailable", { host: "not a url" }).hostClass).toBe("unknown");
	});

	test("classifyHost covers loopback, private and public host shapes", () => {
		for (const host of ["http://localhost:3000", "https://api.localhost", "http://[::1]:8787"]) {
			expect(classifyHost(host)).toBe("loopback");
		}
		for (const host of [
			"https://192.168.1.10",
			"https://172.16.0.1",
			"https://169.254.1.1",
			"https://box.local",
			"https://gateway.internal",
			"https://buildbox",
			"http://[fd00::1]",
		]) {
			expect(classifyHost(host)).toBe("private");
		}
		for (const host of ["https://example.dev/v1", "https://8.8.8.8", "http://[2606:4700::1111]"]) {
			expect(classifyHost(host)).toBe("public");
		}
		for (const host of [undefined, "", "not a url", "://broken"]) {
			expect(classifyHost(host)).toBe("unknown");
		}
	});

	test("keeps an underlying cause off the error object, reachable only via the accessor", () => {
		const cause = new Error("socket hang up");
		const err = new AuraCloudError("unavailable", { cause });
		expect(auraCloudErrorCause(err)).toBe(cause);
		expect(err.cause).toBeUndefined();
		expect(Object.keys(err)).not.toContain("cause");
		expect(Object.getOwnPropertyNames(err)).not.toContain("cause");
		expect(auraCloudErrorCause(new AuraCloudError("unavailable"))).toBeUndefined();
	});
});

describe("AuraCloudError redaction", () => {
	const hostile = {
		status: 401,
		host: `https://user:${SECRET}@cloud.example.dev/v1/token?access_token=${SECRET}`,
		token: SECRET,
		body: `{"refresh_token":"${SECRET}"}`,
	};
	// Cast past the options type on purpose: prove out-of-contract fields cannot leak.
	const sensitive = new AuraCloudError("unauthorized", hostile as any);

	test("message never contains the secret, host, or body", () => {
		expect(sensitive.message).not.toContain(SECRET);
		expect(sensitive.message).not.toContain("cloud.example.dev");
		expect(sensitive.message).not.toContain("refresh_token");
	});

	test("toString never contains the secret or host", () => {
		expect(sensitive.toString()).not.toContain(SECRET);
		expect(sensitive.toString()).not.toContain("access_token");
		expect(sensitive.toString()).not.toContain("cloud.example.dev");
	});

	test("toJSON exposes only code, status and host class", () => {
		expect(sensitive.toJSON()).toEqual({ code: "unauthorized", status: 401, hostClass: "public" });
	});

	test("JSON.stringify leaks nothing", () => {
		const encoded = JSON.stringify(sensitive);
		expect(encoded).not.toContain(SECRET);
		expect(encoded).not.toContain("refresh_token");
		expect(encoded).not.toContain("cloud.example.dev");
	});

	test("own enumerable properties carry no secret material", () => {
		expect(Object.getOwnPropertyNames(sensitive)).not.toContain("token");
		expect(Object.getOwnPropertyNames(sensitive)).not.toContain("body");
		expect(Object.getOwnPropertyNames(sensitive)).not.toContain("host");
		for (const value of Object.values(sensitive)) {
			expect(JSON.stringify(value ?? null)).not.toContain(SECRET);
		}
	});

	// Regression: `Error.cause` is hidden from `Object.keys` but IS walked and printed by
	// inspect. `src/cli.ts` dumps `Bun.inspect(err)` to stderr on any unhandled CLI failure,
	// and a `fetch` TypeError embeds the full request URL in its message.
	describe("wrapped causes never reach an inspect/console path", () => {
		const wrapped = new AuraCloudError("unavailable", { status: 503, cause: new TypeError(CAUSE_MESSAGE) });

		test("Bun.inspect — the exact call `src/cli.ts` makes on an unhandled CLI error", () => {
			for (const colors of [false, true]) {
				const dumped = Bun.inspect(wrapped, { colors, depth: 10 });
				expect(dumped).not.toContain(SECRET);
				expect(dumped).not.toContain("access_token");
				expect(dumped).not.toContain("cloud.example.dev");
				expect(dumped).not.toContain("fetch failed");
			}
			// The redacted summary still survives, so the dump stays useful.
			expect(Bun.inspect(wrapped)).toContain("unavailable");
		});

		test("util.inspect at full depth, including hidden properties", () => {
			for (const options of [{ depth: 10 }, { depth: 10, showHidden: true }]) {
				const dumped = inspect(wrapped, options);
				expect(dumped).not.toContain(SECRET);
				expect(dumped).not.toContain("fetch failed");
			}
		});

		test("String(), stack and JSON paths", () => {
			for (const rendered of [String(wrapped), wrapped.stack ?? "", JSON.stringify(wrapped)]) {
				expect(rendered).not.toContain(SECRET);
				expect(rendered).not.toContain("fetch failed");
			}
		});

		test("the cause is still recoverable for deliberate debugging", () => {
			expect((auraCloudErrorCause(wrapped) as Error).message).toBe(CAUSE_MESSAGE);
		});
	});

	test("messages are derived from the code, so callers cannot inject detail", () => {
		// `message` is not part of the options contract; prove it is ignored, not interpolated.
		const err = new AuraCloudError("invalid_response", { message: `failed for ${SECRET}` } as any);
		expect(err.message).not.toContain(SECRET);
		expect(err.message).toBe(new AuraCloudError("invalid_response").message);
	});
});
