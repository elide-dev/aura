# Elide QA Collector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy a private-queryable Cloudflare Worker grievance collector at `qa.elide.dev` and make it Aura's verified default Auto-QA endpoint.

**Architecture:** A new WHIPLASH infrastructure package exposes the existing OMP `POST /v1/grievances` contract, validates bounded batches, and stores individual entries in a dedicated D1 database with 90-day retention. aura changes only the default endpoint and related user-facing copy; explicit setting and environment overrides remain unchanged.

**Tech Stack:** Cloudflare Workers, D1, Wrangler, TypeScript, Bun tests, aura settings and Auto-QA client.

## Global Constraints

- Collector source and deployment configuration live under `/home/sam/workspace/labs/WHIPLASH/project/infra/qa`.
- The public route is exactly `https://qa.elide.dev/v1/grievances`.
- Preserve the current OMP batch payload and the 50-entry client batch maximum.
- Store no IP addresses, request headers, cookies, raw request bodies, or unrecognized fields.
- Expose no public read API; operators query D1 through authenticated Cloudflare tooling.
- Delete records older than 90 days through a scheduled Worker trigger.
- Keep Auto-QA consent, local SQLite retention, batching, and endpoint override precedence unchanged.
- Do not commit: aura repository rules prohibit commits unless the user explicitly asks.
- Do not begin embedded runtime repair in this plan. After the collector records a controlled reproduction, diagnose the runtime failure and write a root-cause-specific repair plan.

---

## File structure

### runtime

- `package.json`: add `project/infra/qa` to the root workspace list.
- `bun.lock`: record the new workspace package after installation.
- `project/infra/qa/package.json`: Worker package scripts and development types.
- `project/infra/qa/tsconfig.json`: Worker TypeScript target and generated Worker API types.
- `project/infra/qa/wrangler.toml`: Worker name, entrypoint, custom domain, D1 binding, logs, and retention cron.
- `project/infra/qa/schema.sql`: grievance table and receive-time index.
- `project/infra/qa/contract.ts`: request types, bounds, and strict payload parser.
- `project/infra/qa/store.ts`: narrow storage interface plus D1 implementation.
- `project/infra/qa/worker.ts`: HTTP routing, response mapping, dependency wiring, and scheduled cleanup.
- `project/infra/qa/worker.test.ts`: observable HTTP, persistence, and retention contracts with an in-memory store.
- `project/infra/qa/worker-apis.d.ts`: generated Wrangler environment types.

### aura

- `packages/coding-agent/src/config/settings-schema.ts`: default endpoint and settings UI description.
- `packages/coding-agent/src/tools/report-tool-issue.ts`: stale default-host documentation only; no push behavior change.
- `packages/coding-agent/src/cli/grievances-cli.ts`: stale default-host documentation only.
- `packages/coding-agent/test/tools/report-tool-issue.test.ts`: default endpoint and override-precedence contracts.
- `docs/aura/FORK.md`: record the newly touched upstream-owned coding-agent files.
- `packages/coding-agent/CHANGELOG.md`: `[Unreleased]` Changed entry after deployment verification.

---

### Task 1: Create the bounded collector contract

**Files:**
- Modify: `/home/sam/workspace/labs/WHIPLASH/package.json`
- Modify: `/home/sam/workspace/labs/WHIPLASH/bun.lock`
- Create: `/home/sam/workspace/labs/WHIPLASH/project/infra/qa/package.json`
- Create: `/home/sam/workspace/labs/WHIPLASH/project/infra/qa/tsconfig.json`
- Create: `/home/sam/workspace/labs/WHIPLASH/project/infra/qa/contract.ts`
- Create: `/home/sam/workspace/labs/WHIPLASH/project/infra/qa/worker.test.ts`

**Interfaces:**
- Produces: `GrievanceBatch`, `GrievanceEntry`, `PayloadError`, and `parseGrievanceBatch(value: unknown): GrievanceBatch`.
- Consumes: no earlier task interfaces.

- [ ] **Step 1: Add the WHIPLASH workspace package metadata**

Add `project/infra/qa` to the root `workspaces` array. Create `project/infra/qa/package.json` with the established Worker scripts:

