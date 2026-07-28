/** Real Electron/Playwright proof for surface-scoped axe audits and renderer cache reuse. */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createServer, NOOP_LOGGER } from '@electron-stagewright/core'
import { waitForTestSurfaces } from '@electron-stagewright/testkit'
import { afterEach, describe, expect, it } from 'vitest'

import a11yPlugin from '../src/index.js'

const RUN_E2E = process.env['STAGEWRIGHT_E2E'] === '1'
const FIXTURE_MAIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'a11y-electron',
  'main.js',
)

const servers = new Set<Awaited<ReturnType<typeof createServer>>>()
afterEach(async () => {
  await Promise.all([...servers].map((server) => server.close().catch(() => undefined)))
  servers.clear()
})

describe('a11y plugin (real Electron)', () => {
  it.skipIf(!RUN_E2E)(
    'audits selected root and frame surfaces, caches the engine, and maps selector failures',
    async () => {
      const server = await createServer({ plugins: [a11yPlugin], logger: NOOP_LOGGER })
      servers.add(server)
      const launched = (await server.dispatcher.dispatch('electron_launch', {
        main: FIXTURE_MAIN,
      })) as { readonly session_id?: string; readonly _meta?: { readonly session_id?: string } }
      const sessionId = launched.session_id ?? launched._meta?.session_id
      if (typeof sessionId !== 'string') throw new Error('launch returned no session id')

      const listed = await waitForTestSurfaces(
        server.dispatcher,
        sessionId,
        (result) =>
          result.surfaces.some(
            (surface) => surface.kind === 'window' && surface.url?.includes('/host.html'),
          ) &&
          result.surfaces.some(
            (surface) => surface.kind === 'frame' && surface.url?.includes('/child.html'),
          ),
      )
      const host = listed.surfaces.find(
        (surface) => surface.kind === 'window' && surface.url?.includes('/host.html'),
      )
      const child = listed.surfaces.find(
        (surface) => surface.kind === 'frame' && surface.url?.includes('/child.html'),
      )
      if (host === undefined || child === undefined)
        throw new Error('fixture surfaces were not discovered')

      await expect(
        server.dispatcher.dispatch('electron_switch_surface', { sessionId, surfaceId: host.id }),
      ).resolves.toMatchObject({ ok: true, active_surface_id: host.id })
      const first = (await server.dispatcher.dispatch('a11y_audit', {
        sessionId,
        scope: '#audit-root',
      })) as unknown as {
        readonly ok: boolean
        readonly surface_id: string
        readonly engine: { readonly cache_hit: boolean; readonly transferred_bytes: number }
        readonly violations: readonly {
          readonly id: string
          readonly nodes: readonly { readonly targets: readonly (readonly string[])[] }[]
        }[]
        readonly incomplete: readonly unknown[]
      }
      expect(first).toMatchObject({ ok: true, surface_id: host.id, engine: { cache_hit: false } })
      expect(first.engine.transferred_bytes).toBeGreaterThan(100_000)
      const hostImageAlt = first.violations.find((violation) => violation.id === 'image-alt')
      expect(hostImageAlt).toBeDefined()
      expect(
        hostImageAlt?.nodes.some((node) => node.targets.flat().includes('#shadow-image')),
      ).toBe(true)
      expect(Array.isArray(first.incomplete)).toBe(true)
      expect(
        await server.sessions
          .resolve(sessionId)
          .session.evaluate<boolean>('renderer', 'return globalThis.axe?.appOwned === true;'),
      ).toBe(true)

      const capped = (await server.dispatcher.dispatch('a11y_audit', {
        sessionId,
        scope: '#audit-root',
        maxViolations: 1,
        maxNodesPerViolation: 1,
      })) as unknown as {
        readonly ok: boolean
        readonly surface_id: string
        readonly engine: { readonly cache_hit: boolean; readonly transferred_bytes: number }
        readonly summary: { readonly violations: number; readonly violations_truncated: boolean }
        readonly violations: readonly { readonly nodes: readonly unknown[] }[]
      }
      expect(capped).toMatchObject({
        ok: true,
        surface_id: host.id,
        engine: { cache_hit: true, transferred_bytes: 0 },
      })
      expect(capped.summary).toMatchObject({ violations_truncated: true })
      expect(capped.summary.violations).toBeGreaterThan(1)
      expect(capped.violations).toHaveLength(1)
      expect(capped.violations[0]?.nodes).toHaveLength(1)
      await expect(
        server.dispatcher.dispatch('a11y_audit', { sessionId, scope: '[' }),
      ).resolves.toMatchObject({ ok: false, code: 'a11y.INVALID_SELECTOR' })
      await expect(
        server.dispatcher.dispatch('a11y_audit', { sessionId, scope: '#not-present' }),
      ).resolves.toMatchObject({ ok: false, code: 'a11y.SCOPE_NOT_FOUND' })

      await expect(
        server.dispatcher.dispatch('electron_switch_surface', { sessionId, surfaceId: child.id }),
      ).resolves.toMatchObject({ ok: true, active_surface_id: child.id })
      const childAudit = await server.dispatcher.dispatch('a11y_audit', { sessionId })
      expect(childAudit).toMatchObject({
        ok: true,
        surface_id: child.id,
        engine: { cache_hit: false },
      })
      expect(childAudit).toMatchObject({
        violations: expect.arrayContaining([expect.objectContaining({ id: 'image-alt' })]),
      })
      await expect(
        server.dispatcher.dispatch('electron_stop', { sessionId }),
      ).resolves.toMatchObject({
        ok: true,
      })
    },
    90_000,
  )
})
