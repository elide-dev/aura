import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getInstallId } from "@oh-my-pi/pi-utils/dirs";
import {
	AURA_REFRESH_LEASE_TTL_MS,
	AURA_SURFACE_SCOPES,
	type AuraAccountIdentity,
	AuraTokenStore,
} from "../../src/cloud/token-store";

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ISSUER = "https://auth.example.dev";
const OTHER_ISSUER = "https://auth.other.dev";
const STORE_MODULE = path.join(import.meta.dir, "../../src/cloud/token-store.ts");

/** Build a valid 26-char uppercase Crockford ULID from a short readable tag. */
function ulid(tag: string): string {
	const body = tag.toUpperCase().replace(/[^0-9A-HJKMNP-TV-Z]/g, "0");
	return `01J${body}`.padEnd(26, "0").slice(0, 26);
}

const DEVICE_A = ulid("DEVCEA");
const USER_A = ulid("USERA");
const USER_B = ulid("USERB");
const ORG_1 = ulid("ORG1");
const ORG_2 = ulid("ORG2");
const ACCOUNT_A = ulid("ACCTA");
const REALM_A = ulid("REALMA");
const KEY_A = ulid("KEYA");
const DEVICE_OTHER = ulid("DEVCEZ");

let tempRoot = "";
let dbPath = "";

function identity(overrides: Partial<AuraAccountIdentity> = {}): AuraAccountIdentity {
	return {
		issuer: ISSUER,
		deviceId: DEVICE_A,
		userId: USER_A,
		orgId: ORG_1,
		accountId: ACCOUNT_A,
		realmId: REALM_A,
		roles: ["member"],
		scopes: AURA_SURFACE_SCOPES,
		...overrides,
	} as AuraAccountIdentity;
}

async function openStore(at: string = dbPath): Promise<AuraTokenStore> {
	return await AuraTokenStore.open(at);
}

beforeEach(async () => {
	tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aura-token-store-"));
	dbPath = path.join(tempRoot, "agent", "agent.db");
});

