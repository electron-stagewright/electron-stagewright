# ADR-016: Network capture plugin via a transport capture seam

Status: Accepted (renderer capture + stubbing; CDP-transport capture and response-body capture deferred)

## Context

An agent driving an Electron app through Stagewright sees the DOM (snapshot, find, read, interact)
but not the network calls the app makes underneath it. "Did saving the form POST to `/api/save`, and
what did it return?" is unanswerable from the DOM alone. Network capture is the fourth differentiation
plugin (after trace, IPC, and production); it ships the observe half of the dormant `canIntercept`
capability ADR-003 reserved.

Two questions had to be settled: HOW a plugin observes network traffic (it is neither a DOM surface
nor, unlike IPC, reachable through main-process eval — protocol-level network is invisible to an
in-page or main-process `evaluate`), and what SECURITY posture gates that observation.

## Decision

### 1. A dedicated network-capture seam on the transport, not eval

`TransportSession` gains three methods — `startNetworkCapture(filter)`, `networkEvents({ clear? })`,
`stopNetworkCapture()` — mirroring the existing always-on console/dialog buffers, but ARMED: the
listeners record only between start and stop. The default Playwright transport implements them with
`page.on('requestfinished' | 'requestfailed')`, recording one `NetworkEvent` per terminal request
(method, url, status, request/response headers, failure, duration) into a per-session capped ring,
filtered at record time to an explicit URL allowlist (+ optional method filter). The listeners attach
alongside the console/dialog ones (covering current and future windows with no extra bookkeeping) and
stay inert until armed, so `stopNetworkCapture` simply clears the filter — no fragile per-page detach.

`@electron-stagewright/plugin-network` drives that seam: `network_capture_start { urls, methods? }`,
`network_captured { clear? }`, `network_capture_stop`. The plugin keeps the orchestration (allowlist
relay, per-session capture state, header redaction, error envelopes) in TypeScript; the transport owns
the actual listeners and buffer.

A seam — not the eval approach the IPC plugin uses — because eval cannot see protocol-level network
traffic at all, and because network observation is not arbitrary JavaScript, so it should not inherit
the eval threat model or the eval opt-in.

### 2. Gated by `canIntercept`, bounded by an allowlist, NOT by `--allow-eval`

- **`canIntercept`** — the capture tools resolve the session and refuse a transport whose
  `canIntercept` capability is unset (`network.UNSUPPORTED`, with a hint naming the Playwright
  transport). The Playwright transport now declares `canIntercept: true` (its first consumer); the
  injector declares `false` (no renderer network). The CDP transport also declares `false` for now:
  its Network domain could serve capture, but the seam is not wired, and a capability that has a
  consumer stays honest rather than advertising methods that reject at runtime — so a CDP session is
  refused with the same `network.UNSUPPORTED`, and the flag flips to `true` when the CDP seam lands.
  (The seam methods still throw `NOT_IMPLEMENTED` for a direct caller that bypasses the gate.)
- **An explicit URL allowlist** — `network_capture_start` requires at least one URL substring; only
  matching requests are recorded. There is no capture-everything.
- **NOT `--allow-eval` gated** — capture runs no app JavaScript, so it does not require (and is not
  bounded by) the eval opt-in. This is the deliberate distinction from the IPC plugin.

Captured headers can carry secrets (auth, cookies, tokens). The plugin redacts `authorization`,
`cookie`, and `set-cookie` by default (`redactSecureDefaults`, configurable off), `redactHeaders` adds
more, and request/response BODIES are not captured in this increment — headers and metadata only — to
limit the secret surface.

## Rationale

- A capture seam, capability-flagged like `evaluate`'s `supportsMainEval`, is the honest place this
  power lives; it mirrors the console/dialog buffers an agent already reads.
- Recording at terminal state (`requestfinished` / `requestfailed`) yields one complete, immutable,
  JSON-serialisable event per request — no mutate-after-record, and failures are captured too.
- Not gating on eval keeps least privilege real: a renderer-only or no-eval deployment can still
  capture network, and an eval-gated automation does not silently acquire network capture.

## Alternatives considered

- **Capture via `evaluate` (the IPC approach)** — rejected: an in-page or main-process eval cannot
  observe protocol-level requests, and it would drag network capture under the eval threat model it
  does not belong to.
