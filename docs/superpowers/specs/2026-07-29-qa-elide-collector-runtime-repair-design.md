# Elide QA collector and embedded runtime repair — design

**Date:** 2026-07-29
**Status:** approved design, pre-implementation
**Repos:** WHIPLASH and BREAKDANCE (Aura/OMP fork)

## Summary

Elide will operate its own Auto-QA grievance collector at `https://qa.elide.dev/v1/grievances`. The collector will be a Cloudflare Worker in `WHIPLASH/project/infra/qa`, deployed through the same Wrangler conventions as the other WHIPLASH workers and backed by a dedicated D1 database. BREAKDANCE will change Aura's default Auto-QA endpoint from `qa.omp.sh` to `qa.elide.dev` without changing consent, batching, local retention, or endpoint override behavior.

The collector will then provide durable evidence for a controlled reproduction of Aura's failing embedded inline execution. Diagnosis will combine the collector's client/platform symptom record with local Aura logs and direct runtime-path reproduction. The repair must fix the embedded path at its source; it must not silently fall back to the process adapter.

## Confirmed `qa.omp.sh` infrastructure

Public evidence establishes only the following:

- `qa.omp.sh` resolves to Cloudflare addresses and responds with `server: cloudflare`.
- `GET /v1/grievances` returns `405` with `Allow: POST`.
- Invalid POST bodies return structured JSON validation errors.
- The public OMP repository contains the grievance client, local SQLite queue, and push logic, but no collector implementation or deployment manifest.
- The client sends batches of at most 50 rows to the configured endpoint.

The origin runtime, storage engine, retention policy, access controls, and deployment pipeline are not publicly observable. Cloudflare may be a reverse proxy or the application runtime; the available evidence does not distinguish them.

## Goals

- Deploy an Elide-owned, queryable collector at `qa.elide.dev`.
- Preserve compatibility with the existing OMP Auto-QA POST payload.
- Minimize collected data and avoid storing transport metadata.
- Keep collector reads private through authenticated Cloudflare tooling.
- Make `qa.elide.dev` Aura's default while preserving explicit setting and environment overrides.
- Record a controlled inline-execution grievance in D1.
- Reproduce, diagnose, and fix embedded inline Python and JavaScript execution.
- Prove the collector and repaired runtime path end to end.

## Non-goals

- Reproducing the unknown `qa.omp.sh` origin implementation.
- Adding a public report browser or read API.
- Changing Auto-QA consent behavior.
- Replacing Aura's local `autoqa.db` queue.
- Adding silent embedded-to-process fallback.
- Broad runtime refactoring unrelated to the observed inline-execution failure.

## 1. Collector ownership and layout

Create a new WHIPLASH worker package:

```text
/home/sam/workspace/labs/WHIPLASH/project/infra/qa/
  package.json
  tsconfig.json
  wrangler.toml
  worker.ts
  worker.test.ts
  schema.sql
```

The package follows existing WHIPLASH worker conventions:

- private `@elide/workers-*` package;
- Wrangler-backed `build` and `deploy` scripts;
- `worker.ts` as the module entrypoint;
- `wrangler.toml` custom-domain route and observability configuration;
- D1 schema kept beside the worker;
- focused Worker tests using the infrastructure package's established test tooling.

The custom domain is `qa.elide.dev`. The dedicated D1 database name is `elide-qa`; its generated database ID is recorded in `wrangler.toml` after provisioning.

## 2. HTTP contract

### 2.1 Routes

- `POST /v1/grievances`: validate and store an Auto-QA batch.
- `GET /health`: return a small non-sensitive health response.
- Every unsupported method or route returns a bounded error response.

There is no public list, detail, search, mutation, or administration route. Operators query D1 through authenticated Wrangler or the Cloudflare control plane.

### 2.2 Accepted request

The Worker accepts the current client envelope:

```ts
interface GrievanceBatch {
  agent: {
    name: string;
    version: string;
  };
  installId: string;
  platform: string;
  arch: string;
  entries: Array<{
    id: number;
    model: string;
    version: string;
    tool: string;
    report: string;
  }>;
}
```

Validation is strict at the accepted boundary:

- JSON content type;
- bounded request body;
- one to fifty entries;
- finite integer local IDs;
- non-empty bounded strings;
- no reliance on unrecognized fields;
- no coercion of invalid values.

The Worker stores accepted fields individually rather than preserving the raw request body.

### 2.3 Responses

- `202 Accepted`: batch durably inserted; body includes a server-generated receipt ID and accepted count.
- `400 Bad Request`: malformed JSON or invalid payload.
- `404 Not Found`: unknown route.
- `405 Method Not Allowed`: wrong method, with `Allow` where applicable.
- `413 Payload Too Large`: body exceeds the configured bound.
- `429 Too Many Requests`: Cloudflare abuse controls reject the request.
- `503 Service Unavailable`: D1 write failure.

Responses never echo grievance text or internal stack traces. Server failures are logged without report bodies.

## 3. Data model and privacy

D1 stores one row per grievance entry with:

- server receipt ID;
- entry ordinal within the receipt;
- agent name and version;
- install ID supplied by the client;
- platform and architecture;
- model and client version;
- local grievance ID;
- tool name;
- report text;
- server receive timestamp.

The Worker does not store IP addresses, `User-Agent`, cookies, request headers, or unrecognized body fields. Cloudflare platform-level logs remain governed by the account's existing configuration; application logs must not add grievance text or transport identifiers.