afterEach(async () => {
	await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("AuraTokenStore schema and hardening", () => {
	test("creates the core tables and survives reopen", async () => {
		const store = await openStore();
		try {
			const raw = new Database(dbPath, { readonly: true });
			const tables = new Set(
				(raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
					r => r.name,
				),
			);
			raw.close();
			expect(tables.has("aura_cloud_device")).toBe(true);
			expect(tables.has("aura_cloud_auth")).toBe(true);
		} finally {
			store.close();
		}

		const reopened = await openStore();
		try {
			expect(reopened.getInstallationId()).toMatch(ULID_RE);
		} finally {
			reopened.close();
		}
	});

	test("enforces 0700 on the parent directory and 0600 on database, WAL and SHM", async () => {
		const store = await openStore();
		try {
			// `open()` alone must leave everything clamped — no caller opt-in, no later write.
			for (const suffix of ["", "-wal", "-shm"]) {
				const stat = await fs.stat(`${dbPath}${suffix}`);
				expect(`open ${suffix || "db"}:${(stat.mode & 0o777).toString(8)}`).toBe(`open ${suffix || "db"}:600`);
			}
			store.saveLogin({ identity: identity(), refreshToken: "R0" });
			await store.hardenFileModes();
			const dirMode = (await fs.stat(path.dirname(dbPath))).mode & 0o777;
			expect(dirMode & 0o077).toBe(0);
			expect(dirMode & 0o700).toBe(0o700);
			for (const suffix of ["", "-wal", "-shm"]) {
				const file = `${dbPath}${suffix}`;
				const stat = await fs.stat(file).catch(() => undefined);
				if (!stat) continue;
				expect(`${suffix || "db"}:${(stat.mode & 0o777).toString(8)}`).toBe(`${suffix || "db"}:600`);
			}
		} finally {
			store.close();
		}
	});

	/**
	 * The clamp has to hold for *whichever* store creates `agent.db` first, because the cloud
	 * rows land in the same file and the same WAL.
	 *
	 * SQLite derives the `-wal`/`-shm` modes from the database file's mode at the moment it
	 * creates them. That makes the ordering decisive: `AgentStorage` creates the database under
	 * the process umask (0644), turns on WAL and writes during schema init — minting a 0644
	 * `-wal` — and only then chmods. Clamping the database alone therefore leaves a
	 * world-readable WAL for the entire life of that connection, and any `aura_cloud_auth` row
	 * written while it is open sits in those frames. First-run creation order is the case that
	 * actually bites, so that is what this test reproduces.
	 */
	test("WAL and SHM are 0600 even when AgentStorage is the one that creates agent.db", async () => {
		const { AgentStorage } = await import("../../src/session/agent-storage");
		AgentStorage.resetInstance();
		await AgentStorage.open(dbPath);
		try {
			for (const suffix of ["", "-wal", "-shm"]) {
				const stat = await fs.stat(`${dbPath}${suffix}`).catch(() => undefined);
				if (!stat) continue;
				expect(`${suffix || "db"}:${(stat.mode & 0o777).toString(8)}`).toBe(`${suffix || "db"}:600`);
			}
			// Cloud rows written into that shared, still-open WAL stay behind 0600 too.
			const store = await openStore();
			store.saveLogin({ identity: identity(), refreshToken: "R0" });
			for (const suffix of ["", "-wal", "-shm"]) {
				const stat = await fs.stat(`${dbPath}${suffix}`).catch(() => undefined);
				if (!stat) continue;
				expect(`shared ${suffix || "db"}:${(stat.mode & 0o777).toString(8)}`).toBe(`shared ${suffix || "db"}:600`);
			}
			expect(store.readAuth(ISSUER)?.refreshToken).toBe("R0");
			store.close();
		} finally {
			AgentStorage.resetInstance();
		}
	});

	test("uses WAL journaling and a 5s busy timeout", async () => {
		const store = await openStore();
		try {
			expect(store.journalMode()).toBe("wal");
			expect(store.busyTimeoutMs()).toBe(5000);
		} finally {
			store.close();
		}
	});

	test("migrates a legacy aura_cloud_auth table that predates the lease columns", async () => {
		await fs.mkdir(path.dirname(dbPath), { recursive: true, mode: 0o700 });
		const legacy = new Database(dbPath);
		legacy.run(`CREATE TABLE aura_cloud_auth (
			issuer TEXT PRIMARY KEY, refresh_token TEXT NOT NULL, device_id TEXT NOT NULL,
			user_id TEXT NOT NULL, org_id TEXT NOT NULL, account_id TEXT NOT NULL, realm_id TEXT NOT NULL,
			roles_json TEXT NOT NULL, scopes_json TEXT NOT NULL, updated_at INTEGER NOT NULL
		)`);
		legacy.run("INSERT INTO aura_cloud_auth VALUES (?,?,?,?,?,?,?,?,?,?)", [
			ISSUER,
			"R-legacy",
			identity().deviceId,
			identity().userId,
			identity().orgId,
			identity().accountId,
			identity().realmId,
			JSON.stringify(["member"]),
			JSON.stringify(AURA_SURFACE_SCOPES),
			Date.now(),
		] as never);
		legacy.close();

		const store = await openStore();
		try {
			const auth = store.readAuth(ISSUER);
			expect(auth?.refreshToken).toBe("R-legacy");
			const owner = "owner-a";
			const acquired = store.acquireRefreshLease(ISSUER, owner);
			expect(acquired.status).toBe("acquired");
		} finally {
			store.close();
		}
	});

	test("treats malformed and legacy-shaped rows as absent instead of throwing", async () => {
		const store = await openStore();
		try {
			store.saveLogin({ identity: identity(), refreshToken: "R0" });
			const raw = new Database(dbPath);
			raw.run("UPDATE aura_cloud_auth SET roles_json = 'not json' WHERE issuer = ?", [ISSUER] as never);
			raw.close();
			expect(store.readAuth(ISSUER)).toBeUndefined();

			const raw2 = new Database(dbPath);
			raw2.run("UPDATE aura_cloud_auth SET roles_json = '[]', device_id = 'nope' WHERE issuer = ?", [
				ISSUER,
			] as never);
			raw2.close();
			expect(store.readAuth(ISSUER)).toBeUndefined();

			// The store stays usable: a fresh login repairs the row.
			store.saveLogin({ identity: identity(), refreshToken: "R1" });
			expect(store.readAuth(ISSUER)?.refreshToken).toBe("R1");
		} finally {
			store.close();
		}
	});

	test("recovers from a concurrent writer holding the database busy", async () => {
		const store = await openStore();
		try {
			store.saveLogin({ identity: identity(), refreshToken: "R0" });
			// The lock must be held by another *process*: bun:sqlite is synchronous, so a
			// same-process holder could never release while this thread waits on the busy
			// handler. This is also the real-world shape — two omp processes racing.
			const blockerScript = `const {Database} = await import("bun:sqlite");
const db = new Database(${JSON.stringify(dbPath)});
db.run("PRAGMA busy_timeout = 5000");
db.run("BEGIN IMMEDIATE");
db.run("UPDATE aura_cloud_auth SET updated_at = updated_at");
console.log("locked");
await Bun.sleep(200);
db.run("COMMIT");
db.close();`;
			const blocker = Bun.spawn(["bun", "-e", blockerScript], { stdout: "pipe", stderr: "pipe" });
			const reader = blocker.stdout.getReader();
			const first = await reader.read();
			expect(new TextDecoder().decode(first.value).trim()).toBe("locked");
			const started = Date.now();
			const result = store.acquireRefreshLease(ISSUER, "owner-a");
			const elapsed = Date.now() - started;
			expect(await blocker.exited).toBe(0);
			expect(result.status).toBe("acquired");
			expect(elapsed).toBeGreaterThan(50);
			expect(elapsed).toBeLessThan(5000);
		} finally {
			store.close();
		}
	});
});

describe("device and installation identity", () => {
	test("persists one uppercase ULID installation id, stable across reopen", async () => {
		const store = await openStore();
		const first = store.getInstallationId();
		expect(first).toMatch(ULID_RE);
		expect(first).toBe(first.toUpperCase());
		expect(store.getInstallationId()).toBe(first);
		store.close();

		const reopened = await openStore();
		expect(reopened.getInstallationId()).toBe(first);
		reopened.close();

		const raw = new Database(dbPath, { readonly: true });
		const rows = raw.prepare("SELECT singleton, installation_id FROM aura_cloud_device").all() as {
			singleton: number;
			installation_id: string;
		}[];
		raw.close();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ singleton: 1, installation_id: first });
	});

	test("is stable across separate processes and working directories", async () => {
		const store = await openStore();
		const expected = store.getInstallationId();
		store.close();

		const script = `const {AuraTokenStore} = await import(${JSON.stringify(STORE_MODULE)});
const s = await AuraTokenStore.open(${JSON.stringify(dbPath)});
console.log(s.getInstallationId());
s.close();`;
		const cwds = [tempRoot, os.tmpdir()];
		for (const cwd of cwds) {
			const proc = Bun.spawn(["bun", "-e", script], { cwd, stdout: "pipe", stderr: "pipe" });
			const out = (await new Response(proc.stdout).text()).trim();
			const err = await new Response(proc.stderr).text();
			expect(`${await proc.exited}:${err}`).toBe("0:");
			expect(out).toBe(expected);
		}
	});

	test("is isolated between named profiles and distinct from the rollout install UUID", async () => {
		const defaultStore = await openStore();
		const defaultId = defaultStore.getInstallationId();
		defaultStore.close();

		const profileDb = path.join(tempRoot, "profiles", "work", "agent", "agent.db");
		const profileStore = await openStore(profileDb);
		const profileId = profileStore.getInstallationId();
		profileStore.close();

		expect(profileId).toMatch(ULID_RE);
		expect(profileId).not.toBe(defaultId);

		const rollout = getInstallId();
		expect(rollout).toMatch(UUID_RE);
		expect(rollout).not.toMatch(ULID_RE);
		expect(rollout).not.toBe(defaultId);
		expect(rollout).not.toBe(profileId);
	});

	test("persists the verified device grant ULID with the active user row", async () => {
		const store = await openStore();
		try {
			store.saveLogin({ identity: identity(), refreshToken: "R0" });
			expect(store.readAuth(ISSUER)?.identity.deviceId).toBe(identity().deviceId);

			const raw = new Database(dbPath, { readonly: true });
			const row = raw.prepare("SELECT device_id FROM aura_cloud_auth WHERE issuer = ?").get(ISSUER) as {
				device_id: string;
			};
			raw.close();
			expect(row.device_id).toBe(identity().deviceId);
		} finally {
			store.close();
		}
	});
});

