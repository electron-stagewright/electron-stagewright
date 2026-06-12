# Capture diagnostics

Evidence-gathering for debugging a flow or attaching artifacts to a bug report: screenshots,
console output, native dialogs, and full session traces.

## Screenshots

```json
electron_screenshot { "dir": "/abs/artifacts/dir" }
electron_screenshot { "ref": 4, "format": "jpeg", "quality": 80 }
```

The image is written on the server host and the call returns its absolute `path` (plus `bytes`,
`width`/`height`) — bytes are never inlined into the protocol. Aim captures three ways: the whole
targeted window (default; `windowId` / `windowTitle` / `windowIndex` select among multiple),
`fullPage` for the entire scrollable page, or a single element via `ref` / `selector`. For a
stable artifact location, pass `dir` per call or start the server with `--screenshot-dir <dir>` —
otherwise files land in the OS temp directory.

## Console logs

```json
electron_console_logs { "type": ["warning", "error"], "match": "ipc", "limit": 100 }
```

Renderer console output is captured continuously from session start — including windows the app
opens later; each entry carries the originating window's id, so multi-window output stays
attributable. Filters compose (ANDed): `type` (level or list of levels), `match` (a regex over the
text), `since` (epoch ms), `limit` (most recent kept). The response's `overflowed` field counts
entries the ring buffer dropped, so "nothing matched" and "it scrolled away" are distinguishable.

## Native dialogs

Dialogs (`alert` / `confirm` / `prompt` / `beforeunload`) block the renderer, so an unhandled one
freezes every later call. The default policy is therefore **dismiss** from session start — nothing
hangs — and `electron_dialog_handler` both arms a different policy and reads back what fired:

```json
electron_dialog_handler { "action": "dismiss", "perType": { "confirm": "accept" }, "oneShot": true }
electron_dialog_handler { "type": "confirm", "limit": 10 }
```

Arming args: `action` (the default for every dialog), `perType` overrides, `promptText` (submitted
when an accepted `prompt()` fires), `oneShot` (apply to exactly the next dialog, then revert to
dismiss — so a lingering `accept` can never silently confirm a destructive dialog you did not
anticipate). A call with no arming args is inspect-only. Every handled dialog is recorded —
`type`, `message`, the `action` taken, timestamps — whether or not you were watching at the time.

## Session traces — the flight recorder

Load the trace plugin to record every tool call of a session into a portable artifact:

```sh
node packages/core/dist/cli.js --plugin @electron-stagewright/plugin-trace
```

```json
trace_start { "dir": "/abs/traces" }
… the session you want recorded …
trace_stop {}
trace_view { "path": "/abs/traces/<artifact>.jsonl" }
```

- **`trace_start`** begins recording (JSONL artifact: a meta header plus one record per dispatch —
  arguments, result envelope, timing, token estimate; sensitive values can be redacted via plugin
  config). Optional `budgetTokens` + `enforce` turn the trace into a live token budget: advisory
  by default, vetoing over-budget calls when enforced.
- **`trace_status`** / **`trace_tokens`** / **`trace_budget`** — is it recording, where, how many
  records; per-tool token totals and the largest responses; a cheap budget poll.
- **`trace_stop`** flushes and returns the artifact path plus a token report.
- **`trace_view`** renders the artifact to a single self-contained HTML file — summary cards, a
  token-budget bar, per-tool tables, an expandable timeline — openable anywhere, no server.
- **`trace_replay`** re-dispatches a recorded session against a fresh app instance (session ids
  remapped automatically) and judges each step on its stable outcome — the regression-check
  companion: record once, replay after the change.

The token accounting exists because the trace's first consumer is an agent operating under a
context budget: it shows which tools cost the most before the budget bites.

## The artifact, not the app

When the thing to diagnose is a **packaged build** rather than a running session — signing,
notarization, update feed, crash machinery — that is `production_validate` from
`@electron-stagewright/plugin-production`; see the [tool reference](../../TOOL-REFERENCE.md) and
the plugin's README.

---

_Design background: dialog auto-response defaults and console-buffer semantics follow ADR-007;
the trace artifact format, replay, and the dispatch-observer seam are ADR-009; production
validation is ADR-012._
