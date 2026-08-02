# Aura cloud endpoint cutover — design

**Date:** 2026-08-01
**Status:** approved design, pre-implementation

## Summary

Move Aura's first-party remote defaults from upstream/shared infrastructure to the white-label BLACKBOARD deployment without coupling the CLI to one hardcoded production domain. BLACKBOARD owns the server contracts; aura owns client discovery, credentials, compatibility, and local fallback behavior.

Remote agent execution is excluded. Aura remains a local coding agent consuming hosted identity, settings, credential, ingestion, collaboration, and distribution services.

## Dependency and rollout rule

No client default changes until the corresponding BLACKBOARD service has a deployed `{DOMAIN}` route, a release-environment health/contract probe, tenant-scoped authentication where required, a rollback to prior explicit/local behavior, and a aura migration test.

`AURA_DOMAIN` is an explicit, validated bare-domain deployment input; it has no source default, compiled production value, DNS discovery, or bootstrap document. Exact canonical overrides are `AURA_AUTH_URL`, `AURA_SYNC_URL`, `AURA_BROKER_URL`, `AURA_GATEWAY_URL`, `AURA_TELEMETRY_URL`, `AURA_QA_URL`, `AURA_COLLAB_ORIGIN`, `AURA_DIST_API_URL`, `AURA_DIST_DOWNLOAD_URL`, `AURA_DIST_JWKS_URL`, and `AURA_CATALOG_MANIFEST_URL`. Auth publishes only standard OIDC/JWKS metadata and distribution publishes only its signed manifests.

## Endpoint matrix

| Capability | BLACKBOARD contract | Current client state | Cutover |
| --- | --- | --- | --- |
| Direct Aura login | `auth.{DOMAIN}` device authorization, token, refresh, revoke, JWKS/OIDC | No Aura login client | Add first-party Aura account login and secure refresh-token storage; provider OAuth remains separate |
| Settings sync | `sync.{DOMAIN}` revisioned user-profile settings API | Local YAML only | Add authenticated opt-in sync; local files remain offline source/cache |
| Credential broker | `api.{DOMAIN}/broker` preserving broker `/v1/*` | Configurable broker URL/static bearer; local SQLite default | Prefer Aura JWT; retain explicit self-hosted URL/token and local SQLite fallback |
| Model gateway | `api.{DOMAIN}/gateway` preserving gateway `/v1/*` | Configurable external gateway patterns | Add Aura gateway provider/base; no raw provider passthrough |
| Telemetry | `telemetry.{DOMAIN}` OTLP HTTP/protobuf | Embedded Grafana base and Basic header | Remove shared credential, use per-account access token, retain standard `OTEL_*` precedence |
| QA | `qa.{DOMAIN}/v1/grievances` | Embedded shared QA endpoint | Derive an opt-in default from `AURA_DOMAIN`; canonical `AURA_QA_URL`/`AURA_QA_TOKEN` precede legacy aliases and settings; never attach an Aura access JWT |
| Collaboration | `collab.{DOMAIN}` WSS `/r/*` + guest UI | `wss://my.omp.sh` | Use deployment endpoint for new rooms; parse old links without selecting old host by default |
| Share | `collab.{DOMAIN}/s` sealed blob/viewer | `https://my.omp.sh/s` | Use deployment endpoint for uploads; existing links remain readable by original host |
| CLI updates | `api.{DOMAIN}/v1/distribution` manifests + `downloads.{DOMAIN}` objects | Private GitHub release lookup | Prefer signed manifests; keep explicit GitHub/npm fallback for development/rollback |
| Runtime artifacts | `downloads.{DOMAIN}` runtime mirror | Upstream engine releases with pinned SHA-256 | Prefer mirror only after byte/hash parity; preserve explicit upstream fallback without exposing engine identity as Aura product copy |
| Model catalog | optional signed catalog snapshot | `catalog.stencil.so` | Prefer mirror when configured; preserve bundled/provider discovery and Stencil fallback |

## Client configuration

Add dependency-light modules under `packages/coding-agent/src/cloud/`:

- `deployment.ts` validates `AURA_DOMAIN`, exact overrides, source metadata, and independent switches;
- `token-store.ts`, `token-manager.ts`, and `auth.ts` own device login, verified access refresh, account selection/logout, and secure refresh-token storage;
- `settings-sync.ts` owns revisioned profile sync only;
- `telemetry.ts`, `collab.ts`, and `distribution.ts` adapt the shared endpoint/token contracts without duplicating validation or JWT parsing.

Precedence is surface-specific and only the selected tier is validated:

