/**
 * Real-Electron budget smoke: launch the fixture, measure every metric through the real main and
 * renderer, block the main thread on purpose, and gate the result against a loose and an
 * impossible budget. Opt-in via `STAGEWRIGHT_E2E=1`.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createServer } from '@electron-stagewright/core'
import { afterAll, describe, expect, it } from 'vitest'

import budgetPlugin from '../src/index.js'

const RUN_E2E = process.env['STAGEWRIGHT_E2E'] === '1'
const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'budget-app',
)
const BUDGET = path.join(FIXTURE_DIR, 'perf-budget.json')

const closers: Array<() => Promise<void>> = []
afterAll(async () => {
  await Promise.all(closers.splice(0).map((c) => c().catch(() => undefined)))
})

interface Row {
  readonly id: string
  readonly value: number
  readonly metric?: string
}
interface Result {
  readonly id: string
  readonly status: string
  readonly actual?: number
}

describe('budget plugin smoke (real Electron)', () => {
  it.skipIf(!RUN_E2E)(
    'measures a real app and gates it against a budget',
    async () => {
      const server = await createServer({ plugins: [budgetPlugin], allowEval: true })
      closers.push(() => server.close())
      const dispatch = (name: string, args: Record<string, unknown>) =>
        server.dispatcher.dispatch(name, args) as Promise<Record<string, unknown>>

      const launched = await dispatch('electron_launch', {
        main: path.join(FIXTURE_DIR, 'main.js'),
      })
      expect(launched['ok']).toBe(true)
      const sessionId = (launched['session_id'] ??
        (launched['_meta'] as { session_id?: string }).session_id) as string
      // loadEventEnd is only set once the load event has finished.
      const loaded = await dispatch('electron_eval_renderer', {
        sessionId,
        code: `await new Promise((resolve) => {
          if (document.readyState === 'complete') resolve();
          else addEventListener('load', resolve);
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        return document.title;`,
      })
      expect(loaded['ok']).toBe(true)

      // Idle window: every metric is present and the main thread is not blocked.
      const idle = await dispatch('budget_measure', { sessionId, budgetPath: BUDGET })
      expect(idle).toMatchObject({ ok: true, platform: process.platform })
      const rows = idle['measured'] as Row[]
      const value = (id: string, metric?: string) =>
        rows.find((r) => r.id === id && (metric === undefined || r.metric === metric))?.value
      const metric = { darwin: 'footprint', linux: 'pss', win32: 'privateBytes' }[
        process.platform as 'darwin' | 'linux' | 'win32'
      ]
      expect(idle['unavailable']).toBeUndefined()
      expect(value('memory.main', metric)).toBeGreaterThan(5)
      expect(value('memory.renderer', metric)).toBeGreaterThan(5)
      expect(value('memory.main', 'workingSet')).toBeGreaterThan(5)
      expect(value('startup.firstWindowMs')).toBeGreaterThan(0)
      expect(value('ipc.p99Ms')).toBeGreaterThanOrEqual(0)
      expect(value('mainThread.maxStallMs')).toBeLessThan(250)

      // Block the main thread inside an open window; the sampler must see it.
      expect(await dispatch('budget_start', { sessionId, budgetPath: BUDGET })).toMatchObject({
        ok: true,
        ipc_probe: true,
      })
      await dispatch('electron_eval_renderer', { sessionId, code: 'return window.api.block(400)' })
      const loose = await dispatch('budget_check', { sessionId, budgetPath: BUDGET })
      expect(loose).toMatchObject({ ok: true, passed: true })
      const results = loose['results'] as Result[]
      expect(results.filter((r) => r.status !== 'pass')).toEqual([])
      expect(results.find((r) => r.id === 'mainThread.maxStallMs')?.actual).toBeGreaterThan(300)
      expect(results.find((r) => r.id === 'bundle.renderer')?.actual).toBeGreaterThan(0)

      // An impossible budget fails, and names what failed.
      const dir = await mkdtemp(path.join(tmpdir(), 'sw-budget-smoke-'))
      closers.push(() => rm(dir, { recursive: true, force: true }))
      const impossible = path.join(dir, 'impossible.json')
      await writeFile(
        impossible,
        JSON.stringify({
          memory: { [process.platform]: { metric, perTypeMb: { main: 1 } } },
        }),
      )
      const failed = await dispatch('budget_check', { sessionId, budgetPath: impossible })
      expect(failed).toMatchObject({ ok: true, passed: false, reason: 'OVER_BUDGET' })
      expect((failed['results'] as Result[])[0]).toMatchObject({
        id: 'memory.main',
        status: 'fail',
      })

      expect((await dispatch('electron_stop', { sessionId }))['ok']).toBe(true)
    },
    90_000,
  )
})
