/**
 * Verification and lifecycle for Aura access tokens.
 *
 * Three things live here, and nothing else should:
 *
 * 1. **One** signature/standard-claim verifier ({@link verifyAuraToken}), parameterized by an
 *    explicit {@link AuraPrincipalContract}. There is deliberately no second implementation for
 *    API-key principals: the difference between an interactive CLI user and an imported API key
 *    is entirely data — which subject, which tenancy, which scope set, whether a device binding
 *    is required, required-absent, or learned — so the two contracts are two *values* built by
 *    {@link cliUserContract} and {@link importedApiKeyContract}, not two code paths.
 * 2. {@link AuraAuthKeys}, which reads standard authorization-server metadata and the
 *    same-origin JWKS. It is not service discovery: the only fields read from metadata are
 *    `issuer` (which must equal the configured auth origin) and `jwks_uri` (which must equal the
 *    same-origin `/.well-known/jwks.json`). Every route this client calls is fixed and
 *    same-origin; an endpoint advertised by metadata is never used.
 * 3. {@link TokenManager}, which turns the stored refresh grant into short-lived verified access
 *    tokens, single-flighting in-process and — through the store's lease/CAS protocol — across
 *    processes, and {@link TokenManager.authorizedFetch}, the only place a user bearer is ever
 *    attached to an outbound request.
 *
 * Transport rules that apply to *every* request in this file and in `auth.ts`:
 * `redirect:"manual"`, every response body cancelled rather than left dangling, every 3xx —
 * same-origin or cross-origin, 301/302/307/308 alike — mapped to `invalid_response`. A redirect
 * is never followed, so neither a credential nor a POST body is ever replayed to a location the
 * server chose. JSON is read through a hard 64 KiB cap.
 *
 * The manager never holds a refresh token across a rotation. The value it submits comes from
 * the lease acquisition that granted it ownership, read inside the store's `BEGIN IMMEDIATE`,
 * so a manager constructed before another process rotated submits the reloaded value.
 */

import { AuraCloudError } from "./errors";
import { isPlainObject, isUlid, normalizeOrigin } from "./internal";
import {
	AURA_SURFACE_SCOPES,
	type AuraAccessToken,
	type AuraAccessTokenProvider,
	type AuraAccountIdentity,
	type AuraImportReceipt,
	type AuraRefreshLease,
	type AuraTokenStore,
} from "./token-store";

// =============================================================================
// Pinned contract values
// =============================================================================

/** The only audience this client accepts. */
export const AURA_AUTH_AUDIENCE = "elide-cloud";
/** Standard authorization-server metadata, relative to the configured auth origin. */
export const AURA_METADATA_PATH = "/.well-known/oauth-authorization-server";
/** The only JWKS location this client accepts, relative to the configured auth origin. */
export const AURA_JWKS_PATH = "/.well-known/jwks.json";
/** Hard cap on any auth/metadata/JWKS JSON document. */
export const AURA_AUTH_JSON_MAX_BYTES = 65_536;
/** Refresh once the cached access token is within this window of expiry. */
export const AURA_ACCESS_REFRESH_SKEW_MS = 60_000;
/** Tolerated clock disagreement with the issuer, in both directions. */
export const AURA_CLOCK_SKEW_MS = 30_000;
/** The longest access token lifetime this client will accept. */
export const AURA_MAX_ACCESS_LIFETIME_MS = 900_000;
/** How long a successful metadata+JWKS read stays usable. */
export const AURA_JWKS_CACHE_MS = 300_000;
/** How long to keep waiting for another process to finish its rotation. */
export const AURA_REFRESH_WAIT_BUDGET_MS = 60_000;

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded;charset=UTF-8";

/** The injectable `fetch` seam. Tests supply an in-process implementation. */
export type AuraFetch = (input: string, init: RequestInit) => Promise<Response>;

// =============================================================================
// Transport
// =============================================================================

function isAbortLike(error: unknown, signal?: AbortSignal): boolean {
	if (signal?.aborted) return true;
	return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new AuraCloudError("aborted");
}

/** Drop a response body we are not going to read. Never allowed to become a second failure. */
async function cancelBody(response: Response): Promise<void> {
	try {
		if (!response.bodyUsed) await response.body?.cancel();
	} catch {
		// A body that is already errored or locked needs no cancelling.
	}
}

/**
 * Read a JSON document under a hard byte cap.
 *
 * The declared length is checked first so an oversized document costs one header read, but the
 * stream is still counted as it arrives: `content-length` is the server's claim, not a fact.
 */
