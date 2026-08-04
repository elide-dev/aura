/**
 * CLI handler for `aura account` — sign in to (or out of) the Aura account
 * used by cloud-backed surfaces (currently: the hosted observability panel).
 *
 * This is aura-only: `omp` carries none of this. See docs/aura/FORK.md.
 */
import * as readline from "node:readline";
import chalk from "chalk";
import { AuraAuthClient, type AuraLoginPresenter, type AuraOrganizationOption } from "../cloud/auth";
import {
	auraDeploymentFor,
	readCloudSwitches,
	resolveAuraDeployment,
	resolveServiceEndpoint,
} from "../cloud/deployment";
import { isAuraCloudError } from "../cloud/errors";
import { AuraTokenStore } from "../cloud/token-store";
import { Settings } from "../config/settings";
import { openPath } from "../utils/open";

export type AccountAction = "login" | "logout" | "status";
export const ACCOUNT_ACTIONS = ["login", "logout", "status"] as const;

export interface AccountCommandArgs {
	action: AccountAction;
	flags: {
		json?: boolean;
		label?: string;
		open?: boolean;
		force?: boolean;
	};
}

/** Resolve the configured auth origin, or `undefined` when Aura is not configured at all. */
function resolveAuthOrigin(settings: Settings): string | undefined {
	const deployment = resolveAuraDeployment({ env: process.env });
	const switches = readCloudSwitches(settings);
	const narrowed = auraDeploymentFor("account", deployment, switches);
	return resolveServiceEndpoint("auth", { deployment: narrowed })?.url;
}

async function openStore(): Promise<AuraTokenStore> {
	return await AuraTokenStore.open();
}

function cliPresenter(openBrowser: boolean): AuraLoginPresenter {
	return {
		present(approval) {
			console.log(chalk.bold("\nSign in to Aura"));
			console.log(`  Go to: ${chalk.cyan(approval.verificationUri)}`);
			console.log(`  Enter code: ${chalk.bold(approval.userCode)}`);
			if (openBrowser) console.log(chalk.dim("  (opening your browser to the pre-filled link...)"));
			console.log(chalk.dim("Waiting for approval...\n"));
		},
		open(url) {
			openPath(url);
		},
		async selectOrganization(options: readonly AuraOrganizationOption[]): Promise<string | undefined> {
			console.log(chalk.bold("\nMultiple organizations are available:"));
			options.forEach((option, index) => {
				console.log(`  ${index + 1}. ${option.name ?? option.id}`);
			});
			const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
			try {
				const answer = await new Promise<string>(resolve => rl.question("Select a number: ", resolve));
				const index = Number.parseInt(answer.trim(), 10) - 1;
				return options[index]?.id;
			} finally {
				rl.close();
			}
		},
	};
}

function explainAuthError(error: unknown): string {
	if (isAuraCloudError(error)) {
		switch (error.code) {
			case "login_required":
				return "Not signed in. Run `aura account login` first.";
			case "relogin_required":
				return "Your Aura session has expired. Run `aura account login` again.";
			case "access_denied":
				return "Sign-in was denied.";
			case "expired":
				return "The sign-in code expired before it was approved.";
			case "invalid_configuration":
				return "AURA_DOMAIN (or an explicit AURA_AUTH_URL) is not configured.";
			default:
				return `Aura request failed: ${error.code}`;
		}
	}
	return error instanceof Error ? error.message : String(error);
}

export async function runAccountCommand(cmd: AccountCommandArgs): Promise<void> {
	const settings = await Settings.init();
	const authOrigin = resolveAuthOrigin(settings);
	if (!authOrigin) {
		const message = "Aura is not configured — set AURA_DOMAIN (or AURA_AUTH_URL) first.";
		if (cmd.flags.json) console.log(JSON.stringify({ error: message }));
		else console.error(chalk.red(message));
		process.exitCode = 1;
		return;
	}

	const store = await openStore();
	const client = new AuraAuthClient({ authOrigin, store });

	try {
		switch (cmd.action) {
			case "login": {
				const result = await client.login({
					label: cmd.flags.label,
					open: cmd.flags.open ?? true,
					presenter: cliPresenter(cmd.flags.open ?? true),
				});
				if (cmd.flags.json) {
					console.log(JSON.stringify({ signedIn: true, ...result }));
				} else {
					console.log(chalk.green(`Signed in (account ${result.identity.accountId}).`));
				}
				return;
			}
			case "logout": {
				const result = await client.logout({ force: cmd.flags.force });
				if (cmd.flags.json) console.log(JSON.stringify(result));
				else
					console.log(chalk.green(result.revoked ? "Signed out." : "Signed out locally (server logout failed)."));
				return;
			}
			case "status": {
				const status = client.status();
				if (cmd.flags.json) {
					console.log(JSON.stringify(status));
				} else if (!status.signedIn) {
					console.log(chalk.dim("Not signed in to Aura."));
				} else {
					console.log(chalk.green(`Signed in as account ${status.identity?.accountId} (${status.issuer}).`));
				}
				return;
			}
		}
	} catch (error) {
		const message = explainAuthError(error);
		if (cmd.flags.json) console.log(JSON.stringify({ error: message }));
		else console.error(chalk.red(message));
		process.exitCode = 1;
	}
}
