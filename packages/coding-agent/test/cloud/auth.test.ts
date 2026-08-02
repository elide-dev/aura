import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuraAuthClient, type AuraLoginPresenter, type AuraOrganizationOption } from "../../src/cloud/auth";
import { isAuraCloudError } from "../../src/cloud/errors";
import { AURA_JWKS_PATH, AURA_METADATA_PATH, TokenManager } from "../../src/cloud/token-manager";
import { AURA_SURFACE_SCOPES, type AuraAccountIdentity, AuraTokenStore } from "../../src/cloud/token-store";
import {
	AUTH_ORIGIN,
	FakeAuthServer,
	FOREIGN_ORIGIN,
	fakeClock,
	generateSigningKey,
	jsonResponse,
	jwksFor,
	mintToken,
	NINE_SCOPES,
	type SigningKey,
	ulid,
	userClaims,
} from "./aura-auth-fixture";

const METADATA_URL = `${AUTH_ORIGIN}${AURA_METADATA_PATH}`;
const JWKS_URL = `${AUTH_ORIGIN}${AURA_JWKS_PATH}`;
const AUTHORIZE_URL = `${AUTH_ORIGIN}/device/authorize`;
const TOKEN_URL = `${AUTH_ORIGIN}/token`;
const REVOKE_URL = `${AUTH_ORIGIN}/revoke`;

const DEVICE = ulid("DEVCE1");
const USER = ulid("USER1");
const OTHER_USER = ulid("USER2");
const ORG = ulid("ORG1");
const ORG_B = ulid("ORG2");
const ACCOUNT = ulid("ACCT1");
const REALM = ulid("REALM1");

const USER_CODE = "ABCD-EFGH";
const DEVICE_CODE = "device-code-xyz";
const VERIFY_URI = `${AUTH_ORIGIN}/device/verify`;
const VERIFY_URI_COMPLETE = `${AUTH_ORIGIN}/device/verify?user_code=${USER_CODE}`;

const T0 = 1_760_000_000_000;

let key: SigningKey;
let tempRoot = "";
let dbPath = "";
let store: AuraTokenStore;

async function expectCloudError(promise: Promise<unknown>, code: string): Promise<void> {
	let thrown: unknown;
	try {
		await promise;
	} catch (error) {
		thrown = error;
	}
	if (!isAuraCloudError(thrown)) throw new Error(`expected AuraCloudError(${code}), got ${String(thrown)}`);
	expect(thrown.code).toBe(code as never);
}

beforeEach(async () => {
	key = await generateSigningKey("kid-1");
	tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aura-auth-"));
	dbPath = path.join(tempRoot, "agent", "agent.db");
	await fs.mkdir(path.dirname(dbPath), { recursive: true });
	store = await AuraTokenStore.open(dbPath);
});

afterEach(async () => {
	store.close();
	await fs.rm(tempRoot, { recursive: true, force: true });
});

interface RecordingPresenter extends AuraLoginPresenter {
	readonly presented: { userCode: string; verificationUri: string; verificationUriComplete: string }[];
	readonly opened: string[];
	readonly offered: readonly AuraOrganizationOption[][];
}

function presenter(select?: (options: readonly AuraOrganizationOption[]) => Promise<string | undefined>) {
	const presented: RecordingPresenter["presented"] = [];
	const opened: string[] = [];
	const offered: AuraOrganizationOption[][] = [];
	const value: RecordingPresenter = {
		presented,
		opened,
		offered,
		present: approval => {
			presented.push({
				userCode: approval.userCode,
				verificationUri: approval.verificationUri,
				verificationUriComplete: approval.verificationUriComplete,
			});
		},
		open: url => {
			opened.push(url);
		},
		selectOrganization: select
			? async options => {
					offered.push([...options]);
					return await select(options);
				}
			: undefined,
	};
	return value;
}

interface Harness {
	readonly server: FakeAuthServer;
	readonly clock: ReturnType<typeof fakeClock>;
	readonly client: AuraAuthClient;
	readonly manager: TokenManager;
	/** Successive `/token` poll responses, consumed in order; the last one repeats. */
	tokenResponses: (() => Response | Promise<Response>)[];
	authorizeResponse: () => Response | Promise<Response>;
}

