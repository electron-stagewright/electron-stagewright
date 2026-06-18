/**
 * Real-Electron network smoke (ADR-016) — drives the actual Playwright transport network-capture seam
 * (`page.on('requestfinished'|'requestfailed')`) against a live app that periodically fetches an
 * allowlisted URL. Asserts an armed capture observes the request and reads it back.
 *
 * Opt-in: runs only when `STAGEWRIGHT_E2E=1` (with `electron` + `playwright` installed). Skipped by
 * default so `pnpm test` stays fast and headless-CI-safe. No eval opt-in is needed — network capture
 * rides the transport seam, not main-process eval.
 *
 * @module
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createServer } from '@electron-stagewright/core'
import { afterAll, describe, expect, it } from 'vitest'

import networkPlugin from '../src/index.js'

const RUN_E2E = process.env['STAGEWRIGHT_E2E'] === '1'
const FIXTURE_MAIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'network-app',
  'main.js',
)

type Server = Awaited<ReturnType<typeof createServer>>

const closers: Array<() => Promise<void>> = []
afterAll(async () => {
  await Promise.all(closers.splice(0).map((c) => c().catch(() => undefined)))
})

interface NetworkEventLike {
  readonly url: string
  readonly method: string
  readonly status?: number
  readonly failure?: string
  readonly responseBody?: string
  readonly responseBodyBytes?: number
}
interface CapturedRead {
  readonly ok: boolean
  readonly count: number
  readonly events: ReadonlyArray<NetworkEventLike>
}

/** Poll network_captured until an event satisfying `done` lands or the budget runs out. */
async function waitForCapture(
  server: Server,
  sessionId: string,
  done: (read: CapturedRead) => boolean,
  budgetMs = 10_000,
): Promise<CapturedRead> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const read = (await server.dispatcher.dispatch('network_captured', {
      sessionId,
    })) as unknown as CapturedRead
    if (read.ok && done(read)) return read
    if (Date.now() >= deadline) return read
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

describe('network plugin smoke (real Electron)', () => {
  it.skipIf(!RUN_E2E)(
    'captures a real renderer request through the Playwright transport seam',
    async () => {
      const server = await createServer({ plugins: [networkPlugin] })
      closers.push(() => server.close())

      const launched = (await server.dispatcher.dispatch('electron_launch', {
        main: FIXTURE_MAIN,
      })) as { ok: boolean; session_id?: string; _meta?: { session_id?: string } }
      expect(launched.ok).toBe(true)
      const sessionId = launched.session_id ?? launched._meta?.session_id
      if (typeof sessionId !== 'string') throw new Error('launch returned no session id')

      expect(
        await server.dispatcher.dispatch('network_capture_start', {
          sessionId,
          urls: ['/api/'],
        }),
      ).toMatchObject({ ok: true, capturing: true })

      const captured = await waitForCapture(server, sessionId, (r) => r.count >= 1)
      expect(captured.ok).toBe(true)
      expect(captured.count).toBeGreaterThanOrEqual(1)
      expect(captured.events[0]?.url).toContain('/api/')

      expect(await server.dispatcher.dispatch('network_capture_stop', { sessionId })).toMatchObject(
        {
          ok: true,
          stopped: true,
        },
      )
      expect((await server.dispatcher.dispatch('electron_stop', { sessionId })).ok).toBe(true)
    },
    60_000,
  )

  it.skipIf(!RUN_E2E)(
    'stubs a real request (the fixture URL never resolves, so a 200 capture proves the stub fired) and still captures it',
    async () => {
      const server = await createServer({ plugins: [networkPlugin] })
      closers.push(() => server.close())

      const launched = (await server.dispatcher.dispatch('electron_launch', {
        main: FIXTURE_MAIN,
      })) as { ok: boolean; session_id?: string; _meta?: { session_id?: string } }
      const sessionId = launched.session_id ?? launched._meta?.session_id
      if (typeof sessionId !== 'string') throw new Error('launch returned no session id')

      // Capture, then stub the fixture's (unresolvable) /api/probe with a 200. Without the stub the
      // request fails (DNS); a captured event with status 200 proves the stub fulfilled it AND that a
      // stubbed request is still captured (fold F).
      await server.dispatcher.dispatch('network_capture_start', { sessionId, urls: ['/api/'] })
      expect(
        await server.dispatcher.dispatch('network_stub', {
          sessionId,
          urls: ['/api/probe'],
          status: 200,
          contentType: 'text/plain',
          body: 'STUBBED',
        }),
      ).toMatchObject({ ok: true, stubbed: ['/api/probe'] })

      const stubbed = await waitForCapture(server, sessionId, (r) =>
        r.events.some((e) => e.status === 200),
      )
      const ok = stubbed.events.find((e) => e.status === 200)
      expect(ok, 'a stubbed (200) request should have been captured').toBeDefined()
      expect(ok?.url).toContain('/api/probe')

      expect(await server.dispatcher.dispatch('network_unstub', { sessionId })).toMatchObject({
        ok: true,
        unstubbed: 'all',
      })
      expect((await server.dispatcher.dispatch('electron_stop', { sessionId })).ok).toBe(true)
    },
    60_000,
  )

  it.skipIf(!RUN_E2E)(
    'captures a response body when captureBodies is on (stubbed JSON over the unresolvable URL)',
    async () => {
      const server = await createServer({ plugins: [networkPlugin] })
      closers.push(() => server.close())

      const launched = (await server.dispatcher.dispatch('electron_launch', {
        main: FIXTURE_MAIN,
      })) as { ok: boolean; session_id?: string; _meta?: { session_id?: string } }
      const sessionId = launched.session_id ?? launched._meta?.session_id
      if (typeof sessionId !== 'string') throw new Error('launch returned no session id')

      // Capture WITH bodies, then stub /api/probe with a JSON 200 body. The captured event should
      // carry the decoded responseBody — proving the body-capture path end-to-end on real Electron.
      await server.dispatcher.dispatch('network_capture_start', {
        sessionId,
        urls: ['/api/'],
        captureBodies: true,
      })
      await server.dispatcher.dispatch('network_stub', {
        sessionId,
        urls: ['/api/probe'],
        status: 200,
        contentType: 'application/json',
        body: '{"stub":true}',
      })

      const captured = await waitForCapture(server, sessionId, (r) =>
        r.events.some((e) => e.responseBody !== undefined),
      )
      const withBody = captured.events.find((e) => e.responseBody !== undefined)
      expect(withBody, 'a captured event should carry a response body').toBeDefined()
      expect(withBody?.responseBody).toContain('"stub":true')

      expect(await server.dispatcher.dispatch('network_unstub', { sessionId })).toMatchObject({
        ok: true,
      })
      expect((await server.dispatcher.dispatch('electron_stop', { sessionId })).ok).toBe(true)
    },
    60_000,
  )
})
