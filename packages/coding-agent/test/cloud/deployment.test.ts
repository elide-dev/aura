import { describe, expect, test } from "bun:test";
import * as cloud from "../../src/cloud";
import {
	type AuraDeployment,
	auraDeploymentFor,
	CLOUD_CONSUMER_SETTINGS,
	CLOUD_SWITCH_DEFAULTS,
	type CloudConsumer,
	readCloudSwitches,
	resolveAuraDeployment,
	resolveQaConfiguration,
	resolveServiceEndpoint,
} from "../../src/cloud/deployment";
import { type AuraCloudError, isAuraCloudError } from "../../src/cloud/errors";

/** A well-formed opt-in domain, used everywhere a valid `AURA_DOMAIN` is needed. */
const DOMAIN = "aura.example";

type Env = Record<string, string | undefined>;

function deploy(env: Env): AuraDeployment {
	return resolveAuraDeployment({ env });
}

/** Assert the call throws the closed-taxonomy configuration error, never a bare `Error`. */
function expectInvalidConfiguration(run: () => unknown): void {
	let thrown: unknown;
	try {
		run();
	} catch (error) {
		thrown = error;
	}
	expect(isAuraCloudError(thrown)).toBe(true);
	expect((thrown as AuraCloudError).code).toBe("invalid_configuration");
}

// ═══════════════════════════════════════════════════════════════════════════
// Domain derivation
// ═══════════════════════════════════════════════════════════════════════════

describe("AURA_DOMAIN is opt-in", () => {
	test("an empty environment derives nothing at all", () => {
		const d = deploy({});
		expect(d).toEqual({});
		// Spelled out so a future compiled-in default cannot pass silently.
		expect(d.domain).toBeUndefined();
		expect(d.authOrigin).toBeUndefined();
		expect(d.syncOrigin).toBeUndefined();
		expect(d.brokerBaseUrl).toBeUndefined();
		expect(d.gatewayBaseUrl).toBeUndefined();
		expect(d.telemetryBaseUrl).toBeUndefined();
		expect(d.qaEndpoint).toBeUndefined();
		expect(d.collabOrigin).toBeUndefined();
		expect(d.distribution).toBeUndefined();
	});

	test("an empty or whitespace-only AURA_DOMAIN is treated as unset, not as a host", () => {
		expect(deploy({ AURA_DOMAIN: "" })).toEqual({});
		expect(deploy({ AURA_DOMAIN: "   " })).toEqual({});
	});
});

describe("domain derivation table", () => {
	const d = deploy({ AURA_DOMAIN: DOMAIN });

	test("derives every surface exactly as the contract specifies", () => {
		expect(d.domain).toBe(DOMAIN);
		expect(d.authOrigin).toEqual({ url: `https://auth.${DOMAIN}`, source: "domain" });
		expect(d.syncOrigin).toEqual({ url: `https://sync.${DOMAIN}`, source: "domain" });
		expect(d.brokerBaseUrl).toEqual({ url: `https://api.${DOMAIN}/broker`, source: "domain" });
		expect(d.gatewayBaseUrl).toEqual({ url: `https://api.${DOMAIN}/gateway`, source: "domain" });
		expect(d.telemetryBaseUrl).toEqual({ url: `https://telemetry.${DOMAIN}`, source: "domain" });
		expect(d.qaEndpoint).toEqual({ url: `https://qa.${DOMAIN}/v1/grievances`, source: "domain" });
		expect(d.collabOrigin).toEqual({ url: `https://collab.${DOMAIN}`, source: "domain" });
	});

	test("derives the four distribution endpoints exactly as the contract specifies", () => {
		expect(d.distribution).toEqual({
			apiBaseUrl: { url: `https://api.${DOMAIN}/v1/distribution`, source: "domain" },
			downloadBaseUrl: { url: `https://downloads.${DOMAIN}`, source: "domain" },
			jwksUrl: { url: `https://api.${DOMAIN}/.well-known/distribution-jwks.json`, source: "domain" },
			catalogManifestUrl: { url: `https://api.${DOMAIN}/v1/distribution/catalog/manifest`, source: "domain" },
		});
	});

	test("every derived URL is https and carries no credentials, query or fragment", () => {
		for (const endpoint of [
			d.authOrigin,
			d.syncOrigin,
			d.brokerBaseUrl,
			d.gatewayBaseUrl,
			d.telemetryBaseUrl,
			d.qaEndpoint,
			d.collabOrigin,
			d.distribution?.apiBaseUrl,
			d.distribution?.downloadBaseUrl,
			d.distribution?.jwksUrl,
			d.distribution?.catalogManifestUrl,
		]) {
			const url = new URL((endpoint as { url: string }).url);
			expect(url.protocol).toBe("https:");
			expect(url.username).toBe("");
			expect(url.password).toBe("");
			expect(url.search).toBe("");
			expect(url.hash).toBe("");
			expect(url.hostname.endsWith(DOMAIN)).toBe(true);
		}
	});

	test("the exact test domain `localhost` derives without a dot requirement", () => {
		const local = deploy({ AURA_DOMAIN: "localhost" });
		expect(local.domain).toBe("localhost");
		expect(local.authOrigin?.url).toBe("https://auth.localhost");
	});
});

