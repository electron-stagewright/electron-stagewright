/**
 * Real-Electron storage smoke (ADR-018 + Status Update) — drives the actual Playwright transport
 * against a page served over loopback HTTP, covering BOTH storage families:
 *
 * 1. The no-eval seam (`BrowserContext` cookies + `storageState`): seed a cookie for the page's origin,
 *    prove the page itself sees it via document.cookie (the cookie reached the real Chromium cookie
 *    store), read it back through `storage_cookies` (proving the default value redaction in a real
 *    flow), then take a `storage_snapshot` and assert both the cookie and the origin's localStorage.
 * 2. The renderer-eval per-key tools (`storage_local_*` / `storage_session_*`): read the page's seeded
 *    `localStorage` key, set/get/remove a new one, and exercise `sessionStorage` independently — proving
 *    the real `page.evaluate` round-trip and the per-origin behaviour.
 * 3. The renderer-eval IndexedDB tools (`storage_idb_*`): read the page's seeded record, then a full
 *    write round-trip (set, read back, delete) against the real Chromium IndexedDB — proving the async
 *    body actually commits its transactions.
 *
 * Opt-in: runs only when `STAGEWRIGHT_E2E=1` (with `electron` + `playwright` installed). Skipped by
 * default so `pnpm test` stays fast and headless-CI-safe. The cookie/snapshot half needs no eval opt-in
 * (it rides the transport seam); the per-key half needs `--allow-eval=renderer`, modelled here by the
 * `allowEval: { renderer: true }` server option.
 *
 * @module
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createServer } from '@electron-stagewright/core'
import { afterAll, describe, expect, it } from 'vitest'

import storagePlugin from '../src/index.js'

const RUN_E2E = process.env['STAGEWRIGHT_E2E'] === '1'
const FIXTURE_MAIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'storage-app',
  'main.js',
)

type Server = Awaited<ReturnType<typeof createServer>>

const closers: Array<() => Promise<void>> = []
afterAll(async () => {
  await Promise.all(closers.splice(0).map((c) => c().catch(() => undefined)))
})

interface Envelope {
  readonly ok: boolean
  readonly [key: string]: unknown
}

/** Find one element by role + accessible-name substring and return its ref. */
async function findRef(
  server: Server,
  sessionId: string,
  role: string,
  name: string,
): Promise<number> {
  const found = (await server.dispatcher.dispatch('electron_find', {
    sessionId,
    role,
    name_contains: name,
  })) as { matches?: ReadonlyArray<{ ref?: number | null }> }
  const ref = found.matches?.[0]?.ref
  if (ref == null) throw new Error(`could not find ${role} "${name}"`)
  return ref
}

interface SnapshotEnvelope extends Envelope {
  readonly cookies: ReadonlyArray<{ name: string; value: string }>
  readonly origins: ReadonlyArray<{
    origin: string
    localStorage: ReadonlyArray<{ name: string; value: string }>
  }>
}

