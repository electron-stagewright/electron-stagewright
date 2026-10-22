/**
 * Real-Electron inject smoke — injects the Node inspector into a running app that
 * started without a debug flag, then drives the main process: `electron_eval_main`
 * receives the electron module as `electronApp` / `arguments[0]` (the launch
 * contract), and `electron_info` reads the app through it.
 *
 * Opt-in: runs only when `STAGEWRIGHT_E2E=1`. On Windows, where the inspector
 * trigger is unreliable, the app starts with `--inspect` so inject takes its
 * documented discovery fallback.
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
import { injectTool } from '../src/tools/lifecycle/attach.js'
import { detachTool, infoTool } from '../src/tools/lifecycle/index.js'
import { InjectorTransport } from '../src/transports/injector.js'

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

/** Spawn the fixture and resolve once Chromium is up, so the inspector trigger lands on a ready app. */
async function spawnReady(): Promise<ChildProcess> {
  const electronPath = (await import('electron')).default as unknown as string
  // The remote-debugging port is only a readiness signal here; inject never uses it.
  const args = [FIXTURE_MAIN, '--remote-debugging-port=0']
  if (process.platform === 'win32') args.push('--inspect=9229')
  const proc = spawn(electronPath, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child = proc
  await new Promise<void>((resolve, reject) => {
    let stderr = ''
    const timer = setTimeout(() => reject(new Error(`Electron never started:\n${stderr}`)), 20_000)
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (stderr.includes('DevTools listening on')) {
        clearTimeout(timer)
        resolve()
      }
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Electron exited (${code}) during startup:\n${stderr}`))
    })
  })
  return proc
}

describe('inject smoke (real Electron)', () => {
  it.skipIf(!RUN_E2E)(
    'injects into a running app and evaluates in main with the electron module',
    async () => {
      const proc = await spawnReady()
      const sessions = new SessionManager()
      const dispatcher = new Dispatcher({
        sessions,
        transports: new TransportRegistry({ transports: [new InjectorTransport()] }),
        allowEval: true,
      })
      dispatcher.registerAll([injectTool, detachTool, infoTool, ...EVAL_TOOLS])
      try {
        const injected = (await dispatcher.dispatch('electron_inject', {
          pid: proc.pid,
        })) as SuccessResponse & { session_id: string }
        expect(injected).toMatchObject({ ok: true, transport: 'injector' })
        const sessionId = injected.session_id

        const main = await dispatcher.dispatch('electron_eval_main', {
          sessionId,
          code: 'return [typeof arguments[0].dialog.showOpenDialog, arguments[0] === electronApp, arg.n]',
          arg: { n: 7 },
        })
        expect(main).toMatchObject({ ok: true, result: ['function', true, 7] })

        const info = await dispatcher.dispatch('electron_info', { sessionId })
        expect(info).toMatchObject({ ok: true, transport: 'injector', app: { packaged: false } })
        expect(
          (info as SuccessResponse & { versions: { electron: unknown } }).versions.electron,
        ).toBeTypeOf('string')

        await dispatcher.dispatch('electron_detach', { sessionId })
        // Detach leaves the injected app running.
        expect(proc.exitCode).toBeNull()
      } finally {
        if (proc.exitCode === null) proc.kill('SIGKILL')
      }
    },
    60_000,
  )
})