| Surface | Highest to lowest |
| --- | --- |
| Auth/API/sync | per-call or persisted explicit endpoint → canonical exact `AURA_*_URL` → `AURA_DOMAIN` derivation → legacy read alias where one exists → local/offline |
| Collab rooms/UI | per-call/historical link or persisted explicit endpoint → `AURA_COLLAB_ORIGIN` → domain → unconfigured new traffic |
| Share upload/view/delete | per-call/historical link or persisted explicit endpoint → `AURA_COLLAB_ORIGIN` → domain → unconfigured new traffic |
| Telemetry | signal-specific `OTEL_EXPORTER_OTLP_<SIGNAL>_*` → generic `OTEL_EXPORTER_OTLP_*` → explicit `telemetry.*` → `AURA_TELEMETRY_URL` → domain → disabled |
| QA endpoint | `AURA_QA_URL` → legacy `PI_AUTO_QA_PUSH_URL` → `dev.autoqaPush.endpoint` → domain → queue only |
| QA token | `AURA_QA_TOKEN` → legacy `PI_AUTO_QA_PUSH_TOKEN` → `dev.autoqaPush.token` → none |
| Updates | exact distribution URL/token/source → Aura signed-manifest source → configured GitHub/npm availability fallback |
| Runtime/catalog mirrors | exact source → respective Aura mirror → pinned/bundled/provider fallback |

Canonical and legacy environment variables with different simultaneous values fail `invalid_configuration` before I/O; matching duplicates are consumed once. An invalid winning endpoint never falls through. Access/JWKS discovery comes only from the configured auth issuer. Update/catalog metadata is independently signature-verified and never trusts auth JWKS.

The exact settings/defaults are `cloud.account.enabled=true`, `cloud.broker.enabled=true`, `cloud.gateway.enabled=false`, `cloud.settingsSync.enabled=false`, `cloud.telemetry.enabled=false`, `cloud.qa.enabled=true`, `cloud.collab.enabled=true`, `cloud.share.enabled=true`, `cloud.distribution.enabled=true`, `cloud.runtimeMirror.enabled=true`, and `cloud.catalogMirror.enabled=true`. Context and memory each retain their separate default-false `aura.sync.*` opt-in. A switch removes only that surface's canonical Aura override/domain tier; per-call, persisted self-hosted, historical-link, and retained fallback behavior is unchanged. Disabling rooms cannot disable share, and disabling hosted updates cannot disable runtime/catalog or vice versa.

## Authentication

Aura access tokens are short-lived org-scoped JWTs. The client stores only the rotating opaque refresh token through existing auth-storage hardening; it never writes Aura access/refresh tokens into `config.yml`, telemetry settings, logs, session JSONL, URLs, or support bundles. Cache/account/settings/context namespaces use verified `(issuer,user_id)`, not issuer alone; the same user retains user-owned data across selected orgs, while switching users closes old consumers before opening the new namespace.

`aura account login [--domain DOMAIN] [--org ORG]`, `status [--json]`, `switch ACCOUNT`, `sync`, and `logout [--force]` are real lazy top-level subcommands registered in `src/cli-commands.ts`; they never become model input. Interactive login can prompt for one server-approved org; noninteractive multiple-org login requires `--org` and returns `selection_required`. `status` performs no network. `switch` validates an existing issuer/account row before changing the current pointer. Logout first aborts settings/context/telemetry/broker SSE consumers, then revokes and deletes local refresh state; normal revoke failure is reported, while `--force` explicitly performs local-only cleanup without claiming remote revocation.

All service request builders use one single-flight access-token refresh path. Issuer/realm/account come from verified token claims and the configured deployment domain, never caller payload fields. Broker HTTP and every SSE connect/reconnect receive an async bearer getter and reacquire after expiry/401; they never snapshot a token in configuration or construction. Provider OAuth credentials remain owned by `AuthStorage` or the credential broker: Aura login is not a model-provider login and does not replace provider `/login` flows.

## Settings sync boundary

Sync accepts exactly three account-profile keys: `profile.locale` with `{locale:<BCP-47-shaped string>}`, `profile.timezone` with `{timezone:<IANA-shaped string>}`, and `profile.theme` with `{theme:"system"|"light"|"dark"}`. These values live in a dedicated Aura account-profile cache and UI boundary; they do not map to the coding-agent's arbitrary `theme.dark` or `theme.light` theme-name settings. Every other coding-agent setting remains local.

Reject project `.aura`/`.omp` documents, credentials/secrets, filesystem paths, shell/`!command` values, hooks/tools/MCP bearer tokens, executable extension code, machine/runtime paths, and environment-derived values before upload. Local profile state works offline. Each mutation carries a stable mutation ID and base revision; conflicts return current revision/value and are never silently overwritten.

## Telemetry cutover

Remove the embedded Grafana endpoint/header pair from `packages/coding-agent/src/config/settings-schema.ts` and rotate the exposed shared credential before release. `cloud.telemetry.enabled` defaults `false`; login, domain configuration, identity-attribute opt-ins, or another cloud switch never enables export.

