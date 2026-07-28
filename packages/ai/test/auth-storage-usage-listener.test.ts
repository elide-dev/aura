/**
 * Usage-snapshot observer contract:
 *
 *   1. `setUsageSnapshotListener` fires with the same `UsageHistoryEntry[]` that
 *      lands in durable history whenever a fresh usage report is recorded.
 *   2. The observer is best-effort telemetry — a throwing listener must never
 *      propagate into the auth/usage path.
 *   3. Clearing the listener (`undefined`) stops delivery.
 *   4. Live per-chat header ingestion notifies too, not just polled reports.
 *   5. Delivery does not depend on the store being able to persist history —
 *      broker-backed stores have no `recordUsageSnapshots` and must still
 *      export utilization.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	SqliteAuthCredentialStore,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageHistoryEntry, UsageReport } from "@oh-my-pi/pi-ai/usage";
import * as claudeUsage from "@oh-my-pi/pi-ai/usage/claude";

const HOUR = 3_600_000;

function buildReport(fetchedAt: number): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt,
		limits: [
			{
				id: "anthropic:5h",
				label: "5 Hour",
				scope: { provider: "anthropic", windowId: "5h" },
				window: { id: "5h", label: "5 Hour", resetsAt: fetchedAt + 5 * HOUR },
				amount: { usedFraction: 0.42, unit: "percent" },
				status: "ok",
			},
			{
				id: "anthropic:7d",
				label: "7 Day",
				scope: { provider: "anthropic", windowId: "7d" },
				window: { id: "7d", label: "7 Day" },
				amount: { used: 84, limit: 100, unit: "percent" },
				status: "warning",
			},
		],
		metadata: { email: "a@example.com" },
	};
}

/**
 * Minimal in-memory `AuthCredentialStore` — deliberately implements NONE of the
 * optional usage hooks (`recordUsageSnapshots`, `ingestUsageReport`), so it
 * stands in for a broker-backed store with no durable usage history.
 */
function makeStorelessStore(rows: StoredAuthCredential[]): AuthCredentialStore {
	const cache = new Map<string, { value: string; expiresAtSec: number }>();
	return {
		close() {},
		listAuthCredentials() {
			return rows;
		},
		updateAuthCredential() {},
		deleteAuthCredential() {},
		tryDisableAuthCredentialIfMatches() {
			return false;
		},
		replaceAuthCredentialsForProvider() {
			return rows;
		},
		upsertAuthCredentialForProvider() {
			return rows;
		},
		deleteAuthCredentialsForProvider() {},
		getCache(key) {
			const entry = cache.get(key);
			if (!entry) return null;
			if (entry.expiresAtSec * 1000 <= Date.now()) return null;
			return entry.value;
		},
		setCache(key, value, expiresAtSec) {
			cache.set(key, { value, expiresAtSec });
		},
		cleanExpiredCache() {},
	};
}

function oauthRow(email: string): StoredAuthCredential {
	const credential: AuthCredential = {
		type: "oauth",
		access: "oat-1",
		refresh: "refresh-1",
		expires: Date.now() + HOUR,
		accountId: "account-1",
		email,
	};
	return { id: 1, provider: "anthropic", credential, disabledCause: null };
}

function usageHeaders(fiveHour: string, sevenDay: string): Record<string, string> {
	return {
		"anthropic-ratelimit-unified-5h-utilization": fiveHour,
		"anthropic-ratelimit-unified-5h-reset": "1780405800",
		"anthropic-ratelimit-unified-5h-status": "allowed",
		"anthropic-ratelimit-unified-7d-utilization": sevenDay,
		"anthropic-ratelimit-unified-7d-reset": "1780531200",
		"anthropic-ratelimit-unified-7d-status": "allowed",
	};
}