- **Capturing response bodies in this increment** — deferred: bodies widen the secret surface; a
  bounded, redactable `captureBodies` opt-in is a clean follow-up once demand is concrete.
- **Implementing the seam on the CDP transport now** — deferred: protocol-level capture over the CDP
  Network domain (which would also see the main process) is a larger surface; the slice is scoped to
  the default transport to stay one reviewable change.
- **Network stubbing (`page.route`)** — deferred: modifying responses is the other half of
  "intercept"; this slice ships observe-only.

## Consequences

- New package `@electron-stagewright/plugin-network` with `network_capture_start`/`network_captured`/
  `network_capture_stop` and namespaced `network.*` error codes (`UNSUPPORTED`, `ALREADY_CAPTURING`,
  `NOT_CAPTURING`). An empty allowlist is core `BAD_ARGUMENT` (schema), not a plugin code.
- `TransportSession` gains three methods every transport must satisfy: real on Playwright,
  `NOT_IMPLEMENTED` on CDP and injector (and the test fake simulates them). `canIntercept` gains its
  first consumer (amends ADR-003).
- **Renderer-only on the Playwright transport.** `page.on('request')` sees the renderer's fetch / XHR
  / navigation traffic, not the main process's `net` module. Stated as a limitation; CDP-transport
  capture (protocol-level, both processes) is the deferred broader path.
- **Privacy residual.** Capture is opt-in (an explicit allowlist), secret headers are redacted by
  default, and bodies are not captured — but a careless allowlist plus `redactSecureDefaults: false`
  can still surface header values. Documented in the security model.
- One capture per session: concurrent app sessions capture independently, keyed by the unique session
  id; the registry and config are module-level (co-resident servers share lifecycle/config — run fully
  independent lifecycles in separate processes).

## Related decisions

- ADR-003 (transport abstraction) — the `canIntercept` capability this consumes; amended with a Status
  Update for its first consumer.
- ADR-004 (plugin model) — the contract + in-process trust model this plugin is built on.
- ADR-006 (error code registry) — the namespaced `network.*` codes.
- ADR-010 (IPC plugin) — the sibling differentiation plugin; the contrast (eval seam + eval gate)
  motivates this plugin's seam + capability gate.
- ADR-014 (security posture and threat model) — the capture's secret surface and its mitigations.

## References

- `packages/core/src/transports/types.ts` — the seam methods + `NetworkCaptureFilter` / `NetworkEvent`.
- `packages/core/src/transports/playwright-electron.ts` — the `page.on(...)` implementation.
- `packages/core/src/transports/network-filter.ts` — the shared allowlist matcher.
- `packages/plugin-network/src/index.ts` — the tools, capability gate, per-session state, redaction.
- `packages/plugin-network/tests/` — simulated-capture e2e + the gated real-Electron smoke.

## Status Update — 2026-06-16: Response stubbing (the modify half)

The deferred "modify half" named above now ships. `TransportSession` gains `stubNetwork(stub)` /
`clearNetworkStubs(url?)`, and the plugin gains `network_stub` / `network_unstub` — gated on the same
`canIntercept` capability and bounded to the same explicit URL allowlist as capture, and likewise NOT
`--allow-eval` gated.

- The Playwright transport implements it with a single catch-all `page.route('**/*', handler)` that
  consults an ordered list of active stubs (first match wins) and `route.fulfill(...)` / `route.abort(...)`
  / `route.continue()` accordingly. The interceptor is attached lazily on the first stub and
  `page.unroute`-d when the last clears, so non-stubbed traffic is never intercepted once stubbing is
  off; the handler always resolves the route (a thrown handler falls back to `continue()`), so a stub
  can never hang the renderer. `times` (expire after N uses) and `delayMs` (simulate a slow endpoint)
  are supported per stub.
- A stubbed request is still captured (a fulfilled request fires `requestfinished`), so capture and
  stubbing compose — the gated smoke asserts a stubbed (200) response to the fixture's normally-failing
  URL appears in `network_captured`.
- **Stubbing is a MODIFY capability** — it alters what the app receives. It carries the same gating as
  capture (allowlist + `canIntercept` + operator-loaded plugin); the security model gains a row.
- CDP-transport coverage and response-body capture remain deferred.
