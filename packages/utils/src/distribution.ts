/**
 * Distribution coordinates for the aura fork.
 *
 * Single source of truth for where releases live and how updates are
 * discovered, consumed by the updater (`cli/update-cli.ts`), the startup
 * version check, and the CI release scripts. The upstream project distributes
 * through npm (`@oh-my-pi/pi-coding-agent`) and public GitHub releases on
 * `can1357/oh-my-pi`; aura distributes through GitHub releases on the fork
 * repository, so every constant the update path consults lives here rather
 * than pointing at upstream's channels.
 */

/** GitHub `owner/repo` whose releases carry aura's binaries. */
export const DIST_REPO: string = "elide-dev/aura";

/**
 * How release metadata is discovered.
 *
 * - `github`: `GET /repos/{DIST_REPO}/releases/latest` — the only channel that
 *   exists today. The repository is private, so the check requires
 *   `GITHUB_TOKEN`/`GH_TOKEN`; without one, callers treat "cannot check" as
 *   "no update" and stay silent.
 * - `npm`: `GET {DIST_NPM_REGISTRY}{DIST_PACKAGE}/latest` — switch here once an
 *   aura package is published.
 */
export const DIST_UPDATE_CHANNEL: "github" | "npm" = "github";

/**
 * npm package coordinates, reserved for a future publish cycle. Not consulted
 * while {@link DIST_UPDATE_CHANNEL} is `github`.
 */
export const DIST_PACKAGE: string = "@oh-my-pi/pi-coding-agent";

/** Official npm registry origin; see update-cli.ts for why this is pinned. */
export const DIST_NPM_REGISTRY: string = "https://registry.npmjs.org/";

/** Homebrew formula, if/when an aura tap exists. Method never resolves today. */
export const DIST_HOMEBREW_FORMULA: string = "elide-dev/tap/aura";

/** mise tool coordinate for aura installs. */
export const DIST_MISE_TOOL: string = "github:elide-dev/aura";

/** Where a user should go to (re)install when self-update cannot proceed. */
export const DIST_INSTALL_URL: string = "https://github.com/elide-dev/aura/releases";