```json
{
  "name": "@elide/workers-qa",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "types": "bun x -p wrangler@latest wrangler types ./worker-apis.d.ts",
    "test": "bun test",
    "build": "bun x -p wrangler@latest wrangler deploy --dry-run",
    "deploy": "bun x -p wrangler@latest wrangler deploy"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "5.20260706.1",
    "@types/bun": "^1.3.14",
    "typescript": "6.0.3"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "esnext",
    "moduleResolution": "bundler",
    "lib": ["esnext"],
    "types": ["./worker-apis.d.ts", "bun"]
  }
}
```

Run from the WHIPLASH root:

```bash
bun install
```

Expected: the new workspace resolves and `bun.lock` changes only for the workspace/package metadata required by this package.

- [ ] **Step 2: Write failing parser tests**

Start `worker.test.ts` with table-driven tests for the canonical envelope and every rejected boundary:

```ts
import { describe, expect, test } from "bun:test";
import { PayloadError, parseGrievanceBatch } from "./contract";

const validBatch = {
  agent: { name: "omp", version: "18.2.0" },
  installId: "install-123",
  platform: "linux",
  arch: "x64",
  entries: [
    {
      id: 42,
      model: "openai/gpt-5.6",
      version: "18.2.0",
      tool: "run",
      report: "inline Python returned an execution worker failure",
    },
  ],
};

describe("parseGrievanceBatch", () => {
  test("accepts the canonical OMP envelope without retaining unknown fields", () => {
    const parsed = parseGrievanceBatch({ ...validBatch, ignored: "drop-me" });
    expect(parsed).toEqual(validBatch);
  });

  test.each([
    ["non-object", null],
    ["missing agent", { ...validBatch, agent: undefined }],
    ["empty install id", { ...validBatch, installId: "" }],
    ["empty entries", { ...validBatch, entries: [] }],
    ["too many entries", { ...validBatch, entries: Array.from({ length: 51 }, () => validBatch.entries[0]) }],
    ["non-integer local id", { ...validBatch, entries: [{ ...validBatch.entries[0], id: 1.5 }] }],
    ["empty tool", { ...validBatch, entries: [{ ...validBatch.entries[0], tool: "" }] }],
    ["empty report", { ...validBatch, entries: [{ ...validBatch.entries[0], report: "" }] }],
  ])("rejects %s", (_name, value) => {
    expect(() => parseGrievanceBatch(value)).toThrow(PayloadError);
  });
});
```

Add explicit maximum-length tests for every string field using the exported constants, including one value exactly at the bound and one one character over it.

- [ ] **Step 3: Run parser tests and observe the expected failure**

Run:

```bash
cd /home/sam/workspace/labs/WHIPLASH/project/infra/qa
bun test worker.test.ts
```

Expected: FAIL because `contract.ts` does not exist.

- [ ] **Step 4: Implement strict parsing**

Create `contract.ts` with named limits and copied output values:

```ts
export const MAX_BODY_BYTES = 262_144;
export const MAX_ENTRIES = 50;
export const MAX_SHORT_FIELD = 256;
export const MAX_MODEL_FIELD = 512;
export const MAX_REPORT_FIELD = 16_384;

export interface GrievanceEntry {
  id: number;
  model: string;
  version: string;
  tool: string;
  report: string;
}

export interface GrievanceBatch {
  agent: { name: string; version: string };
  installId: string;
  platform: string;
  arch: string;
  entries: GrievanceEntry[];
}

export class PayloadError extends Error {}
```

Implement `parseGrievanceBatch(value)` with local helpers that require plain records, finite safe integers, arrays, and trimmed non-empty strings no longer than their field-specific bound. Return a newly constructed `GrievanceBatch`; never cast and return the input object. Unknown fields are ignored rather than persisted.

- [ ] **Step 5: Run parser tests**

Run:

```bash
bun test worker.test.ts
```

Expected: all `parseGrievanceBatch` tests PASS.

---

### Task 2: Implement D1 persistence and Worker routes

**Files:**
- Create: `/home/sam/workspace/labs/WHIPLASH/project/infra/qa/schema.sql`
- Create: `/home/sam/workspace/labs/WHIPLASH/project/infra/qa/store.ts`
- Create: `/home/sam/workspace/labs/WHIPLASH/project/infra/qa/worker.ts`
- Modify: `/home/sam/workspace/labs/WHIPLASH/project/infra/qa/worker.test.ts`
- Create: `/home/sam/workspace/labs/WHIPLASH/project/infra/qa/wrangler.toml`
- Create: `/home/sam/workspace/labs/WHIPLASH/project/infra/qa/worker-apis.d.ts`

