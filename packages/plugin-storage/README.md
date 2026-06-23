# @electron-stagewright/plugin-storage

Read, seed, and assert an Electron app's **storage** under agent-driven testing (ADR-018, built on the
ADR-004 plugin contract). Seed a cookie before a flow ("skip the login screen"), assert a cookie or a
`localStorage` value after one ("the cart survived a reload"), read/set/remove a single
`localStorage` / `sessionStorage` key, or read and write **IndexedDB** records.

This plugin is **hybrid** — three families with different trust postures:

- **No-eval seam tools** (`storage_cookies`, `storage_set_cookie`, `storage_clear_cookies`,
  `storage_snapshot`) ride a dedicated **transport seam** (Playwright's `BrowserContext` / the CDP
  `Storage` + `Network` domains), not eval, so they do **not** require `--allow-eval`. Cookies work fully
  on both the Playwright launch transport and a CDP attach session; the `localStorage` half of the
  snapshot is full on Playwright and best-effort on CDP (see _Scope_).
- **Per-key Web Storage tools** (`storage_local_*` / `storage_session_*`) read and mutate a single
  `localStorage` / `sessionStorage` key, which needs renderer JavaScript — so they ride
  `transport.evaluate('renderer', …)` and **are renderer-eval gated**. They register only under
  `--allow-eval=renderer` (or bare `--allow-eval`); the dispatcher hides them otherwise.
- **IndexedDB tools** (`storage_idb_*`) read and write records in **existing** databases / object
  stores; also renderer-eval gated. They operate on existing schemas only (they never create or upgrade
  a database/store) and refuse a missing one with `storage.NOT_FOUND`.

## Load it

```sh
node packages/core/dist/cli.js --plugin @electron-stagewright/plugin-storage
```

Programmatically:

```js
import { createServer } from '@electron-stagewright/core'
import storagePlugin from '@electron-stagewright/plugin-storage'

const server = await createServer({ plugins: [storagePlugin] })
```

### Configuration

Via `pluginConfigs.storage`:

- **`revealValues`** (boolean, default `false`) — return cookie **values** verbatim instead of redacting
  them. Off by default because a cookie value can be an auth token (see _Security_).
- **`redactValues`** (boolean, default `false`) — redact **IndexedDB** record values (replace with
  `[redacted]`) in read results. Off by default (IndexedDB values are app state); turn it on if the app
  keeps secrets in IndexedDB.

```js
const server = await createServer({
  plugins: [storagePlugin],
  pluginConfigs: { storage: { revealValues: true, redactValues: true } },
})
```

## Tools

The loader namespaces each tool under the plugin name `storage`:

- **`storage_cookies`** `{ url?, name?, sessionId? }` — return the app's cookies, optionally narrowed by
  `url` (cookies that apply to it) and/or `name`. Cookie **values are redacted by default**. Returns
  `{ count, cookies }`.
- **`storage_set_cookie`** `{ name, value, url?, domain?, path?, expires?, httpOnly?, secure?, sameSite?, sessionId? }`
  — add or overwrite one cookie to seed app state. Provide a `url` **or** a `domain` (one is required;
  neither ⇒ `BAD_ARGUMENT`). `expires` is epoch **seconds**; omit for a session cookie. Returns
  `{ set }`.
- **`storage_clear_cookies`** `{ url?, name?, sessionId? }` — clear cookies: all of them, or only those
  matching `url` and/or `name`. Idempotent. Returns `{ cleared }`.
- **`storage_snapshot`** `{ sessionId? }` — return a point-in-time storage snapshot: every cookie plus
  each visited origin's `localStorage`. The no-eval way to **assert** persisted state. Cookie values are
  redacted by default. Returns `{ cookies, origins }`.

### Per-key Web Storage (renderer-eval gated)

These run renderer JavaScript, so they require `--allow-eval=renderer` (or bare `--allow-eval`) — the
dispatcher hides them otherwise — and the transport's `supportsRendererEval` capability. Each comes in a
`local` (localStorage) and a `session` (sessionStorage) variant; the two stores are independent. Web
Storage **values are returned verbatim, not redacted** (see _Security_). Every result includes the active
page's `origin` (Web Storage is per-origin).

- **`storage_local_get`** / **`storage_session_get`** `{ key?, keys?, sessionId? }` — read one value by
  `key`, or several with `keys` (one renderer round-trip). Provide exactly one of `key` / `keys`. A
  missing key returns `value: null` (distinct from `""`). Returns `{ scope, origin, key, value }` or
  `{ scope, origin, items }`.
- **`storage_local_set`** / **`storage_session_set`** `{ key, value, sessionId? }` — add or overwrite one
  key with a string value. Returns `{ scope, origin, set }`.
- **`storage_local_remove`** / **`storage_session_remove`** `{ key, sessionId? }` — remove one key
  (idempotent). Returns `{ scope, origin, removed }`.
- **`storage_local_keys`** / **`storage_session_keys`** `{ sessionId? }` — list every key in the scope
  (no values; cheap discovery). Returns `{ scope, origin, count, keys }`.
- **`storage_local_clear`** / **`storage_session_clear`** `{ sessionId? }` — clear the whole scope for the
  active origin (idempotent). Returns `{ scope, origin, cleared }`.

### IndexedDB (renderer-eval gated, existing databases/stores only)

Like the per-key tools these require `--allow-eval=renderer` (or bare `--allow-eval`) and the
`supportsRendererEval` capability. They operate on **existing** databases and object stores — they never
create or upgrade a schema (a missing one is `storage.NOT_FOUND`). Record values are returned verbatim
(set `redactValues` to mask them); structured-clone values that are not JSON (a `Blob` / `ArrayBuffer` /
typed array, or a circular reference) come back as a typed placeholder (`{ __type, byteLength? }`).

