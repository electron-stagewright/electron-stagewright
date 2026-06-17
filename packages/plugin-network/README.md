# @electron-stagewright/plugin-network

Capture an Electron app's renderer request/response traffic by URL for agent-driven testing. The
agent's other tools see the DOM; this one sees the network calls the app makes underneath — which
endpoints, what status, how long — so a flow can be debugged or a call asserted (ADR-016, built on
the ADR-004 plugin contract).

Unlike the IPC plugin, network capture rides a dedicated **transport seam**, not main-process eval —
so it does **not** require `--allow-eval`. Capture observes; request stubbing (the modify half) and
CDP-transport coverage are deferred follow-ups.

## Load it

```sh
node packages/core/dist/cli.js --plugin @electron-stagewright/plugin-network

# Configure (optional): redact extra headers, or keep the secure defaults verbatim:
node packages/core/dist/cli.js --plugin @electron-stagewright/plugin-network \
  --plugin-config network='{"redactHeaders":["x-api-key"]}'
```

Programmatically:

```js
import { createServer } from '@electron-stagewright/core'
import networkPlugin from '@electron-stagewright/plugin-network'

const server = await createServer({
  plugins: [networkPlugin],
  pluginConfigs: { network: { redactHeaders: ['x-api-key'] } },
})
```

## Tools

The loader namespaces each tool under the plugin name `network`:

- **`network_capture_start`** `{ urls, methods?, sessionId? }` — start recording the renderer
  requests whose URL contains any entry in `urls` (an explicit allowlist — only matching requests are
  captured; there is no capture-everything). Optionally restrict to `methods` (case-insensitive).
  Captures metadata + headers only (no bodies). Returns `{ capturing, urls, methods? }`.
- **`network_captured`** `{ clear?, sessionId? }` — return the events captured so far. Each event is
  `{ method, url, resourceType?, status?, ok?, requestHeaders?, responseHeaders?, failure?,
durationMs?, timestamp, windowId? }`; configured redact headers are stripped. `clear:true` flushes
  the buffer after reading. Returns `{ count, events, overflowed }` (`overflowed` is how many older
  entries the capped ring dropped).
- **`network_capture_stop`** `{ sessionId? }` — stop the capture and clear its buffer. Returns
  `{ stopped, events }`.

Error codes: `network.UNSUPPORTED`, `network.ALREADY_CAPTURING`, `network.NOT_CAPTURING`.

## Config

`network` plugin config (all optional):

- **`redactHeaders`** — extra request/response header names to replace with `"[redacted]"`
  (case-insensitive), beyond the secure defaults.
- **`redactSecureDefaults`** — when `true` (the default), `authorization`, `cookie`, and `set-cookie`
  are redacted before any event reaches the agent. Set `false` to capture them verbatim.

## Security

Captured headers can carry secrets — auth tokens, cookies, API keys. The plugin limits that surface:

- **Capture is opt-in and bounded to an explicit URL allowlist.** `network_capture_start` requires at
  least one URL substring; only matching requests are recorded. There is no capture-everything.
- **Bodies are not captured.** This increment records request/response metadata and headers only, so
  a captured payload never carries a request or response body.
- **Secret headers are redacted by default.** `authorization`, `cookie`, and `set-cookie` are
  replaced with `[redacted]` unless `redactSecureDefaults` is turned off; `redactHeaders` adds more.

It does **not** run app JavaScript: capture is protocol observation through the transport, so the
plugin is not `--allow-eval` gated (contrast the IPC plugin). It is a first-party, in-process plugin
(ADR-004) the operator chose to load.

## Scope and limitations

- **Renderer traffic only (on the Playwright transport).** Capture sees the renderer's `fetch` / XHR
  / navigation requests, not the main process's `net` module. Protocol-level capture that also covers
  the main process is the deferred CDP-transport path.
- **Capture, not modification.** This plugin observes; stubbing or modifying responses
  (`page.route`-style) is a deferred follow-up.
- **Terminal events only.** An event is recorded when the request finishes or fails; an in-flight
  request appears once it completes.
- **Capped ring buffer.** The transport retains the most recent events (older ones are dropped and
  counted in `overflowed`), so a long capture never grows without bound.
- **One capture per session.** Each running app session captures, reads, and stops independently and
  concurrently. Pass `sessionId` to target a specific app when more than one is running (omitting it
  with several live sessions returns `BAD_ARGUMENT`). The capture registry and config are
  process-global, like other first-party plugins; run independent server lifecycles in separate Node
  processes. Requires a transport whose `canIntercept` capability is set (the default Playwright
  transport); others return `network.UNSUPPORTED`.
