import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isAuraCloudError } from "../../src/cloud/errors";
import {
	AURA_AUTH_AUDIENCE,
	AURA_JWKS_PATH,
	AURA_METADATA_PATH,
	AuraAuthKeys,
	type AuraKeyResolver,
	type AuraPrincipalContract,
	cliUserContract,
	importedApiKeyContract,
	TokenManager,
	verifyAuraToken,
} from "../../src/cloud/token-manager";
import {
	AURA_SURFACE_SCOPES,
	type AuraAccountIdentity,
	type AuraImportReceipt,
	AuraTokenStore,
} from "../../src/cloud/token-store";
import {
	AUTH_ORIGIN,
	apiKeyClaims,
	FakeAuthServer,
	FOREIGN_ORIGIN,
	fakeClock,
	generateSigningKey,
	jsonResponse,
	jwksFor,
	mintToken,
	mintTokenWithForeignSignature,
	NINE_SCOPES,
	type SigningKey,
	ulid,
	userClaims,
} from "./aura-auth-fixture";

const METADATA_URL = `${AUTH_ORIGIN}${AURA_METADATA_PATH}`;
const JWKS_URL = `${AUTH_ORIGIN}${AURA_JWKS_PATH}`;
const TOKEN_URL = `${AUTH_ORIGIN}/token`;
const SERVICE_ORIGIN = "https://sync.example.dev";

const DEVICE = ulid("DEVCE1");
const USER = ulid("USER1");
const ORG = ulid("ORG1");
const ACCOUNT = ulid("ACCT1");
const REALM = ulid("REALM1");
const API_KEY_ID = ulid("KEY1");

const T0 = 1_760_000_000_000;

let key: SigningKey;
let otherKey: SigningKey;
let tempRoot = "";
let dbPath = "";
let store: AuraTokenStore;

function identity(overrides: Partial<AuraAccountIdentity> = {}): AuraAccountIdentity {
	return {
		issuer: AUTH_ORIGIN,
		deviceId: DEVICE,
		userId: USER,
		orgId: ORG,
		accountId: ACCOUNT,
		realmId: REALM,
		roles: ["member"],
		scopes: AURA_SURFACE_SCOPES,
		...overrides,
	} as AuraAccountIdentity;
}

/** A resolver over a fixed key set, so verifier tests do not depend on JWKS transport. */
function staticKeys(...keys: SigningKey[]): AuraKeyResolver & { calls: number } {
	const imported = new Map<string, Promise<CryptoKey>>();
	const resolver = {
		calls: 0,
		async resolve(kid: string): Promise<CryptoKey | undefined> {
			resolver.calls += 1;
			const match = keys.find(candidate => candidate.kid === kid);
			if (!match) return undefined;
			let existing = imported.get(kid);
			if (!existing) {
				const { kty, crv, x } = match.publicJwk as { kty: string; crv: string; x: string };
				existing = crypto.subtle.importKey("jwk", { kty, crv, x }, { name: "Ed25519" }, false, ["verify"]);
				imported.set(kid, existing);
			}
			return await existing;
		},
	};
	return resolver;
}

function userContract(overrides: Partial<AuraPrincipalContract> = {}): AuraPrincipalContract {
	return {
		...cliUserContract({
			issuer: AUTH_ORIGIN,
			device: { mode: "exact", deviceId: DEVICE },
			identity: { userId: USER, orgId: ORG, accountId: ACCOUNT, realmId: REALM, roles: ["member"] },
		}),
		...overrides,
	};
}

const RECEIPT: AuraImportReceipt = {
	issuer: AUTH_ORIGIN,
	userId: USER,
	apiKeyId: API_KEY_ID,
	tokenPrefix: "aura_k1_",
	tokenSha256: "0".repeat(64),
	surface: "broker",
	scopes: ["credential:manage", "model:invoke"],
	deadlineAtMs: T0 + 86_400_000,
	realmId: REALM,
	orgId: ORG,
	accountId: ACCOUNT,
	createdAtMs: T0,
};

async function expectCloudError(promise: Promise<unknown>, code: string): Promise<void> {
	let thrown: unknown;
	try {
		await promise;
	} catch (error) {
		thrown = error;
	}
	if (!isAuraCloudError(thrown)) {
		throw new Error(`expected AuraCloudError(${code}), got ${String(thrown)}`);
	}
	expect(thrown.code).toBe(code as never);
}

beforeEach(async () => {
	key = await generateSigningKey("kid-1");
	otherKey = await generateSigningKey("kid-2");
	tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aura-token-manager-"));
	dbPath = path.join(tempRoot, "agent", "agent.db");
	await fs.mkdir(path.dirname(dbPath), { recursive: true });
	store = await AuraTokenStore.open(dbPath);
});

afterEach(async () => {
	store.close();
	await fs.rm(tempRoot, { recursive: true, force: true });
});

// ===========================================================================
// The one shared verifier
// ===========================================================================

