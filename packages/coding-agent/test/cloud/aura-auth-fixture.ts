/**
 * Shared in-process fixtures for the Aura auth client tests.
 *
 * There is no listener here on purpose: WSL loopback blackholes in this environment, so every
 * test drives the client through an injected `fetch` implementation. That also makes the
 * assertions sharper than a real server would — the fake records the exact URL, method,
 * headers, body and `redirect` mode of every request, and any request to a URL nobody
 * registered is a hard failure rather than a 404.
 */

const encoder = new TextEncoder();

/** The one auth origin every test configures. */
export const AUTH_ORIGIN = "https://auth.example.dev";
/** A different origin, used as a cross-origin redirect receiver. */
export const FOREIGN_ORIGIN = "https://receiver.example.net";

/** Build a valid 26-character uppercase Crockford ULID from a short readable tag. */
export function ulid(tag: string): string {
	const body = tag.toUpperCase().replace(/[^0-9A-HJKMNP-TV-Z]/g, "0");
	return `01J${body}`.padEnd(26, "0").slice(0, 26);
}

export function base64url(input: string | Uint8Array | ArrayBuffer): string {
	const bytes =
		typeof input === "string"
			? encoder.encode(input)
			: input instanceof Uint8Array
				? input
				: new Uint8Array(input as ArrayBuffer);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------------------------------------------------------------------------
// Signing keys and tokens
// ---------------------------------------------------------------------------

/** The public half of a test signing key, in the exact JWKS entry shape the client reads. */
export interface PublicJwk {
	readonly kty: string;
	readonly crv: string;
	readonly x: string;
	readonly kid: string;
	readonly alg: string;
	readonly use: string;
}

export interface SigningKey {
	readonly kid: string;
	readonly privateKey: CryptoKey;
	readonly publicJwk: PublicJwk;
}

export async function generateSigningKey(kid: string): Promise<SigningKey> {
	const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
		"sign",
		"verify",
	])) as unknown as CryptoKeyPair;
	const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as { x?: string };
	return {
		kid,
		privateKey: pair.privateKey,
		publicJwk: { kty: "OKP", crv: "Ed25519", x: jwk.x ?? "", kid, alg: "EdDSA", use: "sig" },
	};
}

export function jwksFor(...keys: SigningKey[]): { keys: unknown[] } {
	return { keys: keys.map(key => key.publicJwk) };
}

/** Mint a compact JWS. Header and payload are written verbatim so tests can corrupt either. */
export async function mintToken(
	key: SigningKey,
	payload: Record<string, unknown>,
	headerOverrides: Record<string, unknown> = {},
): Promise<string> {
	const header = { alg: "EdDSA", typ: "JWT", kid: key.kid, ...headerOverrides };
	const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
	const signature = await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, encoder.encode(signingInput));
	return `${signingInput}.${base64url(signature)}`;
}

/** Re-sign nothing: attach a signature that is valid for *other* bytes. */
export async function mintTokenWithForeignSignature(
	key: SigningKey,
	payload: Record<string, unknown>,
): Promise<string> {
	const token = await mintToken(key, payload);
	const [header, body] = token.split(".");
	const other = await mintToken(key, { ...payload, jti: `${String(payload.jti)}-x` });
	return `${header}.${body}.${other.split(".")[2]}`;
}

export interface ClaimOverrides {
	readonly [claim: string]: unknown;
}

export interface UserClaimInput {
	readonly issuer?: string;
	readonly userId: string;
	readonly orgId: string;
	readonly accountId: string;
	readonly realmId: string;
	readonly deviceId: string;
	readonly roles?: readonly string[];
	readonly scopes?: readonly string[];
	readonly nowMs: number;
	readonly lifetimeSec?: number;
	readonly jti?: string;
}

/** Every minted token gets a distinct `jti`, as a real issuer would. */
let jtiCounter = 0;

export const NINE_SCOPES = [
	"credential:manage",
	"credential:snapshot",
	"distribution:read",
	"model:invoke",
	"sync:read",
	"sync:write",
	"telemetry:write",
	"usage:read",
	"usage:write",
] as const;

export function userClaims(input: UserClaimInput, overrides: ClaimOverrides = {}): Record<string, unknown> {
	const iat = Math.floor(input.nowMs / 1000);
	return {
		iss: input.issuer ?? AUTH_ORIGIN,
		aud: "elide-cloud",
		sub: input.userId,
		iat,
		exp: iat + (input.lifetimeSec ?? 600),
		jti: input.jti ?? ulid(`JTI${++jtiCounter}`),
		principal_type: "user",
		org_id: input.orgId,
		account_id: input.accountId,
		realm_id: input.realmId,
		roles: input.roles ?? ["member"],
		scopes: input.scopes ?? [...NINE_SCOPES],
		device: input.deviceId,
		...overrides,
	};
}