async function readCappedJson(response: Response, url: string): Promise<unknown> {
	const declared = response.headers.get("content-length");
	if (declared !== null) {
		const length = Number(declared);
		if (Number.isFinite(length) && length > AURA_AUTH_JSON_MAX_BYTES) {
			await cancelBody(response);
			throw new AuraCloudError("payload_too_large", { status: response.status, host: url });
		}
	}
	const body = response.body;
	if (!body) return undefined;
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		let done: boolean;
		let value: Uint8Array | undefined;
		try {
			const chunk = await reader.read();
			done = chunk.done;
			value = chunk.value;
		} catch (error) {
			throw new AuraCloudError("invalid_response", { status: response.status, host: url, cause: error });
		}
		if (done) break;
		if (!value) continue;
		total += value.byteLength;
		if (total > AURA_AUTH_JSON_MAX_BYTES) {
			await reader.cancel().catch(() => {});
			throw new AuraCloudError("payload_too_large", { status: response.status, host: url });
		}
		chunks.push(value);
	}
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const text = new TextDecoder().decode(merged);
	if (text.trim() === "") return undefined;
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new AuraCloudError("invalid_response", { status: response.status, host: url, cause: error });
	}
}

/**
 * Send one request with redirects disabled, mapping transport failure onto the taxonomy.
 *
 * Returns the response for *any* status, including 3xx: the caller decides, because whether a
 * response arrived at all is the difference between "this refresh token may have been consumed"
 * and "it certainly was not".
 */
async function auraTransport(
	fetchImpl: AuraFetch,
	url: string,
	init: RequestInit,
	signal: AbortSignal | undefined,
): Promise<Response> {
	throwIfAborted(signal);
	try {
		return await fetchImpl(url, { ...init, redirect: "manual", ...(signal ? { signal } : {}) });
	} catch (error) {
		if (isAbortLike(error, signal)) throw new AuraCloudError("aborted", { cause: error });
		throw new AuraCloudError("unavailable", { host: url, cause: error });
	}
}

/** A 3xx is never followed and never forwarded: cancel it and fail. */
async function guardRedirect(response: Response, url: string): Promise<void> {
	if (response.status >= 300 && response.status < 400) {
		await cancelBody(response);
		throw new AuraCloudError("invalid_response", { status: response.status, host: url });
	}
}

/** The shape every auth/metadata/JWKS call returns: a status and a capped JSON body. */
export interface AuraAuthResponse {
	readonly status: number;
	readonly body: unknown;
}

export interface AuraAuthRequestInput {
	readonly fetch: AuraFetch;
	readonly url: string;
	readonly method?: "GET" | "POST";
	readonly json?: unknown;
	readonly form?: URLSearchParams;
	readonly signal?: AbortSignal;
	/** Invoked with the status the instant a response — any status — arrives. */
	readonly onResponse?: (status: number) => void;
}

/**
 * The single seam for every auth-server call.
 *
 * Centralized so the redirect, body-cancellation and size rules cannot be forgotten at a call
 * site: there is no other way to reach the auth origin from this package.
 */
export async function auraAuthRequest(input: AuraAuthRequestInput): Promise<AuraAuthResponse> {
	const headers: Record<string, string> = { accept: "application/json" };
	let body: string | undefined;
	if (input.form !== undefined) {
		headers["content-type"] = FORM_CONTENT_TYPE;
		body = input.form.toString();
	} else if (input.json !== undefined) {
		headers["content-type"] = "application/json";
		body = JSON.stringify(input.json);
	}
	const init: RequestInit = { method: input.method ?? (body === undefined ? "GET" : "POST"), headers };
	if (body !== undefined) init.body = body;
	const response = await auraTransport(input.fetch, input.url, init, input.signal);
	input.onResponse?.(response.status);
	await guardRedirect(response, input.url);
	return { status: response.status, body: await readCappedJson(response, input.url) };
}

// =============================================================================
// The shared verifier
// =============================================================================

/** How a token's `device` claim relates to this client's device binding. */
export type AuraDeviceBinding =
	/** A ULID `device` must be present; its value is learned (initial login). */
	| { readonly mode: "require" }
	/** A ULID `device` must be present and equal to this id (every refresh). */
	| { readonly mode: "exact"; readonly deviceId: string }
	/** No `device` claim may be present at all (API keys are not device-bound). */
	| { readonly mode: "forbid" };

/**
 * An expected principal.
 *
 * Every field that is `undefined` is still *structurally* validated (ULID ids, string roles);
 * `undefined` only means "this client does not yet know the value", which happens exactly once,
 * at initial login. Everywhere else the contract is fully pinned.
 */
export interface AuraPrincipalContract {
	readonly principalType: "user" | "api_key";
	readonly issuer: string;
	readonly audience: string;
	/** Exact `sub`. */
	readonly subject?: string;
	/** Whether `sub` must additionally be ULID-shaped. */
	readonly ulidSubject: boolean;
	readonly orgId?: string;
	readonly accountId?: string;
	readonly realmId?: string;
	/** Exact roles, compared as a sorted list. */
	readonly roles?: readonly string[];
	/** Exact scope set, compared as a set with duplicates rejected. */
	readonly scopes: readonly string[];
	readonly device: AuraDeviceBinding;
}