async function accessToken(
	clock: ReturnType<typeof fakeClock>,
	overrides: Record<string, unknown> = {},
	ids: { userId?: string; orgId?: string; deviceId?: string } = {},
): Promise<string> {
	return await mintToken(
		key,
		userClaims(
			{
				userId: ids.userId ?? USER,
				orgId: ids.orgId ?? ORG,
				accountId: ACCOUNT,
				realmId: REALM,
				deviceId: ids.deviceId ?? DEVICE,
				nowMs: clock.now(),
			},
			overrides,
		),
	);
}

function harness(options: { authorize?: Record<string, unknown> } = {}): Harness {
	const server = new FakeAuthServer();
	const clock = fakeClock(T0);
	const state: Harness = {
		server,
		clock,
		tokenResponses: [],
		authorizeResponse: () =>
			jsonResponse({
				device_code: DEVICE_CODE,
				user_code: USER_CODE,
				verification_uri: VERIFY_URI,
				verification_uri_complete: VERIFY_URI_COMPLETE,
				expires_in: 600,
				interval: 5,
				...options.authorize,
			}),
		client: undefined as unknown as AuraAuthClient,
		manager: undefined as unknown as TokenManager,
	};
	server.route(METADATA_URL, () => jsonResponse({ issuer: AUTH_ORIGIN, jwks_uri: JWKS_URL }));
	server.route(JWKS_URL, () => jsonResponse(jwksFor(key)));
	server.route(AUTHORIZE_URL, () => state.authorizeResponse());
	server.route(TOKEN_URL, () => {
		const next = state.tokenResponses.length > 1 ? state.tokenResponses.shift() : state.tokenResponses[0];
		if (!next) throw new Error("no token response configured");
		return next();
	});
	const manager = new TokenManager({
		authOrigin: AUTH_ORIGIN,
		store,
		fetch: server.fetch,
		now: clock.now,
		sleep: clock.sleep,
	});
	const client = new AuraAuthClient({
		authOrigin: AUTH_ORIGIN,
		store,
		manager,
		fetch: server.fetch,
		now: clock.now,
		sleep: clock.sleep,
	});
	return Object.assign(state, { client, manager });
}

function grantResponse(token: string, refresh = "refresh-1"): Response {
	return jsonResponse({ access_token: token, refresh_token: refresh, token_type: "Bearer", expires_in: 600 });
}

// ===========================================================================
// Device authorization
// ===========================================================================

