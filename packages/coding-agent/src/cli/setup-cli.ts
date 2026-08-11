/**
 * Setup CLI command handler.
 *
 * Handles `omp setup` for onboarding and `omp setup <component>` for optional dependencies.
 */
import * as path from "node:path";
import { APP_NAME, getProjectDir, getPythonEnvDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { Settings, settings } from "../config/settings";
import { checkPythonKernelAvailability } from "../eval/py/kernel";
import { theme } from "../modes/theme/theme";
import type { ResolvedRuntime, RuntimeSettingsValues, RuntimeStatusResult } from "../runtime";
import { downloadSttModel, isSttModelCached } from "../stt/downloader";
import { isSttModelKey, STT_MODEL_OPTIONS } from "../stt/models";
import { downloadTtsModel, isTtsLocalModelKey, isTtsModelCached, TTS_LOCAL_MODEL_OPTIONS } from "../tts";
import {
	createStatusRuntime,
	ensureRuntimeInstalled,
	formatRuntimeStatus,
	isRuntimeDisabled,
	readRuntimeSettings,
	runRuntimeCommand,
	type StatusRuntime,
} from "./runtime-cli";
import { selectSetupModel } from "./setup-model-picker";

export type SetupComponent = "python" | "speech" | "runtime";

export interface SetupCommandArgs {
	component: SetupComponent;
	flags: {
		json?: boolean;
		check?: boolean;
	};
}

const VALID_COMPONENTS: SetupComponent[] = ["python", "speech", "runtime"];

const MANAGED_PYTHON_ENV = getPythonEnvDir();

/**
 * Parse setup subcommand arguments.
 * Returns undefined if not a setup command.
 */
export function parseSetupArgs(args: string[]): SetupCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "setup") {
		return undefined;
	}

	if (args.length < 2) {
		console.error(chalk.red(`Usage: ${APP_NAME} setup <component>`));
		console.error(`Valid components: ${VALID_COMPONENTS.join(", ")}`);
		process.exit(1);
	}

	const component = args[1];
	if (!VALID_COMPONENTS.includes(component as SetupComponent)) {
		console.error(chalk.red(`Unknown component: ${component}`));
		console.error(`Valid components: ${VALID_COMPONENTS.join(", ")}`);
		process.exit(1);
	}

	const flags: SetupCommandArgs["flags"] = {};
	for (let i = 2; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json") {
			flags.json = true;
		} else if (arg === "--check" || arg === "-c") {
			flags.check = true;
		}
	}

	return {
		component: component as SetupComponent,
		flags,
	};
}

interface PythonCheckResult {
	available: boolean;
	pythonPath?: string;
	usingManagedEnv?: boolean;
	managedEnvPath?: string;
}

function managedPythonPath(): string {
	return process.platform === "win32"
		? path.join(MANAGED_PYTHON_ENV, "Scripts", "python.exe")
		: path.join(MANAGED_PYTHON_ENV, "bin", "python");
}

/**
 * Check Python environment and kernel dependencies.
 */
async function checkPythonSetup(cwd: string, interpreter?: string): Promise<PythonCheckResult> {
	const availability = await checkPythonKernelAvailability(cwd, interpreter, { forceProbe: true });
	return {
		available: availability.ok,
		pythonPath: availability.pythonPath,
		usingManagedEnv: availability.pythonPath === managedPythonPath(),
		managedEnvPath: MANAGED_PYTHON_ENV,
	};
}

/**
 * Install Python packages using uv (preferred) or pip.
 */
// Python installation helper removed: the subprocess runner has no Python
// package dependencies beyond a working interpreter. `omp setup python --check`
// remains as a probe; users install optional libs (pandas, matplotlib, ...)
// directly via pip or the in-process `%pip` magic.

/**
 * Run the setup command.
 */
