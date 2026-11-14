/**
 * Real-Electron smoke for `measureApp`, the engine of the CLI `measure` command: one cold and one
 * warm launch of the fixture on a throwaway profile, with a workload that blocks the main thread.
 * Opt-in via `STAGEWRIGHT_E2E=1`.
 */

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { loadBudget } from '../src/budget.js'
import { measureBundle } from '../src/bundle.js'
import { checkRun } from '../src/check.js'
import { measureApp } from '../src/measure.js'
import { summarizeRun } from '../src/run.js'

const RUN_E2E = process.env['STAGEWRIGHT_E2E'] === '1'

/** Core's Electron binary, read from `path.txt` so nothing triggers a download. */
async function electronBinary(): Promise<string> {
  const requireCore = createRequire(
    fileURLToPath(new URL('../../core/package.json', import.meta.url)),
  )
  const directory = path.dirname(requireCore.resolve('electron/package.json'))
  const override = process.env['ELECTRON_OVERRIDE_DIST_PATH']
  const relative = (await readFile(path.join(directory, 'path.txt'), 'utf8').catch(() => '')).trim()
  return path.join(override || path.join(directory, 'dist'), relative || 'electron')
}
const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'budget-app',
)

describe('budget measure smoke (real Electron)', () => {
  it.skipIf(!RUN_E2E)(
    'measures cold and warm rounds and gates them',
    async () => {
      const budget = await loadBudget(path.join(FIXTURE_DIR, 'perf-budget.json'))
      const phases: string[] = []
      const run = await measureApp({
        launch: { main: path.join(FIXTURE_DIR, 'main.js') },
        rounds: 1,
        settleMs: 300,
        budget,
        workload: async ({ dispatch, sessionId, phase }) => {
          phases.push(phase)
          const blocked = await dispatch('electron_eval_renderer', {
            sessionId,
            code: 'return window.api.block(300)',
          })
          expect(blocked['ok']).toBe(true)
        },
      })

      expect(phases).toEqual(['cold', 'warm'])
      expect(run.rounds.map((round) => round.phase)).toEqual(['cold', 'warm'])
      expect(run.platform).toBe(process.platform)
      expect(run.electron_version).toMatch(/^\d+\./)
      for (const round of run.rounds) {
        expect(round.measurement.unavailable).toBeUndefined()
        expect(round.measurement.mainThread?.maxStallMs).toBeGreaterThan(200)
      }
      const rows = summarizeRun(run)
      expect(
        rows.find((r) => r.id === 'startup.firstWindowMs' && r.phase === 'cold')?.value,
      ).toBeGreaterThan(0)
      expect(rows.find((r) => r.id === 'memory.main' && r.phase === 'warm')?.value).toBeGreaterThan(
        5,
      )

      const bundle = await measureBundle(FIXTURE_DIR, budget.bundle?.entries ?? [])
      const report = checkRun({ ...run, bundle }, budget, { requireMeasurement: true })
      expect(report.results.filter((result) => result.status !== 'pass')).toEqual([])
      expect(report.passed).toBe(true)
      const impossible = checkRun(
        run,
        { mainThread: { maxStallMs: 50 } },
        { ignoreThreshold: true },
      )
      expect(impossible).toMatchObject({ passed: false, reason: 'OVER_BUDGET' })
    },
    120_000,
  )

  it.skipIf(!RUN_E2E)(
    'prepares each round with beforeRound and skips a round that fails',
    async () => {
      const profiles: string[] = []
      const run = await measureApp({
        launch: { main: path.join(FIXTURE_DIR, 'main.js') },
        rounds: 2,
        phases: ['cold'],
        settleMs: 100,
        windowMs: 250,
        failedRounds: 'skip',
        beforeRound: ({ round, profile }) => {
          profiles.push(profile)
          if (round === 1) throw new Error('fixture copy failed')
          return { env: { BUDGET_ROUND: String(round) }, args: ['--lang=en'] }
        },
      })
      expect(profiles).toHaveLength(2)
      expect(new Set(profiles).size).toBe(2)
      expect(run.rounds.map((round) => [round.round, round.phase])).toEqual([[2, 'cold']])
    },
    120_000,
  )

  it.skipIf(!RUN_E2E)(
    'measures memory and its peak without main eval, through the memory probe',
    async () => {
      const electron = await electronBinary()
      const run = await measureApp({
        // An executable launch goes over CDP only, as a build with the inspect fuse off must.
        launch: { executablePath: electron, args: [path.join(FIXTURE_DIR, 'main.js')] },
        rounds: 1,
        phases: ['cold'],
        settleMs: 300,
        windowMs: 1_500,
        memorySampleMs: 250,
        budget: {
          memoryProbe: 'window.api.metrics()',
          memory: {
            [process.platform]: {
              metric: 'workingSet',
              aggregate: 'peak',
              perTypeMb: { main: 4096 },
            },
          },
        },
      })
      const [round] = run.rounds
      expect(round?.measurement.unavailable?.['mainThread']).toMatch(/main eval is unavailable/)
      expect(round?.measurement.unavailable?.['memory']).toBeUndefined()
      expect(round?.measurement.memory?.processes.some((entry) => entry.type === 'main')).toBe(true)
      expect(round?.measurement.memoryPeak).toBeDefined()
      expect(run.electron_version).toMatch(/^\d+\./)
      const rows = summarizeRun(run)
      expect(rows.find((row) => row.id === 'memoryPeak.main')?.value).toBeGreaterThan(5)
    },
    120_000,
  )
})
