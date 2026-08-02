# Aura user-facing and compatibility rebrand — design

**Date:** 2026-08-01
**Status:** approved design, pre-implementation

## Summary

Replace remaining OMP product names, commands, URLs, and visual assets with Aura equivalents while retaining only compatibility identifiers that protect existing user state, serialized protocols, extensions, or native consumers. This is a behavioral migration, not a repository-wide blind string replacement.

## Classification rule

Every OMP/Pi occurrence belongs to one of four classes:

1. **External identity — change now.** UI text, help, executable names, generated completions, product URLs, schemas, web metadata, icons, package/repository metadata, support text, and provider attribution.
2. **Canonical value with legacy read alias — add Aura canonical, retain old reads.** Environment variables, config directories, executable aliases, internal-resource URLs, and saved user integrations.
3. **Protocol or ABI identifier — migrate only with coordinated producer/consumer support.** Hidden worker selectors, native package/module/symbol names, RPC fields, Python integration markers, plugin IDs, DAP identifiers, and serialized session values.
4. **History or third-party identity — retain internally.** Released changelogs, historical issue/PR links, license/upstream attribution, third-party product names, and upstream runtime distribution identifiers remain only where technically or historically exact; current user-facing product copy calls the engine “the runtime.”

Implementation begins by assigning every match to one class. Unclassified bulk replacement is prohibited.

## Visual identity

### Source of truth

Create one approved Aura vector mark and wordmark source under `assets/brand/`. `scripts/generate-aura-assets.ts` derives raster/favicon/PWA/social variants deterministically; no size is independently redrawn.

Required generated outputs are the repository hero, terminal compact mark preserving the approved compact-sun behavior, favicon SVG/ICO plus 16/32/180/192/512 PNGs, PWA maskable icon with safe-zone padding, social/OpenGraph image, Python-package application/icon variants, and monochrome mark.

The current `assets/hero.png`, `assets/icon.svg`, `packages/collab-web/public/favicon*`, `packages/collab-web/public/og-image.png`, `packages/collab-web/public/favicon.ico`, and `python/robomp/assets/icon.*` are replacement targets, not independent sources. `assets/brand/manifest.json` records each generated path, dimensions, color mode, SHA-256, and source revision; the generator refuses an unlisted output.

Current README captures, posters, and videos are also release assets, not string-replacement collateral. `scripts/inventory-aura-media.ts` inventories every Markdown/HTML image/video/poster URL into `assets/media-manifest.json` with classification `current_product|historical_attribution`, local or provisioned-public URL, SHA-256, content type, dimensions/duration, and accessible description. Every `current_product` item is regenerated with Aura chrome or vendored under `assets/media/` and uploaded by the release asset workflow before its URL changes. Historical evidence remains clearly labeled and is not presented as current UI.

`scripts/verify-aura-media.ts` rejects unclassified references, current media with legacy product chrome/hosts, missing local files, non-2xx public URLs, redirect to another owner, wrong content type, digest/dimension mismatch, or README references absent from the manifest. Release ordering is inventory → regenerate/vendor → upload → anonymous URL/content probe → rewrite README → desktop/mobile visual review. Failed upload/probe leaves old attributed history intact and blocks current-page cutover; it never emits broken URLs.

### UI copy and metadata

The collab web app and repository surfaces use product name `Aura`, session product `Aura Collab`, canonical Aura product/repository links, and Aura description/social metadata. They contain no visible “OH MY PI,” `omp collab`, `relay.omp.sh`, `my.omp.sh`, or upstream install instructions.

Legacy links remain parseable/hosted only for compatibility. New links and canonical tags use Aura deployment endpoints.

## CLI and shell integration

### Canonical commands

`aura`, `aura-stats`, and `aura-swarm` are canonical. Generated help, examples, completions, and error recovery use the active canonical binary rather than hardcoding `omp`.

The completion generator changes `_omp`/`__omp` function names and registration targets, `_omp_root` and PowerShell completion function names, cache/completion file names written for new installs, examples embedded in shell snippets, and auxiliary command names.

Legacy scripts can continue invoking `omp`; generation requested through that alias may register both names during the migration window, but generated Aura documentation leads with `aura`.

### User-facing text

Replace public help, command descriptions, startup errors, diagnostics, schema titles, install instructions, and current documentation that identify OMP as the product. Preserve provider/model names and historical notes. Current user-facing text always says “the runtime”; upstream engine distribution names remain confined to internal immutable coordinates/checksums and historical attribution.

## Environment and persistent paths

Canonical public variables use `AURA_*`; old names are read-only aliases in one owner:

