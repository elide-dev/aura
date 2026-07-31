# @oh-my-pi/pi-metaharness

One manager for repository benchmarks. Harbor, TypeScript edit, and SnapCompact
runs use the same experiment → run → trace model, SQLite store, REST/SSE API,
and dashboard. Benchmark-native artifacts remain on disk; adapters normalize
their live progress, scores, token usage, costs, and traces.

```bash
# Dashboard + API on :4700; launch every benchmark from the same “new run” form
bun run serve --port 4700
```

## How Harbor runs execute

1. **Local omp, not npm.** By default the runner bind-mounts the repo
   read-only into each task container (`--install source`) and runs omp
   straight from `packages/coding-agent/src/cli.ts` — TS edits apply to the
   next trial with no rebuild. A cached linux `node_modules` tree (built once
   per lockfile change inside `oven/bun`, stored in `<jobs-dir>/_bench/_deps/`)
   shadows the host's darwin one, and a linux `bun` binary is mounted at
   `/opt/omp/bin` — so trial setup needs zero outbound network. Alternatives:
   `--install local` (pack a tarball per run) or `--binary` (prebuilt
   `dist/aura-linux-*` self-contained binaries).
2. **Auth never enters containers.** A generated `models.yml` routes provider
   `baseUrl`s at the host pm2 auth-gateway; the gateway resolves credentials
   host-side.
3. **Harbor owns trials.** The runner/serve layer polls each trial's
   `result.json` for progress, spend, and outcomes.

## Runtime capability benchmark

Run the matched Bash-vs-runtime agent suite plus the existing deterministic
direct-vs-runtime microbenchmarks from the repository root:

```bash
bun run bench:runtime
```

The command materializes 12 deterministic Harbor tasks, runs paired arms with
alternating AB/BA order, and writes both a frozen launch manifest and comparison
report:

- `runs/harbor/_bench/<prefix>-runtime-manifest.json`
- `runs/harbor/_bench/<prefix>-runtime-comparison.md`

Both arms use the same model, reasoning level, task fixtures, and attempts; only
the runtime tools are added to the second arm. The report pairs outcomes within
task strata, uses a deterministic 10,000-sample task bootstrap for 95%
confidence intervals, reports end-to-end arm time separately from trial time,
and renders the pre-registered decision.
The runtime arm always exposes the production-essential `run`, `check`, and
`build` tools, then adds only the discoverable runtime tools applicable to the
task (for example, `insights` for instrumentation or `jvm_disassemble` for
bytecode inspection). The frozen manifest records the exact runtime tool list
per task. This keeps the causal treatment realistic without charging every
trial for unrelated debugger, profiler, JVM, server, and advisory tool schemas.

Before any model trial, the orchestrator builds the generated TypeScript task
image and runs its verifier against a deterministic valid solution. Every task
image carries the exact Bun executable used to materialize the campaign at
`/opt/runtime-benchmark/bin/bun`; it is on `PATH` for both arms and is
independent of the agent install. The smoke covers `node:fs`, TypeScript syntax,
top-level await, and the expected sorted BFS output. A smoke failure stops the
campaign. The frozen manifest records this verifier Bun's version and SHA-256.


An adapter decision run additionally compares independent process and embedded
runtime services:

```bash
bun run bench:runtime --micro-only --micro-iterations 30 \
  --embedded-lib=/absolute/path/to/packaged/runtime-library \
  --prefix=runtime-embedded-decision
```

The benchmark derives the packaged process executable from the library's
sibling `bin/` directory. In agent mode, both artifacts must live inside the
repository: source-mode Harbor launches map them into the read-only task
container and set `AURA_RUNTIME_BIN`, `AURA_RUNTIME_EMBEDDED_LIB`, and the
`auto` adapter explicitly. `--embedded-lib` takes precedence over
`AURA_RUNTIME_EMBEDDED_LIB` for this benchmark only; it does not change the
process rollout default. Without either value, the existing report is preserved
and its adapter section states that comparison was skipped.

The adapter table reports embedded cold open plus first JavaScript execution as
a non-comparable single sample, then p50/p95 process and embedded latency plus
process-over-embedded speedup for warm JavaScript, TypeScript, and Python
startup, the same three compute cases, and bounded cancellation. Every warm
operation runs once before sampling, timed order alternates each iteration,
exact output is checked before a sample is accepted, and both services close
after the run. Use at least 30 iterations for a rollout decision.

Useful controls:

```bash
bun run bench:runtime --task python-execution --attempts 1
bun run bench:runtime --agent-only
bun run bench:runtime --micro-only --micro-iterations 30
```

### Effectiveness proof workflow

Use concurrency one (enforced by the orchestrator) and keep every launch setting
fixed across comparable arms:

```bash
REPO_ROOT=$(pwd -P)
REVISION=$(git rev-parse HEAD)
SOURCE_PATCH_SHA256=$(git diff HEAD --binary | sha256sum | cut -d' ' -f1)
HISTORICAL_REVISION=2adbb3538b8d7b7df6c09d7e7beefc60b59ce575
RUNTIME_LIB="$REPO_ROOT/out/aura-elide-linux-x64/lib/libelide_embed.so"

# One-task telemetry/auth/runtime preflight
bun run bench:runtime --agent-only --task python-execution --attempts 2 --embedded-lib "$RUNTIME_LIB" \
  --prefix runtime-effectiveness-preflight \
  --revision "$REVISION" \
  --source-patch-sha256 "$SOURCE_PATCH_SHA256" \
  --historical-revision "$HISTORICAL_REVISION"

# Complete pilot
bun run bench:runtime --agent-only --attempts 2 --embedded-lib "$RUNTIME_LIB" \
  --prefix runtime-effectiveness-pilot \
  --revision "$REVISION" \
  --source-patch-sha256 "$SOURCE_PATCH_SHA256" \
  --historical-revision "$HISTORICAL_REVISION"

# Resume the same frozen campaign after interruption; completed arms are skipped
# and incomplete Harbor jobs retain their finished trials.
bun run bench:runtime --agent-only --attempts 2 --embedded-lib "$RUNTIME_LIB" \
  --prefix runtime-effectiveness-pilot \
  --revision "$REVISION" \
  --source-patch-sha256 "$SOURCE_PATCH_SHA256" \
  --historical-revision "$HISTORICAL_REVISION" \
  --resume

# Five-attempt proof plus immutable historical control
bun run bench:runtime --agent-only --attempts 5 --embedded-lib "$RUNTIME_LIB" \
  --prefix runtime-effectiveness-proof \
  --revision "$REVISION" \
  --historical-revision "$HISTORICAL_REVISION" \
  --source-patch-sha256 "$SOURCE_PATCH_SHA256" \
  --historical-binary "$REPO_ROOT/runs/harbor/_bench/historical/aura-linux-x64"

# Deterministic runtime overhead
bun run bench:runtime --micro-only --micro-iterations 30 --embedded-lib "$RUNTIME_LIB" \
  --prefix runtime-effectiveness-micro
```

The matched current-code decision passes only when:

- the lower effectiveness confidence bound is above `-5` percentage points;
- paired duration improves by at least 15% or tokens improve by at least 10%;
- the non-winning efficiency metric regresses by no more than 5%;
- no new systematic error class appears;
- runtime adoption reaches 80% overall and 50% in every capability group.

Missing telemetry, incomplete task pairs, or an interval crossing a gate is
`INCONCLUSIVE`, not a pass. A historical binary adds a separately labeled
whole-product control; it never changes the causal Bash-versus-runtime verdict.

## Server

- `GET /` — experiments, runs, normalized traces, and a launch form for every benchmark.
- `GET /api/experiments[?q=]` — experiment summaries across all benchmark types
  (`q` filters by id/goal substring).
- `POST /api/experiments` — register an experiment before its first arm. Body
  `{ "id": "sb2", "goal": "..." }`; the id is the dash-free token job names
  group under (`sb2-n8` → experiment `sb2`).
- `GET /api/experiments/:id` — arms, per-task matrix, and calibrated projections.
- `PUT /api/experiments/:id` — update the goal and per-run role/note/label.
- `POST /api/experiments/:id/arms` — launch a comparable arm; sample + config
  inherited from a sibling.
- `DELETE /api/experiments/:id` — delete every arm (DB rows **and** job dirs)
  plus the goal row; rejected while any arm is running.
- `GET /api/runs[?experiment=&status=&benchmark=]` — uniform run rows with
  benchmark, score, progress, spend, and tokens.
- `POST /api/runs` — launch through a benchmark adapter. Body:

  ```json
  {
    "benchmark": "edit",
    "model": "anthropic/claude-opus-4-8",
    "tasks": 20,
    "concurrency": 4,
    "attempts": 2,
    "jobName": "edit-baseline",
    "role": "baseline",
    "goal": "compare edit strategies"
  }
  ```

  `benchmark` is `harbor`, `edit`, or `snapcompact`. Harbor uses `dataset`,
  `include`, `timeoutMultiplier`, and `prewalk`; edit uses `include` as task IDs;
  SnapCompact uses `conditions` and treats `tasks` as the passage limit.
- `GET /api/runs/:name` — `{ run, traces }` (syncs native artifacts on read).
- `POST /api/runs/:name/cancel` — cancel a manager-launched run.
- `DELETE /api/runs/:name` — permanently delete a finished run (DB row **and**
  job dir; a surviving dir would be re-discovered on restart); rejected while
  the run is live.
- `POST /api/runs/:name/resume` — resume an incomplete harbor run in place:
  completed trials (and their spend) are reused, interrupted/pending trials
  re-run, and errored trials retried (body `{ "filterErrorTypes": [...] }`
  overrides the retry set, which defaults to every exception type in the job's
  `result.json`). The runner recovers the original launch flags from
  `_bench/<name>/runner-config.json` (snapshotted at launch) or the run's
  `manager.json` — nothing needs re-specifying.