/** The interactive CLI user contract. */
export function cliUserContract(input: {
	issuer: string;
	device: AuraDeviceBinding;
	identity?: Partial<Pick<AuraAccountIdentity, "userId" | "orgId" | "accountId" | "realmId">> & {
		roles?: readonly string[];
	};
}): AuraPrincipalContract {
	return {
		principalType: "user",
		issuer: input.issuer,
		audience: AURA_AUTH_AUDIENCE,
		subject: input.identity?.userId,
		ulidSubject: true,
		orgId: input.identity?.orgId,
		accountId: input.identity?.accountId,
		realmId: input.identity?.realmId,
		roles: input.identity?.roles,
		scopes: AURA_SURFACE_SCOPES,
		device: input.device,
	};
}

/** The imported-API-key contract, pinned entirely by a stored receipt. */
export function importedApiKeyContract(input: { issuer: string; receipt: AuraImportReceipt }): AuraPrincipalContract {
	const receipt = input.receipt;
	return {
		principalType: "api_key",
		issuer: input.issuer,
		audience: AURA_AUTH_AUDIENCE,
		subject: receipt.apiKeyId,
		ulidSubject: false,
		orgId: receipt.orgId,
		accountId: receipt.accountId,
		realmId: receipt.realmId,
		roles: [],
		scopes: receipt.scopes,
		device: { mode: "forbid" },
	};
}

/** A token that passed every check in {@link verifyAuraToken}. */
export interface AuraVerifiedToken {
	readonly token: string;
	readonly principalType: "user" | "api_key";
	readonly subject: string;
	readonly orgId: string;
	readonly accountId: string;
	readonly realmId: string;
	readonly roles: readonly string[];
	readonly scopes: readonly string[];
	readonly deviceId: string | undefined;
	readonly jti: string;
	readonly issuedAtMs: number;
	readonly expiresAtMs: number;
}

/** Resolves a `kid` to a verification key, optionally forcing a key-set refresh. */
export interface AuraKeyResolver {
	resolve(kid: string, options?: { forceRefresh?: boolean; signal?: AbortSignal }): Promise<CryptoKey | undefined>;
}

/** Anything a token fails on is `invalid_response`: the server sent something untrustworthy. */
function reject(): never {
	throw new AuraCloudError("invalid_response");
}

function decodeSegment(segment: string): Uint8Array<ArrayBuffer> {
	if (segment.length === 0 || !BASE64URL_RE.test(segment)) reject();
	const padded = segment
		.replace(/-/g, "+")
		.replace(/_/g, "/")
		.padEnd(Math.ceil(segment.length / 4) * 4, "=");
	let binary: string;
	try {
		binary = atob(padded);
	} catch {
		return reject();
	}
	const bytes = new Uint8Array(new ArrayBuffer(binary.length));
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function decodeJsonSegment(segment: string): Record<string, unknown> {
	const bytes = decodeSegment(segment);
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return reject();
	}
	if (!isPlainObject(parsed)) reject();
	return parsed;
}

function requireStringArray(value: unknown): readonly string[] {
	if (!Array.isArray(value) || !value.every(item => typeof item === "string")) reject();
	return value as readonly string[];
}

function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
	if (actual.length !== expected.length) return false;
	const seen = new Set(actual);
	// Duplicates collapse in the Set, so a length match plus a size match forbids repeats.
	if (seen.size !== actual.length) return false;
	return expected.every(item => seen.has(item));
}

function sameList(actual: readonly string[], expected: readonly string[]): boolean {
	if (actual.length !== expected.length) return false;
	const left = [...actual].sort();
	const right = [...expected].sort();
	return left.every((item, index) => item === right[index]);
}

function requireIntegerClaim(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) reject();
	return value;
}

/**
 * The one signature/standard-claim/principal verifier.
 *
 * An unknown `kid` costs exactly one forced key-set refresh — enough to pick up a rotation,
 * bounded enough that a token naming random kids cannot be used to hammer the JWKS endpoint.
 */