describe("shared token verifier — cryptography and standard claims", () => {
	test("accepts a well-formed cli_user token and reports its verified principal", async () => {
		const token = await mintToken(key, userClaims({ ...ids(), nowMs: T0 }));
		const verified = await verifyAuraToken(token, userContract(), { keys: staticKeys(key), nowMs: T0 });
		expect(verified.principalType).toBe("user");
		expect(verified.subject).toBe(USER);
		expect(verified.orgId).toBe(ORG);
		expect(verified.accountId).toBe(ACCOUNT);
		expect(verified.realmId).toBe(REALM);
		expect(verified.deviceId).toBe(DEVICE);
		expect([...verified.scopes]).toEqual([...NINE_SCOPES]);
		expect(verified.expiresAtMs).toBe(T0 + 600_000);
		expect(verified.token).toBe(token);
	});

	test("the audience is pinned to elide-cloud", () => {
		expect(AURA_AUTH_AUDIENCE).toBe("elide-cloud");
	});

	const structural: [string, () => Promise<string>][] = [
		[
			"two segments",
			async () => (await mintToken(key, userClaims({ ...ids(), nowMs: T0 }))).split(".").slice(0, 2).join("."),
		],
		["four segments", async () => `${await mintToken(key, userClaims({ ...ids(), nowMs: T0 }))}.extra`],
		["empty string", async () => ""],
		[
			"non-base64url header",
			async () => `!!!.${(await mintToken(key, userClaims({ ...ids(), nowMs: T0 }))).split(".").slice(1).join(".")}`,
		],
		[
			"payload that is not JSON",
			async () => {
				const token = await mintToken(key, userClaims({ ...ids(), nowMs: T0 }));
				const [header, , signature] = token.split(".");
				return `${header}.bm90LWpzb24.${signature}`;
			},
		],
		[
			"payload that is a JSON array",
			async () => {
				const token = await mintToken(key, [] as unknown as Record<string, unknown>);
				return token;
			},
		],
	];

	for (const [label, build] of structural) {
		test(`rejects ${label}`, async () => {
			await expectCloudError(
				verifyAuraToken(await build(), userContract(), { keys: staticKeys(key), nowMs: T0 }),
				"invalid_response",
			);
		});
	}

	const headerCases: [string, Record<string, unknown>][] = [
		["alg none", { alg: "none" }],
		["alg HS256", { alg: "HS256" }],
		["alg RS256", { alg: "RS256" }],
		["typ missing", { typ: undefined }],
		["typ not JWT", { typ: "at+jwt" }],
		["kid missing", { kid: undefined }],
		["kid empty", { kid: "" }],
		["kid not a string", { kid: 7 }],
	];

	for (const [label, overrides] of headerCases) {
		test(`rejects header with ${label}`, async () => {
			const token = await mintToken(key, userClaims({ ...ids(), nowMs: T0 }), overrides);
			await expectCloudError(
				verifyAuraToken(token, userContract(), { keys: staticKeys(key), nowMs: T0 }),
				"invalid_response",
			);
		});
	}

	test("rejects a signature made over different bytes", async () => {
		const token = await mintTokenWithForeignSignature(key, userClaims({ ...ids(), nowMs: T0 }));
		await expectCloudError(
			verifyAuraToken(token, userContract(), { keys: staticKeys(key), nowMs: T0 }),
			"invalid_response",
		);
	});

	test("rejects a token signed by a key that is not the one named in kid", async () => {
		const token = await mintToken(otherKey, userClaims({ ...ids(), nowMs: T0 }), { kid: key.kid });
		await expectCloudError(
			verifyAuraToken(token, userContract(), { keys: staticKeys(key, otherKey), nowMs: T0 }),
			"invalid_response",
		);
	});

	test("an unknown kid is retried against a refreshed key set exactly once, then rejected", async () => {
		const token = await mintToken(otherKey, userClaims({ ...ids(), nowMs: T0 }));
		const seen: boolean[] = [];
		const keys: AuraKeyResolver = {
			async resolve(_kid, options) {
				seen.push(options?.forceRefresh === true);
				return undefined;
			},
		};
		await expectCloudError(verifyAuraToken(token, userContract(), { keys, nowMs: T0 }), "invalid_response");
		expect(seen).toEqual([false, true]);
	});

	test("a kid that only appears after a refresh verifies", async () => {
		const token = await mintToken(otherKey, userClaims({ ...ids(), nowMs: T0 }));
		const stale = staticKeys(key);
		const fresh = staticKeys(key, otherKey);
		const keys: AuraKeyResolver = {
			resolve: (kid, options) => (options?.forceRefresh ? fresh.resolve(kid) : stale.resolve(kid)),
		};
		const verified = await verifyAuraToken(token, userContract(), { keys, nowMs: T0 });
		expect(verified.subject).toBe(USER);
	});

	const claimCases: [string, Record<string, unknown>][] = [
		["a foreign issuer", { iss: "https://auth.evil.example" }],
		["an issuer with a trailing slash", { iss: `${AUTH_ORIGIN}/` }],
		["a missing issuer", { iss: undefined }],
		["a foreign audience", { aud: "other-cloud" }],
		["a missing audience", { aud: undefined }],
		["an array audience", { aud: ["elide-cloud"] }],
		["a non-ULID subject", { sub: "user-1" }],
		["a missing subject", { sub: undefined }],
		["a missing jti", { jti: undefined }],
		["a non-string jti", { jti: 42 }],
		["a missing iat", { iat: undefined }],
		["a missing exp", { exp: undefined }],
		["a string exp", { exp: String(Math.floor(T0 / 1000) + 600) }],
	];

	for (const [label, overrides] of claimCases) {
		test(`rejects ${label}`, async () => {
			const token = await mintToken(key, userClaims({ ...ids(), nowMs: T0 }, overrides));
			await expectCloudError(
				verifyAuraToken(token, userContract(), { keys: staticKeys(key), nowMs: T0 }),
				"invalid_response",
			);
		});
	}

	test("tolerates 30 seconds of clock skew in both directions but no more", async () => {
		const iat = Math.floor(T0 / 1000);
		const token = await mintToken(key, userClaims({ ...ids(), nowMs: T0 }));
		// Local clock 29s behind the issuer: still acceptable.
		await verifyAuraToken(token, userContract(), { keys: staticKeys(key), nowMs: T0 - 29_000 });
		await expectCloudError(
			verifyAuraToken(token, userContract(), { keys: staticKeys(key), nowMs: T0 - 31_000 }),
			"invalid_response",
		);
		// Expired 29s ago: acceptable. Expired 31s ago: not.
		const expiry = (iat + 600) * 1000;
		await verifyAuraToken(token, userContract(), { keys: staticKeys(key), nowMs: expiry + 29_000 });
		await expectCloudError(
			verifyAuraToken(token, userContract(), { keys: staticKeys(key), nowMs: expiry + 31_000 }),
			"invalid_response",
		);
	});

	test("caps the access token lifetime at 900 seconds", async () => {
		const ok = await mintToken(key, userClaims({ ...ids(), nowMs: T0, lifetimeSec: 900 }));
		await verifyAuraToken(ok, userContract(), { keys: staticKeys(key), nowMs: T0 });
		const tooLong = await mintToken(key, userClaims({ ...ids(), nowMs: T0, lifetimeSec: 901 }));
		await expectCloudError(
			verifyAuraToken(tooLong, userContract(), { keys: staticKeys(key), nowMs: T0 }),
			"invalid_response",
		);
	});
});

