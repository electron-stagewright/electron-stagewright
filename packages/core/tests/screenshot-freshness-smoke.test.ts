/**
 * Real-Electron screenshot freshness smoke — two captures without a change report the same content
 * hash (`same_as_previous`), a capture taken right after a DOM change shows the new state (a
 * different hash), the frame wait ran, and reusing a path reports `overwrote`. Runs on the
 * Playwright launch and the CDP attach transports.
 *
 * Opt-in: runs only when `STAGEWRIGHT_E2E=1`.
 *
 * @module
 */

import { type ChildProcess, spawn } from 'node:child_process'
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
import { detachTool, launchTool, stopTool } from '../src/tools/lifecycle/index.js'
import { makeScreenshotTool } from '../src/tools/observe/index.js'
import { waitForSelectorTool } from '../src/tools/wait/index.js'
import { CDPTransport, PlaywrightElectronTransport } from '../src/transports/index.js'

const RUN_E2E = process.env['STAGEWRIGHT_E2E'] === '1'
const FIXTURE_MAIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'minimal-electron',
  'main.js',
)

type Capture = SuccessResponse & {
  content_sha256: string
  same_as_previous: boolean
  overwrote: boolean
  frame_waited: boolean
}

let child: ChildProcess | undefined
const dirs: string[] = []

afterAll(async () => {
  if (child !== undefined && child.exitCode === null) child.kill('SIGKILL')
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
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
    makeScreenshotTool(),
    waitForSelectorTool,
    ...EVAL_TOOLS,
  ])
  return dispatcher
}

async function checkFreshness(dispatcher: Dispatcher, sessionId: string): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sw-fresh-smoke-'))
  dirs.push(dir)
  const capture = async (extra: Record<string, unknown> = {}): Promise<Capture> => {
    const res = (await dispatcher.dispatch('electron_screenshot', {
      sessionId,
      dir,
      ...extra,
    })) as Capture
    expect(res).toMatchObject({ ok: true, frame_waited: true })
    return res
  }

  const first = await capture()
  const unchanged = await capture()
  expect(unchanged).toMatchObject({
    same_as_previous: true,
    content_sha256: first.content_sha256,
  })

  // Change the page, then capture at once: the image shows the new state.
  await dispatcher.dispatch('electron_eval_renderer', {
    sessionId,
    code: "document.querySelector('h1').textContent = 'Changed ' + Date.now(); return true",
  })
  const changed = await capture()
  expect(changed.same_as_previous).toBe(false)
  expect(changed.content_sha256).not.toBe(unchanged.content_sha256)

  const file = path.join(dir, 'fixed.png')
  await expect(capture({ path: file, dir: undefined })).resolves.toMatchObject({
    overwrote: false,
  })
  await expect(capture({ path: file, dir: undefined })).resolves.toMatchObject({ overwrote: true })
}

describe('screenshot freshness smoke (real Electron)', () => {
  it.skipIf(!RUN_E2E)(
    'captures the current frame and reports unchanged captures on the launch transport',
    async () => {
      const dispatcher = newDispatcher(new PlaywrightElectronTransport())
      const launched = (await dispatcher.dispatch('electron_launch', {
        main: FIXTURE_MAIN,
      })) as SuccessResponse & { session_id: string }
      try {
        await checkFreshness(dispatcher, launched.session_id)
      } finally {
        await dispatcher.dispatch('electron_stop', { sessionId: launched.session_id })
      }
    },
    60_000,
  )

  it.skipIf(!RUN_E2E)(
    'captures the current frame and reports unchanged captures on the CDP transport',
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
        })) as SuccessResponse & { session_id: string }
        await dispatcher.dispatch('electron_wait_for_selector', {
          sessionId: attached.session_id,
          selector: 'h1',
        })
        await checkFreshness(dispatcher, attached.session_id)
        await dispatcher.dispatch('electron_detach', { sessionId: attached.session_id })
      } finally {
        if (proc.exitCode === null) proc.kill('SIGKILL')
      }
    },
    60_000,
  )
})
