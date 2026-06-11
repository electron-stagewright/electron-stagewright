# ADR-009: Trace artifact format and dispatch-observer seam

Status: Accepted (capture + token report + replay + token budget + offline viewer all shipped)

## Context

The server can drive an app but cannot record what it did. An agent (or a human debugging one)
has no portable record of which tools ran, in what order, with what inputs and outputs, or
where the token budget went. The trace capability is the first product differentiator and the
first genuine consumer of the plugin model (ADR-004): it must observe the WHOLE session, not
just add isolated tools. Two new decisions are needed — how a plugin observes every tool call,
and what the recorded artifact looks like.

## Decision

### 1. A dispatch-observer seam on the dispatcher

The dispatcher (ADR-008) gains a set of best-effort observers. After every `dispatch()`
resolves — success, validation failure, or unknown tool — it notifies each observer exactly
once, through a single internal funnel, with a `DispatchRecord`:

```
{ tool, args, result, startedAt, finishedAt }
```

`args` is the parsed input (or the raw input when validation failed); `result` is the exact
agent-facing envelope (so `estimated_tokens` is read from `result._meta`). Observers register
via `Dispatcher.addObserver(observer): () => void` (returns an unsubscribe), also surfaced to
tool handlers as `ToolContext.addDispatchObserver` so a plugin tool (e.g. `trace_start`) can
attach a sink without the core depending on the plugin.