- `GET /api/runs/:name/traces/:trace[?raw=1]` — normalized or native trace.
- `GET /api/events` — SSE stream of run-list snapshots (sent on change).

State lives in `<jobs-dir>/_manager/metaharness.sqlite`; the filesystem
stays the source of truth and historical CLI runs are auto-discovered.

## Harbor runner options (excerpt)

| Option | Default | Notes |
|---|---|---|
| `-m, --model <provider/model>` | `anthropic/claude-sonnet-4-6` | Repeatable |
| `-l, --tasks <N>` | `20` | Max tasks |
| `-n, --concurrency <N>` | `4` | Concurrent trials |
| `-k, --attempts <N>` | `1` | Attempts per task (pass@k) |
| `-d, --dataset <name>` | `terminal-bench@2.0` | Any Harbor dataset id |
| `-i/-x, --include/--exclude <glob>` | — | Task filters (repeatable) |
| `--timeout-multiplier <x>` | — | Scales task agent/verifier timeouts |
| `--agent-arg <arg>` | — | Extra arg forwarded verbatim to the in-container omp CLI (repeatable) |
| `--env <KEY[=VALUE]>` | — | Forward env into the omp container (repeatable); `KEY` alone forwards the host value |
| `--binary <path>` | — | Prebuilt omp binary (repeat for arm64+x64) |
| `--install <source\|local\|published>` | `source` | `source` = repo bind-mount, `local` = tarball pack, `published` = npm `@oh-my-pi/pi-coding-agent` |
| `--environment <docker\|apple-container>` | `docker` | `apple-container` runs trials via Apple's `container` CLI (no Docker); source/deps mounts go through `harbor --mounts` and the gateway is auto-forwarded from `192.168.64.1:4000` to the loopback-bound gateway |
| `--gateway-url <url>` | `http://host.docker.internal:4000` | `http://192.168.64.1:4000` under `--environment apple-container` |
| `--no-gateway` | off | Pass host provider keys into containers instead |
| `-o, --jobs-dir <path>` | `<repo>/runs/harbor` | Shared with the server |
| `--resume <name\|path>` | — | Resume that job dir via `harbor job resume`; original flags recovered automatically |
| `--filter-error-type <T>` | `CancelledError` | With `--resume`: also re-run completed trials that errored with exception type `T` (repeatable) |
| `--dry-run` | off | Print the harbor command + models.yml and exit |

## Outputs

- `<jobs-dir>/<jobName>/` — Harbor trial dirs (`result.json` per trial).
- `<jobs-dir>/_bench/<jobName>/report.md` — markdown summary table.
- `<jobs-dir>/_bench/<jobName>/harbor.log` — full Harbor output.
- `<jobs-dir>/_manager/logs/<jobName>.log` — runner output for API-launched runs.

## Trace reports

`scripts/trace-report.ts` turns one run trace into a narrative markdown report
(numbered Turn Log with one grounded sentence per assistant turn, harness
notices in place, then a Story Arc and — for failed runs — a failure analysis).
It map/reduces the normalized trace through two cheap OpenRouter models
(defaults: `inclusionai/ling-2.6-flash` per turn, `openai/gpt-oss-120b` for the
arc; ~$0.001 per report). API keys resolve through omp's auth storage.

```bash
bun scripts/trace-report.ts <run> <trace> [--focus "reviewer notes"] [--out report.md]
bun scripts/trace-report.ts "sb3-ntg|django__django-12325__ddQroP4"   # run|trace also accepted
```

Flags: `--base` (server, default `http://localhost:4700`), `--tiny` / `--synth`
(`<provider>/<model-id>` overrides), `--focus` (extra reviewer context, e.g. the
known-correct fix for a failed task), `--concurrency` (default 8).

## Caveats

- **Network policy.** On Harbor's local Docker backend only **public**
  registries work; task containers reach models via the host gateway.
- **`--install source` reflects local TS changes** with no rebuild, but Rust
  natives load from the in-tree `packages/natives/native/pi_natives.linux-*.node`
  prebuilds — rebuild those when Rust changes (the loader skips the version
  sentinel for workspace loads, so a stale `.node` runs silently).
- **Source mode is single-arch.** The deps tree matches the docker daemon's
  native arch; trials on emulated images (e.g. x64 tasks on an arm64 host)
  fail setup with an arch-mismatch error — use `--binary` for those.
- **The repo is visible (read-only) inside task containers** in source mode;
  fine for curated benchmarks, but don't point it at untrusted tasks.
- **Apple Container specifics.** `--environment apple-container` needs
  `brew install container && container system start` (macOS 26+, Apple
  silicon). `--host-network` and `--cleanup*` are docker-only, and bind
  mounts are read-write (the backend ignores `read_only`).
- **`--install local` reflects local TS changes** (inlined into `dist/cli.js`),
  but **not** uncommitted Rust natives — rebuild `packages/natives` per target
  first (the version sentinel must match).