**Interfaces:**
- Consumes: `GrievanceBatch` and `PayloadError` from Task 1.
- Produces: `QaStore`, `D1QaStore`, `QaDependencies`, `handleRequest(request: Request, store: QaStore, dependencies: QaDependencies): Promise<Response>`, and `runRetention(store: QaStore, now?: Date): Promise<number>`.

- [ ] **Step 1: Write failing HTTP and retention tests**

Extend `worker.test.ts` with an in-memory store implementing this exact seam:

```ts
interface StoredReceipt {
  receiptId: string;
  batch: GrievanceBatch;
  receivedAt: string;
}

class MemoryStore implements QaStore {
  readonly receipts: StoredReceipt[] = [];
  deletedBefore: string | undefined;
  failInsert = false;

  async insertReceipt(receiptId: string, batch: GrievanceBatch, receivedAt: string): Promise<void> {
    if (this.failInsert) throw new Error("fixture write failure");
    this.receipts.push({ receiptId, batch, receivedAt });
  }

  async deleteBefore(cutoff: string): Promise<number> {
    this.deletedBefore = cutoff;
    return 3;
  }
}
```

Test these observable contracts:

- `GET /health` returns 200 and does not touch storage.
- canonical `POST /v1/grievances` returns 202 `{ receiptId: "receipt-1", accepted: 1 }` and stores the parsed batch once;
- malformed JSON and invalid payload return 400 without storage;
- a non-JSON content type returns 400;
- wrong method returns 405 with `Allow: POST`;
- unknown route returns 404;
- a body larger than `MAX_BODY_BYTES` returns 413;
- insertion failure returns 503 without grievance text or stack data in the response;
- a denied install-ID rate-limit check returns 429 without storage;
- retention at `2026-07-29T12:00:00.000Z` calls `deleteBefore("2026-04-30T12:00:00.000Z")` and returns the deleted count.

Inject deterministic dependencies:

```ts
const dependencies = {
  now: () => new Date("2026-07-29T12:00:00.000Z"),
  randomUUID: () => "receipt-1",
  allowInstall: async (_installId: string) => true,
};
```

- [ ] **Step 2: Run route tests and observe the expected failure**

Run:

```bash
cd /home/sam/workspace/labs/WHIPLASH/project/infra/qa
bun test worker.test.ts
```

Expected: FAIL because `QaStore`, `handleRequest`, and `runRetention` do not exist.

- [ ] **Step 3: Create the D1 schema**

Create `schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS grievances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_id TEXT NOT NULL,
    receipt_entry INTEGER NOT NULL,
    agent_name TEXT NOT NULL,
    agent_version TEXT NOT NULL,
    install_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    arch TEXT NOT NULL,
    local_id INTEGER NOT NULL,
    model TEXT NOT NULL,
    client_version TEXT NOT NULL,
    tool TEXT NOT NULL,
    report TEXT NOT NULL,
    received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_grievances_received_at
ON grievances(received_at);
```

Do not add IP, header, raw-body, or speculative query indexes.

- [ ] **Step 4: Implement the storage seam and D1 adapter**

Create `store.ts`:

```ts
import type { GrievanceBatch } from "./contract";

export interface QaStore {
  insertReceipt(receiptId: string, batch: GrievanceBatch, receivedAt: string): Promise<void>;
  deleteBefore(cutoff: string): Promise<number>;
}

export class D1QaStore implements QaStore {
  constructor(readonly db: D1Database) {}

  async insertReceipt(receiptId: string, batch: GrievanceBatch, receivedAt: string): Promise<void> {
    const statements = batch.entries.map((entry, index) =>
      this.db
        .prepare(`INSERT INTO grievances (
          receipt_id, receipt_entry, agent_name, agent_version,
          install_id, platform, arch, local_id, model,
          client_version, tool, report, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          receiptId,
          index,
          batch.agent.name,
          batch.agent.version,
          batch.installId,
          batch.platform,
          batch.arch,
          entry.id,
          entry.model,
          entry.version,
          entry.tool,
          entry.report,
          receivedAt,
        ),
    );
    await this.db.batch(statements);
  }

  async deleteBefore(cutoff: string): Promise<number> {
    const result = await this.db
      .prepare("DELETE FROM grievances WHERE received_at < ?")
      .bind(cutoff)
      .run();
    return result.meta.changes;
  }
}
```

- [ ] **Step 5: Implement routing, bounded reads, and retention**

Create `worker.ts` with:

```ts
import { MAX_BODY_BYTES, PayloadError, parseGrievanceBatch } from "./contract";
import { D1QaStore, type QaStore } from "./store";