describe("refresh persistence, CAS and delete", () => {
	/**
	 * The persistence invariant, checked against the committed rows rather than against strings
	 * the test itself made up: after a full lifecycle, the *only* credential material anywhere
	 * in the schema is the current refresh token, in exactly one column. Adding an access-token
	 * column, caching a minted JWT, or keeping the rotated-away token as history all fail here.
	 */
	test("the only credential in any column is the current refresh token", async () => {
		const store = await openStore();
		const ns = { issuer: ISSUER, userId: USER_A };
		try {
			store.saveLogin({ identity: identity(), refreshToken: "R0-consumed" });
			const lease = store.acquireRefreshLease(ISSUER, "owner-a");
			if (lease.status !== "acquired") throw new Error("expected lease");
			store.markRefreshSubmitted(ISSUER, "owner-a", lease.refreshToken);
			store.commitRefreshRotation({
				issuer: ISSUER,
				owner: "owner-a",
				previousRefreshToken: lease.refreshToken,
				previousVersion: lease.version,
				nextRefreshToken: "R1-current",
				deviceId: DEVICE_A,
			});
			store.releaseRefreshLease(ISSUER, "owner-a");
			store.setProfileValue(ns, "display", { name: "a" });
			store.setCacheValue(ns, "models", ["m"], 60_000);
			store.setSyncCursor(ns, "memories", "cursor-1");
			store.recordSyncConflict(ns, { stream: "memories", itemId: "m1", detail: { reason: "diverged" } });
			store.recordImportReceipt({
				issuer: ISSUER,
				userId: USER_A,
				apiKeyId: KEY_A,
				apiKey: "aura_sk_live_KEYMATERIAL",
				surface: "model",
				scopes: ["model:invoke"],
				deadlineAtMs: 1_900_000_000_000,
				realmId: REALM_A,
				orgId: ORG_1,
				accountId: ACCOUNT_A,
			});
			store.close();

			const raw = new Database(dbPath, { readonly: true });
			const tables = (
				raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {
					name: string;
				}[]
			).map(t => t.name);
			expect(tables.length).toBeGreaterThan(5);

			const jwtShaped = /^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
			const sightings: string[] = [];
			for (const table of tables) {
				const columns = (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);
				for (const row of raw.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]) {
					for (const column of columns) {
						const value = row[column];
						if (typeof value !== "string") continue;
						expect(`${table}.${column} jwt-shaped:${jwtShaped.test(value)}`).toBe(
							`${table}.${column} jwt-shaped:false`,
						);
						// The consumed token must survive nowhere — not as history, not in a
						// marker (which stores a digest), not in a cache row.
						expect(`${table}.${column} holds-consumed:${value.includes("R0-consumed")}`).toBe(
							`${table}.${column} holds-consumed:false`,
						);
						expect(`${table}.${column} holds-key:${value.includes("aura_sk_live_KEYMATERIAL")}`).toBe(
							`${table}.${column} holds-key:false`,
						);
						if (value.includes("R1-current")) sightings.push(`${table}.${column}`);
					}
				}
			}
			raw.close();
			expect(sightings).toEqual(["aura_cloud_auth.refresh_token"]);
		} finally {
			store.close();
		}
	});

	test("CAS commit replaces the refresh token and bumps the version", async () => {
		const store = await openStore();
		try {
			const saved = store.saveLogin({ identity: identity(), refreshToken: "R0" });
			const lease = store.acquireRefreshLease(ISSUER, "owner-a");
			expect(lease.status).toBe("acquired");
			if (lease.status !== "acquired") throw new Error("unreachable");
			expect(lease.refreshToken).toBe("R0");
			expect(lease.version).toBe(saved.version);

			const result = store.commitRefreshRotation({
				issuer: ISSUER,
				owner: "owner-a",
				previousRefreshToken: lease.refreshToken,
				previousVersion: lease.version,
				nextRefreshToken: "R1",
				deviceId: identity().deviceId,
			});
			expect(result.status).toBe("committed");
			const after = store.readAuth(ISSUER);
			expect(after?.refreshToken).toBe("R1");
			expect(after?.version).toBeGreaterThan(saved.version);
		} finally {
			store.close();
		}
	});

	test("CAS rejects a stale value/version and a device-id mismatch", async () => {
		const store = await openStore();
		try {
			store.saveLogin({ identity: identity(), refreshToken: "R0" });
			const lease = store.acquireRefreshLease(ISSUER, "owner-a");
			if (lease.status !== "acquired") throw new Error("expected lease");
			store.commitRefreshRotation({
				issuer: ISSUER,
				owner: "owner-a",
				previousRefreshToken: "R0",
				previousVersion: lease.version,
				nextRefreshToken: "R1",
				deviceId: identity().deviceId,
			});
			// Replaying the same acquisition must not roll the row back to a consumed token.
			const replay = store.commitRefreshRotation({
				issuer: ISSUER,
				owner: "owner-a",
				previousRefreshToken: "R0",
				previousVersion: lease.version,
				nextRefreshToken: "R1-again",
				deviceId: identity().deviceId,
			});
			expect(replay.status).toBe("conflict");
			expect(store.readAuth(ISSUER)?.refreshToken).toBe("R1");

			const current = store.readAuth(ISSUER);
			if (!current) throw new Error("expected auth");
			const mismatch = store.commitRefreshRotation({
				issuer: ISSUER,
				owner: "owner-a",
				previousRefreshToken: current.refreshToken,
				previousVersion: current.version,
				nextRefreshToken: "R2",
				deviceId: DEVICE_OTHER,
			});
			expect(mismatch.status).toBe("device_mismatch");
			expect(store.readAuth(ISSUER)?.refreshToken).toBe("R1");
		} finally {
			store.close();
		}
	});

	test("delete removes the refresh row and its lease state", async () => {
		const store = await openStore();
		try {
			store.saveLogin({ identity: identity(), refreshToken: "R0" });
			store.acquireRefreshLease(ISSUER, "owner-a");
			store.deleteAuth(ISSUER);
			expect(store.readAuth(ISSUER)).toBeUndefined();
			const raw = new Database(dbPath, { readonly: true });
			const rows = raw.prepare("SELECT COUNT(*) AS n FROM aura_cloud_auth").get() as { n: number };
			raw.close();
			expect(rows.n).toBe(0);
			const after = store.acquireRefreshLease(ISSUER, "owner-b");
			expect(after.status).toBe("missing");
		} finally {
			store.close();
		}
	});
});

