/** CLI parser, bundle measurement, and the exit-code contract. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

import { afterEach, describe, expect, it } from 'vitest'

import { measureBundle } from '../src/bundle.js'
import {
  BUDGET_EXIT_CODES,
  parseBudgetCliArgs,
  runBudgetCliCommand,
  type BudgetCliDependencies,
} from '../src/cli.js'
import type { MeasureAppOptions } from '../src/measure.js'
import type { BudgetRun } from '../src/run.js'

import { measurement, run } from './helpers.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sw-budget-'))
  dirs.push(dir)
  await mkdir(path.join(dir, 'dist', 'chunks'), { recursive: true })
  await writeFile(path.join(dir, 'dist', 'main.js'), 'a'.repeat(2048))
  await writeFile(path.join(dir, 'dist', 'chunks', 'vendor.js'), 'b'.repeat(1024))
  await writeFile(path.join(dir, 'dist', 'main.js.map'), 'c'.repeat(9000))
  return dir
}

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

describe('parseBudgetCliArgs', () => {
  it('parses each subcommand strictly', () => {
    expect(
      parseBudgetCliArgs([
        'check',
        'run.json',
        '--budget',
        'b.json',
        '--strict',
        '--phase',
        'live',
      ]),
    ).toEqual({
      command: 'check',
      runPath: 'run.json',
      budgetPath: 'b.json',
      strict: true,
      requireMeasurement: false,
      phase: 'live',
      json: false,
    })
    expect(parseBudgetCliArgs(['compare', 'a.json', 'b.json', '--json'])).toMatchObject({
      command: 'compare',
      json: true,
    })
    expect(parseBudgetCliArgs(['bundle', '--help'])).toEqual({ command: 'help' })
    expect(() => parseBudgetCliArgs([])).toThrow(/subcommand/)
    expect(() => parseBudgetCliArgs(['check', 'run.json'])).toThrow(/--budget/)
    expect(() => parseBudgetCliArgs(['check', 'r', '--budget', 'b', '--nope'])).toThrow(/Unknown/)
    expect(() => parseBudgetCliArgs(['check', 'r', '--budget', 'b', '--phase', 'hot'])).toThrow(
      /--phase/,
    )
    expect(() => parseBudgetCliArgs(['compare', 'only-one.json'])).toThrow(/two run files/)
  })
})

describe('measureBundle', () => {
  it('sums a directory, filters by extension, and gzips on request', async () => {
    const dir = await workspace()
    const { entries } = await measureBundle(dir, [
      { path: 'dist', extensions: ['.js'], maxKb: 1 },
      { name: 'entry-gz', path: 'dist/main.js', gzip: true, maxKb: 1 },
    ])
    expect(entries[0]).toMatchObject({ id: 'dist', files: 2, bytes: 3072, gzip: false })
    expect(entries[1]).toMatchObject({
      id: 'entry-gz',
      files: 1,
      bytes: gzipSync(Buffer.from('a'.repeat(2048))).byteLength,
    })
  })

  it('marks a missing or empty entry unavailable instead of zero bytes', async () => {
    const dir = await workspace()
    const { entries } = await measureBundle(dir, [
      { path: 'nope', maxKb: 1 },
      { path: 'dist', extensions: ['.css'], maxKb: 1 },
    ])
    expect(entries[0]?.unavailable).toMatch(/does not exist/)
    expect(entries[1]?.unavailable).toMatch(/no file matched/)
  })
})

describe('electron-stagewright-budget', () => {
  it('bundle: passes, fails over budget, and writes the run', async () => {
    const dir = await workspace()
    const budgetPath = path.join(dir, 'perf-budget.json')
    const outPath = path.join(dir, 'out', 'run.json')
    const write = (maxKb: number) =>
      writeFile(
        budgetPath,
        JSON.stringify({ bundle: { entries: [{ path: 'dist', extensions: ['.js'], maxKb }] } }),
      )

    await write(4)
    const ok = await invoke(['bundle', '--budget', budgetPath, '--out', outPath])
    expect(ok.exitCode).toBe(BUDGET_EXIT_CODES.SUCCESS)
    expect(ok.stdout).toContain('| bundle.dist | 3 KB | 4 KB | 4 KB | pass |')
    expect(JSON.parse(await readFile(outPath, 'utf8')).bundle.entries[0].bytes).toBe(3072)

    await write(2)
    const over = await invoke(['bundle', '--budget', budgetPath, '--json'])
    expect(over.exitCode).toBe(BUDGET_EXIT_CODES.OVER_BUDGET)
    expect(JSON.parse(over.stdout)).toMatchObject({ passed: false, reason: 'OVER_BUDGET' })
  })

  it('bundle: an entry that matches nothing fails instead of passing empty', async () => {
    const dir = await workspace()
    const budgetPath = path.join(dir, 'perf-budget.json')
    await writeFile(
      budgetPath,
      JSON.stringify({ bundle: { entries: [{ path: 'gone', maxKb: 9 }] } }),
    )
    const result = await invoke(['bundle', '--budget', budgetPath])
    expect(result.exitCode).toBe(BUDGET_EXIT_CODES.OVER_BUDGET)
    expect(result.stdout).toContain('NO_MEASUREMENTS')
  })

  it('check and compare read run files; an empty run fails', async () => {
    const dir = await workspace()
    const budgetPath = path.join(dir, 'perf-budget.json')
    await writeFile(
      budgetPath,
      JSON.stringify({ memory: { darwin: { metric: 'footprint', perTypeMb: { main: 100 } } } }),
    )
    const save = async (name: string, value: unknown) => {
      const file = path.join(dir, name)
      await writeFile(file, JSON.stringify(value))
      return file
    }
    const good = await save('good.json', run([['warm', measurement(90)]]))
    const bad = await save('bad.json', run([['warm', measurement(140)]]))
    const empty = await save('empty.json', run([]))

    expect((await invoke(['check', good, '--budget', budgetPath])).exitCode).toBe(0)
    expect((await invoke(['check', bad, '--budget', budgetPath])).exitCode).toBe(1)
    expect((await invoke(['check', empty, '--budget', budgetPath])).exitCode).toBe(1)

    const compared = await invoke(['compare', good, bad])
    expect(compared.exitCode).toBe(0)
    expect(compared.stdout).toContain(
      '| memory.main (warm) [footprint] | 90 MB | 140 MB | +55.6% |',
    )
    expect((await invoke(['compare', empty, empty])).exitCode).toBe(1)
  })

  it('exits 2 on usage errors and unreadable input', async () => {
    const dir = await workspace()
    const notRun = path.join(dir, 'not-run.json')
    await writeFile(notRun, '{}')
    const budgetPath = path.join(dir, 'b.json')
    await writeFile(budgetPath, '{ "startup": { "maxFirstWindowMs": 1 } }')

    expect((await invoke(['wat'])).exitCode).toBe(2)
    expect((await invoke(['check', notRun, '--budget', budgetPath])).exitCode).toBe(2)
    expect(
      (await invoke(['check', notRun, '--budget', path.join(dir, 'missing.json')])).exitCode,
    ).toBe(2)
    const noBundle = await invoke(['bundle', '--budget', budgetPath])
    expect(noBundle.exitCode).toBe(2)
    expect(noBundle.stderr).toContain('no "bundle" section')
    const bundleBudget = path.join(dir, 'bundle.json')
    await writeFile(
      bundleBudget,
      JSON.stringify({ bundle: { entries: [{ path: 'dist', maxKb: 99 }] } }),
    )
    const crashed = await invoke(['bundle', '--budget', bundleBudget, '--out', dir])
    expect(crashed.exitCode).toBe(2)
    expect(crashed.stderr).toContain('fatal')
    expect((await invoke(['--help'])).stdout).toContain('Usage:')
  })
})

describe('measure', () => {
  function fakeMeasure(result: BudgetRun) {
    const seen: MeasureAppOptions[] = []
    const deps: BudgetCliDependencies = {
      measureApp: async (options) => {
        seen.push(options)
        return result
      },
    }
    return { deps, seen }
  }

  it('parses launch, rounds, phases, and repeatable flags', () => {
    const parsed = parseBudgetCliArgs([
      'measure',
      '--main',
      '/app/main.js',
      '--arg',
      '--lang=es',
      '--env',
      'MODE=test=1',
      '--rounds',
      '5',
      '--phases',
      'warm',
      '--budget',
      'b.json',
      '--check',
      '--strict',
    ])
    expect(parsed).toMatchObject({
      command: 'measure',
      main: path.resolve('/app/main.js'),
      args: ['--lang=es'],
      env: { MODE: 'test=1' },
      rounds: 5,
      phases: ['warm'],
      check: true,
      strict: true,
    })
    const bad = (argv: string[]) => () => parseBudgetCliArgs(['measure', ...argv])
    expect(bad([])).toThrow(/--main/)
    expect(bad(['--main', 'm.js', '--rounds', '0'])).toThrow(/--rounds/)
    expect(bad(['--main', 'm.js', '--phases', 'hot'])).toThrow(/--phases/)
    expect(bad(['--main', 'm.js', '--check'])).toThrow(/--budget/)
    expect(bad(['--main', 'm.js', '--strict'])).toThrow(/only with --check/)
    expect(bad(['--main', 'm.js', '--env', 'NOVALUE'])).toThrow(/KEY=VALUE/)
  })

  it('writes the run, adds the bundle, and gates with --check', async () => {
    const dir = await workspace()
    const budgetPath = path.join(dir, 'perf-budget.json')
    await writeFile(
      budgetPath,
      JSON.stringify({
        memory: { darwin: { metric: 'footprint', perTypeMb: { main: 100 } } },
        bundle: { entries: [{ path: 'dist', extensions: ['.js'], maxKb: 4 }] },
      }),
    )
    const outPath = path.join(dir, 'run.json')
    const { deps, seen } = fakeMeasure(run([['warm', measurement(140)]]))
    const argv = ['measure', '--main', 'm.js', '--budget', budgetPath, '--out', outPath]

    const result = await invoke([...argv, '--check'], deps)
    expect(result.exitCode).toBe(BUDGET_EXIT_CODES.OVER_BUDGET)
    expect(result.stdout).toContain('| bundle.dist | 3 KB | 4 KB | 4 KB | pass |')
    expect(seen[0]).toMatchObject({ rounds: 3, phases: ['cold', 'warm'] })
    expect(JSON.parse(await readFile(outPath, 'utf8')).bundle.entries[0].bytes).toBe(3072)

    // Without --check it only records.
    expect((await invoke(argv, deps)).exitCode).toBe(BUDGET_EXIT_CODES.SUCCESS)
  })

  it('fails and writes nothing when no round was measured', async () => {
    const dir = await workspace()
    const outPath = path.join(dir, 'run.json')
    const { deps } = fakeMeasure(run([]))
    const result = await invoke(['measure', '--main', 'm.js', '--out', outPath], deps)
    expect(result.exitCode).toBe(BUDGET_EXIT_CODES.OVER_BUDGET)
    await expect(readFile(outPath, 'utf8')).rejects.toThrow()
  })

  it('rejects a workload that is not a function', async () => {
    const dir = await workspace()
    const workload = path.join(dir, 'workload.mjs')
    await writeFile(workload, 'export default 1\n')
    const result = await invoke(
      ['measure', '--main', 'm.js', '--workload', workload],
      fakeMeasure(run([])).deps,
    )
    expect(result.exitCode).toBe(BUDGET_EXIT_CODES.USAGE)
  })
})