describe("shared token verifier — cli_user principal contract", () => {
	const cases: [string, Record<string, unknown>][] = [
		["principal_type api_key substituted for a user", { principal_type: "api_key" }],
		["principal_type missing", { principal_type: undefined }],
		["a different org", { org_id: ulid("ORG9") }],
		["a different account", { account_id: ulid("ACCT9") }],
		["a different realm", { realm_id: ulid("REALM9") }],
		["a non-ULID org", { org_id: "org-1" }],
		["extra roles", { roles: ["member", "admin"] }],
		["missing roles", { roles: undefined }],
		["roles that are not an array", { roles: "member" }],
		["a missing device", { device: undefined }],
		["a non-ULID device", { device: "device-1" }],
		["a different device", { device: ulid("DEVCE9") }],
		["eight scopes", { scopes: NINE_SCOPES.slice(1) }],
		["ten scopes", { scopes: [...NINE_SCOPES, "admin:all"] }],
		["nine scopes with one substituted", { scopes: [...NINE_SCOPES.slice(1), "admin:all"] }],
		["nine entries with a duplicate", { scopes: [...NINE_SCOPES.slice(1), NINE_SCOPES[1]] }],
		["scopes as a space-delimited string", { scopes: NINE_SCOPES.join(" ") }],
	];

	for (const [label, overrides] of cases) {
		test(`rejects ${label}`, async () => {
			const token = await mintToken(key, userClaims({ ...ids(), nowMs: T0 }, overrides));
			await expectCloudError(
				verifyAuraToken(token, userContract(), { keys: staticKeys(key), nowMs: T0 }),
				"invalid_response",
			);
		});
	}

	test("accepts the nine scopes in any order", async () => {
		const shuffled = [...NINE_SCOPES].reverse();
		const token = await mintToken(key, userClaims({ ...ids(), nowMs: T0 }, { scopes: shuffled }));
		const verified = await verifyAuraToken(token, userContract(), { keys: staticKeys(key), nowMs: T0 });
		expect([...verified.scopes].sort()).toEqual([...NINE_SCOPES].sort());
	});

	test("at login the device is only required to be a ULID, and is then learned", async () => {
		const fresh = ulid("DEVCE7");
		const token = await mintToken(key, userClaims({ ...ids(), deviceId: fresh, nowMs: T0 }));
		const contract = cliUserContract({ issuer: AUTH_ORIGIN, device: { mode: "require" } });
		const verified = await verifyAuraToken(token, contract, { keys: staticKeys(key), nowMs: T0 });
		expect(verified.deviceId).toBe(fresh);
		// Still a ULID requirement, not "anything goes".
		const bad = await mintToken(key, userClaims({ ...ids(), nowMs: T0 }, { device: "laptop" }));
		await expectCloudError(verifyAuraToken(bad, contract, { keys: staticKeys(key), nowMs: T0 }), "invalid_response");
	});

	test("a login contract can still pin an explicitly selected org", async () => {
		const contract = cliUserContract({
			issuer: AUTH_ORIGIN,
			device: { mode: "require" },
			identity: { orgId: ORG },
		});
		const good = await mintToken(key, userClaims({ ...ids(), nowMs: T0 }));
		expect((await verifyAuraToken(good, contract, { keys: staticKeys(key), nowMs: T0 })).orgId).toBe(ORG);
		const wrong = await mintToken(key, userClaims({ ...ids(), orgId: ulid("ORG9"), nowMs: T0 }));
		await expectCloudError(
			verifyAuraToken(wrong, contract, { keys: staticKeys(key), nowMs: T0 }),
			"invalid_response",
		);
	});
});

describe("shared token verifier — imported_api_key principal contract", () => {
	function apiKeyToken(overrides: Record<string, unknown> = {}): Promise<string> {
		return mintToken(
			key,
			apiKeyClaims(
				{
					apiKeyId: API_KEY_ID,
					orgId: ORG,
					accountId: ACCOUNT,
					realmId: REALM,
					scopes: RECEIPT.scopes,
					nowMs: T0,
				},
				overrides,
			),
		);
	}

	const contract = () => importedApiKeyContract({ issuer: AUTH_ORIGIN, receipt: RECEIPT });

	test("accepts a token that matches the receipt exactly", async () => {
		const verified = await verifyAuraToken(await apiKeyToken(), contract(), { keys: staticKeys(key), nowMs: T0 });
		expect(verified.principalType).toBe("api_key");
		expect(verified.subject).toBe(API_KEY_ID);
		expect(verified.deviceId).toBeUndefined();
		expect([...verified.roles]).toEqual([]);
		expect([...verified.scopes].sort()).toEqual([...RECEIPT.scopes].sort());
	});

	const cases: [string, Record<string, unknown>][] = [
		["a subject that is not the receipt's api key id", { sub: ulid("KEY9") }],
		["a user principal substituted for an api key", { principal_type: "user" }],
		["a different realm", { realm_id: ulid("REALM9") }],
		["a different org", { org_id: ulid("ORG9") }],
		["a different account", { account_id: ulid("ACCT9") }],
		["non-empty roles", { roles: ["member"] }],
		["a device binding", { device: DEVICE }],
		["a scope the receipt's surface does not carry", { scopes: [...RECEIPT.scopes, "sync:write"] }],
		["fewer scopes than the receipt's surface", { scopes: [RECEIPT.scopes[0]] }],
		["the nine user scopes", { scopes: [...NINE_SCOPES] }],
		["a foreign issuer", { iss: "https://auth.evil.example" }],
		["a foreign audience", { aud: "other-cloud" }],
	];

	for (const [label, overrides] of cases) {
		test(`rejects ${label}`, async () => {
			await expectCloudError(
				verifyAuraToken(await apiKeyToken(overrides), contract(), { keys: staticKeys(key), nowMs: T0 }),
				"invalid_response",
			);
		});
	}

	test("a valid user token never satisfies the api key contract", async () => {
		const token = await mintToken(key, userClaims({ ...ids(), nowMs: T0 }));
		await expectCloudError(
			verifyAuraToken(token, contract(), { keys: staticKeys(key), nowMs: T0 }),
			"invalid_response",
		);
	});

	test("a valid api key token never satisfies the cli_user contract", async () => {
		await expectCloudError(
			verifyAuraToken(await apiKeyToken(), userContract(), { keys: staticKeys(key), nowMs: T0 }),
			"invalid_response",
		);
	});
});

function ids() {
	return { userId: USER, orgId: ORG, accountId: ACCOUNT, realmId: REALM, deviceId: DEVICE };
}

// ===========================================================================
// Metadata + JWKS
// ===========================================================================

interface KeysHarness {
	readonly server: FakeAuthServer;
	readonly clock: ReturnType<typeof fakeClock>;
	readonly keys: AuraAuthKeys;
}

function keysHarness(options: { metadata?: unknown; jwks?: unknown } = {}): KeysHarness {
	const server = new FakeAuthServer();
	const clock = fakeClock(T0);
	server.route(METADATA_URL, () =>
		jsonResponse(options.metadata ?? { issuer: AUTH_ORIGIN, jwks_uri: JWKS_URL, token_endpoint: TOKEN_URL }),
	);
	server.route(JWKS_URL, () => jsonResponse(options.jwks ?? jwksFor(key)));
	const keys = new AuraAuthKeys({ authOrigin: AUTH_ORIGIN, fetch: server.fetch, now: clock.now });
	return { server, clock, keys };
}

