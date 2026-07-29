import * as os from "node:os";
import * as path from "node:path";
import { sanitizeText } from "@oh-my-pi/pi-utils/sanitize-text";
import { DEFAULT_TAB_WIDTH } from "@oh-my-pi/pi-utils/tab-spacing";

const TAB_SPACES = " ".repeat(DEFAULT_TAB_WIDTH);

/** Home-shorten a path without loading the TUI or native addon graph. */
export function shortenPath(filePath: unknown, homeDir?: string): string {
	if (typeof filePath !== "string") return "";
	const home = homeDir ?? os.homedir();
	if (home && filePath.startsWith(home)) {
		const suffix = filePath.slice(home.length);
		if (suffix === "" || suffix.startsWith(path.posix.sep) || suffix.startsWith(path.win32.sep)) {
			return `~${suffix.replaceAll(path.win32.sep, path.posix.sep)}`;
		}
	}
	return filePath;
}

/** Render an arbitrary filesystem path safely inside one diagnostic row. */
export function formatDisplayPath(filePath: unknown, homeDir?: string): string {
	const sanitized = typeof filePath === "string" ? sanitizeText(filePath) : "";
	return shortenPath(sanitized, homeDir).replaceAll("\t", TAB_SPACES).replaceAll("\n", "\\n");
}