describe("device authorization", () => {
	test("posts the exact authorize document and never touches an OIDC or login route", async () => {
		const h = harness();
		h.tokenResponses = [async () => grantResponse(await accessToken(h.clock))];
		const ui = presenter();
		await h.client.login({ label: "sam's laptop", presenter: ui });

		const authorize = h.server.requestsFor(AUTHORIZE_URL)[0]!;
		expect(authorize.method).toBe("POST");
		expect(authorize.redirect).toBe("manual");
		expect(authorize.headers["content-type"]).toBe("application/json");
		expect(authorize.headers.accept).toBe("application/json");
		expect(authorize.headers.authorization).toBeUndefined();
		expect(authorize.json).toEqual({
			client: "cli",
			installation_id: store.getInstallationId(),
			device_label: "sam's laptop",
		});

		// The exact set of hosts and paths this flow may touch.
		expect([...new Set(h.server.requests.map(r => r.url))].sort()).toEqual(
			[AUTHORIZE_URL, TOKEN_URL, METADATA_URL, JWKS_URL].sort(),
		);
		for (const request of h.server.requests) {
			expect(request.url.startsWith(AUTH_ORIGIN)).toBe(true);
			for (const forbidden of ["/oidc/", "/login", "/signin", "/cdn-cgi/", "/callback"]) {
				expect({ url: request.url, forbidden, hit: request.url.includes(forbidden) }).toEqual({
					url: request.url,
					forbidden,
					hit: false,
				});
			}
			for (const header of Object.keys(request.headers)) {
				expect(header.startsWith("cf-access")).toBe(false);
			}
			expect(request.redirect).toBe("manual");
		}
	});

	test("omits device_label when none was given", async () => {
		const h = harness();
		h.tokenResponses = [async () => grantResponse(await accessToken(h.clock))];
		await h.client.login({ presenter: presenter() });
		expect(h.server.requestsFor(AUTHORIZE_URL)[0]!.json).toEqual({
			client: "cli",
			installation_id: store.getInstallationId(),
		});
	});

	test("displays the server's URI strings byte for byte, without re-serializing them", async () => {
		// A percent-encoded hyphen decodes to the expected user code, so validation passes — but
		// anything that rebuilt the URL from its parsed parts would hand back a different string.
		const raw = `${AUTH_ORIGIN}/device/verify?user_code=ABCD%2DEFGH`;
		const h = harness({ authorize: { verification_uri_complete: raw } });
		h.tokenResponses = [async () => grantResponse(await accessToken(h.clock))];
		const ui = presenter();
		await h.client.login({ presenter: ui, open: true });
		expect(ui.presented).toEqual([
			{ userCode: USER_CODE, verificationUri: VERIFY_URI, verificationUriComplete: raw },
		]);
		expect(ui.opened).toEqual([raw]);
	});

	test("opens a browser only when the user asked for it", async () => {
		const h = harness();
		h.tokenResponses = [async () => grantResponse(await accessToken(h.clock))];
		const ui = presenter();
		await h.client.login({ presenter: ui, open: false });
		expect(ui.presented.length).toBe(1);
		expect(ui.opened).toEqual([]);
	});

	const badUris: [string, Record<string, unknown>][] = [
		["a foreign origin", { verification_uri: `${FOREIGN_ORIGIN}/device/verify` }],
		["a look-alike host", { verification_uri: "https://auth.example.dev.evil.test/device/verify" }],
		["a plain-http origin", { verification_uri: "http://auth.example.dev/device/verify" }],
		["a different port", { verification_uri: "https://auth.example.dev:8443/device/verify" }],
		["userinfo", { verification_uri: "https://user:pass@auth.example.dev/device/verify" }],
		["a fragment", { verification_uri: `${VERIFY_URI}#top` }],
		["a wrong path", { verification_uri: `${AUTH_ORIGIN}/verify` }],
		["a path prefix trick", { verification_uri: `${AUTH_ORIGIN}/device/verify/../../evil` }],
		["an encoded path", { verification_uri: `${AUTH_ORIGIN}/device/%76erify` }],
		["a query on the plain URI", { verification_uri: `${AUTH_ORIGIN}/device/verify?user_code=${USER_CODE}` }],
		["a non-string URI", { verification_uri: 42 }],
		["a missing URI", { verification_uri: undefined }],
		["a fragment on the complete URI", { verification_uri_complete: `${VERIFY_URI_COMPLETE}#top` }],
		["no query on the complete URI", { verification_uri_complete: VERIFY_URI }],
		["an extra query parameter", { verification_uri_complete: `${VERIFY_URI_COMPLETE}&next=/admin` }],
		["an undocumented query parameter", { verification_uri_complete: `${VERIFY_URI}?code=${USER_CODE}` }],
		["a user_code that is not the issued one", { verification_uri_complete: `${VERIFY_URI}?user_code=ZZZZ` }],
		["a repeated user_code", { verification_uri_complete: `${VERIFY_URI_COMPLETE}&user_code=${USER_CODE}` }],
		[
			"a foreign complete URI",
			{ verification_uri_complete: `${FOREIGN_ORIGIN}/device/verify?user_code=${USER_CODE}` },
		],
	];

	for (const [label, overrides] of badUris) {
		test(`refuses to display a verification URI with ${label}`, async () => {
			const h = harness({ authorize: overrides });
			h.tokenResponses = [async () => grantResponse(await accessToken(h.clock))];
			const ui = presenter();
			await expectCloudError(h.client.login({ presenter: ui, open: true }), "invalid_response");
			expect(ui.presented).toEqual([]);
			expect(ui.opened).toEqual([]);
			// Nothing is polled for a flow we refused to show.
			expect(h.server.countFor(TOKEN_URL)).toBe(0);
		});
	}

	test("rejects an authorize response missing a device or user code", async () => {
		for (const overrides of [{ device_code: undefined }, { user_code: "" }, { device_code: 7 }]) {
			const h = harness({ authorize: overrides });
			await expectCloudError(h.client.login({ presenter: presenter() }), "invalid_response");
			expect(h.server.countFor(TOKEN_URL)).toBe(0);
		}
	});

	for (const status of [301, 302, 307, 308]) {
		for (const [label, receiver] of [
			["same-origin", `${AUTH_ORIGIN}/device/authorize2`],
			["cross-origin", `${FOREIGN_ORIGIN}/device/authorize`],
		] as const) {
			test(`maps a ${status} on authorize to a ${label} receiver to invalid_response`, async () => {
				const h = harness();
				let received = 0;
				h.server.route(AUTHORIZE_URL, () => h.server.redirectResponse(status, receiver));
				h.server.route(receiver, () => {
					received += 1;
					return jsonResponse({});
				});
				const ui = presenter();
				await expectCloudError(h.client.login({ presenter: ui }), "invalid_response");
				expect(received).toBe(0);
				expect(h.server.countFor(receiver)).toBe(0);
				expect(h.server.canceledBodies).toBe(1);
				expect(ui.presented).toEqual([]);
			});
		}
	}
});