describe("AuthStorage usage snapshot listener", () => {
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;

	beforeEach(async () => {
		store = new SqliteAuthCredentialStore(new Database(":memory:"));
		store.upsertAuthCredentialForProvider("anthropic", {
			type: "oauth",
			access: "oat-1",
			refresh: "refresh-1",
			expires: Date.now() + HOUR,
			accountId: "account-1",
			email: "a@example.com",
		});
		// Restrict the resolver to anthropic so AuthStorage doesn't fan out real
		// network fetches for providers with *_API_KEY env vars on the test host.
		storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();
	});

	afterEach(() => {
		storage.close();
		vi.restoreAllMocks();
	});

	it("fires when usage history is recorded", async () => {
		const fetchedAt = Date.now();
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => buildReport(fetchedAt));

		const seen: UsageHistoryEntry[][] = [];
		storage.setUsageSnapshotListener(entries => seen.push(entries));

		await storage.fetchUsageReports();

		expect(seen.length).toBeGreaterThan(0);
		expect(seen[0]?.[0]).toHaveProperty("provider");
		expect(seen[0]?.[0]).toHaveProperty("limitId");
		// Same payload the durable store received.
		expect(seen[0]?.map(row => row.limitId).sort()).toEqual(["anthropic:5h", "anthropic:7d"]);
		expect(seen[0]?.find(row => row.limitId === "anthropic:5h")?.usedFraction).toBe(0.42);
		expect(seen[0]?.[0]?.accountKey).toContain("email:a@example.com");
	});

	it("listener throws never propagate", async () => {
		const fetchedAt = Date.now();
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => buildReport(fetchedAt));

		storage.setUsageSnapshotListener(() => {
			throw new Error("boom");
		});

		await storage.fetchUsageReports();

		// The record still landed despite the throwing observer.
		expect(storage.listUsageHistory()).toHaveLength(2);
	});

	it("stops delivering once the listener is cleared", async () => {
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => buildReport(Date.now()));

		let calls = 0;
		storage.setUsageSnapshotListener(() => {
			calls++;
		});
		await storage.fetchUsageReports();
		expect(calls).toBe(1);

		storage.setUsageSnapshotListener(undefined);
		await storage.invalidateUsageCache("anthropic");
		await storage.fetchUsageReports();
		expect(calls).toBe(1);
	});
});

describe("AuthStorage usage snapshot listener: header ingestion", () => {
	let storage: AuthStorage;

	beforeEach(async () => {
		// No durable-history hook on this store: it also proves delivery does not
		// depend on the store implementing `recordUsageSnapshots`.
		storage = new AuthStorage(makeStorelessStore([oauthRow("a@example.com")]), {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockResolvedValue(null);
		expect(await storage.getApiKey("anthropic", "s")).toBe("oat-1");
	});

	afterEach(() => {
		storage.close();
		vi.restoreAllMocks();
	});

	it("fires with the parsed header limits on a successful ingest", () => {
		const seen: UsageHistoryEntry[][] = [];
		storage.setUsageSnapshotListener(entries => seen.push(entries));

		expect(storage.ingestUsageHeaders("anthropic", usageHeaders("0.02", "0.3"), { sessionId: "s" })).toBe(true);

		expect(seen).toHaveLength(1);
		const entries = seen[0] ?? [];
		expect(entries.map(row => row.limitId).sort()).toEqual(["anthropic:5h", "anthropic:7d"]);
		expect(entries.find(row => row.limitId === "anthropic:5h")?.usedFraction).toBeCloseTo(0.02);
		expect(entries.find(row => row.limitId === "anthropic:7d")?.usedFraction).toBeCloseTo(0.3);
		for (const row of entries) {
			expect(row.provider).toBe("anthropic");
			expect(row.accountKey).toContain("email:a@example.com");
		}
	});

	it("listener throws never propagate out of ingestUsageHeaders", () => {
		let called = false;
		storage.setUsageSnapshotListener(() => {
			called = true;
			throw new Error("boom");
		});

		// Still reports the ingest as successful — the observer is out of band.
		expect(storage.ingestUsageHeaders("anthropic", usageHeaders("0.02", "0.3"), { sessionId: "s" })).toBe(true);
		expect(called).toBe(true);
	});
});

describe("AuthStorage usage snapshot listener: store without durable history", () => {
	let storage: AuthStorage;

	beforeEach(async () => {
		storage = new AuthStorage(makeStorelessStore([oauthRow("a@example.com")]), {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();
	});

	afterEach(() => {
		storage.close();
		vi.restoreAllMocks();
	});

	it("still fires on a polled report when the store cannot persist history", async () => {
		const fetchedAt = Date.now();
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => buildReport(fetchedAt));

		const seen: UsageHistoryEntry[][] = [];
		storage.setUsageSnapshotListener(entries => seen.push(entries));

		await storage.fetchUsageReports();

		// Nothing was persisted (no recordUsageSnapshots hook) but telemetry saw it.
		expect(storage.listUsageHistory()).toHaveLength(0);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.map(row => row.limitId).sort()).toEqual(["anthropic:5h", "anthropic:7d"]);
	});
});
