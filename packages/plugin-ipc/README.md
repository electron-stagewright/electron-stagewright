# @electron-stagewright/plugin-ipc

Capture, invoke, and stub Electron IPC for agent-driven testing. The agent's other tools see the
DOM; this one sees the renderer↔main `ipcMain` traffic the DOM hides. The first transport-eval
plugin (ADR-010, built on the ADR-004 plugin contract): it instruments the main process through the
session transport's `evaluate('main', …)` seam, wrapping `ipcMain.handle` for an explicit channel
allowlist.

## Load it

IPC instrumentation runs main-process JavaScript, so the server must run with **`--allow-eval`**:

```sh
node packages/core/dist/cli.js --plugin @electron-stagewright/plugin-ipc --allow-eval

# Configure (optional): redacted arg fields, captured-event cap:
node packages/core/dist/cli.js --plugin @electron-stagewright/plugin-ipc --allow-eval \
  --plugin-config ipc='{"redact":["token"],"maxEvents":5000}'
```

Programmatically:

```js
import { createServer } from '@electron-stagewright/core'
import ipcPlugin from '@electron-stagewright/plugin-ipc'

const server = await createServer({
  plugins: [ipcPlugin],
  allowEval: true,
  pluginConfigs: { ipc: { redact: ['token'] } },
})
```

## Tools

The loader namespaces each tool under the plugin name `ipc`:

- **`ipc_capture_start`** `{ channels, captureSend?, sessionId? }` — start recording calls to the
  ipcMain channels in `channels` (an explicit allowlist — only these are captured). `captureSend`
  also records fire-and-forget on/send messages (default: invoke/handle only). Returns
  `{ capturing, channels }`.
- **`ipc_captured`** `{ channel?, sessionId? }` — return the captured calls, optionally filtered to
  one channel. Each event is `{ channel, type (invoke|send), args, ok, ms, ts, error? }`; configured
  `redact` fields are stripped from `args`. Returns `{ count, events }`.
- **`ipc_capture_stop`** `{ sessionId? }` — stop the capture and restore the app's original ipcMain
  handlers. Returns `{ stopped, events }`.
- **`ipc_invoke`** `{ channel, args?, timeoutMs?, sessionId? }` — call a registered `ipcMain.handle`
  channel from the main process (driving the request the renderer would send) and return its result.
  `timeoutMs` bounds a hung handler. Returns `{ channel, result }`.
- **`ipc_stub`** `{ channel, response, sessionId? }` — make a captured channel's handler return
  `response` instead of running the app's handler, for the duration of the capture. The channel must
  be in the active allowlist; cleared when `ipc_capture_stop` restores the originals.

Error codes: `ipc.EVAL_REQUIRED`, `ipc.MAIN_EVAL_UNSUPPORTED`, `ipc.ALREADY_CAPTURING`,
`ipc.NOT_CAPTURING`, `ipc.CHANNEL_NOT_ALLOWED`, `ipc.INVOKE_FAILED`.

## Config

`ipc` plugin config (all optional):

- **`redact`** — argument property names to replace with `"[redacted]"` in captured events.
- **`maxEvents`** — cap on buffered captured events (default 1000); later calls are dropped.
- **`invokeAllow`** — optional allowlist of channels `ipc_invoke` may target. Omit for unrestricted
  invoke (the default); set to `[]` to block all invoke; set to a list to bound it. Independent of
  the capture/stub allowlist.

## Security

Capture, invoke, and stub all execute JavaScript in the app's main process via the transport's eval
seam. They are gated by the eval opt-in plus channel allowlists:

- **The server's eval opt-in (`--allow-eval`).** Without it, every instrumentation tool returns
  `ipc.EVAL_REQUIRED` — the same gate the core eval tools sit behind. This applies to capture,
  invoke, and stub alike.
- **An explicit channel allowlist for capture and stub.** `ipc_capture_start` requires at least one
  channel; only those channels are wrapped, recorded, or stubbable. There is no "capture
  everything".
- **An optional allowlist for invoke.** `ipc_invoke` is unrestricted by default — it names its
  channel per call (the agent's explicit choice) and is no more powerful than `electron_eval_main`,
  which `--allow-eval` already permits. For defense-in-depth, set the `invokeAllow` config to bound
  it: when present, `ipc_invoke` refuses any channel outside the list — `undefined` (omitted) means
  unrestricted, `[]` means block all invoke, and a list means only those channels.

This is the same trust model as the eval tools: a first-party, in-process plugin (ADR-004) the
operator chose to load, with per-channel capture/stub allowlists and an optional invoke allowlist.
Captured `args` can include IPC payloads; use `redact` to drop sensitive fields before they reach
the agent.

## Scope and limitations

- **invoke/handle is the primary surface.** Capture wraps `ipcMain.handle` (request-response).
  `captureSend` additionally records `ipcMain.on` (fire-and-forget) messages — both listeners
  registered after capture starts AND those already registered for an allowlisted channel (re-wrapped
  on start, parity with the handle re-wrap). On stop, every wrapped `on` listener is detached and the
  app's original is restored, so capture leaves no recording residue (matching invoke/handle, whose
  originals are fully restored too). Pre-existing `ipcMain.once` listeners are left intact — only
  `on` listeners are re-wrapped — so their one-shot behaviour is never changed, at the cost of not
  capturing them.
- **Re-wrapping already-registered handlers is best-effort.** It uses Electron's internal handler
  map; handlers registered AFTER `ipc_capture_start` are always wrapped, and the gated smoke covers
  re-wrapping a handler registered at app startup.
- **`ipc_invoke` drives a registered handler from main** — it needs a handler to exist on the
  channel (otherwise `ipc.INVOKE_FAILED`); it does not synthesise a renderer.
- **One capture per session.** Each running app session captures, reads, stubs, and stops its IPC
  independently and concurrently; starting or stopping one never disturbs another. Pass `sessionId`
  to target a specific app when more than one is running (omitting it with several live sessions
  returns `BAD_ARGUMENT`). The capture registry and config are process-global, like other first-party
  plugins, so run independent server lifecycles in separate Node processes; within one server,
  session-id keying keeps concurrent captures from colliding. Requires a transport with main-process
  eval (Playwright Electron); others return `ipc.MAIN_EVAL_UNSUPPORTED`.