export async function runSetupCommand(cmd: SetupCommandArgs): Promise<void> {
	switch (cmd.component) {
		case "python":
			await handlePythonSetup(cmd.flags);
			break;
		case "speech":
			await handleSpeechSetup(cmd.flags);
			break;
		case "runtime":
			await handleRuntimeSetup(cmd.flags);
			break;
	}
}

async function handlePythonSetup(flags: { json?: boolean; check?: boolean }): Promise<void> {
	const cwd = getProjectDir();
	const projectSettings = await Settings.init({ cwd });
	const interpreter = projectSettings.get("python.interpreter")?.trim() || undefined;
	const check = await checkPythonSetup(cwd, interpreter);

	if (flags.json) {
		console.log(JSON.stringify(check, null, 2));
		if (!check.available) process.exit(1);
		return;
	}

	if (!check.pythonPath) {
		console.error(chalk.red(`${theme.status.error} Python not found`));
		console.error(chalk.dim("Install Python 3.8+ or set python.interpreter to its executable path"));
		process.exit(1);
	}

	console.log(chalk.dim(`Python: ${check.pythonPath}`));
	if (check.usingManagedEnv) {
		console.log(chalk.dim(`Using managed environment: ${check.managedEnvPath}`));
	}

	if (check.available) {
		console.log(chalk.green(`\n${theme.status.success} Python execution is ready`));
		return;
	}

	console.error(chalk.red(`\n${theme.status.error} Python interpreter reported failure`));
	process.exit(1);
}

/**
 * Injection points for {@link runRuntimeSetup}. Production passes none; tests
 * drive every branch without a runtime, a network, or a settings document.
 */
