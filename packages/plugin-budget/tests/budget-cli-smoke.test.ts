/**
 * Real-Electron smoke for `measureApp`, the engine of the CLI `measure` command: one cold and one
 * warm launch of the fixture on a throwaway profile, with a workload that blocks the main thread.
 * Opt-in via `STAGEWRIGHT_E2E=1`.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { loadBudget } from '../src/budget.js'
import { measureBundle } from '../src/bundle.js'
import { checkRun } from '../src/check.js'
import { measureApp } from '../src/measure.js'
import { summarizeRun } from '../src/run.js'

const RUN_E2E = process.env['STAGEWRIGHT_E2E'] === '1'
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
      const impossible = checkRun(run, { mainThread: { maxStallMs: 50 } }, { strict: true })
      expect(impossible).toMatchObject({ passed: false, reason: 'OVER_BUDGET' })
    },
    120_000,
  )
})