describe("cross-process refresh lease", () => {
	test("is exclusive across connections and released for the next waiter", async () => {
		const a = await openStore();
		const b = await openStore();
		try {
			a.saveLogin({ identity: identity(), refreshToken: "R0" });
			const first = a.acquireRefreshLease(ISSUER, "owner-a");
			expect(first.status).toBe("acquired");
			const contended = b.acquireRefreshLease(ISSUER, "owner-b");
			expect(contended.status).toBe("busy");
			if (contended.status === "busy") expect(contended.retryAfterMs).toBeGreaterThan(0);

			a.releaseRefreshLease(ISSUER, "owner-a");
			const second = b.acquireRefreshLease(ISSUER, "owner-b");
			expect(second.status).toBe("acquired");
		} finally {
			a.close();
			b.close();
		}
	});

	test("defaults to a 30 second renewable lease and expires for a stalled owner", async () => {
		expect(AURA_REFRESH_LEASE_TTL_MS).toBe(30_000);
		const a = await openStore();
		const b = await openStore();
		try {
			a.saveLogin({ identity: identity(), refreshToken: "R0" });
			const lease = a.acquireRefreshLease(ISSUER, "owner-a");
			if (lease.status !== "acquired") throw new Error("expected lease");
			expect(lease.expiresAtMs - Date.now()).toBeGreaterThan(25_000);
			expect(a.renewRefreshLease(ISSUER, "owner-a")).toBe(true);
			expect(b.renewRefreshLease(ISSUER, "owner-b")).toBe(false);

			// A short lease lets a stalled owner get fenced out deterministically.
			const shortStore = await openStore();
			shortStore.releaseRefreshLease(ISSUER, "owner-a");
			const shortLease = shortStore.acquireRefreshLease(ISSUER, "owner-a", 20);
			if (shortLease.status !== "acquired") throw new Error("expected lease");
			await Bun.sleep(40);
			const stolen = b.acquireRefreshLease(ISSUER, "owner-b");
			expect(stolen.status).toBe("acquired");
			// The fenced owner can neither renew nor commit.
			expect(shortStore.renewRefreshLease(ISSUER, "owner-a")).toBe(false);
			const lost = shortStore.commitRefreshRotation({
				issuer: ISSUER,
				owner: "owner-a",
				previousRefreshToken: shortLease.refreshToken,
				previousVersion: shortLease.version,
				nextRefreshToken: "R-should-not-land",
				deviceId: identity().deviceId,
			});
			expect(lost.status).toBe("lost_lease");
			expect(shortStore.readAuth(ISSUER)?.refreshToken).toBe("R0");
			shortStore.close();
		} finally {
			a.close();
			b.close();
		}
	});

	test("a crash after the server rotated but before CAS forces relogin", async () => {
		const crashed = await openStore();
		crashed.saveLogin({ identity: identity(), refreshToken: "R0" });
		const lease = crashed.acquireRefreshLease(ISSUER, "owner-crashed", 20);
		if (lease.status !== "acquired") throw new Error("expected lease");
		crashed.markRefreshSubmitted(ISSUER, "owner-crashed", lease.refreshToken);
		crashed.close(); // process dies before CAS; the server already consumed R0.
		await Bun.sleep(40);

		const next = await openStore();
		try {
			const result = next.acquireRefreshLease(ISSUER, "owner-next");
			expect(result.status).toBe("relogin_required");
			// A fresh login clears the poisoned marker.
			next.saveLogin({ identity: identity(), refreshToken: "R-new" });
			expect(next.acquireRefreshLease(ISSUER, "owner-next").status).toBe("acquired");
		} finally {
			next.close();
		}
	});

	// Safety must not rest on owner strings being unique per process lifetime. A restarted
	// process is free to derive its owner from something stable (a machine or installation id),
	// and if that made it skip its own dead attempt's marker it would replay a token the server
	// may already have consumed — the one outcome the contract forbids.
	test("a restart that reuses the crashed owner string is still detected as poisoned", async () => {
		const OWNER = "stable-owner-derived-from-installation-id";
		const crashed = await openStore();
		crashed.saveLogin({ identity: identity(), refreshToken: "R0" });
		const lease = crashed.acquireRefreshLease(ISSUER, OWNER, 20);
		if (lease.status !== "acquired") throw new Error("expected lease");
		crashed.markRefreshSubmitted(ISSUER, OWNER, lease.refreshToken);
		crashed.close();
		await Bun.sleep(40); // the lease lapses; the marker does not.

		const restarted = await openStore();
		try {
			expect(restarted.acquireRefreshLease(ISSUER, OWNER).status).toBe("relogin_required");
			// And it stays poisoned however many times that owner asks.
			expect(restarted.acquireRefreshLease(ISSUER, OWNER).status).toBe("relogin_required");
			expect(restarted.readAuth(ISSUER)?.refreshToken).toBe("R0");
		} finally {
			restarted.close();
		}
	});

	test("an aborted attempt that never reached the server is retryable", async () => {
		const store = await openStore();
		try {
			store.saveLogin({ identity: identity(), refreshToken: "R0" });
			const lease = store.acquireRefreshLease(ISSUER, "owner-a");
			if (lease.status !== "acquired") throw new Error("expected lease");
			store.markRefreshSubmitted(ISSUER, "owner-a", lease.refreshToken);
			store.abandonRefreshAttempt(ISSUER, "owner-a");
			store.releaseRefreshLease(ISSUER, "owner-a");
			const again = store.acquireRefreshLease(ISSUER, "owner-b");
			expect(again.status).toBe("acquired");
			if (again.status === "acquired") expect(again.refreshToken).toBe("R0");
		} finally {
			store.close();
		}
	});

	/**
	 * Scope note for Task 4: this exercises the *store* half of the stale-manager property —
	 * that a second store instance created before a rotation reloads the rotated value on
	 * acquisition. It can only catch a regression where someone adds a refresh cache populated
	 * at `open()`. The manager-level property (that `TokenManager` never holds a refresh string
	 * across a rotation, and re-derives it from `acquireRefreshLease` on every attempt) lives in
	 * the manager and is NOT covered here; Task 4 must test it separately.
	 */
	test("a non-overlapping stale manager submits the reloaded token, never the cached one", async () => {
		// A fake auth server that rotates on every accepted refresh and refuses replays.
		const seen: string[] = [];
		const consumed = new Set<string>();
		let nextIndex = 1;
		const authServer = {
			async refresh(token: string): Promise<{ refreshToken: string }> {
				await Bun.sleep(1);
				seen.push(token);
				if (consumed.has(token)) throw new Error(`replayed consumed refresh token`);
				consumed.add(token);
				return { refreshToken: `R${nextIndex++}` };
			},
		};

		const managerA = await openStore();
		managerA.saveLogin({ identity: identity(), refreshToken: "R0" });
		// Manager B is constructed BEFORE A rotates. It must hold no cached refresh value.
		const managerB = await openStore();

		try {
			for (const [store, owner] of [
				[managerA, "owner-a"],
				[managerB, "owner-b"],
			] as const) {
				const lease = store.acquireRefreshLease(ISSUER, owner);
				if (lease.status !== "acquired") throw new Error(`expected lease for ${owner}`);
				store.markRefreshSubmitted(ISSUER, owner, lease.refreshToken);
				const response = await authServer.refresh(lease.refreshToken);
				expect(store.renewRefreshLease(ISSUER, owner)).toBe(true);
				const committed = store.commitRefreshRotation({
					issuer: ISSUER,
					owner,
					previousRefreshToken: lease.refreshToken,
					previousVersion: lease.version,
					nextRefreshToken: response.refreshToken,
					deviceId: identity().deviceId,
				});
				expect(`${owner}:${committed.status}`).toBe(`${owner}:committed`);
				store.releaseRefreshLease(ISSUER, owner);
			}

			expect(seen).toEqual(["R0", "R1"]);
			expect(seen.filter(t => t === "R0")).toHaveLength(1);
			expect(seen.filter(t => t === "R1")).toHaveLength(1);
			expect(managerA.readAuth(ISSUER)?.refreshToken).toBe("R2");
		} finally {
			managerA.close();
			managerB.close();
		}
	});

	test("a lease lost mid-flight discards the response instead of writing it", async () => {
		const a = await openStore();
		const b = await openStore();
		try {
			a.saveLogin({ identity: identity(), refreshToken: "R0" });
			const lease = a.acquireRefreshLease(ISSUER, "owner-a", 20);
			if (lease.status !== "acquired") throw new Error("expected lease");
			await Bun.sleep(40);
			const stolen = b.acquireRefreshLease(ISSUER, "owner-b");
			if (stolen.status !== "acquired") throw new Error("expected steal");
			// A's in-flight response arrives after ownership moved: renewal fails, so it discards.
			expect(a.renewRefreshLease(ISSUER, "owner-a")).toBe(false);
			const rejected = a.commitRefreshRotation({
				issuer: ISSUER,
				owner: "owner-a",
				previousRefreshToken: lease.refreshToken,
				previousVersion: lease.version,
				nextRefreshToken: "R-from-a",
				deviceId: identity().deviceId,
			});
			expect(rejected.status).toBe("lost_lease");
			const winner = b.commitRefreshRotation({
				issuer: ISSUER,
				owner: "owner-b",
				previousRefreshToken: stolen.refreshToken,
				previousVersion: stolen.version,
				nextRefreshToken: "R-from-b",
				deviceId: identity().deviceId,
			});
			expect(winner.status).toBe("committed");
			expect(b.readAuth(ISSUER)?.refreshToken).toBe("R-from-b");
		} finally {
			a.close();
			b.close();
		}
	});
});

