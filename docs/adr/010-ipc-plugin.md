# ADR-010: IPC capture/invoke/stub plugin via main-process instrumentation

Status: Accepted (capture + invoke + stub; multi-session; send/on capture opt-in)

## Context

An agent driving an Electron app through Stagewright sees the DOM (snapshot, find, read, interact)
but not the renderer↔main IPC traffic underneath it. "Did clicking Save fire the `save-file` IPC
with the right payload?" is unanswerable from the DOM alone. IPC capture/invoke/stub is the second
differentiation plugin (after trace), and the first to need to run code in the MAIN process rather
than a renderer.

Two questions had to be settled before building it: HOW a plugin reaches `ipcMain` (it is not a DOM
surface), and what SECURITY posture gates that reach.

## Decision

### 1. The plugin instruments the main process through the transport's eval seam

`@electron-stagewright/plugin-ipc` drives the main process via the session transport's
`evaluate('main', body, arg)` — the same method the core `electron_eval_main` tool uses. A single
self-contained body (`INSTRUMENT_BODY`, no imports / no closures over module scope — the snapshot
walker's constraint) dispatches on `arg.op` over a persistent `globalThis.__swIpc` state:

- **install** — wraps `ipcMain.handle` so a call to an allowlisted channel is recorded
  (`{ channel, type, args, ok, ms, ts }`); re-wraps already-registered handlers best-effort via the
  internal `_invokeHandlers` map; optionally wraps `ipcMain.on` for fire-and-forget capture.
- **read / stop** — return the buffered events; restore every wrapped handler and the patched
  methods on stop.
- **invoke** — call a registered handle channel from main (driving the renderer's request), bounded
  by an optional timeout.
- **stub** — make an allowlisted channel's handler return a canned value for the capture's duration.

The plugin keeps the orchestration (allowlist enforcement, per-session capture state, redaction,
error envelopes) in TypeScript and the main-process mutation in the body string.

### 2. Gated by the eval opt-in AND an explicit channel allowlist

Main-process eval is powerful, so the instrumentation tools are gated twice:

- **`--allow-eval`** — without the server's eval opt-in, every IPC tool returns `ipc.EVAL_REQUIRED`.
  The transport's `evaluate` does NOT itself pass through the `--allow-eval` _tool_ gate (that gate
  hides the `electron_eval_*` tools, not the transport method), so the plugin enforces the same gate
  at the tool boundary via `ctx.allowEval`.
- **An explicit channel allowlist** — `ipc_capture_start` requires at least one channel; only
  allowlisted channels are wrapped, captured, stubbed, or recorded. There is no capture-everything.

This is the trust model of the eval tools (a first-party, in-process plugin the operator chose to
load) plus a per-channel boundary. The `redact` config drops named arg fields before captured
payloads reach the agent.

## Rationale

- Reusing `evaluate('main')` avoids a new transport contract method for IPC — the seam already
  exists, is capability-flagged (`supportsMainEval`), and is the honest place this power lives.
- Wrapping `ipcMain.handle` at install + re-wrapping the internal map covers both handlers
  registered after capture starts and those registered at app startup (the gated smoke proves the
  latter).
- The double gate (eval flag + allowlist) keeps the blast radius explicit and operator-controlled.

## Alternatives considered

- **A dedicated transport IPC API** (e.g. `transport.ipcCapture(...)`) — heavier contract surface
  across every transport for a capability only the Playwright transport can serve today; the eval
  seam already expresses it.
- **A separate `--allow-ipc` flag** instead of reusing `--allow-eval` — more flags for the same
  underlying capability (arbitrary main-process JS). Folding it under the existing eval opt-in keeps
  one switch for "this server may run app-process code."
- **Capturing all channels** — rejected; an allowlist is the security boundary the scope demands.

## Consequences

- New package `@electron-stagewright/plugin-ipc` with `ipc_capture_start`/`ipc_captured`/
  `ipc_capture_stop`/`ipc_invoke`/`ipc_stub` and namespaced `ipc.*` error codes.
- A plugin reaching `transport.evaluate('main')` bypasses the `--allow-eval` _tool_ gate, so any
  such plugin MUST re-assert the gate at the tool boundary (this plugin checks `ctx.allowEval`).
  Captured payloads may contain sensitive data; `redact` mitigates, same as the trace plugin.
- Re-wrapping existing handlers depends on Electron's internal `_invokeHandlers` map — guarded, with
  a documented limitation if a future Electron changes it.
- One capture per session: concurrent app sessions capture independently, keyed by the unique
  session id. Every op resolves its session first, then looks up that session's capture — so a
  read/stop/stub cannot bleed across sessions, and the single-active-capture guard the first cut
  needed is gone. The capture registry and config are module-level, so co-resident servers in the
  same Node process still share plugin lifecycle/config; run fully independent server lifecycles in
  separate processes. `send/on` capture is opt-in; richer renderer-initiated capture is a forthcoming
  extension.

## Related decisions

- ADR-004 (plugin model) — the contract + in-process trust model this plugin is built on.
- ADR-006 (error code registry) — the namespaced `ipc.*` codes.
- ADR-009 (dispatch seam) — the sibling first-party plugin (trace) and the eval-tool gating context.

## References

- `packages/plugin-ipc/src/instrument.ts` — `INSTRUMENT_BODY` shim + pure `filterEvents`/`redactEvents`.
- `packages/plugin-ipc/src/index.ts` — the tools, allowlist + eval gate, per-session capture state.
- `packages/plugin-ipc/tests/` — pure-helper unit, simulated-main e2e, gated real-Electron smoke.