A scheduled Worker trigger deletes rows older than 90 days. The receive timestamp is indexed for retention cleanup and chronological diagnosis. Tool, client version, platform, and architecture receive indexes only where query evidence justifies them; avoid speculative indexes.

The first version does not attempt cross-request deduplication. The current client protocol lacks a globally unique event ID, and treating `(installId, local id)` as globally unique would discard legitimate reports after users reset their local database. Diagnosis may group duplicate symptom text at query time.

## 4. Abuse and availability controls

The endpoint remains unauthenticated for compatibility with Aura's default client configuration. Protection consists of:

- Cloudflare edge/WAF rate limiting configured for `POST /v1/grievances`;
- strict body, batch, and field limits;
- one D1 transaction per accepted batch;
- no expensive downstream calls;
- no public read surface;
- bounded response bodies;
- Worker observability logs excluding report content.

D1 insertion failure returns non-2xx so Aura retains the local row as unpushed and retries later. Successful acceptance returns 2xx so Aura marks the corresponding local rows pushed.

## 5. Aura integration

BREAKDANCE changes the schema default and user-facing description for `dev.autoqaPush.endpoint` to:

```text
https://qa.elide.dev/v1/grievances
```

Override precedence remains unchanged:

1. `PI_AUTO_QA_PUSH_URL`;
2. configured `dev.autoqaPush.endpoint`;
3. schema default.

Consent and push semantics remain unchanged. Existing users who explicitly configured `qa.omp.sh` continue using it. New/default configurations use Elide's collector.

Because `packages/coding-agent/src/config/settings-schema.ts` is an upstream-owned file in the Aura fork, the change must be recorded in `docs/aura/FORK.md`. The coding-agent changelog receives an `[Unreleased]` Changed entry after the behavior is verified.

## 6. Collector-backed runtime diagnosis

The collector is evidence transport, not a substitute for local debugging. The controlled workflow is:

1. Deploy and smoke-test `qa.elide.dev`.
2. Point the current development Aura session at the new endpoint through the existing override.
3. submit a controlled `run` grievance and confirm its D1 row, including platform, architecture, model, version, and exact surfaced symptom;
4. reproduce inline Python and JavaScript execution through the embedded harness tool;
5. reproduce through the package's direct runtime service/endpoint path to separate tool rendering from Worker/runtime behavior;
6. inspect Aura logs and embedded Worker error propagation to recover the underlying Worker error currently collapsed into `Embedded runtime execution worker failed`;
7. determine the first failing boundary: Worker startup/entry dispatch, library load, ABI open, request codec, guest execution, or result propagation;
8. fix that boundary without adding fallback behavior;
9. rerun the same controlled inline programs and record the resolved outcome.

The existing architecture intentionally fails loudly when an embedded candidate is present but broken. That invariant remains intact.

## 7. Runtime repair constraints

- Fix the root cause, not the generic error message alone.
- Preserve one fresh guest context per run.
- Preserve embedded serialization and cancellation semantics.
- Preserve process-backed behavior for unsupported methods and languages.
- Preserve source-path semantics: inline snippets execute from scratch; path mode resolves sibling imports and data relative to the source file.
- If Worker error propagation hides actionable cause data, improve the structured error/detail path while sanitizing user-facing output and logs according to Aura TUI rules.
- Do not expose the internal Elide product name in Aura's user-facing runtime terminology; the user-facing noun remains “the runtime.”

## 8. Verification

### 8.1 Collector

- Worker tests cover canonical acceptance, multi-entry batches, malformed JSON, missing fields, type errors, empty/oversized strings, more than 50 entries, oversized bodies, wrong methods/routes, D1 failure, and retention cleanup.
- Wrangler dry-run build succeeds.
- D1 schema is applied remotely.
- `GET https://qa.elide.dev/health` succeeds.
- A canonical POST returns `202` and the matching rows are observed through authenticated D1 query.
- An invalid POST returns `400` without inserting rows.

### 8.2 Aura endpoint default

- Focused settings tests prove the new default.
- Existing tests prove environment and explicit setting overrides still win.
- A canonical `flushGrievances` request reaches the configured URL and preserves the payload contract.

### 8.3 Embedded runtime

- Reproduce the pre-fix failure before implementation changes.
- Run inline Python: `print("Hello, world!")` and observe exit code 0 with exact stdout.
- Run inline JavaScript and observe exit code 0 with exact stdout.
- Run two calls that mutate globals and prove no state crosses calls.
- Exercise guest args, stdin, cwd, environment, stdout, stderr, and nonzero exit behavior in the affected adapter.
- Exercise at least one file-backed or process-delegated path to prove routing remains intact.
- Run focused embedded runtime tests and the dedicated runtime smoke path required by the existing implementation plan.

### 8.4 End to end

After the repair, submit a final controlled grievance or diagnostic report to `qa.elide.dev`, confirm its D1 row, and rerun the original harness `run` request successfully. Evidence must distinguish collector acceptance from runtime success; neither implies the other.

## 9. Deployment order and rollback

Order:

1. Provision D1.
2. Apply schema.
3. Deploy Worker and custom domain.
4. Smoke-test health, validation, and insertion.
5. Change Aura's default endpoint.
6. Diagnose and repair embedded execution.
7. Complete focused and end-to-end verification.

Rollback:

- Worker: redeploy the prior Worker version or remove the custom-domain route.
- Client default: revert the schema default; explicit user overrides continue to work throughout.
- Runtime repair: revert only the root-cause change if focused runtime verification regresses, leaving the collector deployment independent.

Collector deployment does not depend on the runtime repair. Aura's default endpoint must not switch until the collector is live and verified.