describe("(issuer,user_id) namespaces", () => {
	const userA = { issuer: ISSUER, userId: USER_A };
	const userB = { issuer: ISSUER, userId: USER_B };

	test("cache, profile, cursor and conflict rows are isolated per user at one issuer", async () => {
		const store = await openStore();
		try {
			store.setProfileValue(userA, "display", { name: "a" });
			store.setProfileValue(userB, "display", { name: "b" });
			expect(store.getProfileValue<{ name: string }>(userA, "display")).toEqual({ name: "a" });
			expect(store.getProfileValue<{ name: string }>(userB, "display")).toEqual({ name: "b" });

			store.setCacheValue(userA, "models", ["a-model"], 60_000);
			store.setCacheValue(userB, "models", ["b-model"], 60_000);
			expect(store.getCacheValue<string[]>(userA, "models")).toEqual(["a-model"]);
			expect(store.getCacheValue<string[]>(userB, "models")).toEqual(["b-model"]);

			store.setSyncCursor(userA, "memories", "cursor-a");
			store.setSyncCursor(userB, "memories", "cursor-b");
			expect(store.getSyncCursor(userA, "memories")).toBe("cursor-a");
			expect(store.getSyncCursor(userB, "memories")).toBe("cursor-b");

			store.recordSyncConflict(userA, { stream: "memories", itemId: "m1", detail: { reason: "diverged" } });
			expect(store.listSyncConflicts(userA)).toHaveLength(1);
			expect(store.listSyncConflicts(userB)).toHaveLength(0);

			// Same user id at a different issuer is a different namespace.
			const crossIssuer = { issuer: OTHER_ISSUER, userId: userA.userId };
			expect(store.getProfileValue<{ name: string }>(crossIssuer, "display")).toBeUndefined();
			expect(store.getCacheValue<string[]>(crossIssuer, "models")).toBeUndefined();
			expect(store.getSyncCursor(crossIssuer, "memories")).toBeUndefined();
		} finally {
			store.close();
		}
	});

	test("rejects namespace lookups that omit the user id", async () => {
		const store = await openStore();
		try {
			store.setProfileValue(userA, "display", { name: "a" });
			expect(() => store.getProfileValue({ issuer: ISSUER, userId: "" }, "display")).toThrow();
			expect(() =>
				store.getCacheValue({ issuer: ISSUER, userId: undefined as unknown as string }, "models"),
			).toThrow();
		} finally {
			store.close();
		}
	});

	test("expired cache entries do not read back", async () => {
		const store = await openStore();
		try {
			store.setCacheValue(userA, "short", { v: 1 }, 10);
			await Bun.sleep(25);
			expect(store.getCacheValue<{ v: number }>(userA, "short")).toBeUndefined();
		} finally {
			store.close();
		}
	});

	test("account replacement closes the old namespace but retains its rows", async () => {
		const store = await openStore();
		try {
			store.saveLogin({ identity: identity(), refreshToken: "R0" });
			store.setProfileValue(userA, "display", { name: "a" });
			expect(store.isNamespaceActive(userA)).toBe(true);

			store.saveLogin({ identity: identity({ userId: userB.userId }), refreshToken: "R0-b" });
			expect(store.isNamespaceActive(userA)).toBe(false);
			expect(store.isNamespaceActive(userB)).toBe(true);
			// Retained, not deleted.
			expect(store.getProfileValue<{ name: string }>(userA, "display")).toEqual({ name: "a" });
			const accounts = store.listAccounts(ISSUER).map(a => a.userId);
			expect(accounts.sort()).toEqual([userA.userId, userB.userId].sort());
			expect(store.activeAccount(ISSUER)?.userId).toBe(userB.userId);
		} finally {
			store.close();
		}
	});

	test("the same user across org selections keeps one namespace with updated tenancy", async () => {
		const store = await openStore();
		try {
			store.saveLogin({ identity: identity({ orgId: ORG_1 }), refreshToken: "R0" });
			store.setProfileValue(userA, "display", { name: "a" });
			store.saveLogin({ identity: identity({ orgId: ORG_2 }), refreshToken: "R0-org2" });

			expect(store.readAuth(ISSUER)?.identity.orgId).toBe(ORG_2);
			expect(store.isNamespaceActive(userA)).toBe(true);
			expect(store.getProfileValue<{ name: string }>(userA, "display")).toEqual({ name: "a" });
			expect(store.listAccounts(ISSUER)).toHaveLength(1);
			expect(store.activeAccount(ISSUER)?.orgId).toBe(ORG_2);
		} finally {
			store.close();
		}
	});

	test("keeps one auth row per issuer while separate issuers coexist", async () => {
		const store = await openStore();
		try {
			store.saveLogin({ identity: identity(), refreshToken: "R0" });
			store.saveLogin({
				identity: identity({ issuer: OTHER_ISSUER, userId: userA.userId }),
				refreshToken: "R0-other",
			});
			expect(store.readAuth(ISSUER)?.refreshToken).toBe("R0");
			expect(store.readAuth(OTHER_ISSUER)?.refreshToken).toBe("R0-other");
			store.deleteAuth(ISSUER);
			expect(store.readAuth(OTHER_ISSUER)?.refreshToken).toBe("R0-other");
		} finally {
			store.close();
		}
	});
});

