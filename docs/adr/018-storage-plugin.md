# ADR-018: Storage plugin via a transport storage seam

Status: Accepted (cookies + storage snapshot on both Playwright and CDP; per-key localStorage / sessionStorage and IndexedDB shipped via a renderer-eval gate — see Status Updates)

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

## Status Update — per-key Web Storage via a renderer-eval gate

The deferred "per-key `localStorage` / `sessionStorage` get/set/remove" alternative shipped, resolving
the permission fork the original ADR left open. IndexedDB stays deferred.

### What landed

The plugin gains a SECOND tool family — `storage_local_*` and `storage_session_*` (get/set/remove/keys/
clear, ten tools) — for single-key Web Storage access. Reading or mutating one key needs renderer
JavaScript (`localStorage.getItem` / `setItem` / `removeItem`, the same for `sessionStorage`), which the
no-eval cookie/snapshot seam cannot serve. They ride the existing `transport.evaluate('renderer', …)`
seam via a fixed source string (`web-storage.ts` `WEB_STORAGE_BODY`); the agent supplies op/scope/key/
value DATA, never code. `storage_*_get` also takes a `keys[]` multi-key form (one round-trip), and every
result carries the active page's `origin` (Web Storage is per-origin). The cookie + snapshot tools are
unchanged and stay no-eval.

### The permission decision (the fork the original ADR named)

The original "Alternatives considered" entry noted that folding renderer storage in would "either bypass
the operator's renderer-eval opt-in or require a new plugin-facing eval permission in the core
dispatcher." It is resolved by **reusing the existing per-target eval opt-in** (`--allow-eval=renderer`,
ADR-014), surfaced to plugins through a new `ctx.allowEvalRenderer` — the renderer twin of the existing
`ctx.allowEval` (which maps to the main target). This is NOT a new permission concept: it exposes the
`EvalPolicy.renderer` flag that already exists. A new dedicated storage-eval permission was REJECTED — it
would fragment ADR-014's per-target least-privilege model and duplicate an opt-in with the same blast
radius. So the plugin is now **hybrid**: the cookie/snapshot tools are no-eval; the per-key tools are
renderer-eval gated.

### Gating (registration-time primary, runtime defense-in-depth)

The per-key tools declare `requiresEvalFlag: true, evalTarget: 'renderer'`, so the dispatcher **hides**
them unless the server permits renderer eval — the operator-facing authorization (a no-renderer-eval
server never registers them; calling one then names `--allow-eval=renderer`). The handlers ALSO re-assert
`if (!ctx.allowEvalRenderer) → storage.EVAL_REQUIRED` at the tool boundary: the transport `evaluate`
method bypasses the tool-registration gate, so the re-assert keeps an authorization bypass impossible if
the tool is ever registered unconditionally (the C9 implementation contract). The transport capability is
checked at runtime too (`supportsRendererEval` → `storage.UNSUPPORTED`), since the eval POLICY is
server-wide but a session's transport may still not support renderer eval (the injector). A renderer
storage-access failure (quota exceeded, opaque origin) becomes `storage.ACCESS_FAILED`, never a raw throw.

### Security

Web Storage **values are returned verbatim, not redacted** — they are app state, and redacting them would
defeat the read tools' assert-a-persisted-value purpose (the same asymmetry the snapshot already
documents for its `localStorage` half). The security model gains a row for the renderer-eval per-key
storage surface. The renderer-eval gate is the operator's primary control over this surface.

### Both transports

`supportsRendererEval` is `true` on both the Playwright launch transport (`page.evaluate`) and the CDP
attach transport (`Runtime.evaluate` against a page target), and `false` on the injector — so the per-key
tools work on the same transports as the cookie/snapshot seam, and `storage.UNSUPPORTED` on the injector.

### Still deferred

IndexedDB read/write — async and structured (databases / object stores / cursors), a materially larger
surface that warrants its own slice. The per-key Web Storage tools cover the common single-value case.

## Status Update — IndexedDB read/write (the last deferred surface)

The remaining deferral — IndexedDB — shipped on the same renderer-eval gate, completing the storage
plugin's surface (cookies, the storage snapshot, per-key Web Storage, IndexedDB).

### What landed

A third tool family — `storage_idb_*` (schema / get / keys / count / set / delete / clear, seven tools) —
over a fixed ASYNC renderer body (`indexeddb.ts` `INDEXEDDB_BODY`). `get` reads one record by key, a key
range, or all (bounded by `limit`, with a `truncated` flag); `index` reads via a store index; `set` /
`delete` / `clear` mutate records; `schema` lists databases or a database's stores. The agent supplies
database / store / key / value / op as DATA, never code. Reuses the renderer-eval gate the per-key slice
built: the same `evalGated` registration marker, `requireRendererEval` (→ `storage.EVAL_REQUIRED` /
`storage.UNSUPPORTED`), and `ctx.allowEvalRenderer`. No core change.

### Existing-schemas-only (the scope boundary)

The body opens a database WITHOUT a version, so it never triggers a create/upgrade; an accidental open of
a non-existent database is aborted in `onupgradeneeded` and reported as `database_not_found`. A missing
database or object store is `storage.NOT_FOUND` (a new namespaced code) — the plugin never creates or
upgrades a schema, because a version change mutates the app's own data model irreversibly, well beyond a
testing seam. Creating stores via a version upgrade is explicitly out of scope (a foot-gun deliberately
not exposed).

### Async correctness + wire-safety

The body promisifies the event-based IndexedDB API and resolves a WRITE only after the transaction
COMMITS (`tx.oncomplete`), so a reported write has actually persisted (the gated real-Electron smoke
re-reads a written record to prove it); the connection is closed in `finally` so a read never blocks a
later app-driven upgrade. IndexedDB values are structured-clone (a superset of JSON), so the body
normalises every returned value — `Date` → ISO string, and a `Blob` / `ArrayBuffer` / typed array or a
circular reference → a typed placeholder (`{ __type, byteLength? }`) — so it round-trips over the MCP
wire rather than shipping `{}` or crashing the read. This is a documented partial, like the CDP
`localStorage` best-effort: binary values are described, not faithfully transferred.

### Security

IndexedDB record values are returned verbatim by default (app state, like the per-key tools), with an
opt-in `redactValues` config that masks read values for an app that keeps secrets in IndexedDB. The
security model gains an IndexedDB row alongside the Web Storage one; the renderer-eval grant is the
operator's control over both. Writes (`set` / `delete` / `clear`) MODIFY app data, bounded by the same
renderer-eval gate + operator-loaded plugin.

### Both transports

Reuses `supportsRendererEval` (Playwright `page.evaluate`, CDP `Runtime.evaluate`); the injector returns
`storage.UNSUPPORTED`. The body unit tests run off-Electron against `fake-indexeddb` (a spec-compliant
in-memory IndexedDB, a dev-only dependency) so the async/transaction logic is covered in CI without real
Electron.

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
