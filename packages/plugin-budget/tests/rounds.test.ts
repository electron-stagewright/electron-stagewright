import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { Budget } from '../src/budget.js'
import { checkRun } from '../src/check.js'
import { runBudgetCliCommand, type BudgetCliDependencies } from '../src/cli.js'
import { measureApp, type MeasureAppOptions } from '../src/measure.js'
import { mergeRuns } from '../src/run.js'
import { measurement, run } from './helpers.js'

const budget: Budget = { memory: { darwin: { metric: 'footprint', perTypeMb: { main: 100 } } } }

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('mergeRuns', () => {
  it('numbers rounds across runs and keeps a run’s cold and warm in one round', () => {
    const merged = mergeRuns([
      run([['cold', measurement(80)]], { electron_version: '45.0.0' }),
      {
        ...run([]),
        rounds: [
          { round: 1, phase: 'cold', measurement: measurement(90) },
          { round: 1, phase: 'warm', measurement: measurement(95) },
        ],
      },
      run([['cold', measurement(300)]]),
    ])
    expect(merged.rounds.map((round) => [round.round, round.phase])).toEqual([
      [1, 'cold'],
      [2, 'cold'],
      [2, 'warm'],
      [3, 'cold'],
    ])
    expect(merged.electron_version).toBe('45.0.0')
    const main = checkRun(merged, budget, { phase: 'cold' }).results[0]
    expect(main).toMatchObject({ actual: 90, status: 'pass' })
  })

  it('refuses runs from different platforms and an empty list', () => {
    expect(() => mergeRuns([run([]), run([], { platform: 'win32' })])).toThrow(/cannot merge/)
    expect(() => mergeRuns([])).toThrow(/at least one/)
  })
})

describe('minSamples', () => {
  it('leaves a median that rests on too few rounds unmeasured', () => {
    const one = run([['cold', measurement(80)]])
    const result = checkRun(one, budget, { minSamples: 2 }).results[0]
    expect(result).toMatchObject({ status: 'unmeasured', actual: 80 })
    expect(result?.detail).toMatch(/1 of the 2 rounds/)
    const two = run([
      ['cold', measurement(80)],
      ['cold', measurement(90)],
    ])
    expect(checkRun(two, budget, { minSamples: 2 }).passed).toBe(true)
  })

  it('never applies to bundle entries', () => {
    const bundled = run([], {
      bundle: { entries: [{ id: 'app', path: 'app', gzip: false, files: 1, bytes: 1024 }] },
    })
    const report = checkRun(
      bundled,
      { bundle: { entries: [{ name: 'app', path: 'app', maxKb: 2 }] } },
      {
        minSamples: 3,
      },
    )
    expect(report.passed).toBe(true)
  })
})

async function invoke(argv: readonly string[], deps?: BudgetCliDependencies) {
  const stdout: string[] = []
  const stderr: string[] = []
  const exitCode = await runBudgetCliCommand(
    argv,
    { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
    deps,
  )
  return { exitCode, stdout: stdout.join(''), stderr: stderr.join('') }
}

describe('measureApp rounds', () => {
  it('fails with the first error when every round failed, even when skipping', async () => {
    const progress: string[] = []
    await expect(
      measureApp({
        launch: { main: 'missing.js' },
        rounds: 2,
        failedRounds: 'skip',
        beforeRound: ({ round }) => {
          throw new Error(`fixture ${round} broken`)
        },
        onProgress: (message) => void progress.push(message),
      }),
    ).rejects.toThrow('fixture 1 broken')
    expect(progress.filter((line) => line.includes('was skipped'))).toHaveLength(2)
  })

  it('refuses a beforeRound result that is not strings', async () => {
    await expect(
      measureApp({
        launch: { main: 'missing.js' },
        rounds: 1,
        beforeRound: () => ({ args: '--enable-logging' }) as unknown as { args: string[] },
      }),
    ).rejects.toThrow(TypeError)
  })
})

describe('CLI rounds', () => {
  it('merges several run files before checking, with --min-samples', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sw-budget-rounds-'))
    dirs.push(dir)
    const budgetPath = path.join(dir, 'budget.json')
    await writeFile(budgetPath, JSON.stringify(budget))
    const paths = await Promise.all(
      [80, 90, 400].map(async (mb, index) => {
        const file = path.join(dir, `run-${index}.json`)
        await writeFile(file, JSON.stringify(run([['cold', measurement(mb)]])))
        return file
      }),
    )
    const merged = await invoke(['check', ...paths, '--budget', budgetPath, '--json'])
    expect(merged.exitCode).toBe(0)
    expect(JSON.parse(merged.stdout).results[0]).toMatchObject({ actual: 90, phase: 'cold' })
    const thin = await invoke([
      'check',
      paths[0] as string,
      '--budget',
      budgetPath,
      '--min-samples',
      '2',
    ])
    expect(thin.exitCode).toBe(1)
    expect(thin.stdout).toContain('1 of the 2 rounds')
  })

  it('passes --before-round and --skip-failed-rounds to measureApp', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sw-budget-rounds-'))
    dirs.push(dir)
    const script = path.join(dir, 'before.mjs')
    await writeFile(
      script,
      'export default async ({ round }) => ({ env: { ROUND: String(round) } })\n',
    )
    const seen: MeasureAppOptions[] = []
    const deps: BudgetCliDependencies = {
      measureApp: async (options) => {
        seen.push(options)
        return run([['cold', measurement(80)]])
      },
    }
    const result = await invoke(
      ['measure', '--main', 'm.js', '--before-round', script, '--skip-failed-rounds'],
      deps,
    )
    expect(result.exitCode).toBe(0)
    expect(seen[0]?.failedRounds).toBe('skip')
    expect(await seen[0]?.beforeRound?.({ round: 2, profile: '/tmp/p' })).toEqual({
      env: { ROUND: '2' },
    })
    expect(
      (
        await invoke(
          [
            'measure',
            '--main',
            'm.js',
            '--rounds',
            '1',
            '--budget',
            'b.json',
            '--check',
            '--min-samples',
            '2',
          ],
          deps,
        )
      ).stderr,
    ).toContain('can never be met')
    expect(
      (await invoke(['check', 'r.json', 'r.json', '--budget', 'b.json'], deps)).stderr,
    ).toContain('same run file twice')
    const missing = await invoke(
      ['measure', '--main', 'm.js', '--before-round', path.join(dir, 'no.mjs')],
      deps,
    )
    expect(missing.exitCode).toBe(2)
    expect(missing.stderr).toContain('Cannot load before-round script')
  })
})
