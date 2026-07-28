/**
 * Usage-snapshot observer contract:
 *
 *   1. `setUsageSnapshotListener` fires with the same `UsageHistoryEntry[]` that
 *      lands in durable history whenever a fresh usage report is recorded.
 *   2. The observer is best-effort telemetry — a throwing listener must never
 *      propagate into the auth/usage path.
 *   3. Clearing the listener (`undefined`) stops delivery.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
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
