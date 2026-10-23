/**
 * Real-Electron window-size smoke — `electron_set_window_size` resizes the window, reports a
 * request below the app's minimum size as clamped with the real size, and sizes the content area,
 * on the launch, CDP attach and inject transports.
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
import { TransportRegistry } from '../src/server/transport-registry.js'
import { EVAL_TOOLS } from '../src/tools/eval/index.js'
import { attachTool, injectTool } from '../src/tools/lifecycle/attach.js'
import {
  detachTool,
  launchTool,
  setWindowSizeTool,
  stopTool,
} from '../src/tools/lifecycle/index.js'
import { CDPTransport, PlaywrightElectronTransport } from '../src/transports/index.js'
import { InjectorTransport } from '../src/transports/injector.js'

const RUN_E2E = process.env['STAGEWRIGHT_E2E'] === '1'
const FIXTURE_MAIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'minimal-electron',
  'main.js',
)
const MIN_SIZE = { width: 400, height: 450 }
const FIXTURE_ENV = { STAGEWRIGHT_FIXTURE_MIN_SIZE: `${MIN_SIZE.width}x${MIN_SIZE.height}` }

let child: ChildProcess | undefined

afterAll(() => {
  if (child !== undefined && child.exitCode === null) child.kill('SIGKILL')
})

function newDispatcher(
  transport: CDPTransport | PlaywrightElectronTransport | InjectorTransport,
): Dispatcher {
  const dispatcher = new Dispatcher({
    sessions: new SessionManager(),
    transports: new TransportRegistry({ transports: [transport] }),
    allowEval: true,
  })
  dispatcher.registerAll([
    launchTool,
    stopTool,
    attachTool,
    injectTool,
    detachTool,
    setWindowSizeTool,
    ...EVAL_TOOLS,
  ])
  return dispatcher
}

/** Spawn the fixture with a DevTools endpoint and resolve its URL. */
async function spawnFixture(extraArgs: readonly string[] = []): Promise<string> {
  const electronPath = (await import('electron')).default as unknown as string
  const proc = spawn(electronPath, [FIXTURE_MAIN, '--remote-debugging-port=0', ...extraArgs], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, ...FIXTURE_ENV },
  })
  child = proc
  return new Promise<string>((resolve, reject) => {
    let stderr = ''
    const timer = setTimeout(() => reject(new Error(`No DevTools endpoint:\n${stderr}`)), 20_000)
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr)
      if (match?.[1] !== undefined) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
  })
}

async function checkWindowSize(
  dispatcher: Dispatcher,
  sessionId: string,
  limitsKnown: boolean,
): Promise<void> {
  await expect(
    dispatcher.dispatch('electron_set_window_size', { sessionId, width: 640, height: 520 }),
  ).resolves.toMatchObject({
    ok: true,
    actual: { width: 640, height: 520 },
    clamped: false,
    window: { width: 640, height: 520 },
  })

  // Below the app's minimum height: the window stops there, and the result says so.
  await expect(
    dispatcher.dispatch('electron_set_window_size', { sessionId, width: 640, height: 300 }),
  ).resolves.toMatchObject({
    ok: true,
    requested: { width: 640, height: 300, area: 'window' },
    actual: { width: 640, height: MIN_SIZE.height },
    clamped: true,
    clamped_by: limitsKnown ? 'minimum_size' : 'window_system',
    min_size: limitsKnown ? MIN_SIZE : null,
  })

  await expect(
    dispatcher.dispatch('electron_set_window_size', {
      sessionId,
      width: 600,
      height: 480,
      area: 'content',
    }),
  ).resolves.toMatchObject({
    ok: true,
    actual: { width: 600, height: 480 },
    clamped: false,
    content: { width: 600, height: 480 },
  })
}

describe('window size smoke (real Electron)', () => {
  it.skipIf(!RUN_E2E)(
    'resizes and reports the clamp on the launch transport',
    async () => {
      const dispatcher = newDispatcher(new PlaywrightElectronTransport())
      const launched = (await dispatcher.dispatch('electron_launch', {
        main: FIXTURE_MAIN,
        env: FIXTURE_ENV,
      })) as SuccessResponse & { session_id: string }
      const sessionId = launched.session_id
      try {
        await checkWindowSize(dispatcher, sessionId, true)
        // The page sees the new content size.
        await expect(
          dispatcher.dispatch('electron_eval_renderer', {
            sessionId,
            code: 'return [innerWidth, innerHeight]',
          }),
        ).resolves.toMatchObject({ ok: true, result: [600, 480] })

        // A maximized window is restored before it is sized (when the platform maximizes at all).
        const maximized = (await dispatcher.dispatch('electron_eval_main', {
          sessionId,
          code: `const win = electronApp.BrowserWindow.getAllWindows()[0];
            win.maximize();
            await new Promise((resolve) => setTimeout(resolve, 300));
            return win.isMaximized()`,
        })) as SuccessResponse & { result: boolean }
        const resized = await dispatcher.dispatch('electron_set_window_size', {
          sessionId,
          width: 700,
          height: 500,
        })
        expect(resized).toMatchObject({ ok: true, actual: { width: 700, height: 500 } })
        if (maximized.result) expect(resized).toMatchObject({ restored_from: 'maximized' })
      } finally {
        await dispatcher.dispatch('electron_stop', { sessionId })
      }
    },
    60_000,
  )

  it.skipIf(!RUN_E2E)(
    'resizes from the page on the CDP transport',
    async () => {
      const cdpUrl = await spawnFixture()
      const dispatcher = newDispatcher(new CDPTransport())
      try {
        const attached = (await dispatcher.dispatch('electron_attach', {
          cdpUrl,
        })) as SuccessResponse & { session_id: string }
        await checkWindowSize(dispatcher, attached.session_id, false)
        await dispatcher.dispatch('electron_detach', { sessionId: attached.session_id })
      } finally {
        if (child?.exitCode === null) child.kill('SIGKILL')
      }
    },
    60_000,
  )

  it.skipIf(!RUN_E2E)(
    'resizes through the main process on the inject transport',
    async () => {
      // Windows needs an explicit inspector port, as in the inject smoke.
      await spawnFixture(process.platform === 'win32' ? ['--inspect=9229'] : [])
      const dispatcher = newDispatcher(new InjectorTransport())
      try {
        const injected = (await dispatcher.dispatch('electron_inject', {
          pid: child?.pid,
        })) as SuccessResponse & { session_id: string }
        expect(injected).toMatchObject({ ok: true })
        await checkWindowSize(dispatcher, injected.session_id, true)
        await dispatcher.dispatch('electron_detach', { sessionId: injected.session_id })
      } finally {
        if (child?.exitCode === null) child.kill('SIGKILL')
      }
    },
    60_000,
  )
})
