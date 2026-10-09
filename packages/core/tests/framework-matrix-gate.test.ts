import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  qualifyMatrix,
  REQUIRED_FRAMEWORKS,
  SCENARIO_ROUND_TRIPS,
  writeMatrixReport,
} from '../../../examples/framework-matrix/matrix.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const fixtures = REQUIRED_FRAMEWORKS.map((name) => ({
  name,
  main: path.join(root, 'examples/framework-matrix/fixtures', name, 'main.js'),
  notes: 'unit runner fixture',
}))

describe('four-framework qualification gate', () => {
  it('rejects zero, missing and duplicate framework rows', async () => {
    const run = async () => ({ name: 'vanilla', ok: true, roundTrips: SCENARIO_ROUND_TRIPS })
    for (const inventory of [
      [],
      fixtures.slice(1),
      [
        ...fixtures.slice(1),
        { ...fixtures[0], name: 'react', main: fixtures[0]?.main ?? '', notes: 'duplicate' },
      ],
    ]) {
      await expect(qualifyMatrix(inventory, run)).rejects.toThrow('exactly vanilla')
    }
  })

  it('records all rows, including a broken greeting and missing fixture', async () => {
    const rows = fixtures.map((f) =>
      f.name === 'angular' ? { ...f, main: '/missing-fixture/main.js' } : f,
    )
    const visited: string[] = []
    const results = await qualifyMatrix(rows, async (fixture) => {
      visited.push(fixture.name)
      if (fixture.name === 'react') throw new Error('Greeting no longer reflects controlled input')
      return { name: fixture.name, ok: true, roundTrips: SCENARIO_ROUND_TRIPS }
    })
    expect(visited).toEqual(['vanilla', 'react', 'vue'])
    expect(results.map((r) => r.name)).toEqual(REQUIRED_FRAMEWORKS)
    expect(results.map((r) => r.ok)).toEqual([true, false, true, false])
    const directory = await mkdtemp(path.join(tmpdir(), 'matrix-gate-'))
    try {
      const report = path.join(directory, 'result.json')
      await writeMatrixReport(report, results, 'source-test-sha')
      const data = JSON.parse(await readFile(report, 'utf8')) as {
        passed: boolean
        sourceSHA: string
      }
      expect(data.passed).toBe(false)
      expect(data.sourceSHA).toBe('source-test-sha')
      await writeMatrixReport(report, [], 'source-test-sha')
      expect((JSON.parse(await readFile(report, 'utf8')) as { passed: boolean }).passed).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('requires scenario execution rather than an empty or partial successful row', async () => {
    for (const roundTrips of [0, SCENARIO_ROUND_TRIPS - 1]) {
      const results = await qualifyMatrix(fixtures, async (fixture) => ({
        name: fixture.name,
        ok: true,
        roundTrips,
      }))
      expect(results.every((r) => !r.ok)).toBe(true)
    }
  })

  it('gates both dependency PR runtime qualification and release validation', async () => {
    for (const name of ['e2e-electron.yml', 'release.yml']) {
      const workflow = await readFile(path.join(root, '.github/workflows', name), 'utf8')
      expect(workflow).toContain('run: xvfb-run --auto-servernum pnpm matrix')
      expect(workflow).toContain('path: output/framework-matrix/results.json')
      expect(workflow).toContain('if-no-files-found: error')
      expect(workflow).toContain('if: always()')
    }
  })
})