describe("auth metadata and JWKS", () => {
	test("reads standard metadata and the same-origin JWKS with manual redirects", async () => {
		const { server, keys } = keysHarness();
		expect(await keys.resolve(key.kid)).toBeDefined();
		expect(server.requests.map(r => `${r.method} ${r.url}`)).toEqual([`GET ${METADATA_URL}`, `GET ${JWKS_URL}`]);
		for (const request of server.requests) {
			expect(request.redirect).toBe("manual");
			expect(request.headers.authorization).toBeUndefined();
			expect(request.headers.accept).toBe("application/json");
		}
	});

	test("the metadata and JWKS paths are the standard ones", () => {
		expect(AURA_METADATA_PATH).toBe("/.well-known/oauth-authorization-server");
		expect(AURA_JWKS_PATH).toBe("/.well-known/jwks.json");
	});

	test("caches a successful fetch for 300 seconds and refetches after", async () => {
		const { server, clock, keys } = keysHarness();
		await keys.resolve(key.kid);
		clock.advance(299_000);
		await keys.resolve(key.kid);
		expect(server.requests.length).toBe(2);
		clock.advance(2_000);
		await keys.resolve(key.kid);
		expect(server.countFor(JWKS_URL)).toBe(2);
		expect(server.countFor(METADATA_URL)).toBe(2);
	});

	test("an unknown kid forces exactly one JWKS refresh", async () => {
		const { server, keys } = keysHarness();
		await keys.resolve(key.kid);
		expect(server.countFor(JWKS_URL)).toBe(1);
		expect(await keys.resolve("kid-unknown", { forceRefresh: true })).toBeUndefined();
		expect(server.countFor(JWKS_URL)).toBe(2);
	});

	test("a failed forced refresh keeps the previously cached keys usable", async () => {
		const { server, keys } = keysHarness();
		expect(await keys.resolve(key.kid)).toBeDefined();
		server.route(METADATA_URL, () => jsonResponse({ error: "boom" }, 500));
		await expectCloudError(keys.resolve(key.kid, { forceRefresh: true }), "invalid_response");
		// The good key set survives the blip: verification keeps working without a new fetch.
		expect(await keys.resolve(key.kid)).toBeDefined();
		expect(server.countFor(JWKS_URL)).toBe(1);
		expect(server.countFor(METADATA_URL)).toBe(2);
	});

	test("a forced refresh never joins a load that started before it was asked for", async () => {
		const { server, keys } = keysHarness();
		let release: (() => void) | undefined;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		let jwksCalls = 0;
		server.route(JWKS_URL, async () => {
			jwksCalls += 1;
			if (jwksCalls === 1) {
				// The pre-rotation key set, still in flight when the forced refresh is requested.
				await gate;
				return jsonResponse(jwksFor(key));
			}
			return jsonResponse(jwksFor(key, otherKey));
		});
		const pending = keys.resolve(key.kid);
		const forced = keys.resolve(otherKey.kid, { forceRefresh: true });
		release?.();
		expect(await pending).toBeDefined();
		// Joining the in-flight load would have returned undefined and burned the one retry.
		expect(await forced).toBeDefined();
		expect(server.countFor(JWKS_URL)).toBe(2);
	});

	test("rejects metadata whose issuer is not the configured auth origin", async () => {
		const { server, keys } = keysHarness({ metadata: { issuer: "https://auth.evil.example", jwks_uri: JWKS_URL } });
		await expectCloudError(keys.resolve(key.kid), "invalid_response");
		expect(server.countFor(JWKS_URL)).toBe(0);
	});

	test("rejects a jwks_uri that is not the same-origin well-known path", async () => {
		for (const jwksUri of [
			`${FOREIGN_ORIGIN}/.well-known/jwks.json`,
			`${AUTH_ORIGIN}/keys`,
			`${AUTH_ORIGIN}/.well-known/jwks.json?x=1`,
			`http://auth.example.dev/.well-known/jwks.json`,
			undefined,
		]) {
			const { server, keys } = keysHarness({ metadata: { issuer: AUTH_ORIGIN, jwks_uri: jwksUri } });
			await expectCloudError(keys.resolve(key.kid), "invalid_response");
			expect(server.countFor(JWKS_URL)).toBe(0);
		}
	});

	test("ignores endpoints advertised by metadata — routes are fixed same-origin", async () => {
		const { keys } = keysHarness({
			metadata: {
				issuer: AUTH_ORIGIN,
				jwks_uri: JWKS_URL,
				token_endpoint: `${FOREIGN_ORIGIN}/token`,
				device_authorization_endpoint: `${FOREIGN_ORIGIN}/device/authorize`,
			},
		});
		expect(await keys.resolve(key.kid)).toBeDefined();
	});

	test("rejects a JWKS with no usable Ed25519 key for the kid", async () => {
		const { keys } = keysHarness({ jwks: { keys: [{ kty: "RSA", kid: key.kid, n: "abc", e: "AQAB" }] } });
		expect(await keys.resolve(key.kid)).toBeUndefined();
	});

	test("caps metadata and JWKS documents at 64 KiB", async () => {
		const huge = { issuer: AUTH_ORIGIN, jwks_uri: JWKS_URL, padding: "x".repeat(70_000) };
		await expectCloudError(keysHarness({ metadata: huge }).keys.resolve(key.kid), "payload_too_large");
		const hugeJwks = { keys: [key.publicJwk], padding: "x".repeat(70_000) };
		await expectCloudError(keysHarness({ jwks: hugeJwks }).keys.resolve(key.kid), "payload_too_large");
	});

	for (const status of [301, 302, 307, 308]) {
		for (const [label, receiver] of [
			["same-origin", `${AUTH_ORIGIN}/elsewhere`],
			["cross-origin", `${FOREIGN_ORIGIN}/elsewhere`],
		] as const) {
			test(`maps a ${status} on metadata to a ${label} receiver to invalid_response`, async () => {
				const { server, keys } = keysHarness();
				let received = 0;
				server.route(METADATA_URL, () => server.redirectResponse(status, receiver));
				server.route(receiver, () => {
					received += 1;
					return jsonResponse({ issuer: AUTH_ORIGIN, jwks_uri: JWKS_URL });
				});
				await expectCloudError(keys.resolve(key.kid), "invalid_response");
				expect(received).toBe(0);
				expect(server.countFor(receiver)).toBe(0);
				expect(server.canceledBodies).toBe(1);
			});

			test(`maps a ${status} on JWKS to a ${label} receiver to invalid_response`, async () => {
				const { server, keys } = keysHarness();
				let received = 0;
				server.route(JWKS_URL, () => server.redirectResponse(status, receiver));
				server.route(receiver, () => {
					received += 1;
					return jsonResponse(jwksFor(key));
				});
				await expectCloudError(keys.resolve(key.kid), "invalid_response");
				expect(received).toBe(0);
				expect(server.countFor(receiver)).toBe(0);
				expect(server.canceledBodies).toBe(1);
			});
		}
	}
});

// ===========================================================================
// TokenManager
// ===========================================================================

interface ManagerHarness {
	readonly server: FakeAuthServer;
	readonly clock: ReturnType<typeof fakeClock>;
	readonly manager: TokenManager;
	readonly issued: string[];
	readonly submitted: string[];
	rotate: boolean;
}