Observers are **best-effort and must not throw**: a throw is caught and logged, never
propagated to the agent (same contract as the transport's console/dialog listeners). With zero
observers the funnel is a single `size > 0` check — no per-call overhead.

### 2. The trace artifact is JSONL, schema version 1

One JSON record per line. The first line is a `meta` header; each subsequent line is a `call`:

```
{ "v": 1, "kind": "meta", "started_at", "core_version" }
{ "kind": "call", "tool", "ok", "code"?, "started_at", "finished_at", "elapsed_ms",
  "estimated_tokens", "args", "result" }
```

JSONL was chosen over zstd/protobuf/OpenTelemetry: it is append-friendly, human-readable, and
parses with `JSON.parse` per line — no dependency, no schema compiler. The explicit `v` lets
replay, budget metadata, and viewer features evolve the shape compatibly.

### 3. Trace is a plugin, recording is opt-in

Per the lean-core thesis (ADR-007), trace ships as `@electron-stagewright/plugin-trace`, not
core. It records only between `trace_start` and `trace_stop`, to an operator-chosen path, and
skips its own `trace_*` calls. Records are buffered in memory (bounded by `maxRecords`) and
written on stop, so the observer stays a cheap array push on the dispatch hot path; a crash
before stop loses the buffer (streaming is a forthcoming improvement).

## Rationale

- A core observer seam is the only way a plugin can see other tools' calls; making it a plugin
  keeps the lean-core tool surface intact while proving plugins can be session-wide.
- Recording all outcomes (including errors) makes a trace a faithful session record.
- Token reporting reads `_meta.estimated_tokens`, already computed per envelope (ADR-006), so
  the report needs no new measurement.

## Alternatives considered

- **Wrap each tool handler** instead of an observer — plugins only add tools; they cannot wrap
  core tools, and a wrapper would not see validation failures (which fail before the handler).
- **Stream each record to disk** — more crash-durable but blocks the dispatch path or needs an
  ordered async queue; deferred behind the in-memory buffer + cap.
- **Binary/OTel artifact** — heavier dependency and tooling than the debugging use case needs.

## Consequences

- `ToolContext` gains `addDispatchObserver`; `DispatchRecord` / `DispatchObserver` are public.
- A trace captures inputs/outputs that may contain sensitive data (typed text, eval payloads).
  It is opt-in and operator-pathed (same trust model as screenshots/logs); a `redact` config
  drops named argument fields. Broader redaction/sandboxing is a forthcoming follow-up.
- The initial plugin surface ships `trace_start`, `trace_stop`, `trace_tokens`, `trace_status`.
  Replay, budget reporting, and the visual viewer extend that surface compatibly.

## Related decisions

- ADR-004 (plugin model) — the contract the trace plugin is built on.
- ADR-006 (error code registry) — `estimated_tokens` and the namespaced `trace.*` error codes.
- ADR-008 (server and tool dispatcher) — the dispatch path the observer seam funnels through.

## References

- `packages/core/src/server/dispatcher.ts` — observer set, `addObserver`, the `#complete` funnel.
- `packages/core/src/tools/types.ts` — `DispatchRecord`, `DispatchObserver`, the ctx seam.
- `packages/plugin-trace/` — the plugin, recorder (JSONL + token summary), and tests.

## Status Update (2026-06-04) — the seam becomes bidirectional; `trace_replay`

The original seam made plugins OBSERVE every dispatch. Replay needs the inverse — to RE-DISPATCH
recorded calls — so the seam gains an active half:

- `ToolContext.dispatch(tool, args): Promise<ToolResult>` re-dispatches a tool through the same
  dispatcher (full Zod validation, operation-type routing, session context, observer notification),
  and `ToolContext.validate(tool, args): ErrorResponse | null` checks a call against the current
  schema WITHOUT running the handler. Both are wired by the dispatcher; the core still does not
  depend on the plugin.
- **Bounded recursion.** Re-dispatch depth is tracked in an `AsyncLocalStorage<number>` (per
  async chain, so concurrent dispatches never share a counter); past `MAX_REDISPATCH_DEPTH = 1` a
  re-dispatch returns `BAD_ARGUMENT` instead of recursing. A tool may drive other tools (replay at
  depth 0, its calls at depth 1); a re-dispatched tool may not re-dispatch again.
- **`trace_replay`** reads an artifact and re-dispatches each `call` in order. The crux is
  **session-id remapping**: the recorded run's session ids are defunct, so the engine keeps a
  `recorded → new` map (learned from each result's `_meta.session_id`) and rewrites each call's
  `sessionId` arg before dispatch. Divergence is judged on the STABLE outcome (`ok` + error `code`),
  not the full envelope (payloads vary run-to-run); each diverged call carries a bounded,
  size-capped field-level diff. `dryRun` re-validates against current schemas without dispatching
  (detects a tool whose signature drifted since recording). A trace recorded with `redact` cannot
  be faithfully replayed — redacted args diverge — which the tool reports rather than hides.
- The "replay a deterministic minimal-app session" acceptance criterion lands here, proven by a
  gated real-Electron smoke (record launch→snapshot→click→stop, then replay with all matched).
- Still forthcoming at this point in the decision history: the visual offline viewer and
  token-budget enforcement.

New references: `packages/plugin-trace/src/replay.ts` (engine); `ToolContext.dispatch` / `validate`
and the `REDISPATCH_DEPTH` guard in `dispatcher.ts`.

## Status Update (2026-06-04) — token budget + a pre-dispatch guard seam

The trace plugin gains a token budget, and the dispatch seam gains a third capability — a
pre-dispatch VETO — alongside observe and re-dispatch:

- **`ToolContext.addDispatchGuard(guard)`** registers a `DispatchGuard` that runs for every
  dispatch BEFORE the handler (after validation + operation-type routing). Returning a `ToolResult`
  vetoes the call (handler never runs; the envelope is returned and observers still see it via
  `#complete`); returning `null` allows it. Guards run in registration order, first veto wins, and
  a throwing guard is caught, logged, and treated as allow (**fail-open** — a guard bug must never
  wedge the tool surface). This is the active-enforcement counterpart to the observe-only seam.
- **Budget.** `trace_start` accepts `budgetTokens` (+ `warnThreshold`, default 0.8); the recorder
  tracks exact `spent` — counted BEFORE the record-cap drop, so an overflowed trace still reports
  the true total — and exposes `budgetStatus()` (`{ budget_tokens, spent, remaining, over_budget,
near_budget, warn_threshold }`). The budget (and exact spent) persist in the JSONL `meta` header
  (additive optional fields; format version stays 1). `trace_status`, `trace_tokens`, the new
  `trace_budget`, and `trace_stop` all surface the nested `budget` object.
- **Enforcement is opt-in.** By default the budget is advisory (report only; the agent polls
  `trace_budget` and self-limits). `trace_start({ enforce: true })` (or the `enforceBudget` config)
  registers a guard that vetoes over-budget calls with the new `trace.BUDGET_EXCEEDED` (http 429,
  not retryable, carries `next_actions`). The guard skips `trace_*` so an over-budget agent can
  always `trace_stop` to recover; the call that tips the budget over still runs (its cost is
  unknown beforehand), everything after it is blocked. The guard is released on stop + teardown.
- Still forthcoming: the visual offline viewer.

New references: `DispatchGuard` / `DispatchGuardCall` / `ToolContext.addDispatchGuard` and the
`#guards` set in `dispatcher.ts`; `BudgetStatus` / `budgetStatusOf` and budget tracking in
`packages/plugin-trace/src/recorder.ts`.

## Status Update (2026-06-06) — the offline viewer

The last forthcoming piece — a visual viewer — ships as `trace_view`. The format decision the
original scope left open ("viewer format chosen before implementation") is resolved as a
**single self-contained HTML document**: inline CSS and JS, no external assets, no CDN, no
runtime server, no build step. The operator opens it by double-clicking; it works fully offline
and is trivial to attach to a bug report. This was chosen over a hosted/served viewer (needs a
process and a port), a framework SPA (build step + bundle), or a terminal viewer (not shareable)
because a trace is a _portable_ record — the viewer should be as portable as the artifact.

- **`trace_view({ path, out? })`** reads a written artifact (the shared `loadTrace` helper, so a
  missing file → `trace.ARTIFACT_NOT_FOUND`, malformed JSONL → `trace.ARTIFACT_INVALID`), renders
  it, and writes the HTML (a write failure → the existing `trace.ARTIFACT_WRITE_FAILED`). With no
  `out`, the report is written next to the trace with a `.html` extension. The render is a pure
  function (`renderTraceHtml(parsed, { generatedAt? })`), so it is unit-tested without disk I/O,
  and the generation timestamp is injected for deterministic output.
- The report shows summary cards (calls, ok/error, total estimated tokens), a token-budget bar
  when the trace carries a budget, the largest-response and per-tool token tables (reusing
  `summarizeTrace`), and an expandable timeline of every call (native `<details>`, so it is
  readable with JS disabled). A small fixed inline script adds tool-name filtering and
  expand/collapse-all as progressive enhancement.
- **SECURITY.** A trace captures arbitrary tool inputs/outputs (typed text, eval payloads, app
  content), so every dynamic value is HTML-escaped on render (text AND attribute values). The
  inline script is a fixed constant with no trace data interpolated into it, so it adds no
  injection surface. A unit test asserts a captured `<img onerror=…>` / `</script>` payload is
  escaped rather than emitted as live markup.

New references: `packages/plugin-trace/src/viewer.ts` (`renderTraceHtml` / `escapeHtml`); the
`trace_view` tool in `packages/plugin-trace/src/index.ts`.
