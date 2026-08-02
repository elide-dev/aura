/**
 * The Aura device authorization flow.
 *
 * This client speaks exactly four routes, all fixed and relative to the configured auth origin:
 * `POST /device/authorize`, `POST /token`, `POST /revoke`, and — only ever as a *string it
 * shows the user* — `/device/verify`. It never constructs or calls `/oidc/start`,
 * `/oidc/callback`, a generic login URL, or a local callback listener, and it never opens a
 * loopback port. The browser and the server between them own the external-OIDC hop; the CLI's
 * only job is to hand the user a code and a URL it has verified belongs to the origin the
 * operator configured.
 *
 * Two rules deserve to be stated on their own:
 *
 * **The verification URIs are validated, then displayed verbatim.** Both strings the server
 * returns are parsed *solely* to check invariants — exact configured origin, https (or an
 * approved loopback http), path `/device/verify`, no credentials, no fragment, and only the
 * documented `user_code` query on the complete form. What is then displayed or opened is the
 * server's original string, byte for byte, never a re-serialization: a client that rebuilds the
 * URL from parsed parts is a client whose displayed URL can differ from the one it validated.
 * Opening a browser happens only as a direct consequence of user action.
 *
 * **Nothing is persisted before it is verified.** The access token is checked through the one
 * shared verifier in `token-manager.ts` — including a ULID device binding — before the refresh
 * token is written, and when the server asks which organization to act as, the choice must come
 * back explicitly from the user and be one the server offered. The first entry in a membership
 * list is never assumed, and an email address never implies a membership.
 */

import { AuraCloudError, isLoopbackHostname } from "./errors";
import { isPlainObject, normalizeOrigin } from "./internal";
import {
	type AuraAuthResponse,
	type AuraFetch,
	type AuraVerifiedToken,
	auraAuthRequest,
	cliUserContract,
	mapGrantFailure,
	TokenManager,
	verifyAuraToken,
} from "./token-manager";
import { AURA_SURFACE_SCOPES, type AuraAccountIdentity, type AuraTokenStore } from "./token-store";

/** The device grant type, verbatim from RFC 8628. */
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
/** The only path a verification URI may point at. */
const VERIFY_PATH = "/device/verify";
/** The only query parameter the complete verification URI may carry. */
const USER_CODE_PARAM = "user_code";
/** Fallback poll interval when the server does not state one, per RFC 8628. */
const DEFAULT_POLL_INTERVAL_MS = 5_000;
/** A `slow_down` raises the interval by this much, and it never comes back down. */
const SLOW_DOWN_STEP_MS = 5_000;
const MAX_POLL_INTERVAL_MS = 300_000;
const MAX_URI_LENGTH = 2_048;

/** What the user is shown while approval is pending. All strings are the server's own. */
export interface AuraDeviceApproval {
	readonly userCode: string;
	/** The server's `verification_uri`, byte for byte. */
	readonly verificationUri: string;
	/** The server's `verification_uri_complete`, byte for byte. */
	readonly verificationUriComplete: string;
	readonly expiresAtMs: number;
	readonly intervalMs: number;
}

/** An organization the server is willing to issue this session for. */
export interface AuraOrganizationOption {
	readonly id: string;
	readonly name?: string;
}

/** The user-facing seam. Everything interactive about login happens through it. */
export interface AuraLoginPresenter {
	/** Show the code and URL. Called once, after validation, with the server's exact strings. */
	present(approval: AuraDeviceApproval): void | Promise<void>;
	/** Open the complete URI. Called only when the user asked for a browser to be opened. */
	open?(url: string): void | Promise<void>;
	/**
	 * Choose among the organizations the server offered. Returning `undefined` means "no
	 * choice was made", which fails the login — there is deliberately no default.
	 */
	selectOrganization?(options: readonly AuraOrganizationOption[]): Promise<string | undefined>;
}

export interface AuraLoginOptions {
	readonly label?: string;
	/** Whether the user asked for a browser to be opened (`--no-open` makes this false). */
	readonly open?: boolean;
	readonly presenter?: AuraLoginPresenter;
	readonly signal?: AbortSignal;
}

export interface AuraLoginResult {
	readonly identity: AuraAccountIdentity;
	/** Expiry of the access token minted by this login. */
	readonly expiresAtMs: number;
}