describe("import receipts", () => {
	const ns = { issuer: ISSUER, userId: USER_A };
	const API_KEY = "aura_sk_live_SUPERSECRETVALUE0123456789";

	test("record non-secret metadata only and never the key itself", async () => {
		const store = await openStore();
		try {
			const receipt = store.recordImportReceipt({
				issuer: ns.issuer,
				userId: ns.userId,
				apiKeyId: KEY_A,
				apiKey: API_KEY,
				surface: "model",
				scopes: ["model:invoke", "usage:write"],
				deadlineAtMs: 1_900_000_000_000,
				realmId: identity().realmId,
				orgId: identity().orgId,
				accountId: identity().accountId,
			});

			const expectedHash = new Bun.CryptoHasher("sha256").update(API_KEY).digest("hex");
			expect(receipt.tokenSha256).toBe(expectedHash);
			expect(receipt.tokenPrefix).toBe(API_KEY.slice(0, 8));
			expect(receipt.surface).toBe("model");
			expect(receipt.scopes).toEqual(["model:invoke", "usage:write"]);
			expect(receipt.deadlineAtMs).toBe(1_900_000_000_000);
			expect(receipt.realmId).toBe(identity().realmId);
			expect(receipt.orgId).toBe(identity().orgId);
			expect(receipt.accountId).toBe(identity().accountId);
			expect(receipt.issuer).toBe(ISSUER);
			expect(JSON.stringify(receipt)).not.toContain(API_KEY);

			expect(store.getImportReceipt(ns, KEY_A)).toEqual(receipt);
			expect(store.getImportReceipt({ issuer: ISSUER, userId: USER_B }, KEY_A)).toBeUndefined();
			store.close();

			const blob =
				(await Bun.file(dbPath).text()) +
				(await Bun.file(`${dbPath}-wal`)
					.text()
					.catch(() => ""));
			expect(blob).not.toContain(API_KEY);
			expect(blob).not.toContain("SUPERSECRETVALUE");
			expect(blob).toContain(expectedHash);
		} finally {
			store.close();
		}
	});
});

// Export/backup/support paths: no code in this repo enumerates the agent database's tables for
// export, backup, or a support bundle — `gc-cli.ts`, `settings.ts`, `agent-storage.ts` and
// `history-storage.ts` only ever name their own tables, and `tools/sqlite-reader.ts` is a
// user-invoked reader over an explicitly supplied path. There is deliberately no test here: the
// only one expressible today would grep source text, which the task constraints forbid and
// which would not catch the regression it claims to (a new bundler in a file it does not name).
// When a real export path lands it needs its own denylist and its own behavioural test.
