/**
 * `aura account` — sign in to (or out of) the Aura account used by
 * cloud-backed surfaces (currently: the hosted observability panel).
 */
import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { ACCOUNT_ACTIONS, type AccountAction, type AccountCommandArgs, runAccountCommand } from "../cli/account-cli";
import { initTheme } from "../modes/theme/theme";

export default class Account extends Command {
	static description = `Sign in to the ${APP_NAME} account (used by the hosted observability panel)`;

	static args = {
		action: Args.string({
			description: "Sub-command",
			required: false,
			options: [...ACCOUNT_ACTIONS],
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		label: Flags.string({ description: "Device label shown when approving this login (login)" }),
		"no-open": Flags.boolean({ description: "Do not open a browser automatically (login)" }),
		force: Flags.boolean({ description: "Sign out locally even if the server logout fails (logout)" }),
	};

	static examples = [
		`# Sign in\n  ${APP_NAME} account login`,
		`# Sign in without opening a browser\n  ${APP_NAME} account login --no-open`,
		`# Check who is signed in\n  ${APP_NAME} account status`,
		`# Sign out\n  ${APP_NAME} account logout`,
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Account);
		if (!args.action) {
			renderCommandHelp(APP_NAME, "account", Account);
			return;
		}
		const cmd: AccountCommandArgs = {
			action: args.action as AccountAction,
			flags: {
				json: flags.json,
				label: flags.label,
				open: !flags["no-open"],
				force: flags.force,
			},
		};
		await initTheme();
		await runAccountCommand(cmd);
	}
}