export async function verifyAuraToken(
	token: string,
	contract: AuraPrincipalContract,
	deps: { keys: AuraKeyResolver; nowMs: number; signal?: AbortSignal },
): Promise<AuraVerifiedToken> {
	if (typeof token !== "string" || token.length === 0) reject();
	const segments = token.split(".");
	if (segments.length !== 3) reject();
	const [headerSegment, payloadSegment, signatureSegment] = segments as [string, string, string];

	const header = decodeJsonSegment(headerSegment);
	if (header.alg !== "EdDSA") reject();
	if (header.typ !== "JWT") reject();
	const kid = header.kid;
	if (typeof kid !== "string" || kid.length === 0) reject();

	let key = await deps.keys.resolve(kid, { signal: deps.signal });
	if (!key) key = await deps.keys.resolve(kid, { forceRefresh: true, signal: deps.signal });
	if (!key) reject();

	const signature = decodeSegment(signatureSegment);
	const signingInput = new TextEncoder().encode(`${headerSegment}.${payloadSegment}`);
	let valid = false;
	try {
		valid = await crypto.subtle.verify({ name: "Ed25519" }, key, signature, signingInput);
	} catch {
		valid = false;
	}
	if (!valid) reject();

	const claims = decodeJsonSegment(payloadSegment);

	// --- standard claims -----------------------------------------------------
	if (claims.iss !== contract.issuer) reject();
	if (claims.aud !== contract.audience) reject();
	const jti = claims.jti;
	if (typeof jti !== "string" || jti.length === 0) reject();
	const iat = requireIntegerClaim(claims.iat);
	const exp = requireIntegerClaim(claims.exp);
	const issuedAtMs = iat * 1000;
	const expiresAtMs = exp * 1000;
	if (expiresAtMs <= issuedAtMs) reject();
	if (expiresAtMs - issuedAtMs > AURA_MAX_ACCESS_LIFETIME_MS) reject();
	if (issuedAtMs > deps.nowMs + AURA_CLOCK_SKEW_MS) reject();
	if (expiresAtMs + AURA_CLOCK_SKEW_MS <= deps.nowMs) reject();

	// --- principal -----------------------------------------------------------
	if (claims.principal_type !== contract.principalType) reject();
	const subject = claims.sub;
	if (typeof subject !== "string" || subject.length === 0) reject();
	if (contract.ulidSubject && !isUlid(subject)) reject();
	if (contract.subject !== undefined && subject !== contract.subject) reject();

	const tenancy = (claim: unknown, expected: string | undefined): string => {
		if (!isUlid(claim)) reject();
		if (expected !== undefined && claim !== expected) reject();
		return claim;
	};
	const orgId = tenancy(claims.org_id, contract.orgId);
	const accountId = tenancy(claims.account_id, contract.accountId);
	const realmId = tenancy(claims.realm_id, contract.realmId);

	const roles = requireStringArray(claims.roles);
	if (contract.roles !== undefined && !sameList(roles, contract.roles)) reject();

	const scopes = requireStringArray(claims.scopes);
	if (!sameSet(scopes, contract.scopes)) reject();

	let deviceId: string | undefined;
	switch (contract.device.mode) {
		case "forbid":
			if (claims.device !== undefined) reject();
			break;
		case "require":
			if (!isUlid(claims.device)) reject();
			deviceId = claims.device;
			break;
		case "exact":
			if (!isUlid(claims.device)) reject();
			if (claims.device !== contract.device.deviceId) reject();
			deviceId = claims.device;
			break;
	}

	return {
		token,
		principalType: contract.principalType,
		subject,
		orgId,
		accountId,
		realmId,
		roles,
		scopes,
		deviceId,
		jti,
		issuedAtMs,
		expiresAtMs,
	};
}

// =============================================================================
// Metadata + JWKS
// =============================================================================

interface KeySet {
	readonly keys: Map<string, CryptoKey>;
	readonly fetchedAtMs: number;
}

export interface AuraAuthKeysOptions {
	readonly authOrigin: string;
	readonly fetch?: AuraFetch;
	readonly now?: () => number;
}

/**
 * Standard authorization-server metadata and the same-origin JWKS.
 *
 * Emphatically not discovery: `issuer` and `jwks_uri` are read to be *checked*, and every other
 * field — including any advertised token or device endpoint — is ignored, because this client's
 * routes are fixed relative to the configured auth origin.
 */
export class AuraAuthKeys implements AuraKeyResolver {
	readonly #authOrigin: string;
	readonly #fetch: AuraFetch;
	readonly #now: () => number;
	#cache: KeySet | undefined;
	#loading: Promise<KeySet> | undefined;

	constructor(options: AuraAuthKeysOptions) {
		this.#authOrigin = normalizeOrigin(options.authOrigin);
		this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
		this.#now = options.now ?? Date.now;
	}

	async resolve(
		kid: string,
		options: { forceRefresh?: boolean; signal?: AbortSignal } = {},
	): Promise<CryptoKey | undefined> {
		const fresh = options.forceRefresh === true;
		const cached = this.#cache;
		// The cache is *not* dropped up front on a forced refresh: a transient JWKS or metadata
		// failure would otherwise throw away a perfectly good key set and take every subsequent
		// verification down with it. It is replaced only by a load that actually succeeded.
		if (!fresh && cached && this.#now() - cached.fetchedAtMs < AURA_JWKS_CACHE_MS) {
			return cached.keys.get(kid);
		}
		const loaded = await this.#load({ signal: options.signal, fresh });
		return loaded.keys.get(kid);
	}

