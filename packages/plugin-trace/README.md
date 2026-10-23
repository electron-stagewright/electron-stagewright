# @electron-stagewright/plugin-trace

Record a driving session to a portable artifact, see where the token budget went, enforce a
budget, and replay the session against a fresh app instance. The first session-observing plugin
(ADR-009, built on the ADR-004 plugin contract): between `trace_start` and `trace_stop` it
subscribes to the server's dispatch-observer seam and captures every tool call — input, output
envelope, timing, and token estimate — to a crash-recoverable JSONL artifact, then `trace_tokens` summarises the cost
and `trace_replay` re-dispatches the calls. Give a recording a `budgetTokens` to track spend
live, and `enforce` to block over-budget calls. `trace_view` renders a recorded trace to a
self-contained HTML report you can open in any browser, offline.

## Load it

By package name (once installed) or file path, like any plugin — the server never auto-scans:

```sh
# By package name:
node packages/core/dist/cli.js --plugin @electron-stagewright/plugin-trace

# Configure (optional): default dir, record cap, redacted arg fields:
node packages/core/dist/cli.js --plugin @electron-stagewright/plugin-trace \
  --plugin-config trace='{"dir":"/tmp/traces","maxRecords":5000,"redact":["text"]}'
```

Programmatically:

```js
import { createServer } from '@electron-stagewright/core'
import tracePlugin from '@electron-stagewright/plugin-trace'

const server = await createServer({
  plugins: [tracePlugin],
  pluginConfigs: { trace: { redact: ['text'] } },
})
```

## Tools

The loader namespaces each tool under the plugin name `trace`:

- **`trace_start`** `{ path?, dir?, budgetTokens?, enforce?, warnThreshold? }` — begin recording
  to a JSONL artifact (path takes precedence over dir; both default to the configured dir or the
  OS temp dir). Calls stream to `<path>.partial`; `trace_stop` publishes `<path>` atomically.
  With `budgetTokens`, track an estimated-token budget; with `enforce:true`, also
  block over-budget calls (`trace.BUDGET_EXCEEDED`). Returns `{ recording, path, budget? }`. The
  plugin's own `trace_*` calls are not recorded (and never blocked by enforcement).
- **`trace_stop`** — flush the artifact, append its completion footer, atomically publish the
  final path, and return `{ path, records, total_estimated_tokens, overflowed, budget? }`.
- **`trace_tokens`** `{ path? }` — summarise token usage: total, per-tool totals, largest
  individual responses, whether the trace overflowed, and budget status (when budgeted). With no
  path it reports the live recording; otherwise reads a written artifact.
