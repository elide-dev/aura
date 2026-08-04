/**
 * Stats CLI command handlers.
 *
 * Handles `omp stats` subcommand for viewing AI usage statistics.
 */

import type { MessageStats } from "@oh-my-pi/omp-stats";
import { truncateToWidth } from "@oh-my-pi/pi-tui/utils";
import { APP_NAME, formatDuration, formatNumber, formatPercent } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import {
	auraDeploymentFor,
	readCloudSwitches,
	resolveAuraDeployment,
	resolveServiceEndpoint,
	resolveStatsPanelUrl,
} from "../cloud/deployment";
import { isAuraCloudError } from "../cloud/errors";
import { TokenManager } from "../cloud/token-manager";
import { AuraTokenStore } from "../cloud/token-store";
import { Settings } from "../config/settings";
import { openPath } from "../utils/open";

/**
 * Single-line TTY progress bar. On a non-TTY stream we just stay quiet -
 * the final "Synced ..." summary still prints either way.
 */
function createSyncProgressReporter(): {
	onProgress: (event: { current: number; total: number; sessionFile: string }) => void;
	finish: () => void;
} {
	const stream = process.stderr;
	const isTty = stream.isTTY === true;
	let lastWidth = 0;
	let lastRender = 0;
	return {
		onProgress(event) {
			if (!isTty) return;
			const now = Date.now();
			// Throttle to ~30 fps and always force a render for the last file.
			if (event.current < event.total && now - lastRender < 33) return;
			lastRender = now;
			const label = chalk.dim(shortenSessionFile(event.sessionFile));
			const pct = ((event.current / event.total) * 100).toFixed(0).padStart(3, " ");
			const counter = chalk.cyan(`[${event.current}/${event.total}]`);
			const line = `${counter} ${pct}%  ${label}`;
			const columns = stream.columns ?? 120;
			const trimmed = truncateToWidth(line, columns - 1);
			stream.write(`\r${trimmed.padEnd(lastWidth)}`);
			lastWidth = trimmed.length;
		},
		finish() {
			if (!isTty || lastWidth === 0) return;
			stream.write(`\r${" ".repeat(lastWidth)}\r`);
			lastWidth = 0;
		},
	};
}

function shortenSessionFile(p: string): string {
	const marker = "/sessions/";
	const idx = p.indexOf(marker);
	return idx >= 0 ? p.slice(idx + marker.length) : p;
}

// =============================================================================
// Types
// =============================================================================

export interface StatsCommandArgs {
	port: number;
	json: boolean;
	summary: boolean;
}

// =============================================================================
// Argument Parser
// =============================================================================

/**
 * Parse stats subcommand arguments.
 * Returns undefined if not a stats command.
 */
export function parseStatsArgs(args: string[]): StatsCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "stats") {
		return undefined;
	}

	const result: StatsCommandArgs = {
		port: 3847,
		json: false,
		summary: false,
	};

	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json" || arg === "-j") {
			result.json = true;
		} else if (arg === "--summary" || arg === "-s") {
			result.summary = true;
		} else if ((arg === "--port" || arg === "-p") && i + 1 < args.length) {
			result.port = parseInt(args[++i], 10);
		} else if (arg.startsWith("--port=")) {
			result.port = parseInt(arg.split("=")[1], 10);
		}
	}

	return result;
}

