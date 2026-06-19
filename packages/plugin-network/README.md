# @electron-stagewright/plugin-network

Capture an Electron app's renderer request/response traffic by URL for agent-driven testing. The
agent's other tools see the DOM; this one sees the network calls the app makes underneath — which
endpoints, what status, how long — so a flow can be debugged or a call asserted (ADR-016, built on
the ADR-004 plugin contract).

Unlike the IPC plugin, the network tools ride a dedicated **transport seam**, not main-process eval —
so they do **not** require `--allow-eval`. Capture observes (headers + metadata by default, and
request/response **bodies** when `captureBodies` opts in); **stubbing** fulfills or aborts matching
requests so the app can be driven through states a live backend won't reliably produce. The seam is
wired on both the default Playwright (launch-mode) transport and the CDP (attach-mode) transport.

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

- **`network_capture_start`** `{ urls, methods?, captureBodies?, maxBodyBytes?, bodyContentTypes?,
sessionId? }` — start recording the renderer requests whose URL contains any entry in `urls` (an
  explicit allowlist — only matching requests are captured; there is no capture-everything).
  Optionally restrict to `methods` (case-insensitive). By default captures metadata + headers only;
  set `captureBodies: true` to also capture request/response bodies (decoded text, capped by
  `maxBodyBytes`, default 64 KiB, hard cap 1 MiB), or `captureBodies: "size"` to record only each
  body's byte length without its content. Bodies are captured only for text-ish content types
  (`bodyContentTypes` overrides the default json/text/xml/form/javascript set). Returns
  `{ capturing, urls, methods? }`.
- **`network_captured`** `{ clear?, sessionId? }` — return the events captured so far. Each event is
  `{ method, url, resourceType?, status?, ok?, requestHeaders?, requestBody?, responseHeaders?,
responseBody?, failure?, durationMs?, timestamp, windowId? }` (plus `requestBodyBytes?` /
  `requestBodyTruncated?` / `responseBodyBytes?` / `responseBodyTruncated?` when bodies are captured);
  configured redact headers are stripped (and body content when `redactBodies` is on). `clear:true`
  flushes the buffer after reading. Returns `{ count, events, overflowed }` (`overflowed` is how many
  older entries the capped ring dropped).
- **`network_capture_stop`** `{ sessionId? }` — stop the capture and clear its buffer. Returns
  `{ stopped, events }`.
- **`network_stub`** `{ urls, methods?, status?, headers?, contentType?, body?, abort?, times?,
delayMs?, sessionId? }` — intercept the requests matching `urls` and either FULFILL them with a
  canned response (status 100-599, headers/contentType/body, default 200) or ABORT them (`abort`, a
  Playwright-compatible simulated network-failure reason such as `failed` — mutually exclusive with
  the fulfill fields). `times` expires the stub after N uses; `delayMs` simulates a slow endpoint.
  Multiple stubs may be active (first match wins); a stubbed request is still captured. Returns
  `{ stubbed, abort? }`.
- **`network_unstub`** `{ url?, sessionId? }` — remove stubs and restore live traffic: all of them,
  or only those whose `urls` allowlist includes `url` (exact match). Idempotent. Returns
  `{ unstubbed }`.

Error codes: `network.UNSUPPORTED`, `network.ALREADY_CAPTURING`, `network.NOT_CAPTURING`. An empty
allowlist or `abort` combined with a fulfill response is core `BAD_ARGUMENT`.

## Config

`network` plugin config (all optional):

- **`redactHeaders`** — extra request/response header names to replace with `"[redacted]"`
  (case-insensitive), beyond the secure defaults.
- **`redactSecureDefaults`** — when `true` (the default), `authorization`, `cookie`, and `set-cookie`
  are redacted before any event reaches the agent. Set `false` to capture them verbatim.
- **`redactBodies`** — when `true`, any captured request/response body is replaced with
  `"[redacted: N bytes]"` (the byte count is kept, the content dropped) before it reaches the agent.
  Off by default; body content is not value-redacted otherwise.

## Security

Captured headers can carry secrets — auth tokens, cookies, API keys. The plugin limits that surface:

- **Capture is opt-in and bounded to an explicit URL allowlist.** `network_capture_start` requires at
  least one URL substring; only matching requests are recorded. There is no capture-everything.
- **Bodies are opt-in and bounded.** Request/response bodies are captured only when `captureBodies` is
  set, only for text-ish content types, and capped to `maxBodyBytes` (default 64 KiB, hard cap 1 MiB);
  `captureBodies: "size"` records only the byte length. Body **content** is not value-redacted like
  headers are — the explicit opt-in, the URL allowlist, the byte cap, and the content-type gate are
  the bound; `redactBodies` drops captured body content entirely (keeping only its size).
- **Secret headers are redacted by default.** `authorization`, `cookie`, and `set-cookie` are
  replaced with `[redacted]` unless `redactSecureDefaults` is turned off; `redactHeaders` adds more.

**Stubbing modifies what the app receives** — it can fulfill an endpoint with a canned response or
abort it. It is gated identically to capture (the transport's `canIntercept` capability + an explicit
URL allowlist; no stub-everything) and, like capture, runs no app JavaScript. The canned body is the
agent's own data; the capability to alter app input is the reason it is bounded to an allowlist and
to a first-party, operator-loaded plugin.

It does **not** run app JavaScript: the network tools are protocol-level interception through the
transport, so the plugin is not `--allow-eval` gated (contrast the IPC plugin). It is a first-party,
in-process plugin (ADR-004) the operator chose to load.

## Scope and limitations

- **Renderer page-target traffic only.** Capture sees the renderer's `fetch` / XHR / navigation
  requests, not the main process's `net` module — on both transports.
- **Both transports.** The seam is wired on the default **Playwright** (launch-mode) transport via
  `page.on(...)` + `page.route(...)`, and on the **CDP** (attach-mode) transport via the Network domain
  (capture + bodies) and the Fetch domain (stub). Either works once its session reports `canIntercept`.
  `network_stub` fulfills or aborts; a stubbed request is still captured (its event shows the stubbed
  status and, with `captureBodies`, the stubbed body). Modifying an in-flight response body mid-stream
  is not offered.
- **Body capture caps exposure, not buffering.** `maxBodyBytes` bounds the bytes that reach the agent;
  the underlying transport may still buffer the whole response to read it. The text-ish content-type
  gate keeps large binary payloads (images, archives) out of capture.
- **Terminal events only.** An event is recorded when the request finishes or fails; an in-flight
  request appears once it completes.
- **Capped ring buffer.** The transport retains the most recent events (older ones are dropped and
  counted in `overflowed`), so a long capture never grows without bound.
- **One capture per session.** Each running app session captures, reads, and stops independently and
  concurrently. Pass `sessionId` to target a specific app when more than one is running (omitting it
  with several live sessions returns `BAD_ARGUMENT`). The capture registry and config are
  process-global, like other first-party plugins; run independent server lifecycles in separate Node
  processes. Requires a transport whose `canIntercept` capability is set (the default Playwright
  transport or the CDP transport); the injector transport returns `network.UNSUPPORTED`.