// ===========================================================================
// Polling
// ===========================================================================

describe("device token polling", () => {
	test("polls with the exact device form at the server's interval", async () => {
		const h = harness({ authorize: { interval: 3 } });
		h.tokenResponses = [
			() => jsonResponse({ error: "authorization_pending" }, 400),
			async () => grantResponse(await accessToken(h.clock)),
		];
		await h.client.login({ presenter: presenter() });
		expect(h.server.countFor(TOKEN_URL)).toBe(2);
		const poll = h.server.requestsFor(TOKEN_URL)[0]!;
		expect(poll.method).toBe("POST");
		expect(poll.redirect).toBe("manual");
		expect(poll.headers["content-type"]).toBe("application/x-www-form-urlencoded;charset=UTF-8");
		expect(poll.headers.authorization).toBeUndefined();
		expect([...(poll.form ?? new URLSearchParams()).keys()].sort()).toEqual(["client", "device_code", "grant_type"]);
		expect(poll.form?.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
		expect(poll.form?.get("device_code")).toBe(DEVICE_CODE);
		expect(poll.form?.get("client")).toBe("cli");
		expect(h.clock.sleeps).toEqual([3_000]);
	});

	test("slow_down raises the interval by five seconds, persistently", async () => {
		const h = harness();
		h.tokenResponses = [
			() => jsonResponse({ error: "authorization_pending" }, 400),
			() => jsonResponse({ error: "slow_down" }, 400),
			() => jsonResponse({ error: "authorization_pending" }, 400),
			async () => grantResponse(await accessToken(h.clock)),
		];
		await h.client.login({ presenter: presenter() });
		expect(h.clock.sleeps).toEqual([5_000, 10_000, 10_000]);
	});

	test("stops with expired once the device code deadline passes", async () => {
		const h = harness({ authorize: { expires_in: 8, interval: 5 } });
		h.tokenResponses = [() => jsonResponse({ error: "authorization_pending" }, 400)];
		await expectCloudError(h.client.login({ presenter: presenter() }), "expired");
		// A second poll fits inside 8 seconds; a third would start after the deadline, so the
		// client stops rather than sending a request it already knows is too late.
		expect(h.server.countFor(TOKEN_URL)).toBe(2);
	});

	test("maps an explicit expired_token to expired and a denial to access_denied", async () => {
		for (const [error, code] of [
			["expired_token", "expired"],
			["access_denied", "access_denied"],
		] as const) {
			const h = harness();
			h.tokenResponses = [() => jsonResponse({ error }, 400)];
			await expectCloudError(h.client.login({ presenter: presenter() }), code);
			expect(store.readAuth(AUTH_ORIGIN)).toBeUndefined();
		}
	});

	test("maps an unrecognized error and a malformed grant to invalid_response", async () => {
		for (const response of [
			() => jsonResponse({ error: "teapot" }, 400),
			() => jsonResponse({ access_token: "not-a-jwt", refresh_token: "r" }),
			() => jsonResponse({ refresh_token: "r" }),
			() => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
		]) {
			const h = harness();
			h.tokenResponses = [response];
			await expectCloudError(h.client.login({ presenter: presenter() }), "invalid_response");
			expect(store.readAuth(AUTH_ORIGIN)).toBeUndefined();
		}
	});

	test("an abort during polling stops immediately and stores nothing", async () => {
		const h = harness();
		const controller = new AbortController();
		let polls = 0;
		h.tokenResponses = [
			() => {
				polls += 1;
				if (polls === 2) controller.abort();
				return jsonResponse({ error: "authorization_pending" }, 400);
			},
		];
		await expectCloudError(h.client.login({ presenter: presenter(), signal: controller.signal }), "aborted");
		expect(polls).toBe(2);
		expect(store.readAuth(AUTH_ORIGIN)).toBeUndefined();
	});

	for (const status of [301, 302, 307, 308]) {
		for (const [label, receiver] of [
			["same-origin", `${AUTH_ORIGIN}/token2`],
			["cross-origin", `${FOREIGN_ORIGIN}/token`],
		] as const) {
			test(`maps a ${status} on the poll to a ${label} receiver to invalid_response`, async () => {
				const h = harness();
				let received = 0;
				h.tokenResponses = [() => h.server.redirectResponse(status, receiver)];
				h.server.route(receiver, () => {
					received += 1;
					return jsonResponse({});
				});
				await expectCloudError(h.client.login({ presenter: presenter() }), "invalid_response");
				expect(received).toBe(0);
				expect(h.server.countFor(receiver)).toBe(0);
				expect(h.server.canceledBodies).toBe(1);
				expect(store.readAuth(AUTH_ORIGIN)).toBeUndefined();
			});
		}
	}
});

// ===========================================================================
// Approval outcomes
// ===========================================================================

describe("approval", () => {
	test("a personal approval verifies the token and stores the rotation-ready grant", async () => {
		const h = harness();
		h.tokenResponses = [async () => grantResponse(await accessToken(h.clock), "refresh-1")];
		const result = await h.client.login({ presenter: presenter() });
		expect(result.identity).toEqual({
			issuer: AUTH_ORIGIN,
			deviceId: DEVICE,
			userId: USER,
			orgId: ORG,
			accountId: ACCOUNT,
			realmId: REALM,
			roles: ["member"],
			scopes: AURA_SURFACE_SCOPES,
		} as AuraAccountIdentity);
		const stored = store.readAuth(AUTH_ORIGIN);
		expect(stored?.refreshToken).toBe("refresh-1");
		expect(stored?.identity.deviceId).toBe(DEVICE);
		expect(store.activeAccount(AUTH_ORIGIN)?.userId).toBe(USER);
		// The verified access token is available without a further network call.
		const token = await h.manager.getAccessToken();
		expect(token.identity.userId).toBe(USER);
		expect(h.server.countFor(TOKEN_URL)).toBe(1);
	});

	test("a team approval records the org the server actually issued", async () => {
		const h = harness();
		h.tokenResponses = [async () => grantResponse(await accessToken(h.clock, {}, { orgId: ORG_B }))];
		const result = await h.client.login({ presenter: presenter() });
		expect(result.identity.orgId).toBe(ORG_B);
		expect(store.readAuth(AUTH_ORIGIN)?.identity.orgId).toBe(ORG_B);
	});

	test("never stores a grant whose token fails verification", async () => {
		for (const overrides of [
			{ device: undefined },
			{ device: "laptop" },
			{ principal_type: "api_key" },
			{ scopes: NINE_SCOPES.slice(1) },
			{ iss: FOREIGN_ORIGIN },
			{ aud: "other-cloud" },
			{ sub: "not-a-ulid" },
		]) {
			const h = harness();
			h.tokenResponses = [async () => grantResponse(await accessToken(h.clock, overrides))];
			await expectCloudError(h.client.login({ presenter: presenter() }), "invalid_response");
			expect(store.readAuth(AUTH_ORIGIN)).toBeUndefined();
		}
	});

	test("a replacement login closes the previous account namespace", async () => {
		store.saveLogin({
			identity: {
				issuer: AUTH_ORIGIN,
				deviceId: DEVICE,
				userId: OTHER_USER,
				orgId: ORG,
				accountId: ACCOUNT,
				realmId: REALM,
				roles: ["member"],
				scopes: AURA_SURFACE_SCOPES,
			},
			refreshToken: "old-refresh",
		});
		const h = harness();
		h.tokenResponses = [async () => grantResponse(await accessToken(h.clock), "refresh-new")];
		await h.client.login({ presenter: presenter() });
		expect(store.activeAccount(AUTH_ORIGIN)?.userId).toBe(USER);
		const accounts = store.listAccounts(AUTH_ORIGIN);
		expect(accounts.find(a => a.userId === OTHER_USER)?.active).toBe(false);
		expect(store.readAuth(AUTH_ORIGIN)?.refreshToken).toBe("refresh-new");
	});
});

describe("organization selection", () => {
	function selectionHarness(orgs: AuraOrganizationOption[]): Harness {
		const h = harness();
		let selected: string | undefined;
		h.server.route(TOKEN_URL, async request => {
			const chosen = request.form?.get("organization_id") ?? undefined;
			if (chosen === undefined) {
				return jsonResponse({ error: "organization_selection_required", organizations: orgs }, 400);
			}
			selected = chosen;
			return grantResponse(await accessToken(h.clock, {}, { orgId: selected }));
		});
		return h;
	}

	test("requires an explicit selection and sends it back to the server", async () => {
		const h = selectionHarness([
			{ id: ORG, name: "Personal" },
			{ id: ORG_B, name: "Elide" },
		]);
		const ui = presenter(async () => ORG_B);
		const result = await h.client.login({ presenter: ui });
		expect(ui.offered).toEqual([
			[
				{ id: ORG, name: "Personal" },
				{ id: ORG_B, name: "Elide" },
			],
		]);
		expect(result.identity.orgId).toBe(ORG_B);
		const second = h.server.requestsFor(TOKEN_URL)[1]!;
		expect(second.form?.get("organization_id")).toBe(ORG_B);
		expect(second.form?.get("device_code")).toBe(DEVICE_CODE);
	});

	test("never picks the first offered org when no selection is made", async () => {
		const h = selectionHarness([
			{ id: ORG, name: "Personal" },
			{ id: ORG_B, name: "Elide" },
		]);
		const ui = presenter(async () => undefined);
		await expectCloudError(h.client.login({ presenter: ui }), "access_denied");
		expect(store.readAuth(AUTH_ORIGIN)).toBeUndefined();
		expect(h.server.countFor(TOKEN_URL)).toBe(1);
	});

	test("never picks an org when the caller offers no way to choose", async () => {
		const h = selectionHarness([
			{ id: ORG, name: "Personal" },
			{ id: ORG_B, name: "Elide" },
		]);
		await expectCloudError(h.client.login({ presenter: presenter() }), "access_denied");
		expect(h.server.countFor(TOKEN_URL)).toBe(1);
	});

	test("refuses a selection the server did not offer", async () => {
		const h = selectionHarness([{ id: ORG, name: "Personal" }]);
		const ui = presenter(async () => ORG_B);
		await expectCloudError(h.client.login({ presenter: ui }), "forbidden");
		expect(h.server.countFor(TOKEN_URL)).toBe(1);
		expect(store.readAuth(AUTH_ORIGIN)).toBeUndefined();
	});

	test("rejects a token issued for an org other than the one selected", async () => {
		const h = harness();
		let asked = false;
		h.server.route(TOKEN_URL, async request => {
			if (!asked) {
				asked = true;
				return jsonResponse(
					{ error: "organization_selection_required", organizations: [{ id: ORG }, { id: ORG_B }] },
					400,
				);
			}
			expect(request.form?.get("organization_id")).toBe(ORG_B);
			// The server hands back a token for the *other* org.
			return grantResponse(await accessToken(h.clock, {}, { orgId: ORG }));
		});
		await expectCloudError(h.client.login({ presenter: presenter(async () => ORG_B) }), "invalid_response");
		expect(store.readAuth(AUTH_ORIGIN)).toBeUndefined();
	});

	test("still requires a choice when exactly one org is offered", async () => {
		const h = selectionHarness([{ id: ORG_B, name: "Elide" }]);
		const ui = presenter(async options => options[0]!.id);
		const result = await h.client.login({ presenter: ui });
		expect(ui.offered.length).toBe(1);
		expect(result.identity.orgId).toBe(ORG_B);
	});
});

// ===========================================================================
// Status and logout
// ===========================================================================

describe("status", () => {
	test("reports the signed-in identity and never a token", async () => {
		const h = harness();
		h.tokenResponses = [async () => grantResponse(await accessToken(h.clock), "refresh-secret-1")];
		await h.client.login({ presenter: presenter() });
		const status = h.client.status();
		expect(status.signedIn).toBe(true);
		expect(status.issuer).toBe(AUTH_ORIGIN);
		expect(status.identity?.userId).toBe(USER);
		const encoded = JSON.stringify(status);
		expect(encoded).not.toContain("refresh-secret-1");
		expect(encoded).not.toContain("eyJ");
		expect(encoded.toLowerCase()).not.toContain("token");
	});

	test("reports a signed-out profile without inventing an identity", () => {
		const h = harness();
		expect(h.client.status()).toEqual({ signedIn: false, issuer: AUTH_ORIGIN, identity: undefined });
	});
});

describe("logout", () => {
	async function signedIn(): Promise<Harness> {
		const h = harness();
		h.tokenResponses = [async () => grantResponse(await accessToken(h.clock), "refresh-1")];
		await h.client.login({ presenter: presenter() });
		return h;
	}

	test("revokes the refresh grant before deleting anything locally", async () => {
		const h = await signedIn();
		let storedWhenRevoked: string | undefined;
		h.server.route(REVOKE_URL, request => {
			storedWhenRevoked = store.readAuth(AUTH_ORIGIN)?.refreshToken;
			expect(request.form?.get("token")).toBe("refresh-1");
			expect(request.form?.get("token_type_hint")).toBe("refresh_token");
			expect(request.form?.get("client")).toBe("cli");
			expect(request.redirect).toBe("manual");
			return jsonResponse({});
		});
		const result = await h.client.logout();
		expect(result).toEqual({ revoked: true, forgotten: true });
		expect(storedWhenRevoked).toBe("refresh-1");
		expect(store.readAuth(AUTH_ORIGIN)).toBeUndefined();
	});

	test("keeps the local grant when revocation fails without --force", async () => {
		const h = await signedIn();
		h.server.route(REVOKE_URL, () => jsonResponse({ error: "server_error" }, 500));
		await expectCloudError(h.client.logout(), "unavailable");
		expect(store.readAuth(AUTH_ORIGIN)?.refreshToken).toBe("refresh-1");
	});

	test("--force forgets locally after a failed revocation", async () => {
		const h = await signedIn();
		h.server.route(REVOKE_URL, () => jsonResponse({ error: "server_error" }, 500));
		const result = await h.client.logout({ force: true });
		expect(result).toEqual({ revoked: false, forgotten: true });
		expect(store.readAuth(AUTH_ORIGIN)).toBeUndefined();
		expect(h.client.status().signedIn).toBe(false);
	});

	test("clears the manager's cached access token", async () => {
		const h = await signedIn();
		h.server.route(REVOKE_URL, () => jsonResponse({}));
		await h.client.logout();
		await expectCloudError(h.manager.getAccessToken(), "login_required");
	});

	test("requires a login when nothing is signed in", async () => {
		const h = harness();
		await expectCloudError(h.client.logout(), "login_required");
		expect(h.server.countFor(REVOKE_URL)).toBe(0);
	});

	for (const status of [301, 302, 307, 308]) {
		for (const [label, receiver] of [
			["same-origin", `${AUTH_ORIGIN}/revoke2`],
			["cross-origin", `${FOREIGN_ORIGIN}/revoke`],
		] as const) {
			test(`maps a ${status} on revoke to a ${label} receiver, keeping the grant`, async () => {
				const h = await signedIn();
				let received = 0;
				h.server.route(REVOKE_URL, () => h.server.redirectResponse(status, receiver));
				h.server.route(receiver, () => {
					received += 1;
					return jsonResponse({});
				});
				await expectCloudError(h.client.logout(), "invalid_response");
				expect(received).toBe(0);
				expect(h.server.countFor(receiver)).toBe(0);
				expect(h.server.canceledBodies).toBe(1);
				expect(store.readAuth(AUTH_ORIGIN)?.refreshToken).toBe("refresh-1");
			});
		}
	}
});