function formatCost(n: number): string {
	if (n < 0.01) return `$${n.toFixed(4)}`;
	if (n < 1) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(2)}`;
}

function normalizePremiumRequests(n: number): number {
	return Math.round((n + Number.EPSILON) * 100) / 100;
}

// =============================================================================
// Hosted panel (aura-only; omp's `stats` stays fully local — see docs/aura/FORK.md)
// =============================================================================

/** Batch cap on the ingest worker's side (workers/stats/contract.ts, elide-cloud). */
const STATS_PUSH_BATCH_LIMIT = 500;

function toStatsRecord(m: MessageStats): Record<string, unknown> {
	return {
		sessionFile: m.sessionFile,
		entryId: m.entryId,
		folder: m.folder,
		model: m.model,
		provider: m.provider,
		api: m.api,
		timestamp: m.timestamp,
		duration: m.duration,
		ttft: m.ttft,
		stopReason: m.stopReason,
		errorMessage: m.errorMessage,
		usage: {
			input: m.usage.input,
			output: m.usage.output,
			cacheRead: m.usage.cacheRead,
			cacheWrite: m.usage.cacheWrite,
			totalTokens: m.usage.totalTokens,
			premiumRequests: m.usage.premiumRequests,
		},
		cost: m.usage.cost,
		agentType: m.agentType,
	};
}

/**
 * Push the most recent local records to the Aura ingest endpoint and, on success, open the
 * hosted panel instead of starting a local server. Returns `false` for every reason the caller
 * should fall back to the existing fully-local flow: `cloud.stats.enabled` is off (the default —
 * this ships session history outward, which is opt-in), Aura is not configured at all, the user
 * has not run `aura account login`, or the push itself failed. None of those are treated as a
 * hard error — the local dashboard has always worked without any of this and must keep working.
 */
async function tryOpenHostedPanel(): Promise<boolean> {
	const settings = await Settings.init();
	const deployment = resolveAuraDeployment({ env: process.env });
	const switches = readCloudSwitches(settings);
	if (!(switches.stats ?? false)) return false;

	const narrowed = auraDeploymentFor("stats", deployment, switches);
	const authOrigin = resolveServiceEndpoint("auth", {
		deployment: auraDeploymentFor("account", deployment, switches),
	})?.url;
	const ingestUrl = resolveServiceEndpoint("stats", { deployment: narrowed })?.url;
	const panelUrl = resolveStatsPanelUrl(deployment.domain);
	if (!authOrigin || !ingestUrl || !panelUrl) return false;

	let token: string;
	try {
		const store = await AuraTokenStore.open();
		const manager = new TokenManager({ authOrigin, store });
		token = (await manager.getAccessToken()).value;
	} catch (error) {
		if (isAuraCloudError(error) && (error.code === "login_required" || error.code === "relogin_required")) {
			console.log(chalk.dim("Hosted panel is enabled but you are not signed in — run `aura account login`."));
			console.log(chalk.dim("Falling back to the local dashboard.\n"));
		} else {
			console.log(chalk.yellow(`Could not reach Aura (${error instanceof Error ? error.message : String(error)}).`));
			console.log(chalk.dim("Falling back to the local dashboard.\n"));
		}
		return false;
	}

	const { getRecentRequests } = await import("@oh-my-pi/omp-stats");
	const recent = await getRecentRequests(STATS_PUSH_BATCH_LIMIT);
	if (recent.length > 0) {
		try {
			const response = await fetch(`${ingestUrl}/v1/messages`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
				body: JSON.stringify({ records: recent.map(toStatsRecord) }),
			});
			if (!response.ok) {
				console.log(chalk.yellow(`Push to the hosted panel failed (HTTP ${response.status}).`));
				console.log(chalk.dim("Falling back to the local dashboard.\n"));
				return false;
			}
			const result = (await response.json()) as { inserted?: number };
			console.log(chalk.green(`Pushed ${result.inserted ?? 0} record(s) to the hosted panel.`));
		} catch (error) {
			console.log(
				chalk.yellow(
					`Push to the hosted panel failed (${error instanceof Error ? error.message : String(error)}).`,
				),
			);
			console.log(chalk.dim("Falling back to the local dashboard.\n"));
			return false;
		}
	}

	console.log(chalk.green(`Hosted dashboard: ${panelUrl}`));
	// Interim auth handoff: the CLI already holds a valid token; the panel does not yet have a
	// session of its own to hand it to, so it rides in the fragment (never sent to the server,
	// never logged) rather than a query param. The client-side consumption of this fragment is
	// not wired up yet — see elide-cloud's workers/stats-panel/public/README.md.
	openPath(`${panelUrl}#token=${encodeURIComponent(token)}`);
	return true;
}

// =============================================================================
// Command Handler
// =============================================================================