async function seedLogin(target: AuraTokenStore, refreshToken: string, id = identity()): Promise<void> {
	target.saveLogin({ identity: id, refreshToken });
}

function managerHarness(
	options: { store?: AuraTokenStore; clock?: ReturnType<typeof fakeClock>; lifetimeSec?: number } = {},
): ManagerHarness {
	const server = new FakeAuthServer();
	const clock = options.clock ?? fakeClock(T0);
	const harness: ManagerHarness = {
		server,
		clock,
		issued: [],
		submitted: [],
		rotate: true,
		manager: undefined as unknown as TokenManager,
	};
	server.route(METADATA_URL, () => jsonResponse({ issuer: AUTH_ORIGIN, jwks_uri: JWKS_URL }));
	server.route(JWKS_URL, () => jsonResponse(jwksFor(key)));
	server.route(TOKEN_URL, async request => {
		const submitted = request.form?.get("refresh_token") ?? "";
		harness.submitted.push(submitted);
		const next = harness.rotate ? `refresh-${harness.submitted.length + 1}` : submitted;
		const access = await mintToken(
			key,
			userClaims({ ...ids(), nowMs: clock.now(), lifetimeSec: options.lifetimeSec ?? 600 }),
		);
		harness.issued.push(access);
		return jsonResponse({
			access_token: access,
			refresh_token: next,
			token_type: "Bearer",
			expires_in: options.lifetimeSec ?? 600,
		});
	});
	const manager = new TokenManager({
		authOrigin: AUTH_ORIGIN,
		store: options.store ?? store,
		fetch: server.fetch,
		now: clock.now,
		sleep: clock.sleep,
	});
	return Object.assign(harness, { manager });
}

