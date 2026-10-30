/**
 * Real-Electron reload smoke — `electron_reload` swaps in a new document (a value set on the old
 * page is gone and the navigation type is `reload`), reports the page ready, honours
 * `ignoreCache`, waits for `waitForSelector`, and times out with `WAIT_TIMEOUT` for a selector
 * that never appears. Runs on the Playwright launch and the CDP attach transports.
 *
 * Opt-in: runs only when `STAGEWRIGHT_E2E=1`.
 *
 * @module
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import { type SuccessResponse } from '../src/errors/envelope.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { SnapshotStore } from '../src/server/snapshot-store.js'
import { TransportRegistry } from '../src/server/transport-registry.js'
import { EVAL_TOOLS } from '../src/tools/eval/index.js'
import { attachTool } from '../src/tools/lifecycle/attach.js'
import {
  detachTool,
  launchTool,
  reloadTool,
  stopTool,
  surfacesListTool,
  switchSurfaceTool,
  windowsListTool,
} from '../src/tools/lifecycle/index.js'
import { waitForSelectorTool } from '../src/tools/wait/index.js'
import { CDPTransport, PlaywrightElectronTransport } from '../src/transports/index.js'

const RUN_E2E = process.env['STAGEWRIGHT_E2E'] === '1'
const FIXTURE_MAIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'minimal-electron',
  'main.js',
)

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
  dispatcher.registerAll([
    launchTool,
    stopTool,
    attachTool,
    detachTool,
    reloadTool,
    surfacesListTool,
    switchSurfaceTool,
    windowsListTool,
    waitForSelectorTool,
    ...EVAL_TOOLS,
  ])
  return dispatcher
}

async function checkReload(dispatcher: Dispatcher, sessionId: string): Promise<void> {
  for (const ignoreCache of [false, true]) {
    await dispatcher.dispatch('electron_eval_renderer', {
      sessionId,
      code: 'window.__beforeReload = true; return true',
    })
    await expect(
      dispatcher.dispatch('electron_reload', { sessionId, ignoreCache }),
    ).resolves.toMatchObject({
      ok: true,
      renderer_ready: true,
      url: expect.stringMatching(/index\.html$/),
    })
    await expect(
      dispatcher.dispatch('electron_eval_renderer', {
        sessionId,
        code: "return [typeof window.__beforeReload, performance.getEntriesByType('navigation')[0].type]",
      }),
    ).resolves.toMatchObject({ ok: true, result: ['undefined', 'reload'] })
  }

  await expect(
    dispatcher.dispatch('electron_reload', { sessionId, waitForSelector: '#ping' }),
  ).resolves.toMatchObject({ ok: true, renderer_ready: true })
  await expect(
    dispatcher.dispatch('electron_reload', {
      sessionId,
      waitForSelector: '#never-there',
      readyTimeoutMs: 1000,
    }),
  ).resolves.toMatchObject({ ok: false, code: 'WAIT_TIMEOUT' })

  // An explicit window id reloads that window.
  const listed = (await dispatcher.dispatch('electron_windows_list', {
    sessionId,
  })) as SuccessResponse & {
    windows: { id: string }[]
  }
  await expect(
    dispatcher.dispatch('electron_reload', { sessionId, windowId: listed.windows[0]?.id }),
  ).resolves.toMatchObject({ ok: true, renderer_ready: true })

  // With an iframe surface selected, the reload still completes from the window root.
  await dispatcher.dispatch('electron_eval_renderer', {
    sessionId,
    code: `const frame = document.createElement('iframe');
      frame.srcdoc = '<button>Inner</button>';
      document.body.append(frame);
      await new Promise((resolve) => frame.addEventListener('load', resolve));
      return true`,
  })
  const surfaces = (await dispatcher.dispatch('electron_surfaces_list', {
    sessionId,
  })) as SuccessResponse & {
    surfaces: { id: string; kind: string }[]
  }
  const frame = surfaces.surfaces.find((surface) => surface.kind === 'frame')
  expect(frame).toBeDefined()
  await dispatcher.dispatch('electron_switch_surface', { sessionId, surfaceId: frame?.id })
  await expect(
    dispatcher.dispatch('electron_reload', { sessionId, waitForSelector: '#ping' }),
  ).resolves.toMatchObject({ ok: true, renderer_ready: true })

  // The reloaded page is ready before it redirects; only the destination has this selector.
  await expect(
    dispatcher.dispatch('electron_eval_renderer', {
      sessionId,
      code: "sessionStorage.setItem('stagewright-reload-redirect', '1'); return true",
    }),
  ).resolves.toMatchObject({ ok: true })
  const redirected = await dispatcher.dispatch('electron_reload', {
    sessionId,
    waitForSelector: '#after-redirect',
    readyTimeoutMs: 5000,
  })
  expect(redirected, JSON.stringify(redirected)).toMatchObject({
    ok: true,
    renderer_ready: true,
    url: expect.stringContaining('reload-target=1'),
  })
}

describe('reload smoke (real Electron)', () => {
  it.skipIf(!RUN_E2E)(
    'reloads the page and waits for the new one on the launch transport',
    async () => {
      const profile = await mkdtemp(path.join(tmpdir(), 'stagewright-reload-launch-'))
      try {
        const dispatcher = newDispatcher(new PlaywrightElectronTransport())
        const launched = (await dispatcher.dispatch('electron_launch', {
          main: FIXTURE_MAIN,
          args: [`--stagewright-fixture-profile=${profile}`],
        })) as SuccessResponse & { session_id: string }
        try {
          await checkReload(dispatcher, launched.session_id)
        } finally {
          await dispatcher.dispatch('electron_stop', { sessionId: launched.session_id })
        }
      } finally {
        await rm(profile, { recursive: true, force: true, maxRetries: 3 })
      }
    },
    60_000,
  )

  it.skipIf(!RUN_E2E)(
    'reloads the page and waits for the new one on the CDP transport',
    async () => {
      const profile = await mkdtemp(path.join(tmpdir(), 'stagewright-reload-cdp-'))
      try {
        const electronPath = (await import('electron')).default as unknown as string
        const proc = spawn(
          electronPath,
          [FIXTURE_MAIN, '--remote-debugging-port=0', `--stagewright-fixture-profile=${profile}`],
          {
            stdio: ['ignore', 'ignore', 'pipe'],
          },
        )
        child = proc
        try {
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
          const attached = (await dispatcher.dispatch('electron_attach', {
            cdpUrl,
          })) as SuccessResponse & { session_id: string }
          await dispatcher.dispatch('electron_wait_for_selector', {
            sessionId: attached.session_id,
            selector: '#ping',
          })
          await checkReload(dispatcher, attached.session_id)
          await dispatcher.dispatch('electron_detach', { sessionId: attached.session_id })
        } finally {
          if (proc.pid !== undefined && proc.exitCode === null && proc.signalCode === null) {
            const exited = once(proc, 'exit')
            proc.kill('SIGKILL')
            await exited
          }
          child = undefined
        }
      } finally {
        await rm(profile, { recursive: true, force: true, maxRetries: 3 })
      }
    },
    60_000,
  )
})