export interface ApiKeyClaimInput {
	readonly issuer?: string;
	readonly apiKeyId: string;
	readonly orgId: string;
	readonly accountId: string;
	readonly realmId: string;
	readonly scopes: readonly string[];
	readonly nowMs: number;
	readonly lifetimeSec?: number;
}

export function apiKeyClaims(input: ApiKeyClaimInput, overrides: ClaimOverrides = {}): Record<string, unknown> {
	const iat = Math.floor(input.nowMs / 1000);
	return {
		iss: input.issuer ?? AUTH_ORIGIN,
		aud: "elide-cloud",
		sub: input.apiKeyId,
		iat,
		exp: iat + (input.lifetimeSec ?? 600),
		jti: ulid(`JTIK${++jtiCounter}`),
		principal_type: "api_key",
		org_id: input.orgId,
		account_id: input.accountId,
		realm_id: input.realmId,
		roles: [],
		scopes: [...input.scopes],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Fake fetch
// ---------------------------------------------------------------------------

export interface RecordedRequest {
	readonly url: string;
	readonly method: string;
	readonly headers: Record<string, string>;
	readonly body: string | undefined;
	readonly redirect: string | undefined;
	readonly form: URLSearchParams | undefined;
	readonly json: unknown;
	/** The signal the client passed, so a test can observe whether it cancelled the call. */
	readonly signal: AbortSignal | undefined;
}

export type RouteHandler = (request: RecordedRequest) => Response | Promise<Response>;

export class FakeAuthServer {
	readonly requests: RecordedRequest[] = [];
	/** How many response bodies the client canceled without reading. */
	canceledBodies = 0;
	readonly #routes = new Map<string, RouteHandler>();

	/** Register (or replace) the handler for an exact URL. */
	route(url: string, handler: RouteHandler): this {
		this.#routes.set(url, handler);
		return this;
	}

	/** Requests recorded for an exact URL. */
	requestsFor(url: string): RecordedRequest[] {
		return this.requests.filter(request => request.url === url);
	}

	countFor(url: string): number {
		return this.requestsFor(url).length;
	}

	/** A body that counts its own cancellation, so "the client canceled it" is observable. */
	streamBody(payload = '{"unread":true}'): ReadableStream<Uint8Array> {
		let sent = false;
		return new ReadableStream<Uint8Array>({
			pull: controller => {
				if (sent) {
					controller.close();
					return;
				}
				sent = true;
				controller.enqueue(encoder.encode(payload));
			},
			cancel: () => {
				this.canceledBodies += 1;
			},
		});
	}

	/** A 3xx whose body is only accounted for if the client cancels it. */
	redirectResponse(status: number, location: string): Response {
		return new Response(this.streamBody(), { status, headers: { location } });
	}

	readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const headers = new Headers(init.headers ?? {});
		const headerMap: Record<string, string> = {};
		headers.forEach((value, key) => {
			headerMap[key.toLowerCase()] = value;
		});
		const body = typeof init.body === "string" ? init.body : init.body === undefined ? undefined : String(init.body);
		let form: URLSearchParams | undefined;
		let json: unknown;
		const contentType = headerMap["content-type"] ?? "";
		if (body !== undefined && contentType.startsWith("application/x-www-form-urlencoded")) {
			form = new URLSearchParams(body);
		}
		if (body !== undefined && contentType.startsWith("application/json")) {
			try {
				json = JSON.parse(body);
			} catch {
				json = undefined;
			}
		}
		const record: RecordedRequest = {
			url,
			method: (init.method ?? "GET").toUpperCase(),
			headers: headerMap,
			body,
			redirect: init.redirect,
			form,
			json,
			signal: init.signal ?? undefined,
		};
		this.requests.push(record);
		if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
		const handler = this.#routes.get(url);
		if (!handler) throw new Error(`unexpected request: ${record.method} ${url}`);
		return await handler(record);
	};
}

export function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

/** A `sleep` that never really waits but advances an injected clock. */
export function fakeClock(startMs: number) {
	const state = {
		nowMs: startMs,
		sleeps: [] as number[],
		now: () => state.nowMs,
		advance: (ms: number) => {
			state.nowMs += ms;
		},
		sleep: async (ms: number, signal?: AbortSignal) => {
			if (signal?.aborted) throw new DOMException("aborted", "AbortError");
			state.sleeps.push(ms);
			state.nowMs += ms;
		},
	};
	return state;
}
