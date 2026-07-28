/**
 * Inspect the managed runtime powering the innate run/check/build/insights/profile tools.
 */
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { createStatusRuntime, readRuntimeSettings, runRuntimeCommand } from "../cli/runtime-cli";
import { Settings } from "../config/settings";

export default class Runtime extends Command {
	static description = "Manage the innate code runtime";

	static args = {
		action: Args.string({
			description: "Runtime action",
			required: false,
			options: ["status"],
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		runtime: Flags.string({ description: "Report on this runtime binary instead of runtime.path" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Runtime);
		const action = (args.action ?? "status") as "status";
		// Report on the same configuration the innate tools resolve: `runRuntimeCommand`'s
		// default service reads `runtime.*` off the settings singleton (say.ts precedent).
		// `--runtime` is the flag layer over that, mirroring the launch flag.
		await Settings.init({ cwd: getProjectDir() });
		const service = createStatusRuntime(readRuntimeSettings(flags.runtime ? { path: flags.runtime } : {}));
		const code = await runRuntimeCommand({ action, flags: { json: flags.json } }, service);
		// `Command` has no `exit()`; gc.ts's precedent is to set the process exit code
		// and return so the CLI can flush stdout before the process ends.
		if (code !== 0) process.exitCode = code;
	}
}