| Canonical | Legacy read alias | Owner |
| --- | --- | --- |
| `AURA_CONFIG_DIR` | `PI_CONFIG_DIR` | `packages/utils/src/dirs.ts` |
| `AURA_INSTALL_DIR` | `PI_INSTALL_DIR` | POSIX/PowerShell installers |
| `AURA_BROKER_URL` | `OMP_AUTH_BROKER_URL` | `session/auth-broker-config.ts` |
| `AURA_BROKER_TOKEN` | `OMP_AUTH_BROKER_TOKEN` | `session/auth-broker-config.ts` |
| `AURA_QA_URL` | `PI_AUTO_QA_PUSH_URL` | `tools/report-tool-issue.ts` |
| `AURA_QA_TOKEN` | `PI_AUTO_QA_PUSH_TOKEN` | `tools/report-tool-issue.ts` |

For each pair: canonical alone wins; legacy alone is accepted with a bounded deprecation warning outside structured/TUI/RPC output; byte-identical duplicates are accepted once; differing simultaneous values fail before filesystem/network work. Write and document only canonical names. Standard third-party variables such as `OTEL_*` and provider API keys remain unchanged. Product-independent protocol fields and provider/model settings—including `model.default`, `model.thinking`, `model.adaptiveThinking`, `model.enableSkillSelection`, and `model.adaptiveThinking.*`—remain unchanged. Any future config-key rename needs its own dual-read/canonical-write/removal contract.

The canonical config root remains `.aura`; `.omp` project config is read-only fallback. Existing user-level state migration is a release prerequisite, not a deferred feature. Implement the registered top-level command `aura config migrate [--dry-run] [--non-interactive]` in existing `packages/coding-agent/src/commands/config.ts` and `packages/coding-agent/src/cli/config-cli.ts`, backed by `packages/utils/src/migrate-agent-dir.ts`.

Before normal agent initialization, if canonical `~/.aura/agent` is absent and legacy `~/.omp/agent` exists, interactive first run offers and performs the same migration; noninteractive/structured invocation exits `migration_required` with the exact command and does not create a fresh canonical store. If both roots contain state, default and automatic migration fail `destination_conflict` without merging or overwriting. Explicit `AURA_CONFIG_DIR`/legacy alias selection remains authoritative and suppresses automatic migration.

Migration acquires an exclusive source/destination lock before opening state; rejects symlinked roots or entries, path escape, non-owned source, unsafe modes, and special files; creates a mode-0700 sibling staging directory; copies regular files with restrictive modes; uses SQLite backup/checkpoint APIs for live databases rather than copying WAL/SHM bytes; preserves profiles, settings, sessions, provider credentials, token rows, MCP configuration, and installation identity; writes a canonical manifest of relative path/size/SHA-256; fsyncs files/directories where available; and atomically renames staging to `~/.aura/agent`. Any error removes staging and leaves both roots unchanged. Success reopens/validates the canonical database and settings before writing a migration receipt; the legacy root remains an untouched read-only backup and receives no new writes.

The command is idempotent: a matching receipt and manifest return success; partial staging is ignored/removed under lock; source changes invalidate retry. Tests cover old-only automatic and command migration, new-only, both-conflict, dry-run, cancellation/failure at every copy/backup/fsync/rename/reopen boundary, malicious symlinks/modes, concurrent processes, profile precedence, SQLite WAL state, exact secret redaction, install-ID stability, `omp` alias behavior, and zero writes to `.omp`.

## Internal URLs

Introduce `aura://` as the canonical embedded-documentation resource scheme and retain `omp://` as a parser alias. Both resolve through the existing documentation index with identical traversal, range, autocomplete, and sanitization rules. They do not gain arbitrary filesystem, archive, or database authority. Rendered help, generated prompts, and new documentation links emit `aura://` only.

Migration scope includes the documentation resource dispatcher, read/range operations, autocomplete, markdown linkification and terminal hyperlinks, extension/plugin references, documentation/prompt files, and user-visible errors.

Do not rename a persisted `omp://` string in place; accept it on read and canonicalize only newly emitted references.

## Protocol and ABI identifiers

### Retain initially

The following stay unchanged until there is demonstrated consumer value and a coordinated protocol version:

- hidden worker selectors such as `__omp_worker_*`;
- native packages and symbols such as `pi-natives` and `__ompInstallTokioRuntime`;
- serialized wire/RPC field names and existing plugin package identifiers;
- internal bundle/cache formats consumed by old binaries;
- upstream source directory/package names where changing them provides no user-visible identity benefit.

These are documented in `docs/aura/FORK.md` as intentional compatibility, not missed branding.

### Migrate with aliases

- Emit DAP `clientName: "Aura"` and retain `clientID: "omp"` during this migration window because external adapters consume the identifier. Assert the exact outbound initialize payload; change `clientID` only in a separately versioned decision backed by adapter evidence.
- Treat both `python/robomp` and `python/omp-rpc` as internal/source-only today. Retain their import/module/distribution names as compatibility identifiers while rebranding descriptions, URLs, CLI copy, and assets. Publishing either requires Aura-named successor distributions and an atomic RobOMP dependency switch; no fork build publishes the old names as new public products.
- Plugin schemas and IDs gain Aura canonical names only when the plugin loader accepts both old and new IDs without loading twice.
- Session/export formats add a format-versioned Aura producer identifier while preserving readers for prior OMP values.