interface Env {
  DB: D1Database;
  RATE_LIMITER: RateLimit;
}

export interface QaDependencies {
  now: () => Date;
  randomUUID: () => string;
  allowInstall: (installId: string) => Promise<boolean>;
}
```

`handleRequest` must inspect `Content-Length` before reading, then read `request.arrayBuffer()` and reject a measured body over `MAX_BODY_BYTES`. Decode UTF-8, parse JSON, call `parseGrievanceBatch`, and check `dependencies.allowInstall(batch.installId)` before insertion. A denied check returns 429 without touching storage. An allowed request inserts once and returns JSON responses with `content-type: application/json; charset=utf-8` and `x-content-type-options: nosniff`. Catch `PayloadError`/`SyntaxError` as 400 and store failures as 503. Do not log request bodies or include exception messages in responses.

`runRetention` computes a cutoff exactly 90 days before `now` and delegates to `store.deleteBefore(cutoff.toISOString())`.

Default export:

```ts
export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, new D1QaStore(env.DB), {
      now: () => new Date(),
      randomUUID: () => crypto.randomUUID(),
      allowInstall: async installId => (await env.RATE_LIMITER.limit({ key: installId })).success,
    });
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await runRetention(new D1QaStore(env.DB));
  },
};
```

- [ ] **Step 6: Add Worker configuration**

Create `wrangler.toml` without a hand-written database ID:

```toml
name = "elide-qa"
main = "worker.ts"
compatibility_date = "2026-07-29"
routes = [{ pattern = "qa.elide.dev", custom_domain = true }]

[[ratelimits]]
name = "RATE_LIMITER"
namespace_id = "1701"
simple = { limit = 60, period = 60 }

[observability.logs]
enabled = true

[triggers]
crons = ["17 3 * * *"]
```

Generate Worker types:

```bash
bun run types
```

Expected: `worker-apis.d.ts` exists and TypeScript recognizes `D1Database` and `ScheduledController`.

- [ ] **Step 7: Run tests and dry-run build**

Run:

```bash
bun test worker.test.ts
bun run build
```

Expected: all tests PASS; Wrangler dry-run succeeds without deploying.

---

### Task 3: Provision and deploy `qa.elide.dev`

**Files:**
- Modify: `/home/sam/workspace/labs/WHIPLASH/project/infra/qa/wrangler.toml` through Wrangler's `--update-config` operation.

**Interfaces:**
- Consumes: Worker package, `schema.sql`, and `DB` binding from Tasks 1–2.
- Produces: live `https://qa.elide.dev/health` and `POST /v1/grievances` endpoints plus a queryable remote D1 database.

- [ ] **Step 1: Confirm Cloudflare authentication without mutating resources**

Run:

```bash
cd /home/sam/workspace/labs/WHIPLASH/project/infra/qa
bun x -p wrangler@latest wrangler whoami
```

Expected: the authenticated Elide Cloudflare account is shown. If authentication is absent, finish all local tasks but report the exact missing credential/session; do not fabricate deployment success.

- [ ] **Step 2: Provision D1 and let Wrangler write the real binding ID**

Run once:

```bash
bun x -p wrangler@latest wrangler d1 create elide-qa --binding DB --update-config
```

Expected: Cloudflare creates `elide-qa` and appends a `[[d1_databases]]` block with `binding = "DB"`, `database_name = "elide-qa"`, and the real `database_id`. If the database already exists, use `wrangler d1 list` to obtain its ID and configure that existing database; never create a duplicate name intentionally.

- [ ] **Step 3: Apply the remote schema**

Run:

```bash
bun x -p wrangler@latest wrangler d1 execute elide-qa --remote --file=./schema.sql
```

Expected: table and index creation statements succeed.

