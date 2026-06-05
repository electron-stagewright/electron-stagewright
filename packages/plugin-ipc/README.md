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

## Security

Capture, invoke, and stub all execute JavaScript in the app's main process via the transport's eval
seam. They are gated two ways:

- **The server's eval opt-in (`--allow-eval`).** Without it, every instrumentation tool returns
  `ipc.EVAL_REQUIRED` — the same gate the core eval tools sit behind. This applies to capture,
  invoke, and stub alike.
- **An explicit channel allowlist for capture and stub.** `ipc_capture_start` requires at least one
  channel; only those channels are wrapped, recorded, or stubbable. There is no "capture
  everything". `ipc_invoke` names its channel per call (the agent's explicit choice) rather than a
  pre-set allowlist — it is no more powerful than `electron_eval_main`, which `--allow-eval` already
  permits.

This is the same trust model as the eval tools: a first-party, in-process plugin (ADR-004) the
operator chose to load, with a per-channel allowlist on capture/stub. Captured `args` can include
IPC payloads; use `redact` to drop sensitive fields before they reach the agent.

## Scope and limitations

- **invoke/handle is the primary surface.** Capture wraps `ipcMain.handle` (request-response).
  `captureSend` additionally records `ipcMain.on` (fire-and-forget) messages. On stop, the patched
  `ipcMain.on` method is restored and the `handle` originals are re-registered, but `on` listeners
  wrapped during the capture window are not individually detached — they keep forwarding to the app
  and are released when the app stops. (Invoke/handle has no such residue; its originals are fully
  restored.) Removing wrapped `on` listeners on stop is a forthcoming refinement of the opt-in path.
- **Re-wrapping already-registered handlers is best-effort.** It uses Electron's internal handler
  map; handlers registered AFTER `ipc_capture_start` are always wrapped, and the gated smoke covers
  re-wrapping a handler registered at app startup.
- **`ipc_invoke` drives a registered handler from main** — it needs a handler to exist on the
  channel (otherwise `ipc.INVOKE_FAILED`); it does not synthesise a renderer.
- **One capture per process at a time** (v1), like the trace plugin. Requires a transport with
  main-process eval (Playwright Electron); others return `ipc.MAIN_EVAL_UNSUPPORTED`.
