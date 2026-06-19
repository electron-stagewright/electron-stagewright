/**
 * Real-Electron clock smoke (ADR-017) — drives the actual Playwright transport clock seam
 * (`page.clock`) end to end: install a fake clock, freeze it at a known instant, read it back from the
 * page (proving Date.now() is frozen), then arm a 60s timer and advance the clock to fire it
 * deterministically (proving timers fire on demand, not on real wall-clock time).
 *
 * Opt-in: runs only when `STAGEWRIGHT_E2E=1` (with `electron` + `playwright` installed). Skipped by
 * default so `pnpm test` stays fast and headless-CI-safe. No eval opt-in is needed — clock control
 * rides the transport seam, not main-process eval.
 *
 * @module
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createServer } from '@electron-stagewright/core'
import { afterAll, describe, expect, it } from 'vitest'

import clockPlugin from '../src/index.js'

const RUN_E2E = process.env['STAGEWRIGHT_E2E'] === '1'
const FIXTURE_MAIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'clock-app',
  'main.js',
)
/** A fixed instant the smoke freezes to and asserts (epoch ms). */
const FROZEN_MS = 1_700_000_000_000

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

describe('clock plugin smoke (real Electron)', () => {
  it.skipIf(!RUN_E2E)(
    'freezes Date.now() and fires a deferred timer by advancing the clock',
    async () => {
      const server = await createServer({ plugins: [clockPlugin] })
      closers.push(() => server.close())

      const launched = (await server.dispatcher.dispatch('electron_launch', {
        main: FIXTURE_MAIN,
      })) as { ok: boolean; session_id?: string; _meta?: { session_id?: string } }
      expect(launched.ok).toBe(true)
      const sessionId = launched.session_id ?? launched._meta?.session_id
      if (typeof sessionId !== 'string') throw new Error('launch returned no session id')

      // Install + freeze the clock at a known instant.
      expect(await server.dispatcher.dispatch('clock_install', { sessionId })).toMatchObject({
        ok: true,
        installed: true,
      })
      expect(
        await server.dispatcher.dispatch('clock_set_time', { sessionId, time: FROZEN_MS }),
      ).toMatchObject({ ok: true })

      // Read the (now frozen) clock from the page and assert Date.now() is pinned.
      const readRef = await findRef(server, sessionId, 'button', 'Read clock')
      expect(
        (
          (await server.dispatcher.dispatch('electron_click', {
            sessionId,
            ref: readRef,
          })) as Envelope
        ).ok,
      ).toBe(true)
      const now = (await server.dispatcher.dispatch('electron_get_text', {
        sessionId,
        selector: '#now',
      })) as Envelope
      expect(String(now['text'])).toContain(String(FROZEN_MS))

      // Arm a 60s timer (under the fake clock), then fire it by advancing — no real waiting.
      const startRef = await findRef(server, sessionId, 'button', 'Start timer')
      await server.dispatcher.dispatch('electron_click', { sessionId, ref: startRef })
      expect(
        await server.dispatcher.dispatch('clock_advance', { sessionId, ms: 60_000 }),
      ).toMatchObject({ ok: true, advancedMs: 60_000 })
      const fired = (await server.dispatcher.dispatch('electron_get_text', {
        sessionId,
        selector: '#fired',
      })) as Envelope
      expect(String(fired['text'])).toContain('FIRED')

      expect((await server.dispatcher.dispatch('electron_stop', { sessionId })).ok).toBe(true)
    },
    60_000,
  )
})