For signal-specific/generic or explicit third-party collectors, preserve operator endpoint/header behavior and never add an Aura token. For a selected Aura-derived exact origin with no explicit Authorization, a guarded exporter delegate obtains a current verified user JWT immediately before every export and invokes transport only after acquisition. Token expiry uses the shared single-flight refresh path; login missing, logout, revoke, refresh failure, or wrong principal completes the batch as bounded failed/suppressed with zero fetch. A static headers factory is insufficient. Every request uses `redirect:"manual"` and no Aura Authorization reaches a same- or cross-origin redirect receiver.

Signal-specific `OTEL_EXPORTER_OTLP_{TRACES,LOGS,METRICS}_*` continues to override generic OTLP configuration; only `http/protobuf` is accepted; `OTEL_SDK_DISABLED=true` disables export; hostname/account/workspace attributes remain separately opt-in.

## QA cutover

Keep consent, local SQLite queue, batch bounds, and “mark pushed on successful 2xx” behavior. Resolve endpoint/token with the canonical/legacy/setting order above; differing simultaneous canonical/legacy values fail before I/O. `cloud.qa.enabled=false` removes only canonical Aura/domain tiers, so an operator's legacy/setting endpoint remains usable; with no eligible endpoint, consented reports remain queued and zero fetch occurs. QA imports no Aura token manager, never attaches an Aura access JWT, and never silently initiates login. UI says “Aura QA,” regardless of operator infrastructure.

## Collaboration/share cutover

New room/share links use `collab.{DOMAIN}`. Wire envelope, room key, write token, fragment handling, and sealed bytes remain unchanged. Aura credentials never enter URLs, fragments, QR codes, or transcripts. `cloud.collab.enabled` owns room relay/UI derivation and `cloud.share.enabled` independently owns upload/view/delete derivation.

Share upload is raw `application/octet-stream`, maximum 1,000,000 bytes, and returns bounded JSON `{id,expiresAt,deleteToken}`. `id` is `shr_` plus an uppercase 26-character ULID and can never match `^[0-9a-fA-F]{20,64}$`; `expiresAt` is ISO-8601; `deleteToken` is 43-character unpadded base64url and is never placed in a URL. Raw read is `/s/{id}/raw`; delete uses the authenticated contract's explicit header. Client validates all fields before rendering a link.

Keep `@oh-my-pi/pi-wire` `DEFAULT_RELAY_URL` and `DEFAULT_SHARE_URL` only as legacy parse fallbacks. New producers render the selected Aura deployment endpoint into room/share links before returning, copying, showing, or QR-encoding them; no later formatter may reinsert a compile-time default. Historical full links, scheme-less links, key-only links, dot/`#`/`%23` separators, pure-hex gist IDs, and `my.omp.sh` links remain parseable through the legacy origin without selecting it for new traffic. The viewer routes only the reserved `shr_` grammar to Aura and pure hex to gist. Tests exercise upload/body/response bounds plus Aura and legacy inputs through `formatCollabLink`, `formatCollabWebLink`, slash-command/UI output, clipboard text, and guest QR rendering.

## Distribution cutover

The BLACKBOARD distribution plan's JSON/JCS/signature contract is authoritative; aura consumes it without redefining a looser shape. Envelopes use closed `{protected,payload,signature}` objects; `protected` fixes `alg:"EdDSA"`, `jcs:"RFC8785"`, a non-empty `kid`, and the exact channel/release/catalog media type. Signed bytes are UTF-8 RFC 8785 JCS of `{payload,protected}` with `signature` excluded. Trust roots are distribution Ed25519 JWKs from the separately configured exact distribution-JWKS origin, never auth JWKS.

Channel/catalog payloads carry `schema_version:1`, unsigned-decimal monotonic `manifest_revision`, `generated_at`, expiry no more than 24 hours later, exact rollout algorithm/basis points/salt/window, and bounded signed descriptors with platform, size, SHA-256, object URL, detached descriptor signature, and status. The client stores the highest `(origin,stream,manifest_revision,signed_digest)` in the current profile's distribution state. Lower revision or same revision/different digest fails closed. Unknown or ineligible key performs exactly one cache-bypassing JWKS refresh; compromised, expired, revoked, malformed, or still-ineligible content never falls back.

Rollout uses the stable installation ID for fresh and existing installs; zero selects fallback and never force-selects a candidate. Before replacement, cache-bypass refetch, reapply high-water, recompute rollout with the same ID, require the downloaded descriptor is still selected, and recheck release status. Signature, expiry, revocation, rollout, asset size, and SHA-256 checks complete before atomic replacement. Runtime/catalog mirrors remain content mirrors subject to checked-in pins/signed descriptors. Only unconfigured, transport, `404`, `408`, `429`, or `5xx` failures may use the explicit existing source; hosted `200`, auth, revocation, replay, or integrity failures fail closed.