export interface AuraLogoutOptions {
	/** Forget locally even if the server would not revoke. */
	readonly force?: boolean;
	readonly signal?: AbortSignal;
}

export interface AuraLogoutResult {
	readonly revoked: boolean;
	readonly forgotten: boolean;
}

/** Redaction-safe account summary. Carries no credential of any kind. */
export interface AuraAccountStatus {
	readonly signedIn: boolean;
	readonly issuer: string;
	readonly identity: AuraAccountIdentity | undefined;
}

export interface AuraAuthClientOptions {
	/** The resolved auth origin. Never re-derived here. */
	readonly authOrigin: string;
	readonly store: AuraTokenStore;
	readonly manager?: TokenManager;
	readonly fetch?: AuraFetch;
	readonly now?: () => number;
	readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function invalid(): never {
	throw new AuraCloudError("invalid_response");
}

/**
 * Check one verification URI string against every invariant, and return nothing.
 *
 * Returning nothing is the point: there is no "normalized" URI for a caller to accidentally
 * display. The only string that reaches the user is the one that came off the wire.
 */
function validateVerificationUri(
	raw: unknown,
	options: { authOrigin: string; userCode?: string },
): asserts raw is string {
	if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URI_LENGTH) invalid();
	// Screen the bytes the server actually sent, before the WHATWG parser gets a chance to
	// rewrite backslashes, strip control characters, or absorb a userinfo segment.
	for (const char of raw) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 0x21 || code > 0x7e) invalid();
	}
	if (raw.includes("\\") || raw.includes("@") || raw.includes("#")) invalid();

	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return invalid();
	}
	if (url.origin !== options.authOrigin) invalid();
	// Same membership question as `deployment.ts` and `classifyHost`, one answer. The policy is
	// this call site's own: an approved http verification URI is only reachable at all because
	// the origin already had to match the configured auth origin, which `deployment.ts` would
	// only have accepted over http on the same loopback set.
	if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) invalid();
	if (url.username !== "" || url.password !== "" || url.hash !== "") invalid();
	if (url.pathname !== VERIFY_PATH) invalid();

	if (options.userCode === undefined) {
		if (url.search !== "") invalid();
		return;
	}
	const keys = [...url.searchParams.keys()];
	if (keys.length !== 1 || keys[0] !== USER_CODE_PARAM) invalid();
	if (url.searchParams.get(USER_CODE_PARAM) !== options.userCode) invalid();
}

interface DeviceAuthorization {
	readonly deviceCode: string;
	readonly approval: AuraDeviceApproval;
}

function readAuthorization(
	result: AuraAuthResponse,
	url: string,
	authOrigin: string,
	nowMs: number,
): DeviceAuthorization {
	if (result.status !== 200 || !isPlainObject(result.body)) throw mapGrantFailure(result, url);
	const body = result.body;
	const deviceCode = body.device_code;
	const userCode = body.user_code;
	if (typeof deviceCode !== "string" || deviceCode.length === 0) invalid();
	if (typeof userCode !== "string" || userCode.length === 0) invalid();
	validateVerificationUri(body.verification_uri, { authOrigin });
	validateVerificationUri(body.verification_uri_complete, { authOrigin, userCode });
	const expiresIn = body.expires_in;
	if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) invalid();
	let intervalMs = DEFAULT_POLL_INTERVAL_MS;
	if (body.interval !== undefined) {
		const interval = body.interval;
		if (typeof interval !== "number" || !Number.isFinite(interval) || interval <= 0) invalid();
		intervalMs = Math.min(interval * 1000, MAX_POLL_INTERVAL_MS);
	}
	return {
		deviceCode,
		approval: {
			userCode,
			verificationUri: body.verification_uri,
			verificationUriComplete: body.verification_uri_complete,
			expiresAtMs: nowMs + expiresIn * 1000,
			intervalMs,
		},
	};
}

function readOrganizations(body: Record<string, unknown>): AuraOrganizationOption[] {
	const raw = body.organizations;
	if (!Array.isArray(raw) || raw.length === 0) invalid();
	return raw.map(entry => {
		if (!isPlainObject(entry)) return invalid();
		const id = entry.id;
		if (typeof id !== "string" || id.length === 0) invalid();
		const name = entry.name;
		return { id, name: typeof name === "string" ? name : undefined };
	});
}

