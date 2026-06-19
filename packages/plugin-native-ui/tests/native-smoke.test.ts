/**
 * Real-Electron native-UI smoke (ADR-019) — drives the actual Playwright transport native-UI seam
 * (`electronApp.evaluate` over `Menu.getApplicationMenu()`) end to end against a fixture that sets a
 * known application menu: reads the whole menu and asserts the interesting fields serialize — a checked
 * checkbox with an accelerator, a disabled item, and role-based items (`reload`, `quit`) found by role.
 *
 * Opt-in: runs only when `STAGEWRIGHT_E2E=1` (with `electron` + `playwright` installed). Skipped by
 * default so `pnpm test` stays fast and headless-CI-safe. No eval opt-in is needed — the menu read rides
 * the transport seam (a fixed serializer), not agent eval.
 *
 * @module
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createServer, type NativeMenu, type NativeMenuItem } from '@electron-stagewright/core'
import { afterAll, describe, expect, it } from 'vitest'

import nativeUiPlugin from '../src/index.js'

const RUN_E2E = process.env['STAGEWRIGHT_E2E'] === '1'
const FIXTURE_MAIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'menu-app',
  'main.js',
)

const closers: Array<() => Promise<void>> = []
afterAll(async () => {
  await Promise.all(closers.splice(0).map((c) => c().catch(() => undefined)))
})

interface MenuEnvelope {
  readonly ok: boolean
  readonly menu: NativeMenu | null
}

interface ItemEnvelope {
  readonly ok: boolean
  readonly found: boolean
  readonly item?: NativeMenuItem
}

describe('native-ui plugin smoke (real Electron)', () => {
  it.skipIf(!RUN_E2E)(
    'reads the application menu and resolves items by label and by role',
    async () => {
      const server = await createServer({ plugins: [nativeUiPlugin] })
      closers.push(() => server.close())

      const launched = (await server.dispatcher.dispatch('electron_launch', {
        main: FIXTURE_MAIN,
      })) as { ok: boolean; session_id?: string; _meta?: { session_id?: string } }
      expect(launched.ok).toBe(true)
      const sessionId = launched.session_id ?? launched._meta?.session_id
      if (typeof sessionId !== 'string') throw new Error('launch returned no session id')

      // The whole menu reads back with a top-level View submenu.
      const full = (await server.dispatcher.dispatch('native_menu', {
        sessionId,
      })) as unknown as MenuEnvelope
      expect(full.ok).toBe(true)
      const view = full.menu?.items.find((i) => i.label === 'View')
      expect(view?.type).toBe('submenu')

      // The checkbox keeps its checked state + accelerator.
      const dark = (await server.dispatcher.dispatch('native_menu_item', {
        sessionId,
        path: ['View', 'Dark Mode'],
      })) as unknown as ItemEnvelope
      expect(dark.found).toBe(true)
      expect(dark.item?.type).toBe('checkbox')
      expect(dark.item?.checked).toBe(true)
      expect(dark.item?.accelerator).toContain('D')

      // The disabled item reports enabled:false.
      const frozen = (await server.dispatcher.dispatch('native_menu_item', {
        sessionId,
        path: ['View', 'Frozen'],
      })) as unknown as ItemEnvelope
      expect(frozen.item?.enabled).toBe(false)

      // Role-based items (no explicit label) are findable by role.
      const quit = (await server.dispatcher.dispatch('native_menu_item', {
        sessionId,
        path: ['Help', 'quit'],
      })) as unknown as ItemEnvelope
      expect(quit.found).toBe(true)
      expect(quit.item?.role).toBe('quit')

      expect((await server.dispatcher.dispatch('electron_stop', { sessionId })).ok).toBe(true)
    },
    60_000,
  )
})