- [ ] **Step 4: Deploy the Worker**

Run:

```bash
bun run deploy
```

Expected: Wrangler deploys `elide-qa` and binds the custom domain `qa.elide.dev`.

- [ ] **Step 5: Smoke-test health and rejection behavior**

Run:

```bash
curl --fail-with-body https://qa.elide.dev/health
curl --silent --show-error --write-out '\n%{http_code}\n' \
  --request POST \
  --header 'content-type: application/json' \
  --data '{}' \
  https://qa.elide.dev/v1/grievances
```

Expected: health returns 200; invalid payload returns 400 and inserts no row.

- [ ] **Step 6: Submit and query a canonical controlled grievance**

Run:

```bash
curl --fail-with-body \
  --request POST \
  --header 'content-type: application/json' \
  --data '{"agent":{"name":"aura-smoke","version":"dev"},"installId":"controlled-smoke","platform":"linux","arch":"x64","entries":[{"id":1,"model":"smoke/model","version":"dev","tool":"run","report":"controlled collector deployment smoke"}]}' \
  https://qa.elide.dev/v1/grievances

bun x -p wrangler@latest wrangler d1 execute elide-qa --remote \
  --command "SELECT receipt_id, tool, report, platform, arch FROM grievances WHERE install_id = 'controlled-smoke' ORDER BY id DESC LIMIT 1"
```

Expected: POST returns 202 with accepted count 1; query returns exactly the controlled row.

---

### Task 4: Change Aura's default collector endpoint

**Files:**
- Modify: `/home/sam/workspace/labs/BREAKDANCE/packages/coding-agent/src/config/settings-schema.ts`
- Modify: `/home/sam/workspace/labs/BREAKDANCE/packages/coding-agent/src/tools/report-tool-issue.ts`
- Modify: `/home/sam/workspace/labs/BREAKDANCE/packages/coding-agent/src/cli/grievances-cli.ts`
- Modify: `/home/sam/workspace/labs/BREAKDANCE/packages/coding-agent/test/tools/report-tool-issue.test.ts`
- Modify: `/home/sam/workspace/labs/BREAKDANCE/docs/aura/FORK.md`

**Interfaces:**
- Consumes: live collector endpoint from Task 3.
- Produces: `Settings.isolated().get("dev.autoqaPush.endpoint") === "https://qa.elide.dev/v1/grievances"` while preserving `PI_AUTO_QA_PUSH_URL` and explicit setting precedence.

- [ ] **Step 1: Read the Aura fork ledger before touching upstream-owned files**

Read `docs/aura/FORK.md`. Confirm whether each of the three coding-agent source files is already listed. Add only newly touched upstream-owned files to the appropriate fork section; do not duplicate existing rows.

- [ ] **Step 2: Add failing default and precedence tests**

In `test/tools/report-tool-issue.test.ts`, add:

```ts
test("uses the Elide collector as the default Auto-QA endpoint", () => {
  expect(Settings.isolated().get("dev.autoqaPush.endpoint")).toBe(
    "https://qa.elide.dev/v1/grievances",
  );
});
```

Retain the existing configured-endpoint fetch test. Add an environment override test that sets `PI_AUTO_QA_PUSH_URL` only for that test, flushes one row with `pushSettings()`, and asserts the captured fetch input is the environment URL. Restore the environment in `afterEach` using the file's existing isolation convention.

- [ ] **Step 3: Run the focused tests and observe the expected failure**

Run:

```bash
cd /home/sam/workspace/labs/BREAKDANCE/packages/coding-agent
bun test test/tools/report-tool-issue.test.ts
```

Expected: the new default assertion FAILS with `https://qa.omp.sh/v1/grievances`; existing configured-endpoint behavior remains green.

- [ ] **Step 4: Update the default and stale host copy**

Change the settings schema default and UI description to `https://qa.elide.dev/v1/grievances`. Update only stale documentation comments in `report-tool-issue.ts` and `grievances-cli.ts`; do not change `resolvePushConfig`, consent resolution, batching, or storage logic.

Use the Aura user-facing product term “the runtime”; do not introduce the internal Elide product name into runtime UI strings. “Elide QA collector” is acceptable only in developer-facing endpoint documentation where ownership matters.

- [ ] **Step 5: Run focused tests and project validation**

Run:

