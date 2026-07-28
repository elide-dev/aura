/**
 * Telemetry resource identity.
 *
 * Pseudonymous by default: a random install id persisted under the config
 * root, service name/version, and nothing that identifies the human. Opt-in
 * identity attributes (hostname, workspace) are added only when the matching
 * telemetry.identity.* setting is true (account identity is handled at the
 * usage-limit event level, not as a resource attribute).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigRootDir, logger, VERSION } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";

const SERVICE_NAME = "aura";

const INSTALL_ID_FILE = "telemetry-install-id";
const INSTALL_ID_RE = /^[0-9a-f-]{36}$/;

let cachedInstallId: string | undefined;

/**
 * A random UUID generated once per install, persisted at
 * `<configRoot>/telemetry-install-id`. Random (not machine-derived), so it is
 * strictly non-reversible; deleting the file rotates the id.
 *
 * Deliberately distinct from `getInstallId()` in `@oh-my-pi/pi-utils` (which
 * backs server-side dedup for grievance pushes): telemetry identity has to be
 * rotatable on its own, without disturbing unrelated install-scoped state.
 */
export function getOrCreateInstallId(): string {
	if (cachedInstallId) return cachedInstallId;
	const file = path.join(getConfigRootDir(), INSTALL_ID_FILE);
	try {
		const existing = fs.readFileSync(file, "utf8").trim();
		if (INSTALL_ID_RE.test(existing)) {
			cachedInstallId = existing;
			return existing;
		}
	} catch {
		// fall through to mint
	}
	const minted = crypto.randomUUID();
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `${minted}\n`, { mode: 0o600 });
	} catch (error) {
		logger.debug("telemetry: could not persist install id", { error: String(error) });
	}
	cachedInstallId = minted;
	return minted;
}

/** Resource attributes for all providers. `OTEL_SERVICE_NAME` env overrides the name. */
export function buildResourceAttributes(options?: { settings?: Pick<Settings, "get"> }): Record<string, string> {
	const attrs: Record<string, string> = {
		"service.name": process.env.OTEL_SERVICE_NAME ?? SERVICE_NAME,
		"service.version": VERSION,
		"aura.install.id": getOrCreateInstallId(),
	};
	const settings = options?.settings;
	if (settings?.get("telemetry.identity.hostname")) attrs["host.name"] = os.hostname();
	if (settings?.get("telemetry.identity.workspace")) attrs["aura.workspace.path"] = process.cwd();
	return attrs;
}