describe("TokenManager access tokens", () => {
	test("refreshes with the exact grant, then caches until exp-60s", async () => {
		await seedLogin(store, "refresh-1");
		const h = managerHarness({ lifetimeSec: 200 });
		const first = await h.manager.getAccessToken();
		expect(first.identity.userId).toBe(USER);
		expect(first.expiresAtMs).toBe(T0 + 200_000);

		const request = h.server.requestsFor(TOKEN_URL)[0]!;
		expect(request.method).toBe("POST");
		expect(request.redirect).toBe("manual");
		expect(request.headers["content-type"]).toBe("application/x-www-form-urlencoded;charset=UTF-8");
		expect(request.headers.accept).toBe("application/json");
		expect(request.headers.authorization).toBeUndefined();
		const submittedForm: [string, string][] = [...(request.form ?? new URLSearchParams()).entries()];
		expect(submittedForm.sort()).toEqual(
			(
				[
					["client", "cli"],
					["grant_type", "refresh_token"],
					["refresh_token", "refresh-1"],
				] as [string, string][]
			).sort(),
		);

		// 139s left: reuse. 61s left: reuse. 59s left: refresh.
		h.clock.advance(61_000);
		expect((await h.manager.getAccessToken()).value).toBe(first.value);
		h.clock.advance(78_000);
		expect((await h.manager.getAccessToken()).value).toBe(first.value);
		expect(h.server.countFor(TOKEN_URL)).toBe(1);
		h.clock.advance(2_000);
		const second = await h.manager.getAccessToken();
		expect(second.value).not.toBe(first.value);
		expect(h.server.countFor(TOKEN_URL)).toBe(2);
	});

	test("forceRefresh bypasses a still-valid cached token", async () => {
		await seedLogin(store, "refresh-1");
		const h = managerHarness();
		const first = await h.manager.getAccessToken();
		const second = await h.manager.getAccessToken({ forceRefresh: true });
		expect(second.value).not.toBe(first.value);
		expect(h.server.countFor(TOKEN_URL)).toBe(2);
	});

	test("one hundred concurrent callers share a single refresh", async () => {
		await seedLogin(store, "refresh-1");
		const h = managerHarness();
		const results = await Promise.all(Array.from({ length: 100 }, () => h.manager.getAccessToken()));
		expect(h.server.countFor(TOKEN_URL)).toBe(1);
		expect(new Set(results.map(r => r.value)).size).toBe(1);
		expect(h.submitted).toEqual(["refresh-1"]);
	});

	test("persists the rotated refresh token before returning the access token", async () => {
		await seedLogin(store, "refresh-1");
		const h = managerHarness();
		const token = await h.manager.getAccessToken();
		// Observed at the instant the access token becomes visible to the caller: the rotation is
		// already committed, so a crash here can never lose the new grant.
		expect(store.readAuth(AUTH_ORIGIN)?.refreshToken).toBe("refresh-2");
		expect(token.value).toBeTruthy();
		expect(store.readAuth(AUTH_ORIGIN)?.identity.deviceId).toBe(DEVICE);
	});

	// The store-level test can only prove the store hands back the committed value. This is the
	// manager-level half, and it is deliberately stronger than "nothing is cached at
	// construction": `early` performs a real refresh *first*, so it has held a refresh token and
	// rotated it, and only then does another process rotate again. If any refresh value survived
	// on the manager object, `early`'s second refresh would resubmit the one it minted rather
	// than the one the other process committed.
	test("never refreshes from an object-cached refresh token", async () => {
		await seedLogin(store, "refresh-1");
		const clock = fakeClock(T0);
		const early = managerHarness({ clock });

		const otherStore = await AuraTokenStore.open(dbPath);
		try {
			const late = managerHarness({ store: otherStore, clock });
			// Share one fake auth server so both managers' submissions land in one ledger.
			const ledger: string[] = [];
			for (const h of [early, late]) {
				h.server.route(TOKEN_URL, async request => {
					const submitted = request.form?.get("refresh_token") ?? "";
					ledger.push(submitted);
					const next = `refresh-${ledger.length + 1}`;
					return jsonResponse({
						access_token: await mintToken(key, userClaims({ ...ids(), nowMs: clock.now() })),
						refresh_token: next,
						token_type: "Bearer",
						expires_in: 600,
					});
				});
			}
			// 1. This manager rotates refresh-1 -> refresh-2 itself, so it has just seen both.
			await early.manager.getAccessToken();
			expect(ledger).toEqual(["refresh-1"]);
			// 2. The other process rotates refresh-2 -> refresh-3 behind its back.
			await late.manager.getAccessToken();
			expect(ledger).toEqual(["refresh-1", "refresh-2"]);
			// 3. It must now submit refresh-3, not the refresh-2 it minted a moment ago.
			await early.manager.getAccessToken({ forceRefresh: true });
			expect(ledger).toEqual(["refresh-1", "refresh-2", "refresh-3"]);
			expect(new Set(ledger).size).toBe(3);
		} finally {
			otherStore.close();
		}
	});

	// A failure that provably minted no grant must not strand the login. The in-flight marker
	// exists to catch a crash between the server consuming a refresh token and the local commit;
	// a 429, a 5xx or a rejected redirect never reached that state.
	for (const [label, failure, code] of [
		["a 503", () => jsonResponse({ error: "server_error" }, 503), "unavailable"],
		["a 429", () => jsonResponse({ error: "slow_down" }, 429), "rate_limited"],
		[
			"a rejected redirect",
			(h: ManagerHarness) => h.server.redirectResponse(302, `${FOREIGN_ORIGIN}/x`),
			"invalid_response",
		],
	] as [string, (h: ManagerHarness) => Response, string][]) {
		test(`recovers from ${label}: the grant stays refreshable`, async () => {
			await seedLogin(store, "refresh-1");
			const h = managerHarness();
			let calls = 0;
			h.server.route(TOKEN_URL, async request => {
				calls += 1;
				h.submitted.push(request.form?.get("refresh_token") ?? "");
				if (calls === 1) return failure(h);
				return jsonResponse({
					access_token: await mintToken(key, userClaims({ ...ids(), nowMs: h.clock.now() })),
					refresh_token: "refresh-2",
					token_type: "Bearer",
					expires_in: 600,
				});
			});
			await expectCloudError(h.manager.getAccessToken(), code);
			expect(store.readAuth(AUTH_ORIGIN)?.refreshToken).toBe("refresh-1");
			// The very next attempt must reach the network again, not fail locally.
			const token = await h.manager.getAccessToken();
			expect(token.value).toBeTruthy();
			expect(h.submitted).toEqual(["refresh-1", "refresh-1"]);
			expect(store.readAuth(AUTH_ORIGIN)?.refreshToken).toBe("refresh-2");
		});
	}

	// The other half of the same rule: a 2xx that failed verification *may* have minted a grant,
	// so the marker is deliberately kept and the account requires a fresh login.
	test("a grant that fails verification is not retried, it requires a new login", async () => {
		await seedLogin(store, "refresh-1");
		const h = managerHarness();
		h.server.route(TOKEN_URL, async () =>
			jsonResponse({
				access_token: await mintToken(
					key,
					userClaims({ ...ids(), deviceId: ulid("DEVCE9"), nowMs: h.clock.now() }),
				),
				refresh_token: "refresh-2",
				expires_in: 600,
			}),
		);
		await expectCloudError(h.manager.getAccessToken(), "invalid_response");
		await expectCloudError(h.manager.getAccessToken(), "relogin_required");
		expect(h.server.countFor(TOKEN_URL)).toBe(1);
		expect(store.readAuth(AUTH_ORIGIN)?.refreshToken).toBe("refresh-1");
	});

	test("one caller's abort never cancels a refresh another caller is waiting on", async () => {
		await seedLogin(store, "refresh-1");
		const h = managerHarness();
		let release: (() => void) | undefined;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		h.server.route(TOKEN_URL, async request => {
			h.submitted.push(request.form?.get("refresh_token") ?? "");
			await gate;
			return jsonResponse({
				access_token: await mintToken(key, userClaims({ ...ids(), nowMs: h.clock.now() })),
				refresh_token: "refresh-2",
				token_type: "Bearer",
				expires_in: 600,
			});
		});
		const controller = new AbortController();
		const unsignalled = h.manager.getAccessToken();
		const signalled = h.manager.getAccessToken({ signal: controller.signal });
		controller.abort();
		await expectCloudError(signalled, "aborted");
		release?.();
		const token = await unsignalled;
		expect(token.value).toBeTruthy();
		expect(h.server.countFor(TOKEN_URL)).toBe(1);
		expect(store.readAuth(AUTH_ORIGIN)?.refreshToken).toBe("refresh-2");
	});

	test("the shared refresh is cancelled only once every joined caller has abandoned it", async () => {
		await seedLogin(store, "refresh-1");
		const h = managerHarness();
		const gate = new Promise<void>(() => {});
		h.server.route(TOKEN_URL, async () => {
			await gate;
			return jsonResponse({});
		});
		const first = new AbortController();
		const second = new AbortController();
		const a = h.manager.getAccessToken({ signal: first.signal });
		const b = h.manager.getAccessToken({ signal: second.signal });
		first.abort();
		await expectCloudError(a, "aborted");
		expect(h.server.requestsFor(TOKEN_URL)[0]!.signal?.aborted).toBe(false);
		second.abort();
		await expectCloudError(b, "aborted");
		expect(h.server.requestsFor(TOKEN_URL)[0]!.signal?.aborted).toBe(true);
	});

	test("requires a login when no auth row exists", async () => {
		const h = managerHarness();
		await expectCloudError(h.manager.getAccessToken(), "login_required");
		expect(h.server.countFor(TOKEN_URL)).toBe(0);
	});

	test("waits for another process holding the refresh lease, then refreshes with its result", async () => {
		await seedLogin(store, "refresh-1");
		const other = await AuraTokenStore.open(dbPath);
		try {
			const lease = other.acquireRefreshLease(AUTH_ORIGIN, "other-process");
			expect(lease.status).toBe("acquired");
			const clock = fakeClock(T0);
			const h = managerHarness({ clock });
			let released = false;
			const gatedSleep = async (ms: number, signal?: AbortSignal) => {
				await clock.sleep(ms, signal);
				if (!released) {
					released = true;
					// The other process finishes its rotation and drops the lease.
					if (lease.status === "acquired") {
						other.commitRefreshRotation({
							issuer: AUTH_ORIGIN,
							owner: "other-process",
							previousRefreshToken: lease.refreshToken,
							previousVersion: lease.version,
							nextRefreshToken: "refresh-from-other",
							deviceId: DEVICE,
						});
					}
					other.releaseRefreshLease(AUTH_ORIGIN, "other-process");
				}
			};
			const manager = new TokenManager({
				authOrigin: AUTH_ORIGIN,
				store,
				fetch: h.server.fetch,
				now: clock.now,
				sleep: gatedSleep,
			});
			await manager.getAccessToken();
			expect(h.submitted).toEqual(["refresh-from-other"]);
		} finally {
			other.close();
		}
	});

	test("refuses to replay a refresh token a crashed attempt already submitted", async () => {
		await seedLogin(store, "refresh-1");
		const ghost = await AuraTokenStore.open(dbPath);
		try {
			const lease = ghost.acquireRefreshLease(AUTH_ORIGIN, "ghost");
			expect(lease.status).toBe("acquired");
			ghost.markRefreshSubmitted(AUTH_ORIGIN, "ghost", "refresh-1");
			ghost.releaseRefreshLease(AUTH_ORIGIN, "ghost");
		} finally {
			ghost.close();
		}
		const h = managerHarness();
		await expectCloudError(h.manager.getAccessToken(), "relogin_required");
		expect(h.server.countFor(TOKEN_URL)).toBe(0);
	});

	test("an abort before the response clears the in-flight marker so a later refresh works", async () => {
		await seedLogin(store, "refresh-1");
		const h = managerHarness();
		const controller = new AbortController();
		h.server.route(TOKEN_URL, () => {
			controller.abort();
			throw new DOMException("aborted", "AbortError");
		});
		await expectCloudError(h.manager.getAccessToken({ signal: controller.signal }), "aborted");
		expect(store.readAuth(AUTH_ORIGIN)?.refreshToken).toBe("refresh-1");

		const healthy = managerHarness();
		const token = await healthy.manager.getAccessToken();
		expect(token.value).toBeTruthy();
		expect(healthy.submitted).toEqual(["refresh-1"]);
	});

	test("an already-aborted signal never reaches the network", async () => {
		await seedLogin(store, "refresh-1");
		const h = managerHarness();
		await expectCloudError(h.manager.getAccessToken({ signal: AbortSignal.abort() }), "aborted");
		expect(h.server.countFor(TOKEN_URL)).toBe(0);
	});

	test("maps invalid_grant to a required re-login and keeps no stale access token", async () => {
		await seedLogin(store, "refresh-1");
		const h = managerHarness();
		h.server.route(TOKEN_URL, () => jsonResponse({ error: "invalid_grant" }, 400));
		await expectCloudError(h.manager.getAccessToken(), "relogin_required");
	});

	test("caps the token response at 64 KiB", async () => {
		await seedLogin(store, "refresh-1");
		const h = managerHarness();
		h.server.route(TOKEN_URL, () => jsonResponse({ access_token: "x".repeat(70_000) }));
		await expectCloudError(h.manager.getAccessToken(), "payload_too_large");
	});

	test("rejects an api_key principal offered to the user token provider", async () => {
		await seedLogin(store, "refresh-1");
		const h = managerHarness();
		h.server.route(TOKEN_URL, async () =>
			jsonResponse({
				access_token: await mintToken(
					key,
					apiKeyClaims({
						apiKeyId: API_KEY_ID,
						orgId: ORG,
						accountId: ACCOUNT,
						realmId: REALM,
						scopes: RECEIPT.scopes,
						nowMs: h.clock.now(),
					}),
				),
				refresh_token: "refresh-2",
				expires_in: 600,
			}),
		);
		await expectCloudError(h.manager.getAccessToken(), "invalid_response");
		// The rotation must not have been committed on an unverifiable grant.
		expect(store.readAuth(AUTH_ORIGIN)?.refreshToken).toBe("refresh-1");
	});

	test("rejects a refreshed token bound to a different device and keeps the stored grant", async () => {
		await seedLogin(store, "refresh-1");
		const h = managerHarness();
		h.server.route(TOKEN_URL, async () =>
			jsonResponse({
				access_token: await mintToken(
					key,
					userClaims({ ...ids(), deviceId: ulid("DEVCE9"), nowMs: h.clock.now() }),
				),
				refresh_token: "refresh-2",
				expires_in: 600,
			}),
		);
		await expectCloudError(h.manager.getAccessToken(), "invalid_response");
		expect(store.readAuth(AUTH_ORIGIN)?.refreshToken).toBe("refresh-1");
	});

	test("releases the refresh lease on every outcome", async () => {
		await seedLogin(store, "refresh-1");
		const h = managerHarness();
		await h.manager.getAccessToken();
		const acquired = store.acquireRefreshLease(AUTH_ORIGIN, "someone-else");
		expect(acquired.status).toBe("acquired");
	});

	for (const status of [301, 302, 307, 308]) {
		for (const [label, receiver] of [
			["same-origin", `${AUTH_ORIGIN}/token2`],
			["cross-origin", `${FOREIGN_ORIGIN}/token`],
		] as const) {
			test(`maps a ${status} on the token endpoint to a ${label} receiver to invalid_response`, async () => {
				await seedLogin(store, "refresh-1");
				const h = managerHarness();
				let received = 0;
				h.server.route(TOKEN_URL, () => h.server.redirectResponse(status, receiver));
				h.server.route(receiver, request => {
					received += 1;
					expect(request.body).toBeUndefined();
					return jsonResponse({});
				});
				await expectCloudError(h.manager.getAccessToken(), "invalid_response");
				expect(received).toBe(0);
				expect(h.server.countFor(receiver)).toBe(0);
				expect(h.server.canceledBodies).toBe(1);
				expect(store.readAuth(AUTH_ORIGIN)?.refreshToken).toBe("refresh-1");
			});
		}
	}
});

