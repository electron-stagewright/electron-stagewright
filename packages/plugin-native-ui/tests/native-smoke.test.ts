/**
 * Real-Electron native-UI smoke (ADR-019) — drives the actual Playwright transport native-UI seam
 * (`electronApp.evaluate` over `Menu.getApplicationMenu()`) end to end against a fixture that sets a
 * known application menu: reads the whole menu and asserts the interesting fields serialize — a checked
 * checkbox with an accelerator, a disabled item, and role-based items (`reload`, `quit`) found by role.
 *
 * Opt-in: runs only when `STAGEWRIGHT_E2E=1` (with `electron` + `playwright` installed). Skipped by
 * default so `pnpm test` stays fast and headless-CI-safe. No eval opt-in is needed — menu access rides
 * the transport seam (a fixed serializer/walker), not agent eval.
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

interface InvokeEnvelope {
  readonly ok: boolean
  readonly invoked: boolean
  readonly reason?: string
}

describe('native-ui plugin smoke (real Electron)', () => {
  it.skipIf(!RUN_E2E)(
    'reads the menu, resolves items by label/role, and invokes an item with a real side effect',
    async () => {
      const server = await createServer({ plugins: [nativeUiPlugin] })
      closers.push(() => server.close())

      const launched = (await server.dispatcher.dispatch('electron_launch', {
        main: FIXTURE_MAIN,
        instrumentNative: true,
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

      // Invoking File > Mark fires its handler, which writes a sentinel into the page — proving the
      // handler actually ran, not just that invoked:true came back.
      const marked = (await server.dispatcher.dispatch('native_menu_invoke', {
        sessionId,
        path: ['File', 'Mark'],
      })) as unknown as InvokeEnvelope
      expect(marked.invoked).toBe(true)
      const sentinel = (await server.dispatcher.dispatch('electron_expect_text', {
        sessionId,
        selector: '#invoked',
        contains: 'INVOKED',
      })) as { ok?: boolean }
      expect(sentinel.ok).toBe(true)

      // A built-in role item cannot be invoked programmatically — it refuses with reason 'role'.
      const roleInvoke = (await server.dispatcher.dispatch('native_menu_invoke', {
        sessionId,
        path: ['Help', 'quit'],
      })) as unknown as InvokeEnvelope
      expect(roleInvoke.invoked).toBe(false)
      expect(roleInvoke.reason).toBe('role')

      // An item with no click option still carries Electron's default click wrapper — validate against
      // REAL Electron that the app-defined-click heuristic reports no_handler, not a false invoked:true
      // (the heuristic is otherwise only exercised against the fake menu in the unit tests).
      const inertInvoke = (await server.dispatcher.dispatch('native_menu_invoke', {
        sessionId,
        path: ['File', 'Inert'],
      })) as unknown as InvokeEnvelope
      expect(inertInvoke.invoked).toBe(false)
      expect(inertInvoke.reason).toBe('no_handler')

      // Notification capture end to end: arm, invoke File > Notify (which shows a real notification),
      // then read it back — proving the Notification.prototype.show hook records against real Electron.
      expect(
        (
          (await server.dispatcher.dispatch('native_notifications_start', {
            sessionId,
          })) as { ok?: boolean }
        ).ok,
      ).toBe(true)
      await server.dispatcher.dispatch('native_menu_invoke', {
        sessionId,
        path: ['File', 'Notify'],
      })
      const captured = (await server.dispatcher.dispatch('native_notifications_stop', {
        sessionId,
      })) as unknown as { count: number; notifications: Array<{ title: string; body?: string }> }
      expect(captured.count).toBe(1)
      expect(captured.notifications[0]).toMatchObject({ title: 'Saved', body: 'All changes saved' })

      // The tray was created at STARTUP, before any agent could arm — proving launch-time
      // instrumentation (instrumentNative) catches the t=0 setup that an after-launch hook would miss.
      const trays = (await server.dispatcher.dispatch('native_trays', {
        sessionId,
      })) as unknown as {
        ok: boolean
        count: number
        trays: Array<{ toolTip?: string; menu?: { items: Array<{ label: string }> } }>
      }
      expect(trays.ok).toBe(true)
      expect(trays.count).toBe(1)
      expect(trays.trays[0]?.toolTip).toBe('Stagewright fixture tray')
      expect(trays.trays[0]?.menu?.items.some((i) => i.label === 'Tray Action')).toBe(true)

      expect((await server.dispatcher.dispatch('electron_stop', { sessionId })).ok).toBe(true)
    },
    60_000,
  )
})
