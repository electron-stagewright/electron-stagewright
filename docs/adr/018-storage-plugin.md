# ADR-018: Storage plugin via a transport storage seam

Status: Accepted (cookies + storage snapshot on both Playwright and CDP; per-key localStorage / IndexedDB deferred)

## Context

An agent driving an Electron app cannot read, seed, or assert the app's **storage** without a seam.
"Skip the login screen by seeding the auth cookie." "Did the cart survive a reload?" "Assert the app
persisted the right `localStorage` value." Today the only path to any of this is renderer eval (running
app JavaScript to poke `document.cookie` / `localStorage`), which carries the eval threat model and the
`--allow-eval` opt-in — too heavy for the common case of reading a cookie or checking a persisted value.

ADR-003's transport capability matrix needs a storage capability, but until this amendment it had no
storage seam and no consumer. This is the storage analog of the network capture plugin (ADR-016) and the
clock plugin (ADR-017): the same "a transport seam + a capability gate + a plugin that drives it" shape.

## Decision

### 1. A dedicated storage seam on the transport, gated by `canAccessStorage`

`TransportSession` gains a storage seam — `getCookies(filter?)`, `setCookie(cookie)`,
`clearCookies(filter?)`, `storageSnapshot()` — plus the types `StorageCookie`, `CookieFilter`,
`StorageOrigin`, `StorageSnapshot`. Two transports implement it and flip `canAccessStorage` from `false`
to `true`:

- **Playwright** (the default launch transport) — via the page's `BrowserContext`: `context.cookies()` /
  `addCookies()` / `clearCookies()` for the cookie CRUD, and `context.storageState()` for the snapshot
  (cookies + every visited origin's `localStorage`).
- **CDP** (the attach transport) — cookies via the `Storage` domain for all-cookie reads/snapshots and
  the `Network` domain for URL-applicable reads, sets, and targeted deletes (`getCookies` / `setCookie` /
  `clearBrowserCookies` / `deleteCookies`); the snapshot's `localStorage` half rides the `DOMStorage`
  domain best-effort for the active origin (see Consequences).

`@electron-stagewright/plugin-storage` drives that seam: `storage_cookies`, `storage_set_cookie`,
`storage_clear_cookies`, `storage_snapshot`. The plugin keeps the orchestration (the gate, the cookie
filter, the url-or-domain refine, cookie-value redaction, error envelopes) in TypeScript; the transport
owns the actual store.

A seam — not eval — because cookie access and a storage snapshot are first-class browser-context
operations, not arbitrary JavaScript; they should not inherit the eval threat model or the
`--allow-eval` opt-in.

### 2. Gated by `canAccessStorage`, NOT `--allow-eval` gated, cookie values redacted by default

- **`canAccessStorage`** — the storage tools resolve the session and refuse a transport whose
  `canAccessStorage` is unset (`storage.UNSUPPORTED`, naming the Playwright launch and CDP attach
  transports). Playwright and CDP declare `true`; the injector declares `false`.
- **NOT `--allow-eval` gated** — storage access runs no app JavaScript, so it does not require the eval
  opt-in. Like the network and clock plugins, unlike the IPC plugin.
- **Cookie values are a secret surface.** A cookie value can carry an auth/session token, so on every
  read path (`storage_cookies`, `storage_snapshot`) the plugin replaces cookie **values** with
  `[redacted]` before they reach the agent, unless the operator sets `revealValues: true` (mirroring the
  network plugin's `redactSecureDefaults`). Cookie names, domains, paths, and flags are never redacted.
  The write path (`storage_set_cookie`) uses the agent's own value and is never redacted.

Writing (`storage_set_cookie`, `storage_clear_cookies`) **modifies app state**, so it is bounded the
same way as the other modify-capable plugins: the `canAccessStorage` capability and the operator-loaded
plugin.

## Rationale

- A storage seam, capability-flagged like the network and clock seams, is the honest place this power
  lives, and it keeps the everyday cookie-and-snapshot operations out of the eval threat model.
- Cookies + the `storageState` snapshot cover the dominant agent needs (seed a session, assert a
  persisted value) without running app JS. The snapshot is the no-eval way to **assert** `localStorage`.
- Defaulting cookie-value redaction on (opt-out, not opt-in) matches the network plugin's posture: the
  secret surface is closed unless the operator explicitly opens it.

## Alternatives considered

- **Per-key `localStorage` / `sessionStorage` get/set/remove and IndexedDB access via `evaluate`** —
  deferred. These need to read and write arbitrary renderer JS state (`localStorage.getItem`, an
  IndexedDB transaction), which is renderer eval, a separate and explicitly-gated capability with its
  own threat model. Folding them into this no-eval seam would either bypass the operator's renderer-eval
  opt-in or require a new plugin-facing eval permission in the core dispatcher — a design change beyond
  this slice. They are a clean follow-up; the read-only snapshot covers the common `localStorage`
  assertion in the meantime.
- **Storage access via `evaluate` (poke `document.cookie` / `localStorage`)** — rejected for the seam'd
  operations: the BrowserContext / CDP `Storage` / `Network` domains already model cookies and the storage
  snapshot first-class, so reusing them via a seam avoids the eval opt-in and the JSON-in-the-renderer
  fragility.

## Consequences

- New package `@electron-stagewright/plugin-storage` with the four `storage_*` tools, a `revealValues`
  config, and the namespaced `storage.UNSUPPORTED` error code. Invalid args (a `set_cookie` with neither
  `url` nor `domain`, a malformed `sameSite`) are core `BAD_ARGUMENT` (schema), not a plugin code.
- `TransportSession` gains four methods every transport must satisfy: real on Playwright and CDP,
  `NOT_IMPLEMENTED` on the injector (and the test fake records them + holds a cookie store).
  `canAccessStorage` gains its first consumers (amends ADR-003): Playwright and CDP flip `false → true`,
  the injector stays `false`.
- **CDP `localStorage` is best-effort.** On a CDP attach session, cookies are full; the `localStorage`
  half of the snapshot rides the `DOMStorage` domain for the active origin and returns an empty list when
  it cannot derive an origin or the domain is unavailable — the cookies still return. The Playwright
  launch transport gives a complete `localStorage` snapshot.
- **Honest capability.** `canAccessStorage: true` means the whole seam works on that transport; a
  transport that cannot satisfy it declares `false` rather than advertising methods that reject at
  runtime. CDP's best-effort `localStorage` is a documented partial within a fully-wired seam, not a
  rejecting method.
- **Cookie secret surface (amends ADR-014).** Cookie values are redacted by default on read; the
  security model gains a row for the cookie surface and the `revealValues` opt-out. **`localStorage`
  values in the snapshot are NOT redacted** — they are app state, and redacting them wholesale would
  defeat the snapshot's assert-a-persisted-value purpose; the asymmetry is documented so an operator
  whose app stores tokens in `localStorage` treats the snapshot output as sensitive.

## Related decisions

- ADR-003 (transport abstraction) — the `canAccessStorage` capability this consumes; amended with a
  Status Update for its first consumers.
- ADR-004 (plugin model) — the contract + in-process trust model this plugin is built on.
- ADR-006 (error code registry) — the namespaced `storage.*` codes.
- ADR-014 (security posture) — the secret-surface threat model the cookie-value redaction extends.
- ADR-016 (network plugin) / ADR-017 (clock plugin) — the sibling plugins whose transport-seam +
  capability-gate shape this mirrors (and whose `redactSecureDefaults` posture the cookie redaction
  follows).

## References

- `packages/core/src/transports/types.ts` — the seam methods + `StorageCookie` / `CookieFilter` /
  `StorageOrigin` / `StorageSnapshot`.
- `packages/core/src/transports/playwright-electron.ts` — the `BrowserContext` implementation.
- `packages/core/src/transports/cdp.ts` — the `Storage` / `Network` + `DOMStorage` implementation.
- `packages/plugin-storage/src/index.ts` — the tools, capability gate, cookie-value redaction.
- `packages/plugin-storage/tests/` — simulated-seam integration + the gated real-Electron smoke.
