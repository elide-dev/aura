/**
 * `aura doctor` — aggregate environment readiness in one shot.
 *
 * Thin oclif shell over {@link runDoctorCommand} (commands/runtime.ts precedent):
 * initialize settings, delegate, and translate the returned code into
 * `process.exitCode`.
 */
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { runDoctorCommand } from "../cli/doctor-cli";
import { Settings } from "../config/settings";

export default class Doctor extends Command {
	static description = "Report environment readiness (identity, runtime, natives, tools, plugins, terminal, memory)";

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		check: Flags.boolean({ description: "Single-line readiness probe (same as `--check`)" }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Doctor);
		// Doctor reports on the same configuration the agent resolves: the runtime,
		// tools and memory sections all read the settings singleton.
		await Settings.init({ cwd: getProjectDir() });
		const code = await runDoctorCommand({ flags: { json: flags.json, check: flags.check } });
		// `Command` has no `exit()`; gc.ts's precedent is to set the process exit
		// code and return so the CLI can flush stdout before the process ends.
		if (code !== 0) process.exitCode = code;
	}
}
