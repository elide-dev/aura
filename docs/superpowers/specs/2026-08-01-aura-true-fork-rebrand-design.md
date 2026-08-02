# Aura true-fork rebrand — design

**Date:** 2026-08-01
**Status:** approved design, pre-implementation

## Summary

Finish Aura's product fork without destabilizing OMP compatibility or increasing upstream-merge risk unnecessarily. The cutover has three independently reviewable workstreams:

1. [Cloud endpoint cutover](./2026-08-01-aura-cloud-endpoint-cutover-design.md) — move Aura-owned remote contracts to the white-label BLACKBOARD deployment and remove upstream/shared service credentials from client defaults.
2. [Package and distribution rebrand](./2026-08-01-aura-package-distribution-rebrand-design.md) — make release artifacts, package metadata, installers, update discovery, repository metadata, and provider attribution unambiguously Aura-owned.
3. [User-facing and compatibility rebrand](./2026-08-01-aura-surface-compatibility-rebrand-design.md) — replace remaining OMP names and visual assets while preserving only deliberate legacy read/protocol aliases.

This specification supersedes the “deep string rebranding is a later pass” deferral in `2026-07-25-aura-omp-fork-design.md`. Existing fork invariants remain: the application noun is Aura, current user-facing copy calls the execution engine “the runtime,” internal immutable upstream distribution coordinates stay technically exact, and every upstream-owned file touched by implementation is recorded through the central cleanup owner.

## Goals

- Aura is the only product identity in install, update, help, web, provider-attribution, release, and support surfaces.
- Aura-owned remote services are discovered from the BLACKBOARD deployment contract, not from `omp.sh`, `my.omp.sh`, or a shared credential embedded in source.
- `aura` is the canonical executable everywhere; compatibility aliases are bounded and testable.
- A release built from this repository never publishes only an `omp` executable and never directs a new user to upstream install/update/support channels.
- Visual assets, social metadata, schemas, package metadata, and generated shell integrations agree on Aura.
- Legacy project configuration remains readable, legacy user-level state is migrated transactionally before first normal launch, and no new writes target `.omp` or old environment names.
- Historical attribution, immutable release notes, and internal ABI identifiers remain intact unless a coordinated migration provides behavioral value.

## Non-goals

- Remote agent execution, hosted workspaces, cloud session orchestration, or remote runtime-debug processes.
- Reimplementing model providers, provider OAuth endpoints, MCP servers, search providers, Smithery, Hugging Face, or GitHub gist.
- Renaming upstream runtime distribution coordinates or release artifacts merely to hide the engine implementation; those identifiers remain internal and never become Aura product copy.
- Rewriting released changelog sections, historical issue/PR links, license attribution, or upstream provenance.
- Removing `.omp`, `OMP_*`, `PI_*`, `omp`, `omp://`, or native ABI compatibility in the same change that introduces the Aura canonical surface.

## Canonical identity matrix

| Surface | Canonical | Compatibility |
| --- | --- | --- |
| Product/display name | `Aura` | None in new UI or docs |
| Primary CLI | `aura` | `omp` executable alias during the migration window |
| Auxiliary CLIs | `aura-stats`, `aura-swarm` | `omp-stats`, `omp-swarm` aliases during the migration window |
| User config directory | `.aura` | `.omp` read-only project compatibility |
| Public environment prefix | `AURA_*` | `OMP_*`, then applicable `PI_*`, as read-only fallback |
| Internal-resource URI | `aura://` | `omp://` parser alias until extensions and saved prompts migrate |
| Release binary prefix | `aura-` | Existing installed binary detection only |
| Public package scope | `@aura/*` after scope ownership is provisioned | GitHub binary distribution remains canonical until then; no fork package is published under `@oh-my-pi` |
| Runtime noun | `the runtime` | Upstream distribution identifiers remain internal to immutable version/asset/checksum/source coordinates |
| Remote hosts | BLACKBOARD `{DOMAIN}` deployment contract | Explicit endpoint overrides; old OMP hosts are not silent fallbacks |

## Compatibility policy

Compatibility is one-way:

1. Aura reads legacy names only where existing user state or external clients require it.
2. Aura writes and renders canonical names only.
3. A legacy alias has an owner, a behavioral test, and a removal condition.
4. Aliases never mask an invalid canonical value. Canonical alone wins and legacy alone migrates with a bounded warning; matching duplicates are accepted once, while differing simultaneous values fail before side effects.
5. Serialized and ABI identifiers are retained unless every producer and consumer can migrate atomically.

The `.aura`/`.omp` split uses a branded write target and read-only project fallback. User-level `~/.omp/agent` is different: old-only state is transactionally migrated by the registered `aura config migrate` command/first-run gate before agent initialization; both nonempty roots fail closed rather than merge.

## Execution order

1. Deploy and validate BLACKBOARD contracts without changing Aura defaults.
2. Land client support for deployment-configured endpoints, registered account lifecycle, refreshable service tokens, and independent switches while retaining explicit old endpoint overrides.
3. Provision and anonymously validate the literal public Aura repository/site/tap identity; keep clean installs local-only until an explicit deployment is supplied.
4. Land transactional legacy user-state migration and prove old-only users retain settings/sessions/credentials/tokens/MCP/profiles/install identity before changing the default global path.
5. Cut each endpoint tier only after its production health, migration, privacy, and independent rollback probes pass; telemetry remains default-off.
6. Inventory/regenerate/vendor/upload/probe all current media, then rebrand repository/web/package/release metadata, provider attribution, assets, help, and completions.
7. Add canonical `AURA_*`/`aura://` surfaces with closed legacy read aliases and conflicting-value failures.
8. Publish the package namespace as a recoverable candidate graph: native/dependency packages first, auxiliary roots next, coding-agent last, verify exact-version install, then promote default tags with coding-agent last.
9. Remove legacy aliases only in a separately approved release after usage evidence and migration documentation show they are no longer needed.

## Verification contract

The implementation must verify behavior and built artifacts, not source text:

- Pack every package and inspect bins, manifests, executable import/loader identities, declarations/source maps/build externals, and the complete native dependency graph; inject failure after each staged publish/tag transition.
- Build release binaries and exercise `aura --version`, `aura --check`, update discovery, runtime provisioning, signed standalone installer replacement/rollback, and all compatibility aliases in npm/POSIX/PowerShell/Homebrew/mise modes.
- Render CLI help, shell completions, DAP initialization, internal URLs, registered account/config commands, and first-run paths through real public interfaces.
- Execute old-only/new-only/both/conflict/idempotent/concurrent/fault-injected global migration and every canonical/legacy/equal/conflicting environment pair; prove no legacy writes.
- Build the collab web app, inspect its emitted manifest/canonical URLs/icons/social image, and anonymously verify every current media URL/content type/digest/dimension after Aura visual review.
- Exercise real request builders to prove Aura attribution, default-off telemetry with refresh per export, account-neutral QA, source-bound collab auth, reserved share IDs, distribution high-water/rollout, and independent BLACKBOARD endpoint switches.
- Keep focused package tests plus the existing fork smoke probe green.

Source-grep tests are prohibited. Static inventory is useful during implementation, but release gates must inspect generated artifacts or observable behavior.

## Fork tracking and release notes

The central Aura cloud-client integration plan's final task is the sole editor of `docs/aura/FORK.md` and shared changelogs after all observable cutovers pass. Each workstream supplies copy-ready touched-path rows, retained-identifier rationale/removal criteria, and one affected-package `[Unreleased]` bullet; documentation-only planning changes require none. Do not commit unless explicitly requested.
