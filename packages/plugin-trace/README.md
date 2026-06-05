# @electron-stagewright/plugin-trace

Record a driving session to a portable artifact, see where the token budget went, enforce a
budget, and replay the session against a fresh app instance. The first session-observing plugin
(ADR-009, built on the ADR-004 plugin contract): between `trace_start` and `trace_stop` it
subscribes to the server's dispatch-observer seam and captures every tool call — input, output
envelope, timing, and token estimate — to a JSONL file, then `trace_tokens` summarises the cost
and `trace_replay` re-dispatches the calls. Give a recording a `budgetTokens` to track spend
live, and `enforce` to block over-budget calls.

A visual viewer is forthcoming.

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
  OS temp dir). With `budgetTokens`, track an estimated-token budget; with `enforce:true`, also
  block over-budget calls (`trace.BUDGET_EXCEEDED`). Returns `{ recording, path, budget? }`. The
  plugin's own `trace_*` calls are not recorded (and never blocked by enforcement).
- **`trace_stop`** — flush the artifact and return `{ path, records, total_estimated_tokens,
overflowed, budget? }`.
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

Error codes: `trace.ALREADY_RECORDING`, `trace.NOT_RECORDING`, `trace.ARTIFACT_NOT_FOUND`,
`trace.ARTIFACT_INVALID`, `trace.ARTIFACT_WRITE_FAILED`, `trace.BUDGET_EXCEEDED`.

## Config

`trace` plugin config (all optional):

- **`dir`** — default directory for artifacts when `trace_start` gets no `path`/`dir`.
- **`maxRecords`** — cap on buffered call records (default 10000); later calls are dropped and
  `overflowed` is reported.
- **`redact`** — argument property names to replace with `"[redacted]"` before recording.
- **`budgetTokens`** — default estimated-token budget when `trace_start` gets no `budgetTokens`.
- **`enforceBudget`** — when true, budgeted recordings block over-budget calls (default false).
- **`warnThreshold`** — fraction of the budget (`0 < warnThreshold <= 1`) at which `near_budget`
  trips (default 0.8).

## Token budget

Pass `budgetTokens` to `trace_start` (or set the `budgetTokens` config default) to track an
estimated-token budget. `trace_status`, `trace_tokens`, `trace_budget`, and `trace_stop` then carry
a `budget` object: `{ budget_tokens, spent, remaining, over_budget, near_budget, warn_threshold }`.
`spent` is exact even when the record buffer overflows (`maxRecords`) — dropped calls still count.

By default the budget is advisory: an agent polls `trace_budget` and self-limits. Set `enforce:true`
(or the `enforceBudget` config) to additionally BLOCK calls once over budget — the dispatcher vetoes
each subsequent non-`trace_*` call with `trace.BUDGET_EXCEEDED` (carrying `next_actions`). The trace
plugin's own tools are never blocked, so an over-budget agent can always call `trace_stop` to
recover. The call that tips the budget over still runs (its cost is unknown until it does);
everything after it is blocked. Token counts are estimates (char/4, per the core error registry).

## Artifact format

JSONL, schema version 1. The first line is a `meta` record (`{ v, kind: "meta", started_at,
core_version, overflowed }`, plus `budget`, `warn_threshold`, and exact `spent` when the recording
had a budget); each subsequent line is a `call` record (`{ kind: "call", tool, ok, code?,
started_at, finished_at, elapsed_ms, estimated_tokens, args, result }`). Records are buffered in
memory and written on `trace_stop`, so a crash before stop loses the buffer (streaming is a
forthcoming improvement).

## Replay limits

Replay is deterministic only for traces whose arguments remain meaningful in a fresh app run.
`trace_replay` automatically remaps session ids created by `electron_launch` / attach-style
calls, but it cannot reconstruct values removed by `redact`: a redacted argument such as
`"[redacted]"` is replayed exactly as recorded and may diverge. Use `dryRun` to check schema
drift without launching an app, and `include` / `exclude` / `maxCalls` to narrow a replay.

## Privacy

A trace captures tool inputs and outputs, which can include typed text or evaluated code. It is
opt-in (records only between `trace_start` and `trace_stop`) and writes to a path you choose —
the same trust model as screenshots and console logs. Use the `redact` config to drop sensitive
argument fields.
