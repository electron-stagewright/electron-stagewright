/**
 * Real-Electron navigation smoke — reloads the renderer and calls renderer tools while it
 * navigates, on the Playwright launch and the CDP attach transports. A call that loses the page
 * must report a classified code (RENDERER_NAVIGATED, a miss on the new page, or a transport
 * timeout), never INTERNAL_ERROR.
 *
 * Opt-in: runs only when `STAGEWRIGHT_E2E=1`.
 *
 * @module
 */

import { type ChildProcess, spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import { type SuccessResponse } from '../src/errors/envelope.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { SnapshotStore } from '../src/server/snapshot-store.js'
import { TransportRegistry } from '../src/server/transport-registry.js'
import { EVAL_TOOLS } from '../src/tools/eval/index.js'
import { INTERACTION_TOOLS } from '../src/tools/interaction/index.js'
import { attachTool } from '../src/tools/lifecycle/attach.js'
import { detachTool, launchTool, stopTool } from '../src/tools/lifecycle/index.js'
import { screenshotTool } from '../src/tools/observe/index.js'
import { READ_TOOLS } from '../src/tools/read/index.js'
import { findTool, snapshotTool } from '../src/tools/snapshot/index.js'
import { waitForSelectorTool } from '../src/tools/wait/index.js'
import { CDPTransport, PlaywrightElectronTransport } from '../src/transports/index.js'

const RUN_E2E = process.env['STAGEWRIGHT_E2E'] === '1'
const FIXTURE_MAIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'minimal-electron',
  'main.js',
)
const TOOLS = [
  launchTool,
  stopTool,
  attachTool,
  detachTool,
  snapshotTool,
  findTool,
  screenshotTool,
  waitForSelectorTool,
  ...READ_TOOLS,
  ...INTERACTION_TOOLS,
  ...EVAL_TOOLS,
]
const QUICK = [0, 5, 20]
// A CDP capture mid-navigation can stall until its 15 s method timeout on Linux, so try it once.
const CALLS: readonly (readonly [string, Record<string, unknown>, readonly number[]])[] = [
  ['electron_snapshot', {}, QUICK],
  ['electron_find', { role: 'button' }, QUICK],
  ['electron_get_text', { selector: 'body' }, QUICK],
  ['electron_exists', { selector: 'button' }, QUICK],
  ['electron_screenshot', {}, [0]],
]

let child: ChildProcess | undefined

afterAll(() => {
  if (child !== undefined && child.exitCode === null) child.kill('SIGKILL')
})

function newDispatcher(transport: CDPTransport | PlaywrightElectronTransport): Dispatcher {
  const dispatcher = new Dispatcher({
    sessions: new SessionManager(),
    snapshots: new SnapshotStore(),
    transports: new TransportRegistry({ transports: [transport] }),
    allowEval: true,
  })
  dispatcher.registerAll(TOOLS)
  return dispatcher
}

/** Reload before each call and return every failure code seen while the page navigated. */
async function codesDuringReloads(dispatcher: Dispatcher, sessionId: string): Promise<string[]> {
  const codes: string[] = []
  for (let round = 0; round < 3; round++) {
    for (const [tool, args, delays] of CALLS) {
      await dispatcher.dispatch('electron_eval_renderer', {
        sessionId,
        code: 'setTimeout(() => location.reload(), 0); return 1',
      })
      for (const delayMs of delays) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        const res = (await dispatcher.dispatch(tool, { sessionId, ...args })) as {
          ok: boolean
          code?: string
        }
        if (!res.ok) codes.push(`${tool}: ${res.code}`)
      }
      await dispatcher.dispatch('electron_wait_for_selector', { sessionId, selector: 'body' })
    }
  }
  return codes
}

function internalErrors(codes: readonly string[]): string[] {
  return codes.filter((entry) => entry.endsWith(': INTERNAL_ERROR'))
}

describe('navigation smoke (real Electron)', () => {
  it.skipIf(!RUN_E2E)(
    'reports a navigation during renderer tools on the launch transport',
    async () => {
      const dispatcher = newDispatcher(new PlaywrightElectronTransport())
      const launched = (await dispatcher.dispatch('electron_launch', {
        main: FIXTURE_MAIN,
      })) as SuccessResponse & {
        session_id: string
      }
      try {
        expect(internalErrors(await codesDuringReloads(dispatcher, launched.session_id))).toEqual(
          [],
        )
      } finally {
        await dispatcher.dispatch('electron_stop', { sessionId: launched.session_id })
      }
    },
    120_000,
  )

  it.skipIf(!RUN_E2E)(
    'reports a navigation during renderer tools on the CDP transport',
    async () => {
      const electronPath = (await import('electron')).default as unknown as string
      const proc = spawn(electronPath, [FIXTURE_MAIN, '--remote-debugging-port=0'], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      child = proc
      const cdpUrl = await new Promise<string>((resolve, reject) => {
        let stderr = ''
        const timer = setTimeout(
          () => reject(new Error(`No DevTools endpoint:\n${stderr}`)),
          20_000,
        )
        proc.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString()
          const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr)
          if (match?.[1] !== undefined) {
            clearTimeout(timer)
            resolve(match[1])
          }
        })
      })
      const dispatcher = newDispatcher(new CDPTransport())
      try {
        const attached = (await dispatcher.dispatch('electron_attach', {
          cdpUrl,
        })) as SuccessResponse & {
          session_id: string
        }
        await dispatcher.dispatch('electron_wait_for_selector', {
          sessionId: attached.session_id,
          selector: 'button',
        })
        expect(internalErrors(await codesDuringReloads(dispatcher, attached.session_id))).toEqual(
          [],
        )
        await dispatcher.dispatch('electron_detach', { sessionId: attached.session_id })
      } finally {
        if (proc.exitCode === null) proc.kill('SIGKILL')
      }
    },
    120_000,
  )
})
