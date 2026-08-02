# Aura package and distribution rebrand — design

**Date:** 2026-08-01
**Status:** approved design, pre-implementation

## Summary

Make every artifact produced, installed, updated, or attributed by this fork unambiguously Aura-owned. The migration is staged because GitHub binaries are usable now while a public package-scope rename is safe only after Aura owns and can publish the complete package graph.

## Current risks

The source CLI manifest exposes both `aura` and `omp`, but the publish pipeline rewrites it to an `omp`-only binary. Install fallback and update metadata still identify `@oh-my-pi/pi-coding-agent`; native optional packages are generated under `@oh-my-pi/*`; root/package/Cargo metadata still points at `omp.sh` and `can1357/oh-my-pi`; provider attribution emits `Oh-My-Pi` and `https://omp.sh`.

This mixed state can ship a binary that claims Aura in the terminal while package managers, provider dashboards, links, and automated updates identify the upstream product.

## Decisions

### Distribution authority

The provisioned Aura public repository and BLACKBOARD signed distribution service are the initial release authorities. The repository MUST be publicly readable without `GITHUB_TOKEN`/`GH_TOKEN` before any installer or fallback points to it. The signed manifest at `api.{DOMAIN}/v1/distribution/*` and immutable objects at `downloads.{DOMAIN}` become the preferred update channel after deployment validation. GitHub remains the compatibility source when hosted distribution is unconfigured or fails with transport, `404`, `408`, `429`, or `5xx`; `401`, `403`, and `410` are authoritative, and any malformed, tampered, expired, rollback, or unknown-key signed `200` fails closed without fallback.

### Public identity provisioning

Release owns one reviewed, secret-free `config/aura-public-identity.json` satisfying:

```ts
interface AuraPublicIdentity {
  githubRepository: `${string}/${string}`; // literal public owner/repository
  productOrigin: `https://${string}`;       // literal public origin, no path
  homebrewTap: `${string}/${string}`;       // literal public owner/tap
  miseCoordinate: `github:${string}/${string}`;
}
```

Provisioning creates the public repository/site/tap first, then writes their literal coordinates. `scripts/render-aura-public-identity.ts` validates the closed key set and renders package metadata, installer repository/raw URLs, Homebrew/mise coordinates, and current documentation; source modules do not carry a competing constant. It rejects missing/private/unreachable coordinates, upstream/fork-source coordinates, non-HTTPS product origins, redirects to a different owner, credentials/query/fragment, and template/placeholder values.

`scripts/probe-aura-public-identity.ts` performs anonymous `HEAD`/read probes for the repository, release asset, raw installer, product origin, and tap before publication. A clean installation remains local-only until the user explicitly supplies a deployment through `AURA_DOMAIN`, an exact override, or the `--domain` argument to `aura account login`; binaries never discover or compile a production service domain. Install docs on the provisioned product origin show that explicit command. Failure of either public-identity or deployment-contract probes blocks release rather than falling back to private or upstream identity.

### Executable names

Published coding-agent artifacts contain:

```json
{
  "bin": {
    "aura": "dist/cli.js",
    "omp": "dist/cli.js"
  }
}
```

`aura` is canonical. `omp` is a compatibility alias with the same entrypoint and no separate behavior. The publish script must never replace this map with an `omp`-only `publishBin` shortcut. Binary archive names and release target labels use `aura-<platform>-<arch>`.

Auxiliary package binaries become `aura-stats` and `aura-swarm`, retaining `omp-stats` and `omp-swarm` aliases during the migration window.

### Public package namespace

Do not publish fork builds under `@oh-my-pi`. Before npm publication, provision the Aura-owned scope and reserve the complete workspace package set. Then perform the recoverable candidate-graph activation below:

| Upstream package | Aura package |
| --- | --- |
| `@oh-my-pi/pi-ai` | `@aura/pi-ai` |
| `@oh-my-pi/pi-agent-core` | `@aura/pi-agent-core` |
| `@oh-my-pi/pi-coding-agent` | `@aura/pi-coding-agent` |
| `@oh-my-pi/pi-catalog` | `@aura/pi-catalog` |
| `@oh-my-pi/pi-tui` | `@aura/pi-tui` |
| `@oh-my-pi/pi-utils` | `@aura/pi-utils` |
| `@oh-my-pi/omp-stats` | `@aura/pi-stats` |
| all other published workspace/native packages | same basename under `@aura` |

The root lockfile; every static, type-only, and dynamic import/export module specifier; workspace dependency/devDependency/peerDependency/optionalDependency; build external/bundle allow-list; test fixture; generated native leaf manifest; native loader package-name and reinstall diagnostic; updater package identity; extension resolver identity; publish rewrite; tarball validation; installer fallback; and release metadata change in the same candidate release. Search the emitted JS, declarations, source maps, native loader, archives, and installed tree—not only manifests—and fail on mixed `@oh-my-pi/*`/`@aura/*` host-module graphs. A half-renamed dependency graph is prohibited.

Until the Aura scope is ready, GitHub binary/source installation remains canonical and `DIST_PACKAGE` must not claim that an unpublished package can update users. The first npm-published Aura release includes a migration note and does not overwrite the upstream package name.

### Repository and website metadata

New public metadata points to the Aura repository and Aura product site:

- root and package `homepage`, `repository`, and `bugs`;
- Cargo workspace `homepage` and `repository`;
- README hero/link/badge/install/update targets;
- GitHub workflows and release scripts;
- installer `REPO`, package fallback, raw script URL, Homebrew tap/formula, and mise coordinate;
- MCP schema `$id`, title, and description where they are user-facing;
- generated manifests and source maps that embed repository URLs.

License and upstream attribution remain. Released changelogs and historical issue/PR URLs are immutable.

### Provider attribution

Change Aura-controlled outbound attribution from:

- `User-Agent: Oh-My-Pi/<version>`
- `HTTP-Referer: https://omp.sh`
- `X-OpenRouter-Title: Oh-My-Pi`

To Aura values sourced from central product constants. Model/provider-specific headers that are not product attribution remain unchanged. The same constants feed catalog discovery user agents so provider analytics never see competing brands.

### Runtime and model catalog

The runtime's engine version and checksum remain pinned in `packages/coding-agent/src/runtime/dist.ts`. Upstream engine artifact filenames and fallback URLs are internal distribution identifiers and never become terminal, installer, error, or documentation product copy.

BLACKBOARD may mirror those exact immutable assets. The client accepts a mirror only when the signed manifest size and SHA-256 match the pin; mirror mismatch fails before extraction. The optional model-catalog mirror preserves bundled catalog and provider-discovery precedence and falls back to its retained third-party source only as an explicitly configured dependency.

## Implementation surfaces

### Release/publish

- `scripts/ci-release-publish.ts`
- `scripts/ci-release-build-binaries.ts`
- `scripts/ci-release-dry-run.test.ts`
- `scripts/install.sh`
- `scripts/install.ps1`
- `scripts/ci-update-brew-formula.ts`
- release workflows under `.github/workflows/`
- root `package.json`, lockfile, and every published `packages/*/package.json`
- every source/type/dynamic module specifier and build external list that names a workspace package
- native leaf generation/packaging plus `packages/natives/native/loader-state.js` package resolution and diagnostic strings
- extension host-module resolver identities and updater/package fallback constants
- `packages/utils/src/distribution.ts`
- `packages/coding-agent/src/cli/update-cli.ts`
- `config/aura-public-identity.json`
- `scripts/render-aura-public-identity.ts`
- `scripts/render-aura-public-identity.test.ts`
- `scripts/probe-aura-public-identity.ts`
- `scripts/probe-aura-public-identity.test.ts`

### Metadata and attribution

- root `package.json`
- `Cargo.toml`
- `README.md`
- `packages/coding-agent/src/config/mcp-schema.json`
- `packages/ai/src/utils/openrouter-headers.ts`
- `packages/catalog/src/provider-models/openai-compat.ts`
- all package READMEs and user-facing install/help docs

### Distribution consumers

- `packages/coding-agent/src/runtime/dist.ts`
- `packages/coding-agent/src/runtime/provision.ts`
- `packages/catalog/src/provider-models/openai-compat.ts`
- signed-manifest client modules introduced by the endpoint-cutover workstream

## Migration invariants

1. New documentation and release output always lead with `aura`.
2. Existing `omp`, `omp-stats`, and `omp-swarm` invocations dispatch the corresponding Aura entrypoint during the documented window in npm, POSIX, PowerShell, Homebrew, mise, source, binary, and upgrade modes.
3. Package-manager identity is never inferred from the invoked executable name.
4. Hosted update checks use the status-sensitive compatibility matrix: availability failures may reach Aura's public GitHub release source; auth, revocation, and signed-content failures never downgrade.
5. Installer source, binary, npm, and version-check modes all agree on repository, package, version, executable, signed manifest revision, size, and SHA-256.
6. Native optional dependencies and every executable loader/import resolve entirely within one package namespace.
7. Provider attribution contains only Aura product values.
8. Runtime mirrors cannot alter the engine pin or checksum.
9. No public package version is overwritten or assumed transactional. Publish exact-version native leaves and dependency packages first under a release-specific candidate dist-tag, publish auxiliary executables next, and publish the coding-agent root last. Install and smoke the complete graph by exact version before moving stable dist-tags dependency-first and the coding-agent tag last.
10. A failed candidate remains non-default and resumable only with byte-identical tarball digests. Rollback moves the coding-agent and auxiliary default tags back first; immutable candidate versions remain for audit, and dependencies are untagged only after no default root references them.

## Verification

- Pack every publishable workspace package and inspect emitted manifests, exact dependency graph, bins, imports/exports, declarations, source maps, build externals, repository links, native loader strings, and optional native packages.
- Exercise the staged publish state machine with failure injected after every package/native leaf/tag move. Assert no missing dependency is reachable from a default top-level tag, retry requires identical digests, coding-agent activates last, and rollback restores the previous root before touching dependencies.
- Run the dry-run publisher and assert `aura`, `omp`, `aura-stats`, `omp-stats`, `aura-swarm`, and `omp-swarm` execute their packed entrypoints.
- Build all release targets, then run `--version`, `--check`, updater discovery, and the existing smoke probe from extracted archives.
- Exercise installer source, binary, explicit ref, package fallback, and upgrade paths in the install-test harness on POSIX and PowerShell plus generated Homebrew/mise artifacts. Every mode installs the compatibility aliases.
- Standalone installers fetch the signed channel envelope and asset to a sibling temporary path, verify trusted key/revision/rollout/version/size/SHA-256 before chmod, fsync where available, retain the old binary, atomically rename, run `aura --version` and `aura --check`, then restore the old binary on interruption or smoke failure. They never stream over the live path or trust an unsigned GitHub URL.
- POSIX uses same-directory symlinks (or same-entrypoint wrappers where links are unavailable) for compatibility names; PowerShell installs deterministic sibling wrappers/copies; Homebrew emits `bin.install_symlink`; mise exposes shims. Tests upgrade an existing alias invocation and prove removal/rollback is atomic.
- Invoke the real OpenRouter and catalog request builders against a local HTTP fixture; assert Aura attribution headers and version format.
- Exercise signed update success, transient transport/`404`/`408`/`429`/`5xx` fallback, authoritative `401`/`403`/`410`, no fallback for malformed/tampered/expired/rollback signed `200`, staged-rollout exclusion, digest mismatch, interrupted replacement, and rollback.
- Provision one runtime artifact from the mirror fixture and prove the existing SHA-256/atomic-install path remains authoritative.
- Render public coordinates from the reviewed identity file and anonymously probe repository, asset, raw installer, product site, and tap; assert no upstream/private coordinate or placeholder reaches an artifact.

Tests inspect emitted artifacts and requests, never implementation source text.

## Compatibility removal

Remove `omp`/auxiliary bin aliases and old package migration messaging only in a separately approved breaking release after telemetry or support evidence shows the aliases are unused. The package namespace itself has no alias/shim: fork packages publish only under the Aura-owned scope.

## Fork tracking

The central Aura cloud-client integration plan's final task is the sole editor of `docs/aura/FORK.md` and shared changelogs after packed-artifact/install/public-identity verification. This workstream supplies copy-ready touched-path rows plus affected-package `[Unreleased]` bullets. Do not commit unless explicitly requested.