## Files affected

Primary aura surfaces:

- `packages/coding-agent/src/cloud/deployment.ts`
- `packages/coding-agent/src/cloud/token-store.ts`
- `packages/coding-agent/src/cloud/token-manager.ts`
- `packages/coding-agent/src/cloud/auth.ts`
- `packages/coding-agent/src/cloud/settings-sync.ts`
- `packages/coding-agent/src/cloud/telemetry.ts`
- `packages/coding-agent/src/cloud/collab.ts`
- `packages/coding-agent/src/cloud/distribution.ts`
- `packages/coding-agent/src/cli/account-cli.ts`
- `packages/coding-agent/src/commands/account.ts`
- `packages/coding-agent/src/cli-commands.ts`
- `packages/coding-agent/src/config/settings-schema.ts`
- `packages/coding-agent/src/config/settings.ts`
- `packages/coding-agent/src/session/auth-broker-config.ts`
- `packages/ai/src/auth-broker/client.ts`
- `packages/coding-agent/src/telemetry/init.ts`
- `packages/coding-agent/src/tools/report-tool-issue.ts`
- `packages/coding-agent/src/collab/protocol.ts`
- `packages/coding-agent/src/export/share.ts`
- `packages/coding-agent/src/cli/distribution-manifest.ts`
- `packages/coding-agent/src/cli/update-cli.ts`
- `packages/coding-agent/src/runtime/dist.ts`
- `packages/coding-agent/src/runtime/provision.ts`
- `packages/catalog/src/catalog-mirror.ts`
- `packages/utils/src/distribution.ts`
- relevant focused tests plus settings, telemetry, auth-broker, collaboration, share, distribution, and environment documentation named by the Aura cloud-client integration plan.

Cloud-client modules stay in coding-agent. The only `packages/ai` change is making the existing broker transport accept an async bearer getter for every HTTP request and SSE connect/reconnect; provider/OAuth responsibility remains separate.

## Verification

- Deployment: every derivation, canonical/legacy disagreement, invalid winning tier, absent domain, and each independent switch; disabling one preserves explicit sources and all siblings with zero unintended requests.
- Device/account: authorize, personal/team selection, noninteractive `selection_required`, poll/slowdown/refresh/revoke/force, real top-level dispatch, cached status, account switch, consumer teardown, no model-input fallthrough.
- Settings/context namespaces: two users under one issuer share no rows/cache/cursor/conflict/prompt; the same verified user across selected orgs retains user-owned state.
- Broker/gateway: refreshed Aura JWT for each HTTP/SSE connect and reconnect, expiry/401 single replay, explicit legacy bearer, local fallback, stream cancellation, opaque gateway wire IDs, and no static token snapshot.
- Telemetry: master default-false opt-in, login/domain zero export while disabled, per-export current Authorization only on exact Aura origin, no shared header, OTEL/explicit foreign precedence, redirect receiver zero requests, protobuf paths, and acquisition-failure zero transport.
- QA: canonical/legacy disagreement, consent, queue-only switch rollback, explicit operator token, no Aura token manager/JWT, acknowledgment, and 4xx/5xx retention behavior.
- Collab/share: independent room/share switches; Aura and legacy inputs through formatter/UI/clipboard/QR; exact `shr_` ID/body/response/raw/delete grammar; no URL token; sealed-byte parity; fatal/retry close codes.
- Distribution: exact envelope/JCS bytes, independent trust root, eligible-key refresh, monotonic high-water/equivocation, rollout including fresh-install zero, pre-apply revalidation, revocation/private prerelease, mirror mismatch, status-sensitive fallback, and atomic rollback.
- Binary smoke: account command discovery, `aura --check`, update check, telemetry disabled then explicit opt-in flush, QA enqueue, collab/share link formatting, runtime status, and zero embedded production domain.

## Rollback

Rollback is exercised one switch at a time: account retains encrypted local rows; settings/context retain per-user local data; broker selects SQLite after restart; gateway unregisters only Aura models; telemetry suppresses Aura batches without changing explicit collectors; QA queues without an eligible endpoint while legacy/setting endpoints remain; rooms and share disable independently; hosted updates, runtime mirror, and catalog mirror disable independently while explicit/pinned/bundled fallbacks retain their prior semantics. Every sibling stays enabled during each test. Rollback never restores an embedded credential, silently directs new traffic to `my.omp.sh`, deletes user-authored state, lowers distribution high-water, or falls back from a security failure. Cached JWKS/manifests remain versioned and expiry-bounded; there is no endpoint-discovery service.

## Fork tracking

The central Aura cloud-client integration plan's final task is the sole editor of `docs/aura/FORK.md` and shared changelogs after every surface smoke passes. Each workstream supplies copy-ready touched-path rows and changelog bullets; it does not edit those shared files concurrently. Do not commit unless explicitly requested.