- **`storage_idb_schema`** `{ database?, sessionId? }` — with no `database`, list databases
  (`{ name, version }`); with one, list its object stores (`{ name, keyPath, autoIncrement, indexes }`).
  Returns `{ origin, databases }` or `{ origin, database, stores }`.
- **`storage_idb_get`** `{ database, store, key?, index?, range?, limit?, sessionId? }` — read one record
  by `key`, a `range` of records, or all (bounded by `limit`, default 1000, with `truncated`). `index`
  reads via a store index. Provide at most one of `key` / `range`. Returns `{ origin, record }` or
  `{ origin, records, truncated }`.
- **`storage_idb_keys`** `{ database, store, index?, range?, limit?, sessionId? }` — list primary keys
  (no values). Returns `{ origin, count, keys, truncated }`.
- **`storage_idb_count`** `{ database, store, index?, range?, sessionId? }` — count records. Returns
  `{ origin, count }`.
- **`storage_idb_set`** `{ database, store, value, key?, sessionId? }` — add or overwrite one record.
  Omit `key` for an in-line-key / autoIncrement store; provide it for an out-of-line-key store. Returns
  `{ origin, key }` (the effective key).
- **`storage_idb_delete`** `{ database, store, key, sessionId? }` — delete one record (idempotent).
  Returns `{ origin, deleted }`.
- **`storage_idb_clear`** `{ database, store, sessionId? }` — clear a store (idempotent). Returns
  `{ origin, cleared }`.

Error codes: `storage.UNSUPPORTED` (the transport cannot access storage, or cannot evaluate in the
renderer), `storage.EVAL_REQUIRED` (a renderer-eval tool was reached without renderer eval — normally
they are hidden), `storage.ACCESS_FAILED` (the renderer could not read/write the area, e.g. quota
exceeded, an opaque origin, or a missing required IndexedDB key), `storage.NOT_FOUND` (a named IndexedDB
database or object store does not exist). Invalid arguments (a `set_cookie` with neither `url` nor
`domain`, a `get` with neither `key` nor `keys`, an `idb_get` with both `key` and `range`, a malformed
`sameSite`) are core `BAD_ARGUMENT`.

## Security

A cookie **value can carry a secret** (a session token, an auth cookie), so on every read path
(`storage_cookies`, `storage_snapshot`) cookie values are replaced with `[redacted]` before they reach
the agent. Set `revealValues: true` to opt out when you genuinely need the value (e.g. asserting it).
Cookie **names**, domains, paths, and flags are never redacted — only the value.

**`localStorage` values are NOT redacted.** The `storage_snapshot` `origins` carry each origin's
`localStorage` verbatim — they are app state, and redacting them wholesale would defeat the snapshot's
purpose (asserting a persisted value). If your app keeps secrets (a JWT, an auth token) in `localStorage`
rather than a cookie, treat the snapshot output as sensitive. Only cookie **values** are redacted.

The write path (`storage_set_cookie`) is not a secret surface: it uses the agent's own value, so it is
never redacted. Writing **modifies app state** (seeding a cookie changes what the app sees on its next
request), bounded by the transport's `canAccessStorage` capability and the operator's choice to load the
plugin. The cookie + snapshot tools run **no app JavaScript** (they ride the transport's storage seam),
so they are not `--allow-eval` gated.

**The per-key Web Storage tools and the IndexedDB tools DO run renderer JavaScript** and are therefore
renderer-eval gated: they register only under `--allow-eval=renderer` (or bare `--allow-eval`) and
re-assert that grant at the tool boundary (`storage.EVAL_REQUIRED`). The agent supplies the operation and
the key/value as **data**, never code — the renderer body is a fixed source string. Web Storage and
IndexedDB **values are returned verbatim** by default: they are app state, and redacting them would
defeat the read tools' assert-a-persisted-value purpose — the same asymmetry the snapshot documents.
Treat the output as sensitive if the app stores tokens there; for IndexedDB, the `redactValues` config
masks record values when you do not need them.

## Scope and limitations

- **Cookies + the storage snapshot, no eval.** Cookie CRUD and the snapshot are served by the transport's
  storage seam (Playwright's `BrowserContext`, the CDP `Storage` / `Network` domains), so no app JS runs.
- **Per-key `localStorage` / `sessionStorage`, renderer-eval gated.** Single-key get/set/remove, key
  listing, and clear for both Web Storage areas are served by `transport.evaluate('renderer', …)` — so
  they need `--allow-eval=renderer` and the `supportsRendererEval` capability (the default Playwright
  launch transport and a CDP attach session both qualify; the injector does not). The read-only
  snapshot remains the no-eval way to assert `localStorage` when renderer eval is not granted.
- **IndexedDB, renderer-eval gated, existing schemas only.** `storage_idb_*` read/write records in
  databases and object stores that already exist; they never create or upgrade a schema (a version
  change would mutate the app's own data model), so a missing database/store is `storage.NOT_FOUND`.
  Values cross the wire as JSON: `Date` becomes an ISO string, and binary/circular values become a typed
  placeholder rather than failing the read.
- **CDP snapshot is best-effort for `localStorage`.** On a CDP attach session, cookies are full; the
  `localStorage` half of the snapshot rides the CDP `DOMStorage` domain and is best-effort (it returns
  what the domain reports for the active origin, or an empty list if it cannot). Use the Playwright launch
  transport for a complete `localStorage` snapshot.
- **Per-session target.** Each running app session accesses its own browser-context storage, keyed by the
  unique session id. Cookie/snapshot tools require `canAccessStorage`; per-key Web Storage and IndexedDB
  tools require `supportsRendererEval` plus the renderer-eval grant. Unsupported transports return
  `storage.UNSUPPORTED`.
