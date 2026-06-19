/**
 * Real-Electron storage smoke (ADR-018) — drives the actual Playwright transport storage seam
 * (`BrowserContext` cookies + `storageState`) end to end against a page served over loopback HTTP:
 * seed a cookie for the page's origin, prove the page itself sees it via document.cookie (the cookie
 * reached the real Chromium cookie store), read it back through `storage_cookies` (proving the default
 * value redaction in a real flow), then take a `storage_snapshot` and assert both the cookie and the
 * origin's localStorage are captured.
 *
 * Opt-in: runs only when `STAGEWRIGHT_E2E=1` (with `electron` + `playwright` installed). Skipped by
 * default so `pnpm test` stays fast and headless-CI-safe. No eval opt-in is needed — storage access
 * rides the transport seam, not main-process eval.
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
      const server = await createServer({ plugins: [storagePlugin] })
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

      expect((await server.dispatcher.dispatch('electron_stop', { sessionId })).ok).toBe(true)
    },
    60_000,
  )
})
