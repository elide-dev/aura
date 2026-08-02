/**
 * Shared hardening for the on-disk SQLite databases under the agent directory.
 *
 * Every store that opens `agent.db` needs the same three things, and getting any of them
 * wrong is a security or startup-reliability bug rather than a style problem:
 *
 * 1. The parent directory is created `0700` and the database (plus its `-wal`/`-shm`
 *    sidecars) are `0600`. The sidecars matter as much as the database: WAL frames hold
 *    committed row images, so a world-readable `-wal` leaks exactly what a world-readable
 *    database would.
 * 2. Opens retry on the `SQLITE_BUSY` family. Bun's default `busy_timeout` is 0 and WAL
 *    recovery takes an exclusive lock, so concurrent process starts otherwise crash.
 * 3. `busy_timeout` is installed *before* the first lock-taking statement (which includes
 *    `PRAGMA journal_mode=WAL`).
 *
 * This module is the single implementation of (1) and (2). It deliberately does not know
 * about schemas: callers pass an `onOpen` hook for their own table setup and an
 * `onExhausted` factory so each store keeps raising its own error type.
 */

import type { Database } from "bun:sqlite";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * SQLite's busy result code family — base `SQLITE_BUSY` plus the extended
 * variants `SQLITE_BUSY_RECOVERY` (concurrent WAL recovery), `SQLITE_BUSY_SNAPSHOT`,
 * and `SQLITE_BUSY_TIMEOUT`. All warrant the same backoff-and-retry treatment.
 */
export function isSqliteBusyError(err: unknown): boolean {
	if (err === null || typeof err !== "object") return false;
	const code = (err as { code?: unknown }).code;
	return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

/** Default number of open attempts before a busy database is reported as a failure. */
export const SQLITE_OPEN_MAX_ATTEMPTS = 4;
/** Base of the exponential backoff between open attempts, in milliseconds. */
export const SQLITE_OPEN_BASE_DELAY_MS = 100;
/** Busy handler timeout installed on every hardened connection. */
export const SQLITE_BUSY_TIMEOUT_MS = 5000;

/** Construction detail for {@link openHardenedSqlite}. */
export interface OpenHardenedSqliteOptions {
	/** Absolute path to the database file. Its parent is created `0700` when missing. */
	readonly dbPath: string;
	/** Opens the underlying handle. Injected so callers keep their own `Database` import/options. */
	readonly open: (dbPath: string) => Database;
	/** Runs inside the retry loop, after `chmod`; throwing a busy error retries the whole open. */
	readonly onOpen?: (db: Database) => void;
	/** Builds the error thrown once every attempt has been exhausted. */
	readonly onExhausted: (detail: { dbPath: string; attempts: number; lastError: Error | undefined }) => Error;
	readonly maxAttempts?: number;
	readonly baseDelayMs?: number;
}

/**
 * Open a database with the shared directory/permission/backoff policy.
 *
 * Non-busy failures propagate immediately: a corrupt or unreadable database is not something
 * a retry can fix, and swallowing it here would turn a hard error into a slow one.
 */
export async function openHardenedSqlite(options: OpenHardenedSqliteOptions): Promise<Database> {
	const { dbPath, open, onOpen, onExhausted } = options;
	const maxAttempts = options.maxAttempts ?? SQLITE_OPEN_MAX_ATTEMPTS;
	const baseDelayMs = options.baseDelayMs ?? SQLITE_OPEN_BASE_DELAY_MS;

	await ensureSqliteParentDir(dbPath);

	let lastBusyError: Error | undefined;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		let db: Database | undefined;
		try {
			db = open(dbPath);
			try {
				await fs.chmod(dbPath, 0o600);
			} catch {
				// Ignore chmod failures (e.g., Windows)
			}
			onOpen?.(db);
			// After `onOpen`, because that is where callers switch on WAL and take their first
			// write — which is what creates `-wal`/`-shm`. SQLite creates them with the process
			// umask, so without this they land `0644` while holding committed row images.
			await hardenSqliteFileModes(dbPath);
			return db;
		} catch (err) {
			db?.close();
			if (!isSqliteBusyError(err)) throw err;
			lastBusyError = err instanceof Error ? err : new Error(String(err));
			if (attempt < maxAttempts - 1) {
				await Bun.sleep(baseDelayMs * 2 ** attempt);
			}
		}
	}
	throw onExhausted({ dbPath, attempts: maxAttempts, lastError: lastBusyError });
}

/** Create the database's parent directory `0700` when it does not already exist. */
export async function ensureSqliteParentDir(dbPath: string): Promise<void> {
	const dir = path.dirname(dbPath);
	const dirExists = await fs
		.stat(dir)
		.then(s => s.isDirectory())
		.catch(() => false);
	if (!dirExists) {
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	}
}

/**
 * Clamp the database and its WAL/SHM sidecars to `0600`.
 *
 * Call after the connection has written at least once: the sidecars only exist once WAL mode
 * is active, and SQLite creates them with the process umask rather than inheriting the
 * database's mode. Missing files are not an error — a read-only or freshly deleted database
 * simply has nothing to clamp.
 */
export async function hardenSqliteFileModes(dbPath: string): Promise<void> {
	for (const file of sqliteFileSet(dbPath)) {
		try {
			await fs.chmod(file, 0o600);
		} catch {
			// Missing sidecar or a filesystem without POSIX modes: nothing to enforce.
		}
	}
}

/**
 * Synchronous {@link hardenSqliteFileModes}, for stores that open inside a constructor.
 *
 * SQLite deletes `-wal`/`-shm` when the last connection closes and recreates them on the next
 * open, so *every* opener of a shared database has to re-clamp them. One store getting this
 * wrong un-hardens the file for all the others.
 */
export function hardenSqliteFileModesSync(dbPath: string, onError?: (file: string, error: unknown) => void): void {
	for (const file of sqliteFileSet(dbPath)) {
		try {
			if (!nodeFs.existsSync(file)) continue;
			nodeFs.chmodSync(file, 0o600);
		} catch (error) {
			onError?.(file, error);
		}
	}
}

function sqliteFileSet(dbPath: string): readonly string[] {
	return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
}