// ===========================================================================
// authorizedFetch
// ===========================================================================

describe("authorizedFetch", () => {
	async function harness(): Promise<ManagerHarness> {
		await seedLogin(store, "refresh-1");
		return managerHarness();
	}

	test("attaches the user bearer only to the explicitly eligible exact origin", async () => {
		const h = await harness();
		const target = `${SERVICE_ORIGIN}/v1/settings`;
		h.server.route(target, () => jsonResponse({ ok: true }));
		await h.manager.authorizedFetch(target, { eligibleOrigin: SERVICE_ORIGIN });
		const request = h.server.requestsFor(target)[0]!;
		expect(request.headers.authorization).toBe(`Bearer ${h.issued[0]}`);
		expect(request.redirect).toBe("manual");
	});

	test("sends anonymously to any origin that is not the eligible one", async () => {
		const h = await harness();
		for (const target of [
			`https://sync.example.dev.evil.test/v1`,
			`https://other.example.dev/v1`,
			`http://sync.example.dev/v1`,
			`https://sync.example.dev:8443/v1`,
		]) {
			h.server.route(target, () => jsonResponse({ ok: true }));
			await h.manager.authorizedFetch(target, { eligibleOrigin: SERVICE_ORIGIN });
			expect(h.server.requestsFor(target)[0]!.headers.authorization).toBeUndefined();
		}
		expect(h.server.countFor(TOKEN_URL)).toBe(0);
	});

	test("sends anonymously when no eligible origin is declared", async () => {
		const h = await harness();
		const target = `${SERVICE_ORIGIN}/v1/settings`;
		h.server.route(target, () => jsonResponse({ ok: true }));
		await h.manager.authorizedFetch(target);
		expect(h.server.requestsFor(target)[0]!.headers.authorization).toBeUndefined();
		expect(h.server.countFor(TOKEN_URL)).toBe(0);
	});

	for (const status of [301, 302, 307, 308]) {
		for (const [label, receiver] of [
			["same-origin", `${SERVICE_ORIGIN}/moved`],
			["cross-origin", `${FOREIGN_ORIGIN}/moved`],
		] as const) {
			test(`rejects a ${status} to a ${label} receiver without forwarding anything`, async () => {
				const h = await harness();
				const target = `${SERVICE_ORIGIN}/v1/settings`;
				let received = 0;
				h.server.route(target, () => h.server.redirectResponse(status, receiver));
				h.server.route(receiver, () => {
					received += 1;
					return jsonResponse({});
				});
				await expectCloudError(
					h.manager.authorizedFetch(target, {
						method: "POST",
						body: "payload",
						eligibleOrigin: SERVICE_ORIGIN,
					}),
					"invalid_response",
				);
				expect(received).toBe(0);
				expect(h.server.countFor(receiver)).toBe(0);
				expect(h.server.canceledBodies).toBe(1);
			});
		}
	}

	test("retries a replayable request exactly once on 401, with a forced refresh", async () => {
		const h = await harness();
		const target = `${SERVICE_ORIGIN}/v1/settings`;
		let calls = 0;
		h.server.route(target, () => {
			calls += 1;
			return calls === 1 ? jsonResponse({ error: "expired" }, 401) : jsonResponse({ ok: true });
		});
		const response = await h.manager.authorizedFetch(target, {
			method: "POST",
			body: "payload",
			eligibleOrigin: SERVICE_ORIGIN,
		});
		expect(response.status).toBe(200);
		expect(calls).toBe(2);
		expect(h.server.countFor(TOKEN_URL)).toBe(2);
		const [first, second] = h.server.requestsFor(target);
		expect(first!.headers.authorization).toBe(`Bearer ${h.issued[0]}`);
		expect(second!.headers.authorization).toBe(`Bearer ${h.issued[1]}`);
		expect(second!.body).toBe("payload");
	});

	test("does not retry a second 401", async () => {
		const h = await harness();
		const target = `${SERVICE_ORIGIN}/v1/settings`;
		h.server.route(target, () => jsonResponse({ error: "expired" }, 401));
		const response = await h.manager.authorizedFetch(target, { eligibleOrigin: SERVICE_ORIGIN });
		expect(response.status).toBe(401);
		expect(h.server.countFor(target)).toBe(2);
	});

	test("never refreshes or retries on 403", async () => {
		const h = await harness();
		const target = `${SERVICE_ORIGIN}/v1/settings`;
		h.server.route(target, () => jsonResponse({ error: "forbidden" }, 403));
		const response = await h.manager.authorizedFetch(target, { eligibleOrigin: SERVICE_ORIGIN });
		expect(response.status).toBe(403);
		expect(h.server.countFor(target)).toBe(1);
		expect(h.server.countFor(TOKEN_URL)).toBe(1);
	});

	test("never retries a request whose body cannot be replayed", async () => {
		const h = await harness();
		const target = `${SERVICE_ORIGIN}/v1/upload`;
		h.server.route(target, () => jsonResponse({ error: "expired" }, 401));
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1]));
				controller.close();
			},
		});
		const response = await h.manager.authorizedFetch(target, {
			method: "POST",
			body,
			eligibleOrigin: SERVICE_ORIGIN,
		});
		expect(response.status).toBe(401);
		expect(h.server.countFor(target)).toBe(1);
	});

	test("a 401 from an anonymous request never triggers a refresh", async () => {
		const h = await harness();
		const target = `${FOREIGN_ORIGIN}/v1/thing`;
		h.server.route(target, () => jsonResponse({ error: "nope" }, 401));
		const response = await h.manager.authorizedFetch(target, { eligibleOrigin: SERVICE_ORIGIN });
		expect(response.status).toBe(401);
		expect(h.server.countFor(target)).toBe(1);
		expect(h.server.countFor(TOKEN_URL)).toBe(0);
	});
});