/**
 * Device login, logout and account status for one auth origin.
 *
 * Holds no credential of its own: the refresh grant lives in the store and the access token in
 * the {@link TokenManager}, which is also the only thing that ever verifies a token.
 */
export class AuraAuthClient {
	readonly #authOrigin: string;
	readonly #store: AuraTokenStore;
	readonly #manager: TokenManager;
	readonly #fetch: AuraFetch;
	readonly #now: () => number;
	readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

	constructor(options: AuraAuthClientOptions) {
		this.#authOrigin = normalizeOrigin(options.authOrigin);
		this.#store = options.store;
		this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
		this.#now = options.now ?? Date.now;
		this.#sleep =
			options.sleep ??
			((ms, signal) =>
				new Promise((resolve, reject) => {
					const timer = setTimeout(resolve, ms);
					signal?.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							reject(new AuraCloudError("aborted"));
						},
						{ once: true },
					);
				}));
		this.#manager =
			options.manager ??
			new TokenManager({
				authOrigin: this.#authOrigin,
				store: options.store,
				fetch: this.#fetch,
				now: this.#now,
				sleep: this.#sleep,
			});
	}

	/** The token manager this client primes on a successful login. */
	get manager(): TokenManager {
		return this.#manager;
	}

	/** The signed-in account, with no credential material anywhere in the result. */
	status(): AuraAccountStatus {
		const stored = this.#store.readAuth(this.#authOrigin);
		return { signedIn: stored !== undefined, issuer: this.#authOrigin, identity: stored?.identity };
	}

	/**
	 * Run the device flow to completion.
	 *
	 * Order matters and is load-bearing: authorize, validate both URIs, show them, poll, verify
	 * the returned token (device binding included), and only then persist the refresh grant.
	 */
	async login(options: AuraLoginOptions = {}): Promise<AuraLoginResult> {
		const signal = options.signal;
		this.#throwIfAborted(signal);
		const authorizeUrl = `${this.#authOrigin}/device/authorize`;
		const payload: Record<string, unknown> = {
			client: "cli",
			installation_id: this.#store.getInstallationId(),
		};
		if (options.label !== undefined) payload.device_label = options.label;
		const authorization = readAuthorization(
			await auraAuthRequest({ fetch: this.#fetch, url: authorizeUrl, json: payload, signal }),
			authorizeUrl,
			this.#authOrigin,
			this.#now(),
		);

		const presenter = options.presenter;
		await presenter?.present(authorization.approval);
		// Only ever as a consequence of the user's own invocation.
		if (options.open === true) await presenter?.open?.(authorization.approval.verificationUriComplete);

		const grant = await this.#poll(authorization, presenter, signal);
		const verified = await verifyAuraToken(
			grant.accessToken,
			cliUserContract({
				issuer: this.#authOrigin,
				// Learned here and pinned forever after: every later refresh must present it.
				device: { mode: "require" },
				identity: grant.organizationId === undefined ? undefined : { orgId: grant.organizationId },
			}),
			{ keys: this.#manager.keys, nowMs: this.#now(), signal },
		);
		return this.#persist(verified, grant.refreshToken);
	}

	/** Revoke the refresh grant at the server, then forget it locally. */
	async logout(options: AuraLogoutOptions = {}): Promise<AuraLogoutResult> {
		const stored = this.#store.readAuth(this.#authOrigin);
		if (!stored) throw new AuraCloudError("login_required");
		const url = `${this.#authOrigin}/revoke`;
		let revoked = false;
		try {
			const result = await auraAuthRequest({
				fetch: this.#fetch,
				url,
				form: new URLSearchParams({
					token: stored.refreshToken,
					token_type_hint: "refresh_token",
					client: "cli",
				}),
				signal: options.signal,
			});
			if (result.status < 200 || result.status >= 300) throw mapGrantFailure(result, url);
			revoked = true;
		} catch (error) {
			// An abort is never a licence to forget: the user asked to stop, not to sign out.
			if (!options.force || (error instanceof AuraCloudError && error.code === "aborted")) throw error;
		}
		this.#store.deleteAuth(this.#authOrigin);
		this.#manager.forget();
		return { revoked, forgotten: true };
	}

	#throwIfAborted(signal: AbortSignal | undefined): void {
		if (signal?.aborted) throw new AuraCloudError("aborted");
	}

	/**
	 * Poll the token endpoint until approval, denial, or the device code's deadline.
	 *
	 * `slow_down` raises the interval permanently — a server that asked once to be polled less
	 * often should not have to ask again on the very next tick.
	 */
	async #poll(
		authorization: DeviceAuthorization,
		presenter: AuraLoginPresenter | undefined,
		signal: AbortSignal | undefined,
	): Promise<{ accessToken: string; refreshToken: string; organizationId: string | undefined }> {
		const url = `${this.#authOrigin}/token`;
		let intervalMs = authorization.approval.intervalMs;
		let organizationId: string | undefined;
		for (;;) {
			this.#throwIfAborted(signal);
			const form = new URLSearchParams({
				grant_type: DEVICE_GRANT_TYPE,
				device_code: authorization.deviceCode,
				client: "cli",
			});
			if (organizationId !== undefined) form.set("organization_id", organizationId);
			const result = await auraAuthRequest({ fetch: this.#fetch, url, form, signal });
			this.#throwIfAborted(signal);

			if (result.status >= 200 && result.status < 300) {
				if (!isPlainObject(result.body)) invalid();
				const accessToken = result.body.access_token;
				const refreshToken = result.body.refresh_token;
				if (typeof accessToken !== "string" || accessToken.length === 0) invalid();
				if (typeof refreshToken !== "string" || refreshToken.length === 0) invalid();
				return { accessToken, refreshToken, organizationId };
			}

			const error = isPlainObject(result.body) ? result.body.error : undefined;
			if (error === "organization_selection_required") {
				if (organizationId !== undefined) invalid();
				organizationId = await this.#selectOrganization(
					readOrganizations(result.body as Record<string, unknown>),
					presenter,
				);
				// The user just acted; resume immediately rather than sitting out an interval.
				continue;
			}
			if (error === "slow_down") {
				intervalMs = Math.min(intervalMs + SLOW_DOWN_STEP_MS, MAX_POLL_INTERVAL_MS);
			} else if (error !== "authorization_pending") {
				if (error === "expired_token") throw new AuraCloudError("expired", { status: result.status, host: url });
				if (error === "access_denied") {
					throw new AuraCloudError("access_denied", { status: result.status, host: url });
				}
				throw new AuraCloudError("invalid_response", { status: result.status, host: url });
			}

			if (this.#now() + intervalMs >= authorization.approval.expiresAtMs) {
				throw new AuraCloudError("expired", { host: url });
			}
			try {
				await this.#sleep(intervalMs, signal);
			} catch (sleepError) {
				if (sleepError instanceof AuraCloudError) throw sleepError;
				throw new AuraCloudError("aborted", { cause: sleepError });
			}
		}
	}

	/**
	 * Obtain an explicit, server-offered organization choice.
	 *
	 * There is no fallback branch on purpose. Picking the first membership, or one derived from
	 * an email domain, would silently place a session in a tenant the user never named.
	 */
	async #selectOrganization(
		offered: readonly AuraOrganizationOption[],
		presenter: AuraLoginPresenter | undefined,
	): Promise<string> {
		const chosen = await presenter?.selectOrganization?.(offered);
		if (chosen === undefined) throw new AuraCloudError("access_denied");
		if (!offered.some(option => option.id === chosen)) throw new AuraCloudError("forbidden");
		return chosen;
	}

	/** Persist a verified login and prime the manager with the access token it just checked. */
	#persist(verified: AuraVerifiedToken, refreshToken: string): AuraLoginResult {
		const deviceId = verified.deviceId;
		if (deviceId === undefined) invalid();
		const identity: AuraAccountIdentity = {
			issuer: this.#authOrigin,
			deviceId,
			userId: verified.subject,
			orgId: verified.orgId,
			accountId: verified.accountId,
			realmId: verified.realmId,
			roles: [...verified.roles],
			scopes: AURA_SURFACE_SCOPES,
		};
		const stored = this.#store.saveLogin({ identity, refreshToken });
		this.#manager.forget();
		this.#manager.adoptVerifiedLogin(verified, stored.identity);
		return { identity: stored.identity, expiresAtMs: verified.expiresAtMs };
	}
}