export interface RuntimeSetupDependencies {
	readSettings?: () => RuntimeSettingsValues;
	createRuntime?: (values: RuntimeSettingsValues) => StatusRuntime;
	install?: (values: RuntimeSettingsValues, onProgress: (message: string) => void) => Promise<ResolvedRuntime>;
	print?: (line: string) => void;
	/** Transient single-line sink for download progress. */
	progress?: (text: string) => void;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** One status probe, always closing the service it was given. */
async function probeRuntimeStatus(service: StatusRuntime): Promise<RuntimeStatusResult> {
	if (isRuntimeDisabled(service)) throw new Error("runtime.enabled = false");
	try {
		return await service.status();
	} finally {
		await service.close?.();
	}
}

/**
 * `aura setup runtime` — the component form of the managed runtime.
 *
 * `--check`/`--json` are `aura runtime status` exactly: the same probe (which
 * forces `autoDownload: false`), the same renderer, the same exit code, so the
 * two commands can never disagree. The command's own surface is the bare install
 * path, which performs the managed download that otherwise only happens
 * implicitly inside the first innate tool call, then re-probes and reports the
 * real adapter/ABI/schema state it produced.
 */
export async function runRuntimeSetup(
	flags: { json?: boolean; check?: boolean },
	deps: RuntimeSetupDependencies = {},
): Promise<number> {
	const createRuntime = deps.createRuntime ?? createStatusRuntime;
	const install = deps.install ?? ensureRuntimeInstalled;
	const print = deps.print ?? (line => console.log(line));
	// An injected sink owns its own line discipline; the default one overwrites a
	// single terminal row, so it has to close that row — and only if it opened one.
	const sink = deps.progress;
	let progressed = false;
	const progress = (text: string) => {
		progressed = true;
		if (sink) sink(text);
		else process.stdout.write(`\r${chalk.dim(text)}\x1b[K`);
	};
	const endProgress = () => {
		if (progressed && !sink) process.stdout.write("\n");
	};
	const values = (deps.readSettings ?? readRuntimeSettings)();
	const service = createRuntime(values);

	if (flags.check || flags.json) {
		return runRuntimeCommand({ action: "status", flags: { json: flags.json } }, service, print);
	}
	if (isRuntimeDisabled(service)) {
		const code = await runRuntimeCommand({ action: "status", flags: {} }, service, print);
		print(chalk.dim(`Enable it with \`${APP_NAME} config set runtime.enabled true\`, then rerun this command.`));
		return code;
	}

	let status: RuntimeStatusResult;
	try {
		status = await probeRuntimeStatus(service);
	} catch (error) {
		print(chalk.red(`${theme.status.error} ${errorMessage(error)}`));
		return 1;
	}
	if (status.available) {
		print(formatRuntimeStatus(status));
		print(chalk.green(`\n${theme.status.success} The runtime is installed and ready`));
		return 0;
	}

	print(chalk.dim("Installing the managed runtime..."));
	try {
		await install(values, message => progress(message));
	} catch (error) {
		endProgress();
		// The runtime's own refusal, verbatim: it is the surface that knows why.
		print(chalk.red(`${theme.status.error} ${errorMessage(error)}`));
		return 1;
	}
	endProgress();

	let installed: RuntimeStatusResult;
	try {
		installed = await probeRuntimeStatus(createRuntime(values));
	} catch (error) {
		print(chalk.red(`${theme.status.error} ${errorMessage(error)}`));
		return 1;
	}
	print(formatRuntimeStatus(installed));
	if (!installed.available) {
		print(chalk.red(`\n${theme.status.error} The runtime is installed but not usable`));
		return 1;
	}
	print(chalk.green(`\n${theme.status.success} The runtime is installed and ready`));
	return 0;
}

async function handleRuntimeSetup(flags: { json?: boolean; check?: boolean }): Promise<void> {
	await Settings.init({ cwd: getProjectDir() });
	const code = await runRuntimeSetup(flags);
	// `Command` has no `exit()`; set the code and return so stdout flushes first
	// (the `commands/runtime.ts` precedent).
	if (code !== 0) process.exitCode = code;
}

/**
 * One installable speech dependency. `isReady`/`status` are read-only probes;
 * `pick` (optional) lets an interactive user choose + persist a model; `ensure`
 * performs the download, streaming a normalized progress event.
 */
interface SpeechComponent {
	name: string;
	isReady(): Promise<boolean>;
	status(): Promise<string>;
	pick?(): Promise<boolean>;
	ensure(onProgress: (progress: { stage: string; percent?: number }) => void): Promise<void>;
}

function buildSpeechComponents(): SpeechComponent[] {
	return [
		{
			name: "Speech-to-Text model",
			isReady: () => isSttModelCached(settings.get("stt.modelName")),
			status: async () => {
				const key = settings.get("stt.modelName");
				return (await isSttModelCached(key)) ? key : `${key} — not downloaded`;
			},
			pick: async () => {
				const chosen = await selectSetupModel(
					"Speech-to-Text model",
					[...STT_MODEL_OPTIONS],
					settings.get("stt.modelName"),
				);
				if (chosen === null) return false;
				if (isSttModelKey(chosen)) {
					settings.set("stt.modelName", chosen);
					await settings.flush();
				}
				return true;
			},
			ensure: onProgress =>
				downloadSttModel(settings.get("stt.modelName"), progress =>
					onProgress({ stage: `Downloading ${progress.label} model`, percent: progress.percent }),
				),
		},
		{
			name: "Text-to-Speech model",
			isReady: () => isTtsModelCached(settings.get("tts.localModel")),
			status: async () => {
				const key = settings.get("tts.localModel");
				return (await isTtsModelCached(key)) ? key : `${key} — model/runtime not installed`;
			},
			pick: async () => {
				const chosen = await selectSetupModel(
					"Text-to-Speech model",
					[...TTS_LOCAL_MODEL_OPTIONS],
					settings.get("tts.localModel"),
				);
				if (chosen === null) return false;
				if (isTtsLocalModelKey(chosen)) {
					settings.set("tts.localModel", chosen);
					await settings.flush();
				}
				return true;
			},
			ensure: async onProgress => {
				const ok = await downloadTtsModel(settings.get("tts.localModel"), progress =>
					onProgress({ stage: progress.stage, percent: progress.percent }),
				);
				if (!ok) throw new Error("Failed to download the local text-to-speech model.");
			},
		},
	];
}

/**
 * Unified `omp setup speech` flow. Drives every {@link SpeechComponent} through
 * one path: report (`--json`/`--check`) or install (interactive pick + ensure
 * with single-line progress; non-TTY skips pickers and installs configured
 * values).
 */
async function handleSpeechSetup(flags: { json?: boolean; check?: boolean }): Promise<void> {
	await Settings.init({ cwd: getProjectDir() });
	const components = buildSpeechComponents();

	if (flags.json) {
		const report: Record<string, { ready: boolean; status: string }> = {};
		let allReady = true;
		for (const component of components) {
			const ready = await component.isReady();
			if (!ready) allReady = false;
			report[component.name] = { ready, status: await component.status() };
		}
		console.log(JSON.stringify(report, null, 2));
		if (!allReady) process.exit(1);
		return;
	}

	if (flags.check) {
		console.log(chalk.bold("Speech dependencies:"));
		let allReady = true;
		for (const component of components) {
			const ready = await component.isReady();
			if (!ready) allReady = false;
			const mark = ready ? chalk.green("[ok]") : chalk.yellow("[missing]");
			console.log(`  ${mark} ${component.name}: ${await component.status()}`);
		}
		if (!allReady) process.exit(1);
		return;
	}

	const interactive = Boolean(process.stdout.isTTY);
	for (const component of components) {
		if (interactive && component.pick) {
			await component.pick();
		}
		if (await component.isReady()) {
			console.log(chalk.green(`${theme.status.success} ${component.name} ready`));
			continue;
		}
		console.log(chalk.dim(`Preparing ${component.name}...`));
		try {
			await component.ensure(progress => {
				const percent = typeof progress.percent === "number" ? ` (${progress.percent}%)` : "";
				process.stdout.write(`\r${chalk.dim(`${progress.stage}${percent}`)}\x1b[K`);
			});
			process.stdout.write("\n");
		} catch (err) {
			process.stdout.write("\n");
			const msg = err instanceof Error ? err.message : `Failed to set up ${component.name}`;
			console.error(chalk.red(`${theme.status.error} ${msg}`));
			process.exit(1);
		}
	}

	console.log(chalk.green(`\n${theme.status.success} Speech is ready`));
	console.log(
		chalk.dim(
			"Enable speech-to-text via stt.enabled, then hold Space to talk (or bind app.stt.toggle); enable the speech-generation tool via speechgen.enabled; speak replies aloud via speech.enabled.",
		),
	);
}

/**
 * Print setup command help.
 */
export function printSetupHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} setup`)} - Run onboarding or install dependencies for optional features

${chalk.bold("Usage:")}
  ${APP_NAME} setup                     Run the onboarding wizard
  ${APP_NAME} setup <component> [options]

${chalk.bold("Components:")}
  python    Verify a Python 3 interpreter is reachable for code execution
  speech    Pick and download speech-to-text and text-to-speech models
  runtime   Install the managed runtime that powers the innate execution tools

${chalk.bold("Options:")}
  -c, --check   Check if dependencies are installed without installing
  --json        Output status as JSON

${chalk.bold("Examples:")}
  ${APP_NAME} setup                  Run the onboarding wizard
  ${APP_NAME} setup python           Check Python execution dependencies
  ${APP_NAME} setup speech           Pick and download the STT and TTS models
  ${APP_NAME} setup speech --check   Check if speech dependencies are available
  ${APP_NAME} setup python --check   Check if Python execution is available
  ${APP_NAME} setup runtime          Download the managed runtime if it is missing
  ${APP_NAME} setup runtime --check  Report runtime readiness (same as \`${APP_NAME} runtime status\`)
`);
}
