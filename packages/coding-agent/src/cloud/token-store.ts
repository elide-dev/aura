/**
 * Hardened local storage for Aura cloud identity.
 *
 * The store owns everything about the cloud client that outlives a process: the per-profile
 * installation id, the refresh token for each issuer, the identity that token belongs to, and
 * the per-`(issuer,user_id)` profile/cache/sync/import-receipt namespaces.
 *
 * Three rules shape the whole file:
 *
 * 1. **Only refresh tokens persist.** Access tokens and API-key-exchange JWTs are short-lived
 *    bearer credentials; they live in the token manager's memory and there is deliberately no
 *    method here that accepts one. Import receipts record a prefix and a SHA-256 digest, never
 *    the key.
 * 2. **Nothing user-scoped is reachable by issuer alone.** `aura_cloud_auth` is keyed by issuer
 *    because exactly one account is signed in per issuer at a time, but every derived row —
 *    profile, cache, sync cursor, conflict, receipt — is keyed by `(issuer,user_id)` and every
 *    accessor demands both. Signing in as a different user at the same issuer closes the old
 *    namespace and retains its rows; it never merges them.
 * 3. **Refresh rotation is arbitrated by the database, not by object state.** A manager never
 *    holds a refresh token across a rotation. `BEGIN IMMEDIATE` lease acquisition atomically
 *    returns the *current* value and version, the winner submits only that value, and the CAS
 *    write compares the same value and version while re-checking lease ownership. A process
 *    constructed before another rotated therefore submits the reloaded token, never a cached
 *    one, and a fenced owner's late response is discarded rather than written.
 *
 * The version is `updated_at`, monotonically advanced on every write, so no column beyond the
 * pinned schema is needed to make the compare-and-swap total.
 */

import { Database } from "bun:sqlite";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";
import { hardenSqliteFileModes, openHardenedSqlite, SQLITE_BUSY_TIMEOUT_MS } from "@oh-my-pi/pi-utils/sqlite-hardening";
import { AuraCloudError } from "./errors";

// =============================================================================
// Public contract
// =============================================================================