- **`trace_status`** — `{ recording, path?, records?, overflowed?, budget? }`.
- **`trace_budget`** — a cheap poll for the live recording's budget: `{ recording, path?,
budget? }`, where `budget` is `{ budget_tokens, spent, remaining, over_budget, near_budget,
warn_threshold }`. For an agent to self-limit mid-session without the full token breakdown.
- **`trace_replay`** `{ path, dryRun?, stopOnError?, include?, exclude?, maxCalls? }` — replay a
  written artifact by re-dispatching its calls, remap recorded session ids to the fresh replayed
  session, and report `{ replayed, matched, diverged, skipped, dry_run, calls }`. Divergence is
  judged on stable `ok`/`code` outcomes; diverged calls include bounded field-level diffs.
  `dryRun` validates the recorded calls against current schemas without dispatching them.
- **`trace_view`** `{ path, out? }` — render a written artifact to a single self-contained HTML
  report (inline CSS/JS, no external assets) and return `{ path, source, calls, bytes }`, where
  `path` is the written report. With no `out` the report is written next to the trace with a
  `.html` extension.
- **`trace_promote`** `{ path, out?, redactions?, include?, exclude?, parameters? }` — turn a diagnostic trace
  into a reviewable `stagewright-replay` v1 JSON spec. It retains tool args plus explicit `ok`
  checkpoints, replaces captured session ids with stable placeholders, and redacts sensitive args
  before writing (password/token/authorization/cookie defaults plus any named `args.*` fields).
  When filters select a later session-bound call, it retains the earlier session creator so the
  resulting spec remains runnable.
  Add result matchers intentionally when a regression needs to observe a value. `parameters`
  (e.g. `{ "language": { "type": "string", "enum": ["en", "es"], "value": "es" } }`) turns every
  argument exactly equal to `value` into a placeholder and writes a version 2 spec that declares
  the parameter with `value` as its default (no default for a `sensitive` one); the result counts
  the values each parameter replaced, and one that replaces nothing is `BAD_ARGUMENT`. A parameter
  placed on a redacted argument (such as `args.token`) must be `sensitive`, so its value is never
  written as a default.

Error codes: `trace.ALREADY_RECORDING`, `trace.NOT_RECORDING`, `trace.ARTIFACT_NOT_FOUND`,
`trace.ARTIFACT_INVALID`, `trace.ARTIFACT_WRITE_FAILED`, `trace.BUDGET_EXCEEDED`.

## Portable evidence

`trace_stop`, `trace_view`, and `trace_promote` also return expiring artifact metadata and MCP
resource links when output fits the server's portable limits (8 MiB per artifact, 32 MiB/32 artifacts
per server, 15-minute lifetime). Fetch JSONL, HTML or replay JSON with `resources/read`; no shared
filesystem is required. Local paths and JSON text remain compatible, and `artifact_unavailable`
explains size/capacity fallbacks. The recorder captures bounded generated bytes alongside its stream,
so resource reads never reopen the output path. Redaction and the existing opt-in data policy apply.
The tools advertise success/error output schemas and always include structured content.

## Config

`trace` plugin config (all optional):

- **`dir`** — default directory for artifacts when `trace_start` gets no `path`/`dir`.
- **`maxRecords`** — cap on written call records (default 10000); later calls are dropped and
  `overflowed` is reported.
- **`redact`** — argument property names to replace with `"[redacted]"` before recording.
- **`budgetTokens`** — default estimated-token budget when `trace_start` gets no `budgetTokens`.
- **`enforceBudget`** — when true, budgeted recordings block over-budget calls (default false).
- **`warnThreshold`** — fraction of the budget (`0 < warnThreshold <= 1`) at which `near_budget`
  trips (default 0.8).
- **`fsync`** — sync a partial artifact before its final rename (default false). Enable this only
  when the extra durability is worth the stop-time I/O cost.

## Token budget

Pass `budgetTokens` to `trace_start` (or set the `budgetTokens` config default) to track an
estimated-token budget. `trace_status`, `trace_tokens`, `trace_budget`, and `trace_stop` then carry
a `budget` object: `{ budget_tokens, spent, remaining, over_budget, near_budget, warn_threshold }`.
`spent` is exact even when the record cap overflows (`maxRecords`) — dropped calls still count.

By default the budget is advisory: an agent polls `trace_budget` and self-limits. Set `enforce:true`
(or the `enforceBudget` config) to additionally BLOCK calls once over budget — the dispatcher vetoes
each subsequent non-`trace_*` call with `trace.BUDGET_EXCEEDED` (carrying `next_actions`). The trace
plugin's own tools are never blocked, so an over-budget agent can always call `trace_stop` to
recover. The call that tips the budget over still runs (its cost is unknown until it does);
everything after it is blocked. Token counts are estimates (char/4, per the core error registry).

## Artifact format

JSONL, schema version 2. `trace_start` writes a `header` record to `<path>.partial`; each call
has a monotonic `seq`; `trace_stop` appends a `footer` (`complete:true`, call count, overflow,
and exact budget spend) and atomically renames the file to `<path>`. The observer path only adds
redacted records to a bounded queue, so dispatches do not wait for disk I/O. If the process stops
unexpectedly, the `.partial` file remains readable with `complete:false` (and a possibly
interrupted final line is ignored); `trace_tokens`, `trace_replay`, and `trace_view` accept it for
recovery. Existing version-1 `meta`/`call` artifacts remain readable through a separate legacy
reader.

## Replay limits

Replay is deterministic only for traces whose arguments remain meaningful in a fresh app run.
`trace_replay` automatically remaps session ids created by `electron_launch` / attach-style
calls, but it cannot reconstruct values removed by `redact`: a redacted argument such as
`"[redacted]"` is replayed exactly as recorded and may diverge. Use `dryRun` to check schema
drift without launching an app, and `include` / `exclude` / `maxCalls` to narrow a replay.

## Promoted regression specs

`trace_promote` separates evidence from a durable regression contract. The generated JSON carries
`format: "stagewright-replay"`, `version: 1`, stable session placeholders, normalizers for session
ids/timestamps/absolute paths, and one explicit `{ ok }` checkpoint per selected call. It does not
copy arbitrary result payloads from the diagnostic trace. Reviewers can add a result matcher only
where a behavior matters: `exact`, `subset`, `regex`, or `ignore`, with optional numeric tolerance
for exact/subset comparisons. Unsafe nested-quantifier regexes are refused by the runner.

### Parameters (version 2)

A spec that runs the same flow for several inputs (each language, theme or window size) declares
typed parameters and uses `{ "$param": "<name>" }` as a whole JSON value inside step `args` or an
`exact` / `subset` matcher value. Nothing else can be parameterized: no string interpolation, no
dynamic keys, no tool names or control flow. A matrix runs one spec per value set.

```json
{
  "format": "stagewright-replay",
  "version": 2,
  "parameters": {
    "language": { "type": "string", "enum": ["en", "es"], "default": "en" },
    "dump": { "type": "path", "description": "SQL file to import" },
    "apiToken": { "type": "string", "sensitive": true }
  },
  "steps": [
    {
      "tool": "storage_local_set",
      "args": { "key": "language", "value": { "$param": "language" } },
      "expect": { "ok": true }
    }
  ]
}
```

Types are `string` (`enum`, `pattern`, `minLength`, `maxLength`), `number` and `integer` (`enum`,
`minimum`, `maximum`), `boolean`, and `path` (absolute; on Windows with a drive letter or UNC
share). Every check runs before the first step: a placeholder without a declared parameter, a
declared parameter no step uses, or an invalid default is a malformed spec (exit `2`); an unknown,
missing or invalid supplied value is invalid usage (exit `64`, error code `INVALID_PARAMETERS`).
A `sensitive` parameter is `[redacted]` by name in the report's `parameters`; in expected and actual
values any leaf equal to it is redacted, and a sensitive string of four or more characters is also
redacted inside longer text. When the trace plugin is loaded the runner adds the argument names that
carry it to the trace `redact` list.
The report lists the values a run used under `parameters`.

## Headless replay

The package also ships `electron-stagewright-replay`, a standalone CI runner for a committed
specification. It starts a fresh core server, runs the declared `electron_launch` step and later
steps through the normal dispatcher, then always closes the server:

```sh
electron-stagewright-replay tests/regressions/greeting.replay.json --json
```

`--json` writes exactly one `stagewright-replay-report` object to stdout; diagnostics stay on
stderr. Its exit codes distinguish a checkpoint mismatch (`1`), malformed spec (`2`), failed app
launch (`3`), infrastructure failure (`4`), and invalid CLI usage (`64`). It accepts
`--include` / `--exclude`, `--plugin` / `--plugin-config`, `--allow-eval`, `--app-root`,
`--operation-timeout-ms`, and `--tool-profile` where a spec needs the same core configuration as
an MCP run. Filtered execution retains the session creator required by a selected later step.
Supply parameter values with `--param name=value` (repeatable), `--params-file values.json` (a
JSON object), and `--param-env name=ENV_VAR` for secrets; later sources win in that order.

On Linux CI, run Electron under Xvfb and preserve the JSON report even when its non-zero exit code
correctly fails the job:

```yaml
- name: Replay Electron regression
  run: xvfb-run --auto-servernum electron-stagewright-replay tests/regressions/greeting.replay.json --json > replay-report.json

- name: Upload replay report
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: replay-report
    path: replay-report.json
```

## Offline viewer

`trace_view` renders a written artifact to a **single self-contained HTML file** — inline CSS and
JS, no external assets, no CDN, no server. Open it by double-clicking; it works offline and is
easy to attach to a bug report. The report shows summary cards (calls, ok/error counts, total
estimated tokens), a token-budget bar when the trace was budgeted, the largest-response and
per-tool token tables, and an expandable timeline of every call with its args and result. A small
inline script adds tool-name filtering and expand/collapse-all, but the report is fully readable
without JS (it uses native `<details>`). Every captured value is HTML-escaped on render, so a
trace that captured markup or script-like text cannot inject it into the report.

## Privacy

A trace captures tool inputs and outputs, which can include typed text or evaluated code. It is
opt-in (records only between `trace_start` and `trace_stop`) and writes to a path you choose —
the same trust model as screenshots and console logs. Use the `redact` config to drop sensitive
argument fields.
