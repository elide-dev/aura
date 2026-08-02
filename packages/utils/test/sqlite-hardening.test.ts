import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	hardenSqliteFileModesSync,
	isSqliteBusyError,
	openHardenedSqlite,
	SQLITE_OPEN_MAX_ATTEMPTS,
} from "@oh-my-pi/pi-utils/sqlite-hardening";

let tempRoot = "";
let dbPath = "";

function busyError(): Error {
	return Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
}

beforeEach(async () => {
	tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sqlite-hardening-"));
	dbPath = path.join(tempRoot, "nested", "agent.db");
});

afterEach(async () => {
	await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("openHardenedSqlite", () => {
	test("creates the parent 0700 and the database 0600", async () => {
		const db = await openHardenedSqlite({
			dbPath,
			open: file => new Database(file),
			onExhausted: () => new Error("unreachable"),
		});
		db.close();
		expect(((await fs.stat(path.dirname(dbPath))).mode & 0o777).toString(8)).toBe("700");
		expect(((await fs.stat(dbPath)).mode & 0o777).toString(8)).toBe("600");
	});

	// SQLite mints `-wal`/`-shm` with the *database file's* mode at the moment it creates them,
	// which is during the caller's first WAL write — i.e. inside `onOpen`. Hardening has to
	// happen after that hook, not before it, or the sidecars keep the umask mode.
	test("clamps the WAL and SHM sidecars created during onOpen", async () => {
		const db = await openHardenedSqlite({
			dbPath,
			open: file => new Database(file),
			onOpen: handle => {
				// Deliberately before any chmod of the database: reproduces a caller whose schema
				// init runs against a freshly created, umask-moded file.
				handle.run("PRAGMA journal_mode=WAL");
				handle.run("CREATE TABLE t (a INTEGER)");
				handle.run("INSERT INTO t VALUES (1)");
			},
			onExhausted: () => new Error("unreachable"),
		});
		try {
			for (const suffix of ["", "-wal", "-shm"]) {
				const stat = await fs.stat(`${dbPath}${suffix}`).catch(() => undefined);
				if (!stat) continue;
				expect(`${suffix || "db"}:${(stat.mode & 0o777).toString(8)}`).toBe(`${suffix || "db"}:600`);
			}
		} finally {
			db.close();
		}
	});

	// Statement preparation reads the schema and can return SQLITE_BUSY under a concurrent
	// startup, so callers that build their store inside `onOpen` must get the same retry the
	// bare open gets.
	test("retries a busy failure raised from onOpen and succeeds once it clears", async () => {
		let attempts = 0;
		const db = await openHardenedSqlite({
			dbPath,
			open: file => new Database(file),
			onOpen: () => {
				attempts++;
				if (attempts < 3) throw busyError();
			},
			onExhausted: () => new Error("unreachable"),
			baseDelayMs: 1,
		});
		db.close();
		expect(attempts).toBe(3);
	});

	test("gives up through onExhausted after the attempt budget", async () => {
		let attempts = 0;
		const failure = await openHardenedSqlite({
			dbPath,
			open: file => new Database(file),
			onOpen: () => {
				attempts++;
				throw busyError();
			},
			onExhausted: detail => new Error(`exhausted after ${detail.attempts}: ${detail.lastError?.message}`),
			baseDelayMs: 1,
		}).catch((err: Error) => err);
		expect(attempts).toBe(SQLITE_OPEN_MAX_ATTEMPTS);
		expect((failure as Error).message).toBe(`exhausted after ${SQLITE_OPEN_MAX_ATTEMPTS}: database is locked`);
	});

	// A leaked handle keeps a WAL reader open, which blocks checkpoints for every other process.
	test("closes the handle when onOpen throws a non-busy error", async () => {
		let handle: Database | undefined;
		const failure = await openHardenedSqlite({
			dbPath,
			open: file => new Database(file),
			onOpen: db => {
				handle = db;
				throw new Error("constructor blew up");
			},
			onExhausted: () => new Error("unreachable"),
		}).catch((err: Error) => err);
		expect((failure as Error).message).toBe("constructor blew up");
		expect(handle).toBeDefined();
		expect(() => handle?.query("SELECT 1").get()).toThrow();
	});
});

describe("isSqliteBusyError", () => {
	test("matches the whole busy family and nothing else", () => {
		for (const code of ["SQLITE_BUSY", "SQLITE_BUSY_RECOVERY", "SQLITE_BUSY_SNAPSHOT", "SQLITE_BUSY_TIMEOUT"]) {
			expect(isSqliteBusyError(Object.assign(new Error("x"), { code }))).toBe(true);
		}
		expect(isSqliteBusyError(Object.assign(new Error("x"), { code: "SQLITE_LOCKED" }))).toBe(false);
		expect(isSqliteBusyError(new Error("x"))).toBe(false);
		expect(isSqliteBusyError(undefined)).toBe(false);
	});
});

describe("hardenSqliteFileModesSync", () => {
	test("clamps db, WAL and SHM and reports per-file failures", async () => {
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		const db = new Database(dbPath);
		db.run("PRAGMA journal_mode=WAL");
		db.run("CREATE TABLE t (a INTEGER)");
		db.run("INSERT INTO t VALUES (1)");
		await fs.chmod(dbPath, 0o644);
		await fs.chmod(`${dbPath}-wal`, 0o644);
		hardenSqliteFileModesSync(dbPath);
		for (const suffix of ["", "-wal", "-shm"]) {
			const stat = await fs.stat(`${dbPath}${suffix}`).catch(() => undefined);
			if (!stat) continue;
			expect(`${suffix || "db"}:${(stat.mode & 0o777).toString(8)}`).toBe(`${suffix || "db"}:600`);
		}
		db.close();

		// Missing files are not an error and do not invoke the reporter.
		const reported: string[] = [];
		hardenSqliteFileModesSync(path.join(tempRoot, "absent.db"), file => reported.push(file));
		expect(reported).toEqual([]);
	});
});
