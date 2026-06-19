# @electron-stagewright/plugin-storage

Read, seed, and assert an Electron app's **storage** under agent-driven testing (ADR-018, built on the
ADR-004 plugin contract). Seed a cookie before a flow ("skip the login screen"), assert a cookie or a
`localStorage` value after one ("the cart survived a reload") — all **without running app JavaScript**.

Like the network and clock plugins, the storage tools ride a dedicated **transport seam**, not
main-process eval — so they do **not** require `--allow-eval`. They run on both the default **Playwright**
launch transport (via Playwright's `BrowserContext`) and a **CDP** attach session (via the CDP `Storage`
and `Network` domains). Cookies work fully on both; the `localStorage` half of the snapshot is full on
Playwright and best-effort on CDP (see _Scope_).

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

```js
const server = await createServer({
  plugins: [storagePlugin],
  pluginConfigs: { storage: { revealValues: true } },
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

Error codes: `storage.UNSUPPORTED` (the transport cannot access storage). Invalid arguments (a
`set_cookie` with neither `url` nor `domain`, a malformed `sameSite`) are core `BAD_ARGUMENT`.

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
plugin. The plugin runs **no app JavaScript** (it rides the transport's storage seam, not eval), so it is
not `--allow-eval` gated.

## Scope and limitations

- **Cookies + the storage snapshot, no eval.** Cookie CRUD and the snapshot are served by the transport's
  storage seam (Playwright's `BrowserContext`, the CDP `Storage` / `Network` domains), so no app JS runs.
- **`localStorage` is read-only and snapshot-shaped.** The snapshot exposes each origin's `localStorage`;
  there is no per-key get/set/remove and no `sessionStorage` or `IndexedDB`. Those need renderer eval
  (reading and writing arbitrary app JS state), which is a separate, explicitly-gated capability — they
  are a deferred follow-up, not part of this no-eval seam.
- **CDP snapshot is best-effort for `localStorage`.** On a CDP attach session, cookies are full; the
  `localStorage` half of the snapshot rides the CDP `DOMStorage` domain and is best-effort (it returns
  what the domain reports for the active origin, or an empty list if it cannot). Use the Playwright launch
  transport for a complete `localStorage` snapshot.
- **One store per session.** Each running app session accesses its own storage, keyed by the unique
  session id. Requires a transport whose `canAccessStorage` capability is set (the default Playwright
  launch transport or a CDP attach session); others return `storage.UNSUPPORTED`.