describe('storage plugin smoke (real Electron)', () => {
  it.skipIf(!RUN_E2E)(
    'seeds a cookie the page can see, redacts it on read, and snapshots localStorage',
    async () => {
      // Renderer eval granted so the per-key storage_local_* / storage_session_* tools register; the
      // cookie/snapshot half does not need it.
      const server = await createServer({
        plugins: [storagePlugin],
        allowEval: { main: false, renderer: true },
      })
      closers.push(() => server.close())

      const launched = (await server.dispatcher.dispatch('electron_launch', {
        main: FIXTURE_MAIN,
      })) as { ok: boolean; session_id?: string; _meta?: { session_id?: string } }
      expect(launched.ok).toBe(true)
      const sessionId = launched.session_id ?? launched._meta?.session_id
      if (typeof sessionId !== 'string') throw new Error('launch returned no session id')

      // The page reports its own origin; target it when seeding the cookie.
      const originText = (await server.dispatcher.dispatch('electron_get_text', {
        sessionId,
        selector: '#origin',
      })) as Envelope
      const origin = String(originText['text']).trim()
      expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

      // Seed a non-httpOnly cookie for the origin.
      expect(
        await server.dispatcher.dispatch('storage_set_cookie', {
          sessionId,
          name: 'session',
          value: 'tok-123',
          url: origin,
        }),
      ).toMatchObject({ ok: true, set: 'session' })

      // The page itself can see it via document.cookie — it reached the real Chromium cookie store.
      const readRef = await findRef(server, sessionId, 'button', 'Read cookie')
      await server.dispatcher.dispatch('electron_click', { sessionId, ref: readRef })
      const cookieText = (await server.dispatcher.dispatch('electron_get_text', {
        sessionId,
        selector: '#cookie',
      })) as Envelope
      expect(String(cookieText['text'])).toContain('session=tok-123')

      // Reading it back through the plugin redacts the value by default.
      const cookies = (await server.dispatcher.dispatch('storage_cookies', {
        sessionId,
        url: origin,
      })) as unknown as Envelope & { cookies: ReadonlyArray<{ name: string; value: string }> }
      const seeded = cookies.cookies.find((c) => c.name === 'session')
      expect(seeded?.value).toBe('[redacted]')

      // The snapshot captures the cookie (redacted) and the origin's localStorage.
      const snap = (await server.dispatcher.dispatch('storage_snapshot', {
        sessionId,
      })) as unknown as SnapshotEnvelope
      expect(snap.cookies.some((c) => c.name === 'session' && c.value === '[redacted]')).toBe(true)
      const originEntry = snap.origins.find((o) => o.origin === origin)
      expect(originEntry?.localStorage).toContainEqual({ name: 'cart', value: '3-items' })

      // Clearing by name removes it.
      expect(
        await server.dispatcher.dispatch('storage_clear_cookies', { sessionId, name: 'session' }),
      ).toMatchObject({ ok: true, cleared: 'session' })
      const after = (await server.dispatcher.dispatch('storage_cookies', {
        sessionId,
        url: origin,
      })) as unknown as Envelope & { cookies: ReadonlyArray<{ name: string }> }
      expect(after.cookies.some((c) => c.name === 'session')).toBe(false)

      // --- Per-key Web Storage (renderer-eval) ---

      // The page seeded localStorage.cart on load; the per-key read sees it and reports the origin.
      const cart = (await server.dispatcher.dispatch('storage_local_get', {
        sessionId,
        key: 'cart',
      })) as unknown as Envelope & { value: string | null; origin: string }
      expect(cart).toMatchObject({ ok: true, value: '3-items', origin })

      // Set, read back, then remove a fresh localStorage key.
      expect(
        await server.dispatcher.dispatch('storage_local_set', {
          sessionId,
          key: 'flag',
          value: 'on',
        }),
      ).toMatchObject({ ok: true, set: 'flag' })
      expect(
        await server.dispatcher.dispatch('storage_local_get', { sessionId, key: 'flag' }),
      ).toMatchObject({ ok: true, value: 'on' })
      expect(
        await server.dispatcher.dispatch('storage_local_remove', { sessionId, key: 'flag' }),
      ).toMatchObject({ ok: true, removed: 'flag' })
      expect(
        await server.dispatcher.dispatch('storage_local_get', { sessionId, key: 'flag' }),
      ).toMatchObject({ ok: true, value: null })

      // sessionStorage is a separate area: a key set there is invisible to localStorage.
      await server.dispatcher.dispatch('storage_session_set', {
        sessionId,
        key: 'tab',
        value: '42',
      })
      expect(
        await server.dispatcher.dispatch('storage_session_get', { sessionId, key: 'tab' }),
      ).toMatchObject({ ok: true, scope: 'session', value: '42' })
      expect(
        await server.dispatcher.dispatch('storage_local_get', { sessionId, key: 'tab' }),
      ).toMatchObject({ ok: true, value: null })

      // --- IndexedDB (renderer-eval) ---

      // Wait for the fixture's async IndexedDB seed to finish (it flips #idb to "seeded").
      await server.dispatcher.dispatch('electron_expect_text', {
        sessionId,
        selector: '#idb',
        contains: 'seeded',
      })

      // The fixture seeded appdb/docs with one record; schema + get see it.
      const schema = (await server.dispatcher.dispatch('storage_idb_schema', {
        sessionId,
        database: 'appdb',
      })) as unknown as Envelope & { stores: ReadonlyArray<{ name: string; keyPath: unknown }> }
      expect(schema.stores.some((s) => s.name === 'docs' && s.keyPath === 'id')).toBe(true)

      expect(
        await server.dispatcher.dispatch('storage_idb_get', {
          sessionId,
          database: 'appdb',
          store: 'docs',
          key: 'seed',
        }),
      ).toMatchObject({ ok: true, record: { key: 'seed', value: { title: 'Seeded doc' } } })

      // Write round-trip: set a new record, read it back (proves the async transaction committed), delete it.
      expect(
        await server.dispatcher.dispatch('storage_idb_set', {
          sessionId,
          database: 'appdb',
          store: 'docs',
          value: { id: 'new', title: 'Written by the agent' },
        }),
      ).toMatchObject({ ok: true, key: 'new' })
      expect(
        await server.dispatcher.dispatch('storage_idb_get', {
          sessionId,
          database: 'appdb',
          store: 'docs',
          key: 'new',
        }),
      ).toMatchObject({ ok: true, record: { value: { title: 'Written by the agent' } } })
      expect(
        await server.dispatcher.dispatch('storage_idb_delete', {
          sessionId,
          database: 'appdb',
          store: 'docs',
          key: 'new',
        }),
      ).toMatchObject({ ok: true, deleted: 'new' })
      expect(
        await server.dispatcher.dispatch('storage_idb_get', {
          sessionId,
          database: 'appdb',
          store: 'docs',
          key: 'new',
        }),
      ).toMatchObject({ ok: true, record: null })

      expect((await server.dispatcher.dispatch('electron_stop', { sessionId })).ok).toBe(true)
    },
    60_000,
  )
})