export async function runStatsCommand(cmd: StatsCommandArgs): Promise<void> {
	// Lazy import to avoid loading stats module when not needed
	const { getDashboardStats, syncAllSessions, getTotalMessageCount, startServer, closeDb } = await import(
		"@oh-my-pi/omp-stats"
	);

	// Sync session files first
	const progress = createSyncProgressReporter();
	process.stderr.write("Syncing session files...\n");
	const { processed, files } = await syncAllSessions({ onProgress: progress.onProgress });
	progress.finish();
	const total = await getTotalMessageCount();
	console.log(`Synced ${processed} new entries from ${files} files (${total} total)\n`);

	if (cmd.json) {
		const stats = await getDashboardStats();
		console.log(JSON.stringify(stats, null, 2));
		return;
	}

	if (cmd.summary) {
		await printStatsSummary();
		return;
	}

	if (await tryOpenHostedPanel()) {
		closeDb();
		return;
	}

	// Start the dashboard server
	const { port } = await startServer(cmd.port);
	console.log(chalk.green(`Dashboard available at: http://localhost:${port}`));

	// Open browser
	const url = `http://localhost:${port}`;
	openPath(url);

	console.log("Press Ctrl+C to stop\n");

	// Keep process running
	process.on("SIGINT", () => {
		console.log("\nShutting down...");
		closeDb();
		process.exit(0);
	});

	// Keep the process alive
	await new Promise(() => {});
}

async function printStatsSummary(): Promise<void> {
	const { getDashboardStats } = await import("@oh-my-pi/omp-stats");
	const stats = await getDashboardStats();
	const { overall, byModel, byFolder } = stats;

	console.log(chalk.bold("\n=== AI Usage Statistics ===\n"));

	console.log(chalk.bold("Overall:"));
	console.log(`  Requests: ${formatNumber(overall.totalRequests)} (${formatNumber(overall.failedRequests)} errors)`);
	console.log(`  Error Rate: ${formatPercent(overall.errorRate)}`);
	console.log(`  Total Tokens: ${formatNumber(overall.totalInputTokens + overall.totalOutputTokens)}`);
	console.log(`  Input Tokens: ${formatNumber(overall.totalInputTokens)}`);
	console.log(`  Output Tokens: ${formatNumber(overall.totalOutputTokens)}`);
	console.log(`  Cache Rate: ${formatPercent(overall.cacheRate)}`);
	console.log(`  Total Cost: ${formatCost(overall.totalCost)}`);
	console.log(`  Premium Requests: ${formatNumber(normalizePremiumRequests(overall.totalPremiumRequests ?? 0))}`);
	console.log(`  Avg Duration: ${overall.avgDuration !== null ? formatDuration(overall.avgDuration) : "-"}`);
	console.log(`  Avg TTFT: ${overall.avgTtft !== null ? formatDuration(overall.avgTtft) : "-"}`);
	if (overall.avgTokensPerSecond !== null) {
		console.log(`  Avg Tokens/s: ${overall.avgTokensPerSecond.toFixed(1)}`);
	}

	if (byModel.length > 0) {
		console.log(chalk.bold("\nBy Model:"));
		for (const m of byModel.slice(0, 10)) {
			console.log(
				`  ${m.model}: ${formatNumber(m.totalRequests)} reqs, ${formatCost(m.totalCost)}, ${formatPercent(m.cacheRate)} cache`,
			);
		}
	}

	if (byFolder.length > 0) {
		console.log(chalk.bold("\nBy Folder:"));
		for (const f of byFolder.slice(0, 10)) {
			console.log(`  ${f.folder}: ${formatNumber(f.totalRequests)} reqs, ${formatCost(f.totalCost)}`);
		}
	}

	console.log("");
}

// =============================================================================
// Help
// =============================================================================

export function printStatsHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} stats`)} - AI Usage Statistics Dashboard

${chalk.bold("Usage:")}
  ${APP_NAME} stats [options]

${chalk.bold("Options:")}
  -p, --port <port>  Port for the dashboard server (default: 3847)
  -j, --json         Output stats as JSON and exit
  -s, --summary      Print summary to console and exit
  -h, --help         Show this help message

${chalk.bold("Examples:")}
  ${APP_NAME} stats              # Start dashboard server
  ${APP_NAME} stats --json       # Print stats as JSON
  ${APP_NAME} stats --summary    # Print summary to console
  ${APP_NAME} stats --port 8080  # Start on custom port

${chalk.bold("Metrics:")}
  - Total requests and error rate
  - Token usage (input, output, cache)
  - Cost breakdown
  - Average duration and time to first token (TTFT)
  - Tokens per second throughput
`);
}