describe("AURA_DOMAIN validation rejects rather than normalizes", () => {
	const REJECTED = [
		"https://aura.example", // scheme
		"//aura.example",
		"aura.example/path", // path
		"aura.example\\evil", // backslash
		"aura.example:8443", // port
		"*.aura.example", // wildcard
		"user@aura.example", // userinfo
		"user:pw@aura.example",
		"aura.example?x=1", // query
		"aura.example#frag", // fragment
		"aura.example.", // trailing dot
		".aura.example", // leading dot
		"aura..example", // empty label
		" aura.example", // whitespace
		"aura.example ",
		"aura example",
		"aura.example\n",
		"AURA.example", // not already lowercase
		"aura.EXAMPLE",
		"aura_x.example", // underscore
		"-aura.example", // non-alphanumeric edge
		"aura-.example",
		"aura.example-",
		"localhost1", // no dot and not exactly `localhost`
		"single",
		"aurå.example", // non-ASCII
		"xn--", // degenerate punycode label edges
		`${"a".repeat(64)}.example`, // label > 63
		`${`${"a".repeat(60)}.`.repeat(5)}example`, // derived host > 253
	];

	for (const value of REJECTED) {
		test(`rejects ${JSON.stringify(value)}`, () => {
			expectInvalidConfiguration(() => deploy({ AURA_DOMAIN: value }));
		});
	}

	test("accepts the DNS bounds it is supposed to accept", () => {
		const label63 = "a".repeat(63);
		expect(deploy({ AURA_DOMAIN: `${label63}.example` }).domain).toBe(`${label63}.example`);
		expect(deploy({ AURA_DOMAIN: "a.b" }).domain).toBe("a.b");
		expect(deploy({ AURA_DOMAIN: "a-b.c-d.example" }).domain).toBe("a-b.c-d.example");
		expect(deploy({ AURA_DOMAIN: "1.2.example" }).domain).toBe("1.2.example");
	});

	test("an invalid domain is an error, never a fall-through to no domain", () => {
		// The dangerous failure mode is a silently empty deployment: the caller would
		// then take the legacy/offline path with the operator believing Aura is on.
		expectInvalidConfiguration(() => deploy({ AURA_DOMAIN: "https://aura.example" }));
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Environment overrides
// ═══════════════════════════════════════════════════════════════════════════

describe("exact Aura override variables", () => {
	test("each override replaces exactly its own surface and nothing else", () => {
		const cases: ReadonlyArray<readonly [string, string, (d: AuraDeployment) => string | undefined]> = [
			["AURA_AUTH_URL", "https://id.corp.example", d => d.authOrigin?.url],
			["AURA_SYNC_URL", "https://state.corp.example", d => d.syncOrigin?.url],
			["AURA_BROKER_URL", "https://edge.corp.example/b", d => d.brokerBaseUrl?.url],
			["AURA_GATEWAY_URL", "https://edge.corp.example/g", d => d.gatewayBaseUrl?.url],
			["AURA_TELEMETRY_URL", "https://otlp.corp.example/otlp", d => d.telemetryBaseUrl?.url],
			["AURA_QA_URL", "https://qa.corp.example/v1/grievances", d => d.qaEndpoint?.url],
			["AURA_COLLAB_ORIGIN", "https://rooms.corp.example", d => d.collabOrigin?.url],
			["AURA_DIST_API_URL", "https://dist.corp.example/v1", d => d.distribution?.apiBaseUrl.url],
			["AURA_DIST_DOWNLOAD_URL", "https://dl.corp.example", d => d.distribution?.downloadBaseUrl.url],
			["AURA_DIST_JWKS_URL", "https://dist.corp.example/keys.json", d => d.distribution?.jwksUrl.url],
			[
				"AURA_CATALOG_MANIFEST_URL",
				"https://dist.corp.example/catalog",
				d => d.distribution?.catalogManifestUrl.url,
			],
		];

		for (const [name, value, read] of cases) {
			const withOverride = deploy({ AURA_DOMAIN: DOMAIN, [name]: value });
			const plain = deploy({ AURA_DOMAIN: DOMAIN });
			expect(read(withOverride)).toBe(value);

			// Only this surface moved; everything else still reads from the domain.
			for (const [otherName, , readOther] of cases) {
				if (otherName === name) continue;
				expect(readOther(withOverride)).toBe(readOther(plain));
			}
		}
	});

	test("an override is marked `aura_env`, a derivation `domain`", () => {
		const d = deploy({ AURA_DOMAIN: DOMAIN, AURA_AUTH_URL: "https://id.corp.example" });
		expect(d.authOrigin).toEqual({ url: "https://id.corp.example", source: "aura_env" });
		expect(d.syncOrigin?.source).toBe("domain");
	});

	test("overrides work with no domain at all", () => {
		const d = deploy({ AURA_AUTH_URL: "https://id.corp.example", AURA_BROKER_URL: "https://edge.corp.example/b" });
		expect(d.domain).toBeUndefined();
		expect(d.authOrigin).toEqual({ url: "https://id.corp.example", source: "aura_env" });
		expect(d.brokerBaseUrl).toEqual({ url: "https://edge.corp.example/b", source: "aura_env" });
		expect(d.syncOrigin).toBeUndefined();
		expect(d.distribution).toBeUndefined();
	});

	test("a partial distribution override set without a domain is an error, not a half-built object", () => {
		expectInvalidConfiguration(() => deploy({ AURA_DIST_DOWNLOAD_URL: "https://dl.corp.example" }));
	});

	test("a complete distribution override set without a domain resolves", () => {
		const d = deploy({
			AURA_DIST_API_URL: "https://dist.corp.example/v1",
			AURA_DIST_DOWNLOAD_URL: "https://dl.corp.example",
			AURA_DIST_JWKS_URL: "https://dist.corp.example/keys.json",
			AURA_CATALOG_MANIFEST_URL: "https://dist.corp.example/catalog",
		});
		expect(d.distribution?.apiBaseUrl.source).toBe("aura_env");
		expect(d.distribution?.catalogManifestUrl.url).toBe("https://dist.corp.example/catalog");
	});
});

describe("override URL validation", () => {
	test("normalizes trailing slashes only", () => {
		expect(deploy({ AURA_AUTH_URL: "https://id.corp.example/" }).authOrigin?.url).toBe("https://id.corp.example");
		expect(deploy({ AURA_BROKER_URL: "https://edge.corp.example/b///" }).brokerBaseUrl?.url).toBe(
			"https://edge.corp.example/b",
		);
		// The host, port and path are otherwise preserved byte for byte.
		expect(deploy({ AURA_BROKER_URL: "https://Edge.CORP.example:8443/B/r" }).brokerBaseUrl?.url).toBe(
			"https://edge.corp.example:8443/B/r",
		);
	});

	test("auth, sync and collab overrides are origins: a path is rejected", () => {
		for (const name of ["AURA_AUTH_URL", "AURA_SYNC_URL", "AURA_COLLAB_ORIGIN"]) {
			expectInvalidConfiguration(() => deploy({ [name]: "https://host.corp.example/nested" }));
			// A bare `/` is the empty path, not a path.
			const bare = deploy({ [name]: "https://host.corp.example/" });
			const resolved = bare.authOrigin ?? bare.syncOrigin ?? bare.collabOrigin;
			expect(resolved?.url).toBe("https://host.corp.example");
		}
	});

	test("broker, gateway, telemetry, QA and distribution overrides accept a base path", () => {
		expect(deploy({ AURA_BROKER_URL: "https://h.corp.example/x/y" }).brokerBaseUrl?.url).toBe(
			"https://h.corp.example/x/y",
		);
		expect(deploy({ AURA_GATEWAY_URL: "https://h.corp.example/x/y" }).gatewayBaseUrl?.url).toBe(
			"https://h.corp.example/x/y",
		);
		expect(deploy({ AURA_TELEMETRY_URL: "https://h.corp.example/otlp" }).telemetryBaseUrl?.url).toBe(
			"https://h.corp.example/otlp",
		);
		expect(deploy({ AURA_QA_URL: "https://h.corp.example/v1/grievances" }).qaEndpoint?.url).toBe(
			"https://h.corp.example/v1/grievances",
		);
	});

	test("dot and dot-dot path segments are rejected", () => {
		for (const path of ["/a/../b", "/./a", "/a/..", "/a//b"]) {
			expectInvalidConfiguration(() => deploy({ AURA_BROKER_URL: `https://h.corp.example${path}` }));
		}
	});

	test("non-HTTPS is rejected off loopback", () => {
		for (const name of ["AURA_AUTH_URL", "AURA_SYNC_URL", "AURA_BROKER_URL", "AURA_TELEMETRY_URL", "AURA_QA_URL"]) {
			expectInvalidConfiguration(() => deploy({ [name]: "http://host.corp.example" }));
		}
		expectInvalidConfiguration(() => deploy({ AURA_AUTH_URL: "ftp://host.corp.example" }));
		expectInvalidConfiguration(() => deploy({ AURA_AUTH_URL: "file:///etc/passwd" }));
		expectInvalidConfiguration(() => deploy({ AURA_AUTH_URL: "javascript:alert(1)" }));
		// `wss:` is a collab-only scheme.
		expectInvalidConfiguration(() => deploy({ AURA_AUTH_URL: "wss://host.corp.example" }));
	});

	test("collab accepts wss and, on loopback, ws", () => {
		expect(deploy({ AURA_COLLAB_ORIGIN: "wss://rooms.corp.example" }).collabOrigin?.url).toBe(
			"wss://rooms.corp.example",
		);
		expect(deploy({ AURA_COLLAB_ORIGIN: "ws://localhost:7475" }).collabOrigin?.url).toBe("ws://localhost:7475");
		expectInvalidConfiguration(() => deploy({ AURA_COLLAB_ORIGIN: "ws://rooms.corp.example" }));
	});

	// The exemption exists because loopback traffic never reaches a network, so it is scoped to
	// exactly the hosts that cannot leave the machine — the same membership `classifyHost` and
	// `auth.ts` use, via the one shared `isLoopbackHostname`.
	test("loopback hosts may use plain HTTP", () => {
		for (const host of ["localhost", "api.localhost", "127.0.0.1", "127.0.0.2", "[::1]", "0.0.0.0"]) {
			expect(deploy({ AURA_AUTH_URL: `http://${host}:8787` }).authOrigin?.url).toBe(`http://${host}:8787`);
		}
		// Near-misses are not loopback: they must still be HTTPS.
		for (const host of ["localhost.corp.example", "my-localhost", "[::2]", "128.0.0.1", "10.0.0.1"]) {
			expectInvalidConfiguration(() => deploy({ AURA_AUTH_URL: `http://${host}:8787` }));
		}
	});

	test("credentials, query, fragment, encoded separators and control characters are rejected", () => {
		for (const value of [
			"https://user:pw@host.corp.example",
			"https://user@host.corp.example",
			"https://host.corp.example?token=abc",
			"https://host.corp.example/#frag",
			"https://host.corp.example/a%2Fb",
			"https://host.corp.example/a%2fb",
			"https://host.corp.example/a%5Cb",
			"https://host.corp.example/a%00b",
			"https://host.corp.example/a%2e%2e/b",
			"https://host.corp.example/a\tb",
			"https://host.corp.example/a\nb",
			"https://host.corp.example/a b",
			"https://host.corp.example\\evil.example",
			"https://*.corp.example",
			"https://host.corp.example./x",
			"not a url",
			"https://",
		]) {
			expectInvalidConfiguration(() => deploy({ AURA_BROKER_URL: value }));
		}
	});

	test("an over-long override URL is rejected", () => {
		expectInvalidConfiguration(() => deploy({ AURA_BROKER_URL: `https://h.corp.example/${"a".repeat(4096)}` }));
	});

	test("surrounding whitespace on an override is trimmed, interior whitespace is rejected", () => {
		expect(deploy({ AURA_AUTH_URL: "  https://id.corp.example\n" }).authOrigin?.url).toBe("https://id.corp.example");
		expectInvalidConfiguration(() => deploy({ AURA_AUTH_URL: "https://id.corp .example" }));
	});

	test("an invalid override never falls through to the domain derivation", () => {
		expectInvalidConfiguration(() => deploy({ AURA_DOMAIN: DOMAIN, AURA_AUTH_URL: "http://evil.example" }));
	});

	test("errors carry no URL material", () => {
		let thrown: AuraCloudError | undefined;
		try {
			deploy({ AURA_BROKER_URL: "https://user:sk-live-SECRET@host.corp.example?token=sk-live-SECRET" });
		} catch (error) {
			thrown = error as AuraCloudError;
		}
		expect(thrown?.code).toBe("invalid_configuration");
		for (const rendered of [thrown?.message ?? "", String(thrown), JSON.stringify(thrown)]) {
			expect(rendered).not.toContain("sk-live-SECRET");
			expect(rendered).not.toContain("host.corp.example");
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Precedence
// ═══════════════════════════════════════════════════════════════════════════

describe("service endpoint precedence", () => {
	const d = deploy({ AURA_DOMAIN: DOMAIN, AURA_AUTH_URL: "https://id.corp.example" });

	test("per-call beats everything", () => {
		expect(
			resolveServiceEndpoint("auth", {
				deployment: d,
				perCallUrl: "https://call.example",
				persistedUrl: "https://setting.example",
				legacyUrl: "https://legacy.example",
			}),
		).toEqual({ url: "https://call.example", source: "call" });
	});

	test("persisted beats the Aura tiers and legacy", () => {
		expect(
			resolveServiceEndpoint("auth", {
				deployment: d,
				persistedUrl: "https://setting.example",
				legacyUrl: "https://legacy.example",
			}),
		).toEqual({ url: "https://setting.example", source: "setting" });
	});

	test("the exact Aura override beats the domain and legacy", () => {
		expect(resolveServiceEndpoint("auth", { deployment: d, legacyUrl: "https://legacy.example" })).toEqual({
			url: "https://id.corp.example",
			source: "aura_env",
		});
	});

	test("the domain beats legacy", () => {
		expect(resolveServiceEndpoint("broker", { deployment: d, legacyUrl: "https://legacy.example" })).toEqual({
			url: `https://api.${DOMAIN}/broker`,
			source: "domain",
		});
	});

	test("legacy is the last configured tier", () => {
		expect(resolveServiceEndpoint("broker", { deployment: {}, legacyUrl: "https://legacy.example" })).toEqual({
			url: "https://legacy.example",
			source: "legacy_env",
		});
	});

	test("nothing configured resolves to undefined rather than a compiled-in host", () => {
		for (const surface of ["auth", "sync", "broker", "gateway", "telemetry", "qa", "collab"] as const) {
			expect(resolveServiceEndpoint(surface, { deployment: {} })).toBeUndefined();
		}
	});

	test("empty and whitespace-only explicit values do not occupy a tier", () => {
		expect(resolveServiceEndpoint("auth", { deployment: d, perCallUrl: "", persistedUrl: "   " })).toEqual({
			url: "https://id.corp.example",
			source: "aura_env",
		});
	});

	test("each surface reads its own deployment field", () => {
		const full = deploy({ AURA_DOMAIN: DOMAIN });
		expect(resolveServiceEndpoint("sync", { deployment: full })?.url).toBe(`https://sync.${DOMAIN}`);
		expect(resolveServiceEndpoint("gateway", { deployment: full })?.url).toBe(`https://api.${DOMAIN}/gateway`);
		expect(resolveServiceEndpoint("telemetry", { deployment: full })?.url).toBe(`https://telemetry.${DOMAIN}`);
		expect(resolveServiceEndpoint("collab", { deployment: full })?.url).toBe(`https://collab.${DOMAIN}`);
	});

	test("explicit tiers keep their existing semantics and are not held to Aura URL rules", () => {
		// `collab.relayUrl` is a `wss://` value; `OMP_AUTH_BROKER_URL` may be plain HTTP on
		// an operator's own network. Aura's strict rules govern Aura's own tiers only.
		expect(resolveServiceEndpoint("collab", { deployment: {}, persistedUrl: "wss://relay.example.com" })).toEqual({
			url: "wss://relay.example.com",
			source: "setting",
		});
		expect(resolveServiceEndpoint("broker", { deployment: {}, legacyUrl: "http://broker.internal:9000" })).toEqual({
			url: "http://broker.internal:9000",
			source: "legacy_env",
		});
	});

	test("QA orders the legacy alias above the setting and the domain", () => {
		const domainOnly = deploy({ AURA_DOMAIN: DOMAIN });
		expect(
			resolveServiceEndpoint("qa", {
				deployment: domainOnly,
				persistedUrl: "https://setting.example/g",
				legacyUrl: "https://legacy.example/g",
			}),
		).toEqual({ url: "https://legacy.example/g", source: "legacy_env" });

		expect(
			resolveServiceEndpoint("qa", { deployment: domainOnly, persistedUrl: "https://setting.example/g" }),
		).toEqual({ url: "https://setting.example/g", source: "setting" });

		expect(resolveServiceEndpoint("qa", { deployment: domainOnly })).toEqual({
			url: `https://qa.${DOMAIN}/v1/grievances`,
			source: "domain",
		});

		// The exact Aura variable still outranks the legacy alias.
		const auraQa = deploy({ AURA_DOMAIN: DOMAIN, AURA_QA_URL: "https://qa.corp.example/g" });
		expect(
			resolveServiceEndpoint("qa", {
				deployment: auraQa,
				persistedUrl: "https://setting.example/g",
				legacyUrl: "https://qa.corp.example/g",
			}),
		).toEqual({ url: "https://qa.corp.example/g", source: "aura_env" });
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// QA canonical / legacy agreement
// ═══════════════════════════════════════════════════════════════════════════

describe("QA canonical and legacy variables", () => {
	const QA = "https://qa.corp.example/v1/grievances";

	test("the canonical Aura URL wins when the legacy alias is absent", () => {
		const env = { AURA_QA_URL: QA };
		const config = resolveQaConfiguration({ deployment: deploy(env), env });
		expect(config.endpoint).toEqual({ url: QA, source: "aura_env" });
	});

	test("byte-equal canonical and legacy values are accepted once", () => {
		const env = { AURA_QA_URL: QA, PI_AUTO_QA_PUSH_URL: QA, AURA_QA_TOKEN: "t", PI_AUTO_QA_PUSH_TOKEN: "t" };
		const config = resolveQaConfiguration({ deployment: deploy(env), env });
		expect(config.endpoint).toEqual({ url: QA, source: "aura_env" });
		expect(config.token).toEqual({ value: "t", source: "aura_env" });
	});

	test("a disagreeing URL fails before anything can be sent", () => {
		const env = { AURA_QA_URL: QA, PI_AUTO_QA_PUSH_URL: "https://other.corp.example/v1/grievances" };
		expectInvalidConfiguration(() => resolveQaConfiguration({ deployment: deploy(env), env }));
	});

	test("a disagreeing token fails before anything can be sent", () => {
		const env = { AURA_QA_URL: QA, AURA_QA_TOKEN: "canonical", PI_AUTO_QA_PUSH_TOKEN: "legacy" };
		expectInvalidConfiguration(() => resolveQaConfiguration({ deployment: deploy(env), env }));
	});

	test("a QA disagreement does not poison the rest of the deployment", () => {
		// Resolving the deployment is a whole-process operation; a QA-only conflict must
		// not take auth, sync or distribution down with it.
		const env = { AURA_DOMAIN: DOMAIN, AURA_QA_URL: QA, PI_AUTO_QA_PUSH_URL: "https://other.corp.example/g" };
		expect(deploy(env).authOrigin?.url).toBe(`https://auth.${DOMAIN}`);
	});

	test("token order is Aura, then legacy, then setting", () => {
		const both = { AURA_QA_TOKEN: "a", PI_AUTO_QA_PUSH_TOKEN: "a" };
		expect(resolveQaConfiguration({ deployment: {}, env: both, settingToken: "s" }).token).toEqual({
			value: "a",
			source: "aura_env",
		});
		expect(
			resolveQaConfiguration({ deployment: {}, env: { PI_AUTO_QA_PUSH_TOKEN: "l" }, settingToken: "s" }).token,
		).toEqual({ value: "l", source: "legacy_env" });
		expect(resolveQaConfiguration({ deployment: {}, env: {}, settingToken: "s" }).token).toEqual({
			value: "s",
			source: "setting",
		});
		expect(resolveQaConfiguration({ deployment: {}, env: {} }).token).toBeUndefined();
	});

	test("no QA tier is configured means no endpoint at all", () => {
		expect(resolveQaConfiguration({ deployment: {}, env: {} }).endpoint).toBeUndefined();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Cloud switches
// ═══════════════════════════════════════════════════════════════════════════

/** Which deployment field each consumer is entitled to read. */
const CONSUMER_FIELD: Readonly<Record<CloudConsumer, keyof AuraDeployment>> = {
	account: "authOrigin",
	settingsSync: "syncOrigin",
	broker: "brokerBaseUrl",
	gateway: "gatewayBaseUrl",
	telemetry: "telemetryBaseUrl",
	qa: "qaEndpoint",
	collab: "collabOrigin",
	share: "collabOrigin",
	distribution: "distribution",
	runtimeMirror: "distribution",
	catalogMirror: "distribution",
	stats: "statsIngestBaseUrl",
};

/** Consumers that resolve through {@link resolveServiceEndpoint}; the mirrors do not. */
const SURFACE_FOR_CONSUMER: Readonly<
	Partial<Record<CloudConsumer, "auth" | "sync" | "broker" | "gateway" | "telemetry" | "qa" | "collab" | "stats">>
> = {
	account: "auth",
	settingsSync: "sync",
	broker: "broker",
	gateway: "gateway",
	telemetry: "telemetry",
	qa: "qa",
	collab: "collab",
	share: "collab",
	stats: "stats",
};

const ALL_CONSUMERS = Object.keys(CONSUMER_FIELD) as CloudConsumer[];
const ALL_ON: Record<CloudConsumer, boolean> = Object.fromEntries(ALL_CONSUMERS.map(c => [c, true])) as never;

describe("cloud switches", () => {
	test("pins the switch setting names and defaults", () => {
		expect(CLOUD_CONSUMER_SETTINGS).toEqual({
			account: "cloud.account.enabled",
			broker: "cloud.broker.enabled",
			gateway: "cloud.gateway.enabled",
			settingsSync: "cloud.settingsSync.enabled",
			telemetry: "cloud.telemetry.enabled",
			qa: "cloud.qa.enabled",
			collab: "cloud.collab.enabled",
			share: "cloud.share.enabled",
			distribution: "cloud.distribution.enabled",
			runtimeMirror: "cloud.runtimeMirror.enabled",
			catalogMirror: "cloud.catalogMirror.enabled",
			stats: "cloud.stats.enabled",
		});
		expect(CLOUD_SWITCH_DEFAULTS).toEqual({
			account: true,
			broker: true,
			gateway: false,
			settingsSync: false,
			telemetry: false,
			qa: true,
			collab: true,
			share: true,
			distribution: true,
			runtimeMirror: true,
			catalogMirror: true,
			stats: false,
		});
	});

	test("readCloudSwitches reads every switch through the settings paths", () => {
		const seen: string[] = [];
		const values: Record<string, boolean> = { "cloud.qa.enabled": false, "cloud.gateway.enabled": true };
		const switches = readCloudSwitches({
			get: (path: string) => {
				seen.push(path);
				return values[path];
			},
		} as never);
		expect(new Set(seen)).toEqual(new Set(Object.values(CLOUD_CONSUMER_SETTINGS)));
		expect(switches.qa).toBe(false);
		expect(switches.gateway).toBe(true);
		expect(switches.account).toBe(true); // absent value falls back to the schema default
	});

	test("an omitted switch falls back to its documented default", () => {
		const d = deploy({ AURA_DOMAIN: DOMAIN });
		expect(auraDeploymentFor("account", d).authOrigin).toBeDefined();
		expect(auraDeploymentFor("broker", d).brokerBaseUrl).toBeDefined();
		expect(auraDeploymentFor("gateway", d).gatewayBaseUrl).toBeUndefined();
		expect(auraDeploymentFor("settingsSync", d).syncOrigin).toBeUndefined();
		expect(auraDeploymentFor("telemetry", d).telemetryBaseUrl).toBeUndefined();
	});

	test("an enabled consumer sees exactly its own field and no others", () => {
		const d = deploy({ AURA_DOMAIN: DOMAIN });
		for (const consumer of ALL_CONSUMERS) {
			const view = auraDeploymentFor(consumer, d, ALL_ON);
			const field = CONSUMER_FIELD[consumer];
			expect(view[field]).toBeDefined();
			for (const other of [
				"authOrigin",
				"syncOrigin",
				"brokerBaseUrl",
				"gatewayBaseUrl",
				"telemetryBaseUrl",
				"qaEndpoint",
				"collabOrigin",
				"distribution",
			] as const) {
				if (other === field) continue;
				expect(view[other]).toBeUndefined();
			}
		}
	});

	describe.each(ALL_CONSUMERS)("cloud.%s.enabled=false", consumer => {
		const off = { ...ALL_ON, [consumer]: false };

		test("removes the Aura override tier", () => {
			const d = deploy({
				AURA_AUTH_URL: "https://id.corp.example",
				AURA_SYNC_URL: "https://state.corp.example",
				AURA_BROKER_URL: "https://edge.corp.example/b",
				AURA_GATEWAY_URL: "https://edge.corp.example/g",
				AURA_TELEMETRY_URL: "https://otlp.corp.example",
				AURA_QA_URL: "https://qa.corp.example/g",
				AURA_COLLAB_ORIGIN: "https://rooms.corp.example",
				AURA_DIST_API_URL: "https://dist.corp.example/v1",
				AURA_DIST_DOWNLOAD_URL: "https://dl.corp.example",
				AURA_DIST_JWKS_URL: "https://dist.corp.example/keys.json",
				AURA_CATALOG_MANIFEST_URL: "https://dist.corp.example/catalog",
			});
			expect(auraDeploymentFor(consumer, d, off)[CONSUMER_FIELD[consumer]]).toBeUndefined();
		});

		test("removes the domain tier", () => {
			const d = deploy({ AURA_DOMAIN: DOMAIN });
			expect(auraDeploymentFor(consumer, d, off)[CONSUMER_FIELD[consumer]]).toBeUndefined();
		});

		test("leaves every other consumer's Aura tiers alone", () => {
			const d = deploy({ AURA_DOMAIN: DOMAIN });
			for (const other of ALL_CONSUMERS) {
				if (other === consumer) continue;
				// Consumers that share a field are the collab/share and distribution pairs;
				// each keeps its own view because the switch is applied per consumer.
				expect(auraDeploymentFor(other, d, off)[CONSUMER_FIELD[other]]).toBeDefined();
			}
		});

		// The explicit tiers are only meaningful for consumers that resolve through
		// `resolveServiceEndpoint`. The three distribution mirrors do not, so they are excluded
		// by construction rather than by an early `return` that would count as a passing test
		// while asserting nothing.
		const surface = SURFACE_FOR_CONSUMER[consumer];
		if (surface) {
			test("preserves a per-call explicit endpoint", () => {
				const d = auraDeploymentFor(consumer, deploy({ AURA_DOMAIN: DOMAIN }), off);
				expect(resolveServiceEndpoint(surface, { deployment: d, perCallUrl: "https://call.example" })).toEqual({
					url: "https://call.example",
					source: "call",
				});
			});

			test("preserves a persisted explicit endpoint", () => {
				const d = auraDeploymentFor(consumer, deploy({ AURA_DOMAIN: DOMAIN }), off);
				expect(resolveServiceEndpoint(surface, { deployment: d, persistedUrl: "https://setting.example" })).toEqual(
					{ url: "https://setting.example", source: "setting" },
				);
			});

			test("preserves the legacy tier", () => {
				const d = auraDeploymentFor(consumer, deploy({ AURA_DOMAIN: DOMAIN }), off);
				expect(resolveServiceEndpoint(surface, { deployment: d, legacyUrl: "https://legacy.example" })).toEqual({
					url: "https://legacy.example",
					source: "legacy_env",
				});
			});
		} else {
			// And the exclusion itself is asserted, so a mirror that later grows a
			// `resolveServiceEndpoint` surface fails here instead of silently losing coverage.
			test("has no resolveServiceEndpoint surface, so the explicit tiers do not apply", () => {
				expect({ consumer, surface: SURFACE_FOR_CONSUMER[consumer] }).toEqual({ consumer, surface: undefined });
				expect(auraDeploymentFor(consumer, deploy({ AURA_DOMAIN: DOMAIN }), off).distribution).toBeUndefined();
			});
		}
	});

	test("cloud.qa.enabled=false with a domain and no explicit URL leaves nothing to send to", () => {
		const env = { AURA_DOMAIN: DOMAIN };
		const gated = auraDeploymentFor("qa", deploy(env), { ...ALL_ON, qa: false });
		expect(resolveQaConfiguration({ deployment: gated, env }).endpoint).toBeUndefined();
	});

	test("cloud.qa.enabled=false keeps the legacy and setting tiers operator-controlled", () => {
		const env = { AURA_DOMAIN: DOMAIN, PI_AUTO_QA_PUSH_URL: "https://legacy.example/g", PI_AUTO_QA_PUSH_TOKEN: "l" };
		const gated = auraDeploymentFor("qa", deploy(env), { ...ALL_ON, qa: false });
		const config = resolveQaConfiguration({ deployment: gated, env, settingUrl: "https://setting.example/g" });
		expect(config.endpoint).toEqual({ url: "https://legacy.example/g", source: "legacy_env" });
		expect(config.token).toEqual({ value: "l", source: "legacy_env" });

		const settingOnly = resolveQaConfiguration({
			deployment: auraDeploymentFor("qa", deploy({ AURA_DOMAIN: DOMAIN }), { ...ALL_ON, qa: false }),
			env: {},
			settingUrl: "https://setting.example/g",
		});
		expect(settingOnly.endpoint).toEqual({ url: "https://setting.example/g", source: "setting" });
	});

	test("collab and share are independently switchable off the one collab origin", () => {
		const d = deploy({ AURA_DOMAIN: DOMAIN });
		expect(auraDeploymentFor("collab", d, { ...ALL_ON, collab: false }).collabOrigin).toBeUndefined();
		expect(auraDeploymentFor("share", d, { ...ALL_ON, collab: false }).collabOrigin).toBeDefined();
		expect(auraDeploymentFor("share", d, { ...ALL_ON, share: false }).collabOrigin).toBeUndefined();
		expect(auraDeploymentFor("collab", d, { ...ALL_ON, share: false }).collabOrigin).toBeDefined();
	});

	test("distribution, runtime mirror and catalog mirror are independently switchable", () => {
		const d = deploy({ AURA_DOMAIN: DOMAIN });
		for (const consumer of ["distribution", "runtimeMirror", "catalogMirror"] as const) {
			const off = { ...ALL_ON, [consumer]: false };
			expect(auraDeploymentFor(consumer, d, off).distribution).toBeUndefined();
			for (const other of ["distribution", "runtimeMirror", "catalogMirror"] as const) {
				if (other === consumer) continue;
				expect(auraDeploymentFor(other, d, off).distribution).toBeDefined();
			}
		}
	});
});

describe("switch table agrees with the settings schema", () => {
	// `CLOUD_SWITCH_DEFAULTS` is a hand-kept mirror so `src/cloud` stays free of the 6k-line
	// schema module. Nothing else would notice the two drifting apart.
	test("every switch exists in the schema with the same default", async () => {
		const { SETTINGS_SCHEMA } = await import("../../src/config/settings-schema");
		for (const consumer of ALL_CONSUMERS) {
			const path = CLOUD_CONSUMER_SETTINGS[consumer];
			const def = (SETTINGS_SCHEMA as Record<string, { type: string; default: unknown } | undefined>)[path];
			expect({ path, def: def && { type: def.type, default: def.default } }).toEqual({
				path,
				def: { type: "boolean", default: CLOUD_SWITCH_DEFAULTS[consumer] },
			});
		}
	});

	test("the schema declares no other `cloud.*` settings", async () => {
		const { SETTINGS_SCHEMA } = await import("../../src/config/settings-schema");
		const declared = Object.keys(SETTINGS_SCHEMA).filter(path => path.startsWith("cloud."));
		expect(new Set(declared)).toEqual(new Set(Object.values(CLOUD_CONSUMER_SETTINGS)));
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Barrel
// ═══════════════════════════════════════════════════════════════════════════

describe("cloud barrel", () => {
	test("re-exports the deployment API", () => {
		expect(cloud.resolveAuraDeployment).toBe(resolveAuraDeployment);
		expect(cloud.resolveServiceEndpoint).toBe(resolveServiceEndpoint);
		expect(cloud.auraDeploymentFor).toBe(auraDeploymentFor);
	});

	test("exposes no generic arbitrary-host URL builder", () => {
		for (const name of Object.keys(cloud)) {
			expect(/^(build|make|create).*Url$/i.test(name)).toBe(false);
		}
	});
});
