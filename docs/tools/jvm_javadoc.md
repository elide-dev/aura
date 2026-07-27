# jvm_javadoc

> Generate Javadoc HTML API docs from Java source into a project directory.

## Source
- Entry: `packages/coding-agent/src/tools/jvm-javadoc.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/jvm-javadoc.md`
- Key collaborators:
  - `packages/coding-agent/src/runtime/service.ts` — `RuntimeService.jvm()`.
  - `packages/coding-agent/src/runtime/transport/local.ts` — the `javadoc` flow of `runtime/jvm` plus `refuseExistingOutput()`.
  - `packages/coding-agent/src/runtime/jvm.ts` — `deriveJvmMainClass()`.
  - `packages/coding-agent/src/runtime/format.ts` — `formatExecResult()` on failure.
  - `packages/coding-agent/src/tools/index.ts` — registers the built-in via `JvmJavadocTool.createIf`.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `code` | `string` | Yes | Java source to document. |
| `output` | `string` | No | Output directory, resolved against the session cwd. Defaults to `javadoc-out`. |
| `overwrite` | `boolean` | No | Required to replace an existing `output`. |
| `timeoutMs` | `number` | No | Kills the generator after this many milliseconds. |

Java only — there is no Kotlin (Dokka) variant. `mainClass` is not a tool parameter; the documented class name is derived from `code`.

## Outputs
A single text block plus `details` carrying the raw `RuntimeJvmResult`.

- On success, three lines:
  - `Generated API docs for <className> → <output> (<entryCount> entries).`
  - `Top-level: <first up to 12 entries, comma-separated>`
  - `Tip: open <output>/index.html to browse them.`
- On failure the text is `formatExecResult(result)`.
- `details`: `{ exitCode, stdout, stderr, durationMs, killed, action: "javadoc", phase: "javadoc", language: "java", className, output?, entryCount?, topLevel? }`.

## Flow
1. `JvmJavadocTool.createIf(session)` returns `null` unless `runtime.enabled` is truthy.
2. Params are sent as `runtime/jvm` with `action: "javadoc"` and `cwd` = the session cwd.
3. `output` (default `javadoc-out`) is resolved against `cwd`. **If it exists and `overwrite` is not `true` the call fails before anything is spawned** and the existing directory is untouched.
4. The endpoint opens one temp workdir, derives the class name from `code`, and writes `<className>.java`.
5. Generate: `<binary> javadoc -- -d apidocs <className>.java`, with the workdir as cwd and `JAVA_HOME`/`JDK_HOME` stripped. A nonzero or killed run returns without writing anything.
6. On success the existing `output` is removed, its parent is created, and `apidocs` is copied recursively to `output`.
7. `entryCount` is the recursive entry count of `output`; `topLevel` is its first 12 top-level entries, sorted.
8. The workdir is removed in a `finally` block.

## Modes / Variants
None — one flow, Java source in, an HTML tree out.

## Side Effects
- Filesystem: writes `output` (and its parent directories) in your project — one of only two runtime tools that write outside a temp dir. With `overwrite: true` the directory is **replaced wholesale**, not merged. The temp workdir is removed afterwards.
- Subprocesses: one runtime spawn.
- Network: first use may download the managed runtime when `runtime.autoDownload` is on.
- Approval: `approval = "exec"`.

## Limits & Caps
- One compilation unit per call; no package trees, no `-link`/`-doclet` options.
- Javadoc warnings do not fail the run; a nonzero exit does.
- Requires runtime >= 1.4.

## Errors
- `The runtime service is unavailable on this session (runtime.enabled may be false, or this host does not provide it).` when no runtime service is wired.
- `jvm_javadoc requires \`code\` (Java source to document).` — `invalid-params`.
- `Refusing to overwrite <absolute path> — pass overwrite: true to replace it.` — `invalid-params`, with `data.output`.
- `runtime-missing` with installation guidance; `cancelled` on abort.

## Notes
- `loadMode = "discoverable"`.
- A generated tree is a few dozen files even for one class, which is why the result reports a count and a sample rather than a listing.