// ===========================================================================
// Imported API keys
// ===========================================================================

describe("imported API key tokens", () => {
	async function apiKeyHarness() {
		await seedLogin(store, "refresh-1");
		const h = managerHarness();
		h.server.route(TOKEN_URL, async request => {
			if (request.form?.get("grant_type") === "refresh_token") {
				return jsonResponse({
					access_token: await mintToken(key, userClaims({ ...ids(), nowMs: h.clock.now() })),
					refresh_token: "refresh-2",
					expires_in: 600,
				});
			}
			return jsonResponse({
				access_token: await mintToken(
					key,
					apiKeyClaims({
						apiKeyId: API_KEY_ID,
						orgId: ORG,
						accountId: ACCOUNT,
						realmId: REALM,
						scopes: RECEIPT.scopes,
						nowMs: h.clock.now(),
					}),
				),
				token_type: "Bearer",
				expires_in: 600,
			});
		});
		return h;
	}

	test("exchanges and verifies an imported key against its receipt", async () => {
		const h = await apiKeyHarness();
		const verified = await h.manager.getImportedApiKeyToken({ receipt: RECEIPT, credential: "aura_k1_.legacy" });
		expect(verified.principalType).toBe("api_key");
		expect(verified.subject).toBe(API_KEY_ID);
		const request = h.server.requestsFor(TOKEN_URL)[0]!;
		expect(request.redirect).toBe("manual");
		expect(request.form?.get("client")).toBe("cli");
		expect(request.form?.get("api_key")).toBe("aura_k1_.legacy");
		expect(request.form?.get("refresh_token")).toBeNull();
	});

	test("caches the exchanged token in memory and reuses it", async () => {
		const h = await apiKeyHarness();
		const first = await h.manager.getImportedApiKeyToken({ receipt: RECEIPT, credential: "aura_k1_.legacy" });
		const second = await h.manager.getImportedApiKeyToken({ receipt: RECEIPT, credential: "aura_k1_.legacy" });
		expect(second.token).toBe(first.token);
		expect(h.server.countFor(TOKEN_URL)).toBe(1);
	});

	test("the api key token is never returned by the user access token provider", async () => {
		const h = await apiKeyHarness();
		const apiKeyToken = await h.manager.getImportedApiKeyToken({ receipt: RECEIPT, credential: "aura_k1_.legacy" });
		const user = await h.manager.getAccessToken();
		expect(user.value).not.toBe(apiKeyToken.token);
		expect(user.identity.userId).toBe(USER);
		// And the exchange never persisted anything.
		expect(store.readAuth(AUTH_ORIGIN)?.refreshToken).toBe("refresh-2");
	});

	test("rejects an exchanged token that does not match the receipt", async () => {
		const h = await apiKeyHarness();
		h.server.route(TOKEN_URL, async () =>
			jsonResponse({
				access_token: await mintToken(
					key,
					apiKeyClaims({
						apiKeyId: ulid("KEY9"),
						orgId: ORG,
						accountId: ACCOUNT,
						realmId: REALM,
						scopes: RECEIPT.scopes,
						nowMs: h.clock.now(),
					}),
				),
				expires_in: 600,
			}),
		);
		await expectCloudError(
			h.manager.getImportedApiKeyToken({ receipt: RECEIPT, credential: "aura_k1_.legacy" }),
			"invalid_response",
		);
	});
});