```bash
bun test test/tools/report-tool-issue.test.ts
bun check
```

Expected: focused tests PASS and project validation succeeds.

- [ ] **Step 6: Update the fork ledger**

Add rows for any newly touched upstream-owned files, including their upstream path, Aura purpose (“default Auto-QA collector ownership”), and sync risk. Do not add duplicate rows for files already tracked.

---

### Task 5: Verify Aura-to-D1 delivery and finish package cleanup

**Files:**
- Modify: `/home/sam/workspace/labs/BREAKDANCE/packages/coding-agent/CHANGELOG.md`

**Interfaces:**
- Consumes: deployed collector and migrated default endpoint.
- Produces: observed canonical client delivery in D1 and release documentation for the verified behavior change.

- [ ] **Step 1: Submit through Aura's real grievance client**

Create `/tmp/aura-qa-e2e.ts` with this exact probe:

```ts
import { Database } from "bun:sqlite";
import { Settings } from "/home/sam/workspace/labs/BREAKDANCE/packages/coding-agent/src/config/settings";
import { flushGrievances } from "/home/sam/workspace/labs/BREAKDANCE/packages/coding-agent/src/tools/report-tool-issue";

const marker = "aura-default-e2e-20260729";
const db = new Database(":memory:");
db.exec(`
  CREATE TABLE grievances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model TEXT NOT NULL,
    version TEXT NOT NULL,
    tool TEXT NOT NULL,
    report TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    pushed INTEGER NOT NULL DEFAULT 0
  )
`);
db.prepare(
  "INSERT INTO grievances (model, version, tool, report) VALUES (?, ?, ?, ?)",
).run("aura/e2e", "dev", "run", marker);

const settings = Settings.isolated({
  "dev.autoqa": true,
  "dev.autoqaConsent": "granted",
});
const result = await flushGrievances(db, settings, { fetch });
if (!result.ok || result.pushed !== 1) {
  throw new Error(`unexpected flush result: ${JSON.stringify(result)}`);
}
process.stdout.write(`${JSON.stringify({ marker, result })}\n`);
```

Run:

```bash
cd /home/sam/workspace/labs/BREAKDANCE/packages/coding-agent
bun /tmp/aura-qa-e2e.ts
```

Expected: the probe prints `{"marker":"aura-default-e2e-20260729","result":{"pushed":1,"ok":true}}`. It exercises `flushGrievances`, the schema-default endpoint, the canonical envelope, and the real network fetch.

- [ ] **Step 2: Confirm the exact report in remote D1**

From `WHIPLASH/project/infra/qa`, run:

```bash
bun x -p wrangler@latest wrangler d1 execute elide-qa --remote \
  --command "SELECT agent_name, agent_version, install_id, platform, arch, tool, report, received_at FROM grievances WHERE report = 'aura-default-e2e-20260729' ORDER BY id DESC LIMIT 1"
```

Expected: the latest matching row has tool `run`, report `aura-default-e2e-20260729`, and the current platform/architecture.

- [ ] **Step 3: Record the verified endpoint migration in the changelog**

Under `packages/coding-agent/CHANGELOG.md` → `## [Unreleased]` → `### Changed`, add:

```markdown
- Changed the default Auto-QA grievance collector to the Elide-operated `qa.elide.dev` endpoint while preserving explicit endpoint overrides.
```

Do not edit released sections.

- [ ] **Step 4: Final collector and client verification**

Run:

```bash
cd /home/sam/workspace/labs/WHIPLASH/project/infra/qa
bun test worker.test.ts
bun run build

cd /home/sam/workspace/labs/BREAKDANCE/packages/coding-agent
bun test test/tools/report-tool-issue.test.ts
bun check
```

Then call:

```bash
curl --fail-with-body https://qa.elide.dev/health
```

Expected: Worker tests and dry-run build PASS; coding-agent tests and validation PASS; live health returns 200.

- [ ] **Step 5: Hand off the recorded inline failure to root-cause diagnosis**

Submit the current embedded harness symptom through `xd://report_issue` after the default migration, query its D1 row by exact report text, then invoke `systematic-debugging`. Reproduce through both the harness `run` tool and `test/runtime-embedded-integration.test.ts`. The runtime repair plan must name the observed first failing boundary and the exact regression test before changing implementation code.