No alias remains without a removal criterion.

## Documentation policy

Update current README, package READMEs, docs, generated help, schemas, and install instructions. Do not rewrite released changelog sections, historical benchmark/results prose that accurately names upstream OMP, issue/PR URLs and contributor attribution, the fork's upstream merge documentation, or third-party names when they identify the actual external service/runtime.

New docs link to Aura's repository and service domains. Compatibility docs may name OMP only to explain migration.

## Implementation slices

### Brand assets, media, and collab web

Modify `assets/brand/manifest.json`, generated `assets/`, `assets/media-manifest.json`, `assets/media/`, `scripts/generate-aura-assets.ts`, `scripts/inventory-aura-media.ts`, `scripts/verify-aura-media.ts`, their focused tests, `packages/collab-web/public/`, collab HTML/manifest/robots/sitemap, README media references, release asset upload workflow, and Python package assets. Build the web bundle; anonymously probe uploaded media; visually review repository plus desktop/mobile/PWA landing/join/share surfaces.

### CLI, help, completions, and auxiliary bins

Modify coding-agent and stats/swarm manifests, help templates, completion generator, command examples, and installer-generated invocations. Exercise bash, zsh, fish, and PowerShell output through their real completion entrypoints.

### Environment/path migration

Implement the closed environment map only in each named owner, then migrate consumers without local precedence logic. Add `packages/utils/src/migrate-agent-dir.ts`, `packages/utils/test/migrate-agent-dir.test.ts`, the existing registered `packages/coding-agent/src/{commands/config.ts,cli/config-cli.ts}` command owners, `packages/coding-agent/test/cli/config-cli.test.ts`, and `packages/coding-agent/test/startup-config-migration.test.ts` before changing the default global read path. Release installers invoke `aura config migrate --non-interactive` for old-only state before launching the new binary; installer fault tests prove migration or binary failure restores the old executable/root selection.

### URI migration

Add canonical and alias schemes in the central resource resolver, migrate all producers to Aura, then update extensions/docs/tests. Use one parser; do not fork code paths.

### Protocol/ABI audit

For each retained identifier, record consumer, compatibility reason, and removal trigger in the fork ledger. Rename only the items covered by integration tests across both producers and consumers.

## Verification

- Asset generation is deterministic; emitted dimensions, alpha/maskable safe zones, favicon contents, manifest references, social metadata, and SHA-256 manifest entries are validated as artifacts.
- Media inventory covers every current README/web image, capture, poster, and video. Anonymous probes verify URL, owner, content type, digest, dimensions/duration; visual review proves all current-product captures show Aura and historical assets are labeled.
- Browser smoke visually verifies collab landing/join/share flows, installable manifest, icons, title, canonical URL, and responsive layouts.
- CLI smoke verifies `aura --help`, `aura --version`, `aura --check`, `aura-stats`, `aura-swarm`, and compatibility aliases in every install mode.
- Completion tests invoke each shell integration and verify Aura command dispatch, filenames, quoting, and legacy alias behavior.
- Environment tests cover each canonical-only/legacy-only/equal/conflicting pair, invalid canonical, warning-safe output, no legacy writes, and profile inheritance.
- Migration tests execute the real command/first-run gate through old-only/new-only/both/conflict/dry-run/idempotent/concurrent/symlink/permission/WAL/fault-injection cases and prove settings/sessions/credentials/tokens/MCP/profiles/install ID survive with zero source mutation.
- URI contract tests read docs root, embedded/ranged Markdown, traversal failures, autocomplete, plugin/extension rendering, and terminal links through both schemes. New emitted links use `aura://`; a separate resolver test proves the retained alias. Archive/database selector tests stay on existing filesystem-path surfaces.
- DAP/plugin/Python/native smoke tests prove every deliberately migrated boundary and deliberately retained compatibility path.
- Package/web artifacts contain Aura current metadata while history and license attribution remain intact.

Tests assert behavior or generated artifacts; source-grep assertions are prohibited.

## Removal criteria

A compatibility alias can be removed only when the owning integration has shipped an Aura producer for at least one documented migration window, saved state/external clients can be migrated automatically or rejected with actionable guidance, usage/support evidence shows the alias no longer protects material users, the removal is called out as breaking, and the full installed-artifact smoke passes without it.

## Fork tracking

The central Aura cloud-client integration plan's final task is the sole editor of `docs/aura/FORK.md` and shared changelogs. This workstream supplies copy-ready rows for every newly touched upstream-owned path plus retained protocol/ABI names and their removal criteria after behavioral/media/visual verification. Do not commit unless explicitly requested.
