/**
 * Real-Electron tutorial smoke — executes the exact flow the getting-started guide documents
 * (docs/guides/getting-started.md) against the bundled minimal example app, so the tutorial is
 * provably runnable, not aspirational prose: launch → snapshot → fill the form → find by
 * role+name → click by ref → expect_text → stop.
 *
 * Opt-in: runs only when `STAGEWRIGHT_E2E=1`. Skipped by default.
 */

import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import { type SuccessResponse } from '../src/errors/envelope.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { SnapshotStore } from '../src/server/snapshot-store.js'
import { TransportRegistry } from '../src/server/transport-registry.js'
import { PlaywrightElectronTransport } from '../src/transports/index.js'
import { expectTextTool } from '../src/tools/expect/index.js'
import { checkTool, clickTool, selectOptionTool, typeTool } from '../src/tools/interaction/index.js'
import { launchTool, stopTool } from '../src/tools/lifecycle/index.js'
import { findTool, snapshotTool } from '../src/tools/snapshot/index.js'

const RUN_E2E = process.env['STAGEWRIGHT_E2E'] === '1'
const MINIMAL_APP_MAIN = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'examples',
  'minimal-app',
  'main.js',
)

const sessions = new SessionManager()

afterAll(async () => {
  await sessions.disposeAll()
})

describe('getting-started tutorial smoke (real Electron)', () => {
  it.skipIf(!RUN_E2E)(
    'the documented flow runs end to end against the minimal example app',
    async () => {
      const dispatcher = new Dispatcher({
        sessions,
        snapshots: new SnapshotStore(),
        transports: new TransportRegistry({
          transports: [new PlaywrightElectronTransport()],
        }),
      })
      dispatcher.registerAll([
        launchTool,
        snapshotTool,
        findTool,
        typeTool,
        checkTool,
        selectOptionTool,
        clickTool,
        expectTextTool,
        stopTool,
      ])

      // Step 1 — launch (the guide's call, fixture path substituted).
      const launched = (await dispatcher.dispatch('electron_launch', {
        main: MINIMAL_APP_MAIN,
      })) as SuccessResponse & { session_id: string; renderer_ready: boolean }
      expect(launched.ok).toBe(true)
      const sessionId = launched.session_id

      try {
        // Step 2 — snapshot: the form's interactive elements are visible to the agent.
        const snap = (await dispatcher.dispatch('electron_snapshot', {
          sessionId,
        })) as SuccessResponse & {
          snapshot?: { entries?: ReadonlyArray<{ role?: string }> }
        }
        expect(snap.ok).toBe(true)
        expect((snap.snapshot?.entries ?? []).length).toBeGreaterThan(0)

        // Step 4 (guide order) — fill the form by selector.
        expect(
          (
            (await dispatcher.dispatch('electron_type', {
              sessionId,
              selector: '#name',
              text: 'Ada Lovelace',
            })) as SuccessResponse
          ).ok,
        ).toBe(true)
        expect(
          (
            (await dispatcher.dispatch('electron_check', {
              sessionId,
              selector: '#subscribe',
            })) as SuccessResponse
          ).ok,
        ).toBe(true)
        expect(
          (
            (await dispatcher.dispatch('electron_select_option', {
              sessionId,
              selector: '#plan',
              values: ['pro'],
            })) as SuccessResponse
          ).ok,
        ).toBe(true)

        // Step 3 — find the button by role + accessible name, no CSS.
        const found = (await dispatcher.dispatch('electron_find', {
          sessionId,
          role: 'button',
          name_contains: 'Greet',
        })) as SuccessResponse & {
          matches: ReadonlyArray<{ ref?: number | null }>
        }
        expect(found.ok).toBe(true)
        const ref = found.matches[0]?.ref
        expect(typeof ref).toBe('number')

        // Step 4 — click it BY REF, the agent-native addressing the guide teaches.
        expect(
          ((await dispatcher.dispatch('electron_click', { sessionId, ref })) as SuccessResponse).ok,
        ).toBe(true)

        // Step 5 — one-call verification, exactly as documented.
        const verdict = (await dispatcher.dispatch('electron_expect_text', {
          sessionId,
          selector: '#status',
          contains: 'Hello, Ada Lovelace',
        })) as SuccessResponse & { matched: boolean; actual: string }
        expect(verdict.ok).toBe(true)
        expect(verdict.matched).toBe(true)
        expect(verdict.actual).toContain('Plan: pro')
      } finally {
        // Step 7 — always stop, even on a failing path (the guide's closing rule).
        await dispatcher.dispatch('electron_stop', { sessionId })
      }
    },
    60_000,
  )
})