	async #load(options: { signal: AbortSignal | undefined; fresh: boolean }): Promise<KeySet> {
		const existing = this.#loading;
		if (existing) {
			// A forced refresh must not be satisfied by a load that began before it was asked for:
			// joining one would hand back pre-rotation keys and silently consume the verifier's
			// single retry. Wait for it to settle, then decide again.
			if (!options.fresh) return await existing;
			await existing.catch(() => {});
			const started = this.#loading;
			if (started) return await started;
		}
		const pending = this.#fetchKeySet(options.signal).finally(() => {
			this.#loading = undefined;
		});
		this.#loading = pending;
		const loaded = await pending;
		this.#cache = loaded;
		return loaded;
	}

	async #fetchKeySet(signal: AbortSignal | undefined): Promise<KeySet> {
		const metadataUrl = `${this.#authOrigin}${AURA_METADATA_PATH}`;
		const metadata = await auraAuthRequest({ fetch: this.#fetch, url: metadataUrl, signal });
		if (metadata.status !== 200 || !isPlainObject(metadata.body)) {
			throw new AuraCloudError("invalid_response", { status: metadata.status, host: metadataUrl });
		}
		if (metadata.body.issuer !== this.#authOrigin) {
			throw new AuraCloudError("invalid_response", { status: metadata.status, host: metadataUrl });
		}
		const jwksUrl = `${this.#authOrigin}${AURA_JWKS_PATH}`;
		// Exact string equality, not URL equivalence: a `jwks_uri` that merely *normalizes* to
		// the right place is a server describing a location this client did not pin.
		if (metadata.body.jwks_uri !== jwksUrl) {
			throw new AuraCloudError("invalid_response", { status: metadata.status, host: metadataUrl });
		}
		const jwks = await auraAuthRequest({ fetch: this.#fetch, url: jwksUrl, signal });
		if (jwks.status !== 200 || !isPlainObject(jwks.body) || !Array.isArray(jwks.body.keys)) {
			throw new AuraCloudError("invalid_response", { status: jwks.status, host: jwksUrl });
		}
		const keys = new Map<string, CryptoKey>();
		for (const entry of jwks.body.keys) {
			if (!isPlainObject(entry)) continue;
			const { kty, crv, x, kid } = entry as { kty?: unknown; crv?: unknown; x?: unknown; kid?: unknown };
			if (kty !== "OKP" || crv !== "Ed25519") continue;
			if (typeof x !== "string" || typeof kid !== "string" || kid.length === 0) continue;
			try {
				keys.set(
					kid,
					await crypto.subtle.importKey("jwk", { kty, crv, x }, { name: "Ed25519" }, false, ["verify"]),
				);
			} catch {
				// A malformed entry is skipped, not fatal: one bad key must not disable rotation.
			}
		}
		return { keys, fetchedAtMs: this.#now() };
	}
}

// =============================================================================
// TokenManager
// =============================================================================

export interface TokenManagerOptions {
	/** The resolved auth origin. Never re-derived here. */
	readonly authOrigin: string;
	readonly store: AuraTokenStore;
	readonly fetch?: AuraFetch;
	readonly now?: () => number;
	readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** Lease owner label. Need not be unique across processes; the store is digest-fenced. */
	readonly owner?: string;
}

/** `RequestInit` plus the explicit eligibility declaration a bearer requires. */
export interface AuraAuthorizedFetchInit extends Omit<RequestInit, "redirect"> {
	/**
	 * The exact origin that may receive the Aura user bearer. A request to any other origin —
	 * including a different scheme, port, or a suffix look-alike — is sent anonymously.
	 */
	readonly eligibleOrigin?: string;
}

interface RefreshControl {
	readonly controller: AbortController;
	callers: number;
	aborted: number;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, rejectSleep) => {
		if (signal?.aborted) {
			rejectSleep(new AuraCloudError("aborted"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			rejectSleep(new AuraCloudError("aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Whether a failed refresh provably left the submitted token unspent.
 *
 * `undefined` means no response arrived at all. A rejected 3xx carries no grant, and 408/429/5xx
 * are the server declining to do work. Every other status — including any 2xx that later failed
 * to parse or verify — is treated as "may have minted a rotation", which is the conservative
 * side of the only judgement call in this file.
 */
function grantCertainlyNotMinted(status: number | undefined): boolean {
	if (status === undefined) return true;
	if (status >= 300 && status < 400) return true;
	if (status === 408 || status === 429) return true;
	return status >= 500;
}

/** Bodies we can hand to `fetch` a second time without having consumed anything. */
function isReplayableBody(body: RequestInit["body"]): boolean {
	if (body === undefined || body === null) return true;
	if (typeof body === "string") return true;
	if (body instanceof URLSearchParams) return true;
	if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return true;
	if (typeof Blob !== "undefined" && body instanceof Blob) return true;
	if (typeof FormData !== "undefined" && body instanceof FormData) return true;
	return false;
}

/**
 * Mints and caches verified Aura access tokens.
 *
 * One manager serves one issuer. In-process it single-flights: a hundred concurrent callers
 * cause exactly one network refresh. Across processes the store's lease does the same job, and
 * the value submitted always comes from the lease acquisition rather than from any field on this
 * object — which is what makes a long-lived manager unable to replay a rotated-away token.
 */
export class TokenManager implements AuraAccessTokenProvider {
	readonly #authOrigin: string;
	readonly #store: AuraTokenStore;
	readonly #fetch: AuraFetch;
	readonly #now: () => number;
	readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	readonly #owner: string;
	readonly #keys: AuraAuthKeys;
	/** Memory-only. Access tokens are never persisted. */
	#access: AuraAccessToken | undefined;
	#inflight: Promise<AuraAccessToken> | undefined;
	#control: RefreshControl | undefined;
	/**
	 * Imported-API-key tokens, kept in a *separate* map that no `AuraAccessTokenProvider` method
	 * reads. An API-key principal must never be handed to a consumer that asked for the user.
	 */
	readonly #apiKeyTokens = new Map<string, AuraVerifiedToken>();

	constructor(options: TokenManagerOptions) {
		this.#authOrigin = normalizeOrigin(options.authOrigin);
		this.#store = options.store;
		this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
		this.#now = options.now ?? Date.now;
		this.#sleep = options.sleep ?? defaultSleep;
		this.#owner = options.owner ?? crypto.randomUUID();
		this.#keys = new AuraAuthKeys({ authOrigin: this.#authOrigin, fetch: this.#fetch, now: this.#now });
	}

	/** The configured auth origin, which is also the token issuer. */
	get issuer(): string {
		return this.#authOrigin;
	}

	/** The verification key resolver, shared with the auth client so logins verify identically. */
	get keys(): AuraAuthKeys {
		return this.#keys;
	}

	/** The signed-in identity, read from storage rather than from any cached grant. */
	getCachedIdentity(): AuraAccountIdentity | undefined {
		return this.#access?.identity ?? this.#store.readAuth(this.#authOrigin)?.identity;
	}

	/** Drop every in-memory token. Storage is untouched. */
	forget(): void {
		this.#access = undefined;
		this.#apiKeyTokens.clear();
	}

	/** Seed the cache with a token just verified by the login flow. */
	adoptVerifiedLogin(verified: AuraVerifiedToken, identity: AuraAccountIdentity): void {
		if (verified.principalType !== "user") throw new AuraCloudError("invalid_response");
		this.#access = { value: verified.token, expiresAtMs: verified.expiresAtMs, identity };
	}

	async getAccessToken(options: { signal?: AbortSignal; forceRefresh?: boolean } = {}): Promise<AuraAccessToken> {
		throwIfAborted(options.signal);
		if (!options.forceRefresh) {
			const cached = this.#access;
			if (cached && cached.expiresAtMs - this.#now() > AURA_ACCESS_REFRESH_SKEW_MS) return cached;
		}
		return await this.#joinRefresh(options.signal);
	}

	/**
	 * Join the issuer's in-process refresh, starting it if nobody has.
	 *
	 * The network call runs under an internal signal that is aborted only once *every* joined
	 * caller has abandoned it, so one caller's cancellation cannot cancel another's refresh.
	 */
	#joinRefresh(signal: AbortSignal | undefined): Promise<AuraAccessToken> {
		// An aborted control is not joinable. `#inflight` stays set until the shared refresh
		// settles, which is strictly later than the moment the last caller's abort fired the
		// internal controller — so without this check a caller arriving in that window would be
		// counted onto a doomed refresh and rejected with `aborted` having never asked for
		// cancellation. It starts its own instead; the abandoned one is left to unwind.
		if (!this.#inflight || this.#control?.controller.signal.aborted) {
			const control: RefreshControl = { controller: new AbortController(), callers: 0, aborted: 0 };
			this.#control = control;
			this.#inflight = this.#refresh(control.controller.signal).finally(() => {
				// Only when still current: an abandoned refresh settling later must not clear the
				// replacement that took its place.
				if (this.#control !== control) return;
				this.#inflight = undefined;
				this.#control = undefined;
			});
		}
		const control = this.#control;
		const pending = this.#inflight;
		if (!control) return pending;
		// Every joined caller is counted, signalled or not. Counting only the signalled ones would
		// let a single aborting caller satisfy "everyone left" and cancel the shared network call
		// out from under callers who never asked for cancellation.
		control.callers += 1;
		if (!signal) {
			return pending.finally(() => {
				control.callers -= 1;
			});
		}
		return new Promise<AuraAccessToken>((resolve, rejectJoin) => {
			const onAbort = () => {
				control.aborted += 1;
				if (control.aborted >= control.callers) control.controller.abort();
				rejectJoin(new AuraCloudError("aborted"));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			pending.then(resolve, rejectJoin).finally(() => {
				control.callers -= 1;
				signal.removeEventListener("abort", onAbort);
			});
		});
	}

	async #refresh(signal: AbortSignal): Promise<AuraAccessToken> {
		const deadline = this.#now() + AURA_REFRESH_WAIT_BUDGET_MS;
		for (let attempt = 0; attempt < 8; attempt++) {
			throwIfAborted(signal);
			const lease = this.#store.acquireRefreshLease(this.#authOrigin, this.#owner);
			switch (lease.status) {
				case "missing":
					throw new AuraCloudError("login_required");
				case "relogin_required":
					throw new AuraCloudError("relogin_required");
				case "busy": {
					if (this.#now() >= deadline) throw new AuraCloudError("unavailable");
					await this.#sleep(Math.max(1, lease.retryAfterMs), signal);
					continue;
				}
				case "acquired": {
					const rotated = await this.#rotate(lease, signal);
					if (rotated) return rotated;
					// Ownership or the stored value moved under us: the response was discarded, so
					// re-read the committed state and try again.
					continue;
				}
			}
		}
		throw new AuraCloudError("unavailable");
	}

	/**
	 * Perform one leased rotation. Returns `undefined` when the outcome must be discarded and
	 * the caller should re-acquire.
	 */
	async #rotate(lease: AuraRefreshLease, signal: AbortSignal): Promise<AuraAccessToken | undefined> {
		const issuer = this.#authOrigin;
		const owner = this.#owner;
		const url = `${issuer}/token`;
		const renew = setInterval(() => {
			// A store closed by a concurrent shutdown must not turn lease renewal into an uncaught
			// exception on the timer queue; losing the lease is already a handled outcome.
			try {
				this.#store.renewRefreshLease(issuer, owner);
			} catch {
				// Ignored deliberately: the commit re-checks ownership before it writes.
			}
		}, 10_000);
		(renew as unknown as { unref?: () => void }).unref?.();
		let status: number | undefined;
		try {
			// Written before the request leaves: a crash between the server consuming this token
			// and the local commit must be detectable by the next process.
			this.#store.markRefreshSubmitted(issuer, owner, lease.refreshToken);
			const form = new URLSearchParams({
				grant_type: "refresh_token",
				client: "cli",
				refresh_token: lease.refreshToken,
			});
			const result = await auraAuthRequest({
				fetch: this.#fetch,
				url,
				form,
				signal,
				onResponse: responseStatus => {
					status = responseStatus;
				},
			});
			const grant = readGrant(result, url);
			const verified = await verifyAuraToken(
				grant.accessToken,
				cliUserContract({
					issuer,
					device: { mode: "exact", deviceId: lease.identity.deviceId },
					identity: lease.identity,
				}),
				{ keys: this.#keys, nowMs: this.#now(), signal },
			);
			if (!this.#store.renewRefreshLease(issuer, owner)) return undefined;
			const commit = this.#store.commitRefreshRotation({
				issuer,
				owner,
				previousRefreshToken: lease.refreshToken,
				previousVersion: lease.version,
				nextRefreshToken: grant.refreshToken,
				deviceId: verified.deviceId as string,
			});
			switch (commit.status) {
				case "committed": {
					const token: AuraAccessToken = {
						value: verified.token,
						expiresAtMs: verified.expiresAtMs,
						identity: commit.auth.identity,
					};
					this.#access = token;
					return token;
				}
				case "lost_lease":
				case "conflict":
					return undefined;
				case "missing":
					throw new AuraCloudError("login_required");
				case "device_mismatch":
					throw new AuraCloudError("relogin_required");
			}
		} catch (error) {
			// The in-flight marker exists to catch a crash between the server minting a rotation
			// and this process committing it — so it may only be cleared when the failure proves
			// no rotation was minted. A 429/5xx/rejected-3xx (and a request that never got a
			// response at all) provably minted nothing, and stranding the login on one of those
			// would turn a transient blip into a forced re-login. Anything else — above all a 2xx
			// whose token failed verification — keeps the marker, because the submitted refresh
			// token may already be spent.
			if (grantCertainlyNotMinted(status)) {
				// Bookkeeping must not become the reported failure. A store closed by a concurrent
				// shutdown raises a bare `bun:sqlite` error, which would escape the taxonomy and —
				// worse — mask whatever the rotation was actually failing with. Not clearing the
				// marker is the safe direction anyway: the next process re-reads it and asks for a
				// re-login rather than replaying a token that might be spent.
				try {
					this.#store.abandonRefreshAttempt(issuer, owner);
				} catch {
					// Ignored deliberately; see above.
				}
			}
			throw error;
		} finally {
			clearInterval(renew);
			// Same reasoning, and it matters most here: an exception thrown from a `finally`
			// *replaces* the error travelling through it, so an unguarded release would turn every
			// concurrent-close into `Error: Database has closed` and lose the real cause. Losing
			// the lease is already a handled outcome — the commit re-checks ownership before it
			// writes, and the lease expires on its own TTL.
			try {
				this.#store.releaseRefreshLease(issuer, owner);
			} catch {
				// Ignored deliberately; see above.
			}
		}
	}

	/**
	 * Fetch with the Aura user bearer attached to exactly one declared origin.
	 *
	 * Eligibility is an explicit parameter rather than an inferred property of the URL: every
	 * surface decides for itself which origin may see the token, and a request to anything else
	 * — a look-alike host, a different port, plain http — goes out anonymously rather than
	 * failing closed in a way callers would be tempted to work around.
	 */
	async authorizedFetch(url: string, init: AuraAuthorizedFetchInit = {}): Promise<Response> {
		const { eligibleOrigin, ...rest } = init;
		let target: URL;
		try {
			target = new URL(url);
		} catch {
			throw new AuraCloudError("invalid_configuration");
		}
		const eligible = eligibleOrigin !== undefined && normalizeOrigin(eligibleOrigin) === target.origin;
		const signal = rest.signal ?? undefined;
		const send = async (bearer: string | undefined): Promise<Response> => {
			const headers = new Headers(rest.headers ?? {});
			if (bearer !== undefined) headers.set("authorization", `Bearer ${bearer}`);
			const response = await auraTransport(this.#fetch, url, { ...rest, headers }, signal);
			await guardRedirect(response, url);
			return response;
		};
		if (!eligible) return await send(undefined);

		const token = await this.getAccessToken({ signal });
		const first = await send(token.value);
		// 403 is an authorization decision about a valid identity: refreshing cannot change it.
		if (first.status !== 401 || !isReplayableBody(rest.body)) return first;
		await cancelBody(first);
		const refreshed = await this.getAccessToken({ signal, forceRefresh: true });
		return await send(refreshed.value);
	}

	/**
	 * Exchange an imported API key for a JWT verified against its receipt.
	 *
	 * The result is cached here and *only* here: {@link getAccessToken} never reads this map, so
	 * an API-key principal cannot reach a consumer that asked for the signed-in user.
	 */
	async getImportedApiKeyToken(input: {
		receipt: AuraImportReceipt;
		credential: string;
		signal?: AbortSignal;
	}): Promise<AuraVerifiedToken> {
		const receipt = input.receipt;
		if (normalizeOrigin(receipt.issuer) !== this.#authOrigin) throw new AuraCloudError("invalid_configuration");
		if (typeof input.credential !== "string" || input.credential.length === 0) {
			throw new AuraCloudError("invalid_configuration");
		}
		const cacheKey = [receipt.issuer, receipt.userId, receipt.apiKeyId, receipt.surface].join(" ");
		const cached = this.#apiKeyTokens.get(cacheKey);
		if (cached && cached.expiresAtMs - this.#now() > AURA_ACCESS_REFRESH_SKEW_MS) return cached;

		const url = `${this.#authOrigin}/token`;
		const result = await auraAuthRequest({
			fetch: this.#fetch,
			url,
			form: new URLSearchParams({
				grant_type: "urn:elide:params:grant-type:api-key",
				client: "cli",
				api_key: input.credential,
			}),
			signal: input.signal,
		});
		if (result.status !== 200 || !isPlainObject(result.body)) {
			throw mapGrantFailure(result, url);
		}
		const accessToken = result.body.access_token;
		if (typeof accessToken !== "string" || accessToken.length === 0) {
			throw new AuraCloudError("invalid_response", { status: result.status, host: url });
		}
		const verified = await verifyAuraToken(
			accessToken,
			importedApiKeyContract({ issuer: this.#authOrigin, receipt }),
			{ keys: this.#keys, nowMs: this.#now(), signal: input.signal },
		);
		this.#apiKeyTokens.set(cacheKey, verified);
		return verified;
	}
}

interface Grant {
	readonly accessToken: string;
	readonly refreshToken: string;
}

/** Map a non-success grant response onto the taxonomy. */
export function mapGrantFailure(result: AuraAuthResponse, url: string): AuraCloudError {
	const error = isPlainObject(result.body) ? result.body.error : undefined;
	if (error === "invalid_grant" || error === "expired_token") {
		return new AuraCloudError("relogin_required", { status: result.status, host: url });
	}
	if (error === "access_denied") return new AuraCloudError("access_denied", { status: result.status, host: url });
	if (result.status === 401) return new AuraCloudError("unauthorized", { status: result.status, host: url });
	if (result.status === 403) return new AuraCloudError("forbidden", { status: result.status, host: url });
	if (result.status === 429) return new AuraCloudError("rate_limited", { status: result.status, host: url });
	if (result.status >= 500) return new AuraCloudError("unavailable", { status: result.status, host: url });
	return new AuraCloudError("invalid_response", { status: result.status, host: url });
}

function readGrant(result: AuraAuthResponse, url: string): Grant {
	if (result.status !== 200 || !isPlainObject(result.body)) throw mapGrantFailure(result, url);
	const accessToken = result.body.access_token;
	const refreshToken = result.body.refresh_token;
	if (typeof accessToken !== "string" || accessToken.length === 0) {
		throw new AuraCloudError("invalid_response", { status: result.status, host: url });
	}
	if (typeof refreshToken !== "string" || refreshToken.length === 0) {
		throw new AuraCloudError("invalid_response", { status: result.status, host: url });
	}
	return { accessToken, refreshToken };
}