/** The exact surface scope set an interactive CLI user session carries. */
export const AURA_SURFACE_SCOPES = [
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

/** One scope from {@link AURA_SURFACE_SCOPES}. */
export type AuraSurfaceScope = (typeof AURA_SURFACE_SCOPES)[number];

/** The verified principal behind a signed-in Aura session. */
export interface AuraAccountIdentity {
	issuer: string;
	deviceId: string;
	userId: string;
	orgId: string;
	accountId: string;
	realmId: string;
	roles: readonly string[];
	scopes: typeof AURA_SURFACE_SCOPES;
}

/** A minted, memory-only access token. Never persisted. */
export interface AuraAccessToken {
	value: string;
	expiresAtMs: number;
	identity: AuraAccountIdentity;
}

/** The seam consumers use to obtain a user access token. */
export interface AuraAccessTokenProvider {
	getAccessToken(options?: { signal?: AbortSignal; forceRefresh?: boolean }): Promise<AuraAccessToken>;
	getCachedIdentity(): AuraAccountIdentity | undefined;
}

/** The renewable cross-process refresh lease duration. */
export const AURA_REFRESH_LEASE_TTL_MS = 30_000;

/** A stored refresh credential plus the identity and version it is bound to. */
export interface AuraStoredAuth {
	readonly identity: AuraAccountIdentity;
	readonly refreshToken: string;
	/** Compare-and-swap version; also the row's `updated_at`. */
	readonly version: number;
}

/** A `(issuer,user_id)` namespace. Both halves are always required. */
export interface AuraAccountNamespace {
	readonly issuer: string;
	readonly userId: string;
}

/** A held refresh lease, carrying the value/version the holder must submit and CAS on. */
export interface AuraRefreshLease {
	readonly status: "acquired";
	readonly owner: string;
	readonly expiresAtMs: number;
	readonly refreshToken: string;
	readonly version: number;
	readonly identity: AuraAccountIdentity;
}

/** The outcome of a lease acquisition attempt. */
export type AuraLeaseAcquisition =
	| AuraRefreshLease
	/** Another owner holds an unexpired lease. */
	| { readonly status: "busy"; readonly retryAfterMs: number }
	/** No usable auth row for the issuer: the caller must log in. */
	| { readonly status: "missing" }
	/** A previous attempt submitted this exact token and never committed: it may be consumed. */
	| { readonly status: "relogin_required" };

/** The outcome of a compare-and-swap rotation commit. */
export type AuraRotationResult =
	| { readonly status: "committed"; readonly auth: AuraStoredAuth }
	/** The lease expired or moved to another owner: the response must be discarded. */
	| { readonly status: "lost_lease" }
	/** The stored value/version moved: another rotation won. */
	| { readonly status: "conflict" }
	/** The row is gone. */
	| { readonly status: "missing" }
	/** The refreshed grant is bound to a different device than the persisted one. */
	| { readonly status: "device_mismatch" };

/** Non-secret metadata retained about an imported API key. */
export interface AuraImportReceipt {
	readonly issuer: string;
	readonly userId: string;
	readonly apiKeyId: string;
	/** First bytes of the key, for human recognition only. */
	readonly tokenPrefix: string;
	/** Hex SHA-256 of the key, so a re-import can be recognised without storing the key. */
	readonly tokenSha256: string;
	readonly surface: string;
	readonly scopes: readonly string[];
	readonly deadlineAtMs: number;
	readonly realmId: string;
	readonly orgId: string;
	readonly accountId: string;
	readonly createdAtMs: number;
}

/** Input for {@link AuraTokenStore.recordImportReceipt}. The key is hashed, never stored. */
export interface AuraImportReceiptInput {
	readonly issuer: string;
	readonly userId: string;
	readonly apiKeyId: string;
	/** The raw imported key. Reduced to a prefix and digest before it touches SQLite. */
	readonly apiKey: string;
	readonly surface: string;
	readonly scopes: readonly string[];
	readonly deadlineAtMs: number;
	readonly realmId: string;
	readonly orgId: string;
	readonly accountId: string;
}

/** A `(issuer,user_id)` account row, active or retained. */
export interface AuraStoredAccount {
	readonly issuer: string;
	readonly userId: string;
	readonly orgId: string;
	readonly accountId: string;
	readonly realmId: string;
	readonly active: boolean;
	readonly openedAtMs: number;
	readonly closedAtMs: number | undefined;
}

/** A recorded sync conflict, retained for later reconciliation. */
export interface AuraSyncConflict {
	readonly stream: string;
	readonly itemId: string;
	readonly detail: unknown;
	readonly createdAtMs: number;
}

// =============================================================================
// Internals
// =============================================================================

const SCHEMA_VERSION = 1;
const TOKEN_PREFIX_LENGTH = 8;
/** Crockford base32, excluding I/L/O/U. */
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Generate an uppercase Crockford ULID.
 *
 * Local because the identifier has to be lexicographically sortable and 26 characters to
 * satisfy the server's `sub`/`device`/installation contract; a UUID would not round-trip.
 */
function newUlid(nowMs: number = Date.now()): string {
	let time = "";
	let remaining = nowMs;
	for (let i = 0; i < 10; i++) {
		time = ULID_ALPHABET[remaining % 32] + time;
		remaining = Math.floor(remaining / 32);
	}
	const random = new Uint8Array(16);
	crypto.getRandomValues(random);
	let suffix = "";
	for (const byte of random) suffix += ULID_ALPHABET[byte % 32];
	return time + suffix;
}

function isUlid(value: unknown): value is string {
	return typeof value === "string" && ULID_RE.test(value);
}

function requireNamespace(ns: AuraAccountNamespace | undefined): AuraAccountNamespace {
	// A namespace with a blank user id would silently widen a lookup to "any user at this
	// issuer", which is exactly the shape this store forbids. Fail loudly instead.
	const issuer = ns?.issuer;
	const userId = ns?.userId;
	if (typeof issuer !== "string" || issuer.length === 0) throw new AuraCloudError("invalid_configuration");
	if (typeof userId !== "string" || userId.length === 0) throw new AuraCloudError("invalid_configuration");
	return { issuer, userId };
}

function requireIssuer(issuer: string): string {
	if (typeof issuer !== "string" || issuer.length === 0) throw new AuraCloudError("invalid_configuration");
	return issuer;
}

function parseJsonArray(raw: unknown): string[] | undefined {
	if (typeof raw !== "string") return undefined;
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return undefined;
		if (!parsed.every(item => typeof item === "string")) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

function sha256Hex(value: string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

interface AuthRow {
	issuer: string;
	refresh_token: string;
	device_id: string;
	user_id: string;
	org_id: string;
	account_id: string;
	realm_id: string;
	roles_json: string;
	scopes_json: string;
	updated_at: number;
	refresh_lease_owner: string | null;
	refresh_lease_expires_at: number | null;
}

/**
 * Turn a stored row into an identity, or `undefined` when anything about it is malformed.
 *
 * Legacy or hand-edited rows are treated as absent rather than repaired: a partially trusted
 * identity is worse than no identity, because the scope/device fields are what the token
 * verifier compares against.
 */
function rowToAuth(row: AuthRow | null | undefined): AuraStoredAuth | undefined {
	if (!row) return undefined;
	if (typeof row.issuer !== "string" || row.issuer.length === 0) return undefined;
	if (typeof row.refresh_token !== "string" || row.refresh_token.length === 0) return undefined;
	if (!isUlid(row.device_id) || !isUlid(row.user_id)) return undefined;
	if (!isUlid(row.org_id) || !isUlid(row.account_id) || !isUlid(row.realm_id)) return undefined;
	const roles = parseJsonArray(row.roles_json);
	const scopes = parseJsonArray(row.scopes_json);
	if (!roles || !scopes) return undefined;
	// The scope set is exact, not a superset: an unexpected scope means the row was written by
	// something that does not share this client's contract.
	if (scopes.length !== AURA_SURFACE_SCOPES.length) return undefined;
	if (!AURA_SURFACE_SCOPES.every((scope, index) => scopes[index] === scope)) return undefined;
	if (typeof row.updated_at !== "number") return undefined;
	return {
		refreshToken: row.refresh_token,
		version: row.updated_at,
		identity: {
			issuer: row.issuer,
			deviceId: row.device_id,
			userId: row.user_id,
			orgId: row.org_id,
			accountId: row.account_id,
			realmId: row.realm_id,
			roles,
			scopes: AURA_SURFACE_SCOPES,
		},
	};
}

/**
 * Local storage for the Aura cloud client.
 *
 * Instances are cheap and hold no credential state between calls: every read goes to SQLite so
 * that a second process (or a second instance in this one) rotating a token is observed rather
 * than overwritten.
 */
export class AuraTokenStore {
	readonly #db: Database;
	readonly #dbPath: string;
	#installationId: string | undefined;

	private constructor(db: Database, dbPath: string) {
		this.#db = db;
		this.#dbPath = dbPath;
	}

	/** Open (creating if needed) the cloud tables in the canonical agent database. */
	static async open(dbPath: string = getAgentDbPath()): Promise<AuraTokenStore> {
		const db = await openHardenedSqlite({
			dbPath,
			open: file => new Database(file, { create: true }),
			onOpen: handle => {
				AuraTokenStore.#initializeSchema(handle);
			},
			onExhausted: ({ lastError }) => new AuraCloudError("unavailable", { cause: lastError }),
		});
		// `openHardenedSqlite` has already clamped the database and its WAL/SHM sidecars: it
		// does so after `onOpen`, which is where WAL mode is switched on and the sidecars appear.
		return new AuraTokenStore(db, dbPath);
	}

	/** Path of the underlying database. */
	get dbPath(): string {
		return this.#dbPath;
	}

	close(): void {
		this.#db.close();
	}

	/** Re-clamp the database and its WAL/SHM sidecars to `0600`. */
	async hardenFileModes(): Promise<void> {
		await hardenSqliteFileModes(this.#dbPath);
	}

	/** The active journal mode; `"wal"` for every hardened connection. */
	journalMode(): string {
		const row = this.#db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
		return row.journal_mode.toLowerCase();
	}

	/** The busy handler timeout in milliseconds. */
	busyTimeoutMs(): number {
		const row = this.#db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
		return row.timeout;
	}

	static #initializeSchema(db: Database): void {
		// Before any lock-taking statement — `PRAGMA journal_mode=WAL` takes an exclusive lock
		// during WAL recovery and would otherwise fail outright under concurrent starts.
		db.run(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
		db.run("PRAGMA journal_mode=WAL");
		db.run("PRAGMA synchronous=NORMAL");
		db.run(`
			CREATE TABLE IF NOT EXISTS aura_cloud_device (
			  singleton INTEGER PRIMARY KEY CHECK(singleton=1), installation_id TEXT NOT NULL, created_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS aura_cloud_auth (
			  issuer TEXT PRIMARY KEY, refresh_token TEXT NOT NULL,
			  device_id TEXT NOT NULL,
			  user_id TEXT NOT NULL, org_id TEXT NOT NULL, account_id TEXT NOT NULL, realm_id TEXT NOT NULL,
			  roles_json TEXT NOT NULL, scopes_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
			  refresh_lease_owner TEXT, refresh_lease_expires_at INTEGER
			);
			CREATE TABLE IF NOT EXISTS aura_cloud_schema_version (
			  id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS aura_cloud_account (
			  issuer TEXT NOT NULL, user_id TEXT NOT NULL,
			  org_id TEXT NOT NULL, account_id TEXT NOT NULL, realm_id TEXT NOT NULL,
			  opened_at INTEGER NOT NULL, closed_at INTEGER,
			  PRIMARY KEY (issuer, user_id)
			);
			CREATE TABLE IF NOT EXISTS aura_cloud_profile (
			  issuer TEXT NOT NULL, user_id TEXT NOT NULL, key TEXT NOT NULL,
			  value_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
			  PRIMARY KEY (issuer, user_id, key)
			);
			CREATE TABLE IF NOT EXISTS aura_cloud_cache (
			  issuer TEXT NOT NULL, user_id TEXT NOT NULL, key TEXT NOT NULL,
			  value_json TEXT NOT NULL, expires_at INTEGER NOT NULL,
			  PRIMARY KEY (issuer, user_id, key)
			);
			CREATE TABLE IF NOT EXISTS aura_cloud_sync_cursor (
			  issuer TEXT NOT NULL, user_id TEXT NOT NULL, stream TEXT NOT NULL,
			  cursor TEXT NOT NULL, updated_at INTEGER NOT NULL,
			  PRIMARY KEY (issuer, user_id, stream)
			);
			CREATE TABLE IF NOT EXISTS aura_cloud_sync_conflict (
			  id INTEGER PRIMARY KEY AUTOINCREMENT,
			  issuer TEXT NOT NULL, user_id TEXT NOT NULL, stream TEXT NOT NULL,
			  item_id TEXT NOT NULL, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_aura_cloud_sync_conflict_ns
			  ON aura_cloud_sync_conflict(issuer, user_id, stream);
			CREATE TABLE IF NOT EXISTS aura_cloud_import_receipt (
			  issuer TEXT NOT NULL, user_id TEXT NOT NULL, api_key_id TEXT NOT NULL,
			  token_prefix TEXT NOT NULL, token_sha256 TEXT NOT NULL,
			  surface TEXT NOT NULL, scopes_json TEXT NOT NULL, deadline_at INTEGER NOT NULL,
			  realm_id TEXT NOT NULL, org_id TEXT NOT NULL, account_id TEXT NOT NULL,
			  created_at INTEGER NOT NULL,
			  PRIMARY KEY (issuer, user_id, api_key_id)
			);
			CREATE TABLE IF NOT EXISTS aura_cloud_refresh_inflight (
			  issuer TEXT PRIMARY KEY, owner TEXT NOT NULL,
			  token_sha256 TEXT NOT NULL, started_at INTEGER NOT NULL
			);
		`);
		AuraTokenStore.#migrate(db);
	}

	/**
	 * Bring a database written by an older build up to {@link SCHEMA_VERSION}.
	 *
	 * `CREATE TABLE IF NOT EXISTS` is a no-op against an existing table, so a pre-lease
	 * `aura_cloud_auth` keeps its old column set until it is widened here.
	 */
	static #migrate(db: Database): void {
		const columns = new Set(
			(db.prepare("PRAGMA table_info(aura_cloud_auth)").all() as { name: string }[]).map(c => c.name),
		);
		if (!columns.has("refresh_lease_owner")) {
			db.run("ALTER TABLE aura_cloud_auth ADD COLUMN refresh_lease_owner TEXT");
		}
		if (!columns.has("refresh_lease_expires_at")) {
			db.run("ALTER TABLE aura_cloud_auth ADD COLUMN refresh_lease_expires_at INTEGER");
		}
		db.run(
			"INSERT INTO aura_cloud_schema_version (id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version",
			[SCHEMA_VERSION] as never,
		);
	}

	// -------------------------------------------------------------------------
	// Installation identity
	// -------------------------------------------------------------------------

	/**
	 * The persisted uppercase ULID identifying this installation of this profile.
	 *
	 * Per *profile*, not per machine: profiles have separate agent databases precisely so their
	 * cloud identities do not correlate. Distinct from the rollout `getInstallId()` UUID, which
	 * is anchored to the base config root and shared across profiles.
	 */
	getInstallationId(): string {
		if (this.#installationId) return this.#installationId;
		const insert = this.#db.transaction((id: string, now: number) => {
			this.#db.run(
				"INSERT OR IGNORE INTO aura_cloud_device (singleton, installation_id, created_at) VALUES (1, ?, ?)",
				[id, now] as never,
			);
		});
		insert.immediate(newUlid(), Date.now());
		const row = this.#db.prepare("SELECT installation_id FROM aura_cloud_device WHERE singleton = 1").get() as {
			installation_id: string;
		} | null;
		// A row written by an older/corrupted build is replaced rather than trusted: the server
		// rejects a non-ULID installation id outright.
		if (!row || !isUlid(row.installation_id)) {
			const replacement = newUlid();
			this.#db.run(
				"INSERT INTO aura_cloud_device (singleton, installation_id, created_at) VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET installation_id = excluded.installation_id, created_at = excluded.created_at",
				[replacement, Date.now()] as never,
			);
			this.#installationId = replacement;
			return replacement;
		}
		this.#installationId = row.installation_id;
		return row.installation_id;
	}

	// -------------------------------------------------------------------------
	// Auth rows
	// -------------------------------------------------------------------------

	/** The stored auth for an issuer, or `undefined` when absent or malformed. */
	readAuth(issuer: string): AuraStoredAuth | undefined {
		return rowToAuth(this.#authRow(requireIssuer(issuer)));
	}

	#authRow(issuer: string): AuthRow | null {
		return this.#db.prepare("SELECT * FROM aura_cloud_auth WHERE issuer = ?").get(issuer) as AuthRow | null;
	}

	/**
	 * Persist a freshly verified login, replacing whatever was stored for the issuer.
	 *
	 * Replacing a *different* user closes the previous namespace: its rows are retained (the
	 * user may sign back in) but it stops being the active account. Re-logging in as the same
	 * user with a different org selection keeps the one namespace and updates its tenancy.
	 */
	saveLogin(input: { identity: AuraAccountIdentity; refreshToken: string }): AuraStoredAuth {
		const identity = input.identity;
		requireIssuer(identity.issuer);
		if (!isUlid(identity.deviceId) || !isUlid(identity.userId)) throw new AuraCloudError("invalid_configuration");
		if (!isUlid(identity.orgId) || !isUlid(identity.accountId) || !isUlid(identity.realmId)) {
			throw new AuraCloudError("invalid_configuration");
		}
		if (typeof input.refreshToken !== "string" || input.refreshToken.length === 0) {
			throw new AuraCloudError("invalid_configuration");
		}
		const write = this.#db.transaction(() => {
			// Inside the immediate transaction: a version read outside it could tie with a
			// concurrent writer's and leave two distinct rows sharing one CAS version.
			const version = this.#nextVersion(identity.issuer);
			this.#db.run(
				`INSERT INTO aura_cloud_auth (issuer, refresh_token, device_id, user_id, org_id, account_id, realm_id, roles_json, scopes_json, updated_at, refresh_lease_owner, refresh_lease_expires_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
				 ON CONFLICT(issuer) DO UPDATE SET
				   refresh_token = excluded.refresh_token, device_id = excluded.device_id, user_id = excluded.user_id,
				   org_id = excluded.org_id, account_id = excluded.account_id, realm_id = excluded.realm_id,
				   roles_json = excluded.roles_json, scopes_json = excluded.scopes_json, updated_at = excluded.updated_at,
				   refresh_lease_owner = NULL, refresh_lease_expires_at = NULL`,
				[
					identity.issuer,
					input.refreshToken,
					identity.deviceId,
					identity.userId,
					identity.orgId,
					identity.accountId,
					identity.realmId,
					JSON.stringify([...identity.roles]),
					JSON.stringify([...AURA_SURFACE_SCOPES]),
					version,
				] as never,
			);
			// A fresh grant supersedes any half-finished rotation, poisoned or not.
			this.#db.run("DELETE FROM aura_cloud_refresh_inflight WHERE issuer = ?", [identity.issuer] as never);
			this.#db.run(
				"UPDATE aura_cloud_account SET closed_at = ? WHERE issuer = ? AND user_id != ? AND closed_at IS NULL",
				[version, identity.issuer, identity.userId] as never,
			);
			this.#db.run(
				`INSERT INTO aura_cloud_account (issuer, user_id, org_id, account_id, realm_id, opened_at, closed_at)
				 VALUES (?, ?, ?, ?, ?, ?, NULL)
				 ON CONFLICT(issuer, user_id) DO UPDATE SET
				   org_id = excluded.org_id, account_id = excluded.account_id, realm_id = excluded.realm_id, closed_at = NULL`,
				[identity.issuer, identity.userId, identity.orgId, identity.accountId, identity.realmId, version] as never,
			);
		});
		write.immediate();
		const stored = this.readAuth(identity.issuer);
		if (!stored) throw new AuraCloudError("invalid_configuration");
		return stored;
	}

	/** Forget the issuer's refresh credential and every trace of its rotation state. */
	deleteAuth(issuer: string): void {
		const key = requireIssuer(issuer);
		const remove = this.#db.transaction(() => {
			this.#db.run("DELETE FROM aura_cloud_auth WHERE issuer = ?", [key] as never);
			this.#db.run("DELETE FROM aura_cloud_refresh_inflight WHERE issuer = ?", [key] as never);
		});
		remove.immediate();
	}

	/**
	 * A version strictly greater than the row's current one.
	 *
	 * Wall-clock milliseconds are the natural choice, but two writes inside the same
	 * millisecond would otherwise share a version and make the CAS ambiguous.
	 */
	#nextVersion(issuer: string): number {
		const row = this.#db.prepare("SELECT updated_at FROM aura_cloud_auth WHERE issuer = ?").get(issuer) as {
			updated_at: number;
		} | null;
		const now = Date.now();
		const previous = typeof row?.updated_at === "number" ? row.updated_at : 0;
		return now > previous ? now : previous + 1;
	}

	// -------------------------------------------------------------------------
	// Refresh lease and rotation
	// -------------------------------------------------------------------------

	/**
	 * Take the issuer's refresh lease, returning the value and version the holder must use.
	 *
	 * The read happens *inside* the `BEGIN IMMEDIATE` that writes the lease, so the returned
	 * value is the committed one at the moment ownership was granted — that is what makes a
	 * long-lived manager unable to submit a token another process already rotated away.
	 *
	 * `owner` identifies the holder for lease exclusivity and renewal fencing. It does not have
	 * to be unique across process lifetimes: `relogin_required` is decided from the in-flight
	 * token digest alone, so a restarted process that reuses a dead attempt's owner string is
	 * still stopped from replaying that attempt's token.
	 */
	acquireRefreshLease(issuer: string, owner: string, ttlMs: number = AURA_REFRESH_LEASE_TTL_MS): AuraLeaseAcquisition {
		const key = requireIssuer(issuer);
		if (typeof owner !== "string" || owner.length === 0) throw new AuraCloudError("invalid_configuration");
		const acquire = this.#db.transaction((): AuraLeaseAcquisition => {
			const now = Date.now();
			const row = this.#authRow(key);
			const auth = rowToAuth(row);
			if (!row || !auth) return { status: "missing" };
			const heldBy = row.refresh_lease_owner;
			const heldUntil = typeof row.refresh_lease_expires_at === "number" ? row.refresh_lease_expires_at : 0;
			if (heldBy && heldBy !== owner && heldUntil > now) {
				return { status: "busy", retryAfterMs: Math.max(1, heldUntil - now) };
			}
			const inflight = this.#db
				.prepare("SELECT token_sha256 FROM aura_cloud_refresh_inflight WHERE issuer = ?")
				.get(key) as { token_sha256: string } | null;
			// A marker still matching the *stored* token means some attempt sent this exact
			// refresh token to the server and never committed the rotation. The server may have
			// consumed it, and retrying a consumed refresh is precisely what the contract
			// forbids — the only safe answer is a fresh login.
			//
			// Deliberately owner-agnostic. Comparing owners would make safety depend on every
			// caller minting a fresh owner string per process: a restarted process that derives
			// a stable owner (from a machine or installation id, say) would match its own dead
			// attempt's marker, skip this check, and replay the possibly-consumed token. There
			// is also no legitimate flow in which one owner re-acquires with its own marker
			// still standing — a live attempt either commits (which clears the marker) or
			// abandons it — so treating the same-owner case as poisoned costs nothing.
			if (inflight && inflight.token_sha256 === sha256Hex(auth.refreshToken)) {
				return { status: "relogin_required" };
			}
			const expiresAtMs = now + ttlMs;
			this.#db.run(
				"UPDATE aura_cloud_auth SET refresh_lease_owner = ?, refresh_lease_expires_at = ? WHERE issuer = ?",
				[owner, expiresAtMs, key] as never,
			);
			return {
				status: "acquired",
				owner,
				expiresAtMs,
				refreshToken: auth.refreshToken,
				version: auth.version,
				identity: auth.identity,
			};
		});
		return acquire.immediate() as AuraLeaseAcquisition;
	}

	/**
	 * Extend the lease. `false` means ownership was lost, and the caller must discard whatever
	 * response it is holding rather than write it.
	 */
	renewRefreshLease(issuer: string, owner: string, ttlMs: number = AURA_REFRESH_LEASE_TTL_MS): boolean {
		const key = requireIssuer(issuer);
		const now = Date.now();
		const result = this.#db.run(
			"UPDATE aura_cloud_auth SET refresh_lease_expires_at = ? WHERE issuer = ? AND refresh_lease_owner = ? AND refresh_lease_expires_at > ?",
			[now + ttlMs, key, owner, now] as never,
		);
		return Number(result.changes) === 1;
	}

	/** Release the lease if this owner still holds it. */
	releaseRefreshLease(issuer: string, owner: string): void {
		this.#db.run(
			"UPDATE aura_cloud_auth SET refresh_lease_owner = NULL, refresh_lease_expires_at = NULL WHERE issuer = ? AND refresh_lease_owner = ?",
			[requireIssuer(issuer), owner] as never,
		);
	}

	/**
	 * Record that this owner is about to send `refreshToken` to the server.
	 *
	 * Written before the request leaves the process so that a crash between the server
	 * consuming the token and the local CAS is detectable by the next process — which reads
	 * the marker in {@link acquireRefreshLease} and answers `relogin_required`.
	 *
	 * The marker records the token digest, never the owner's identity, so crash detection does
	 * not depend on owner strings being unique across process lifetimes. `owner` is used only
	 * to scope {@link abandonRefreshAttempt}.
	 */
	markRefreshSubmitted(issuer: string, owner: string, refreshToken: string): void {
		this.#db.run(
			`INSERT INTO aura_cloud_refresh_inflight (issuer, owner, token_sha256, started_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT(issuer) DO UPDATE SET owner = excluded.owner, token_sha256 = excluded.token_sha256, started_at = excluded.started_at`,
			[requireIssuer(issuer), owner, sha256Hex(refreshToken), Date.now()] as never,
		);
	}

	/**
	 * Clear the in-flight marker after an attempt that provably minted no grant.
	 *
	 * The rule is about the *grant*, not about whether a response arrived. Call this only for
	 * outcomes where the server certainly did not rotate the submitted refresh token: no
	 * response at all (aborted before send, connection error), a rejected 3xx, or a 408/429/5xx
	 * — the server declining to do work. `grantCertainlyNotMinted` in `token-manager.ts` is the
	 * single decision procedure and the only caller; keep the two in step rather than
	 * re-deriving the rule here.
	 *
	 * Never call this for any other outcome — above all a 2xx whose token failed to parse or
	 * verify — because the submitted token may already be spent, and clearing the marker would
	 * make a consumed token look retryable. Equally, do not narrow this to "no response only":
	 * keeping the marker after a transient 429/5xx strands the login and forces a re-login for
	 * what was a network blip.
	 */
	abandonRefreshAttempt(issuer: string, owner: string): void {
		this.#db.run("DELETE FROM aura_cloud_refresh_inflight WHERE issuer = ? AND owner = ?", [
			requireIssuer(issuer),
			owner,
		] as never);
	}

	/**
	 * Commit a rotation: swap `previousRefreshToken`/`previousVersion` for the new value, only
	 * while this owner still holds the lease and the device binding still matches.
	 */
	commitRefreshRotation(input: {
		issuer: string;
		owner: string;
		previousRefreshToken: string;
		previousVersion: number;
		nextRefreshToken: string;
		deviceId: string;
	}): AuraRotationResult {
		const key = requireIssuer(input.issuer);
		if (typeof input.nextRefreshToken !== "string" || input.nextRefreshToken.length === 0) {
			throw new AuraCloudError("invalid_response");
		}
		const commit = this.#db.transaction((): AuraRotationResult => {
			const now = Date.now();
			const row = this.#authRow(key);
			if (!row) return { status: "missing" };
			const ownsLease =
				row.refresh_lease_owner === input.owner &&
				typeof row.refresh_lease_expires_at === "number" &&
				row.refresh_lease_expires_at > now;
			if (!ownsLease) return { status: "lost_lease" };
			if (row.refresh_token !== input.previousRefreshToken || row.updated_at !== input.previousVersion) {
				return { status: "conflict" };
			}
			if (row.device_id !== input.deviceId) return { status: "device_mismatch" };
			const version = now > row.updated_at ? now : row.updated_at + 1;
			this.#db.run(
				"UPDATE aura_cloud_auth SET refresh_token = ?, updated_at = ? WHERE issuer = ? AND refresh_token = ? AND updated_at = ?",
				[input.nextRefreshToken, version, key, input.previousRefreshToken, input.previousVersion] as never,
			);
			this.#db.run("DELETE FROM aura_cloud_refresh_inflight WHERE issuer = ?", [key] as never);
			const stored = rowToAuth(this.#authRow(key));
			if (!stored) return { status: "missing" };
			return { status: "committed", auth: stored };
		});
		return commit.immediate() as AuraRotationResult;
	}

	// -------------------------------------------------------------------------
	// (issuer,user_id) namespaces
	// -------------------------------------------------------------------------

	/** Every account ever signed in at the issuer, active or retained. */
	listAccounts(issuer: string): AuraStoredAccount[] {
		const rows = this.#db
			.prepare("SELECT * FROM aura_cloud_account WHERE issuer = ? ORDER BY opened_at ASC")
			.all(requireIssuer(issuer)) as {
			issuer: string;
			user_id: string;
			org_id: string;
			account_id: string;
			realm_id: string;
			opened_at: number;
			closed_at: number | null;
		}[];
		return rows.map(row => ({
			issuer: row.issuer,
			userId: row.user_id,
			orgId: row.org_id,
			accountId: row.account_id,
			realmId: row.realm_id,
			active: row.closed_at === null,
			openedAtMs: row.opened_at,
			closedAtMs: row.closed_at ?? undefined,
		}));
	}

	/** The one account currently signed in at the issuer, if any. */
	activeAccount(issuer: string): AuraStoredAccount | undefined {
		return this.listAccounts(issuer).find(account => account.active);
	}

	/** Whether the namespace is the issuer's active account (as opposed to retained). */
	isNamespaceActive(ns: AuraAccountNamespace): boolean {
		const { issuer, userId } = requireNamespace(ns);
		const row = this.#db
			.prepare("SELECT closed_at FROM aura_cloud_account WHERE issuer = ? AND user_id = ?")
			.get(issuer, userId) as { closed_at: number | null } | null;
		return row !== null && row.closed_at === null;
	}

	/** Persist a namespaced profile value. Values are JSON; never put credentials here. */
	setProfileValue(ns: AuraAccountNamespace, key: string, value: unknown): void {
		const { issuer, userId } = requireNamespace(ns);
		this.#db.run(
			`INSERT INTO aura_cloud_profile (issuer, user_id, key, value_json, updated_at) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(issuer, user_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
			[issuer, userId, key, JSON.stringify(value ?? null), Date.now()] as never,
		);
	}

	getProfileValue<T = unknown>(ns: AuraAccountNamespace, key: string): T | undefined {
		const { issuer, userId } = requireNamespace(ns);
		const row = this.#db
			.prepare("SELECT value_json FROM aura_cloud_profile WHERE issuer = ? AND user_id = ? AND key = ?")
			.get(issuer, userId, key) as { value_json: string } | null;
		if (!row) return undefined;
		try {
			return JSON.parse(row.value_json) as T;
		} catch {
			return undefined;
		}
	}

	deleteProfileValue(ns: AuraAccountNamespace, key: string): void {
		const { issuer, userId } = requireNamespace(ns);
		this.#db.run("DELETE FROM aura_cloud_profile WHERE issuer = ? AND user_id = ? AND key = ?", [
			issuer,
			userId,
			key,
		] as never);
	}

	/** Cache a namespaced value with an explicit TTL. */
	setCacheValue(ns: AuraAccountNamespace, key: string, value: unknown, ttlMs = 300_000): void {
		const { issuer, userId } = requireNamespace(ns);
		this.#db.run(
			`INSERT INTO aura_cloud_cache (issuer, user_id, key, value_json, expires_at) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(issuer, user_id, key) DO UPDATE SET value_json = excluded.value_json, expires_at = excluded.expires_at`,
			[issuer, userId, key, JSON.stringify(value ?? null), Date.now() + ttlMs] as never,
		);
	}

	getCacheValue<T = unknown>(ns: AuraAccountNamespace, key: string): T | undefined {
		const { issuer, userId } = requireNamespace(ns);
		const row = this.#db
			.prepare("SELECT value_json, expires_at FROM aura_cloud_cache WHERE issuer = ? AND user_id = ? AND key = ?")
			.get(issuer, userId, key) as { value_json: string; expires_at: number } | null;
		if (!row) return undefined;
		if (row.expires_at <= Date.now()) return undefined;
		try {
			return JSON.parse(row.value_json) as T;
		} catch {
			return undefined;
		}
	}

	/** Drop expired cache rows for a namespace. */
	pruneCache(ns: AuraAccountNamespace): void {
		const { issuer, userId } = requireNamespace(ns);
		this.#db.run("DELETE FROM aura_cloud_cache WHERE issuer = ? AND user_id = ? AND expires_at <= ?", [
			issuer,
			userId,
			Date.now(),
		] as never);
	}

	setSyncCursor(ns: AuraAccountNamespace, stream: string, cursor: string): void {
		const { issuer, userId } = requireNamespace(ns);
		this.#db.run(
			`INSERT INTO aura_cloud_sync_cursor (issuer, user_id, stream, cursor, updated_at) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(issuer, user_id, stream) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
			[issuer, userId, stream, cursor, Date.now()] as never,
		);
	}

	getSyncCursor(ns: AuraAccountNamespace, stream: string): string | undefined {
		const { issuer, userId } = requireNamespace(ns);
		const row = this.#db
			.prepare("SELECT cursor FROM aura_cloud_sync_cursor WHERE issuer = ? AND user_id = ? AND stream = ?")
			.get(issuer, userId, stream) as { cursor: string } | null;
		return row?.cursor;
	}

	recordSyncConflict(ns: AuraAccountNamespace, conflict: { stream: string; itemId: string; detail: unknown }): void {
		const { issuer, userId } = requireNamespace(ns);
		this.#db.run(
			"INSERT INTO aura_cloud_sync_conflict (issuer, user_id, stream, item_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			[
				issuer,
				userId,
				conflict.stream,
				conflict.itemId,
				JSON.stringify(conflict.detail ?? null),
				Date.now(),
			] as never,
		);
	}

	listSyncConflicts(ns: AuraAccountNamespace, stream?: string): AuraSyncConflict[] {
		const { issuer, userId } = requireNamespace(ns);
		const rows = this.#db
			.prepare(
				"SELECT stream, item_id, detail_json, created_at FROM aura_cloud_sync_conflict WHERE issuer = ? AND user_id = ? AND (? IS NULL OR stream = ?) ORDER BY id ASC",
			)
			.all(issuer, userId, stream ?? null, stream ?? null) as {
			stream: string;
			item_id: string;
			detail_json: string;
			created_at: number;
		}[];
		return rows.map(row => {
			let detail: unknown;
			try {
				detail = JSON.parse(row.detail_json);
			} catch {
				detail = undefined;
			}
			return { stream: row.stream, itemId: row.item_id, detail, createdAtMs: row.created_at };
		});
	}

	// -------------------------------------------------------------------------
	// Import receipts
	// -------------------------------------------------------------------------

	/**
	 * Record what was imported, without recording the key.
	 *
	 * The raw key is reduced to a display prefix and a SHA-256 digest inside this method and
	 * never bound to a statement, so it cannot reach the database file or its WAL.
	 */
	recordImportReceipt(input: AuraImportReceiptInput): AuraImportReceipt {
		const { issuer, userId } = requireNamespace({ issuer: input.issuer, userId: input.userId });
		if (typeof input.apiKey !== "string" || input.apiKey.length === 0)
			throw new AuraCloudError("invalid_configuration");
		if (typeof input.apiKeyId !== "string" || input.apiKeyId.length === 0) {
			throw new AuraCloudError("invalid_configuration");
		}
		const receipt: AuraImportReceipt = {
			issuer,
			userId,
			apiKeyId: input.apiKeyId,
			tokenPrefix: input.apiKey.slice(0, TOKEN_PREFIX_LENGTH),
			tokenSha256: sha256Hex(input.apiKey),
			surface: input.surface,
			scopes: [...input.scopes],
			deadlineAtMs: input.deadlineAtMs,
			realmId: input.realmId,
			orgId: input.orgId,
			accountId: input.accountId,
			createdAtMs: Date.now(),
		};
		this.#db.run(
			`INSERT INTO aura_cloud_import_receipt (issuer, user_id, api_key_id, token_prefix, token_sha256, surface, scopes_json, deadline_at, realm_id, org_id, account_id, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(issuer, user_id, api_key_id) DO UPDATE SET
			   token_prefix = excluded.token_prefix, token_sha256 = excluded.token_sha256, surface = excluded.surface,
			   scopes_json = excluded.scopes_json, deadline_at = excluded.deadline_at, realm_id = excluded.realm_id,
			   org_id = excluded.org_id, account_id = excluded.account_id, created_at = excluded.created_at`,
			[
				receipt.issuer,
				receipt.userId,
				receipt.apiKeyId,
				receipt.tokenPrefix,
				receipt.tokenSha256,
				receipt.surface,
				JSON.stringify(receipt.scopes),
				receipt.deadlineAtMs,
				receipt.realmId,
				receipt.orgId,
				receipt.accountId,
				receipt.createdAtMs,
			] as never,
		);
		return receipt;
	}

	getImportReceipt(ns: AuraAccountNamespace, apiKeyId: string): AuraImportReceipt | undefined {
		const { issuer, userId } = requireNamespace(ns);
		const row = this.#db
			.prepare("SELECT * FROM aura_cloud_import_receipt WHERE issuer = ? AND user_id = ? AND api_key_id = ?")
			.get(issuer, userId, apiKeyId) as Record<string, never> | null;
		return row ? receiptFromRow(row) : undefined;
	}

	listImportReceipts(ns: AuraAccountNamespace): AuraImportReceipt[] {
		const { issuer, userId } = requireNamespace(ns);
		const rows = this.#db
			.prepare("SELECT * FROM aura_cloud_import_receipt WHERE issuer = ? AND user_id = ? ORDER BY created_at ASC")
			.all(issuer, userId) as Record<string, never>[];
		return rows.map(receiptFromRow).filter((r): r is AuraImportReceipt => r !== undefined);
	}

	deleteImportReceipt(ns: AuraAccountNamespace, apiKeyId: string): void {
		const { issuer, userId } = requireNamespace(ns);
		this.#db.run("DELETE FROM aura_cloud_import_receipt WHERE issuer = ? AND user_id = ? AND api_key_id = ?", [
			issuer,
			userId,
			apiKeyId,
		] as never);
	}
}

function receiptFromRow(row: Record<string, never>): AuraImportReceipt | undefined {
	const scopes = parseJsonArray(row.scopes_json);
	if (!scopes) return undefined;
	return {
		issuer: row.issuer as string,
		userId: row.user_id as string,
		apiKeyId: row.api_key_id as string,
		tokenPrefix: row.token_prefix as string,
		tokenSha256: row.token_sha256 as string,
		surface: row.surface as string,
		scopes,
		deadlineAtMs: row.deadline_at as number,
		realmId: row.realm_id as string,
		orgId: row.org_id as string,
		accountId: row.account_id as string,
		createdAtMs: row.created_at as number,
	};
}
