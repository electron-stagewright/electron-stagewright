import { access, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { FrameworkFixture, ScenarioResult } from './harness.js'

export const REQUIRED_FRAMEWORKS = ['vanilla', 'react', 'vue', 'angular'] as const

/** A complete scenario makes the launch call plus the nine shared greeting steps. */
export const SCENARIO_ROUND_TRIPS = 10

export async function qualifyMatrix(
  fixtures: readonly FrameworkFixture[],
  run: (fixture: FrameworkFixture) => Promise<ScenarioResult>,
): Promise<ScenarioResult[]> {
  const names = fixtures.map((fixture) => fixture.name)
  if (
    names.length !== REQUIRED_FRAMEWORKS.length ||
    new Set(names).size !== names.length ||
    REQUIRED_FRAMEWORKS.some((name) => !names.includes(name))
  ) {
    throw new Error('Qualification requires exactly vanilla, react, vue and angular')
  }
  const results: ScenarioResult[] = []
  for (const fixture of fixtures) {
    try {
      await access(fixture.main)
      const result = await run(fixture)
      if (result.name !== fixture.name || (result.ok && result.roundTrips < SCENARIO_ROUND_TRIPS)) {
        throw new Error(`Incomplete scenario evidence for ${fixture.name}`)
      }
      results.push(result)
    } catch (error) {
      results.push({
        name: fixture.name,
        ok: false,
        roundTrips: 0,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return results
}

export async function writeMatrixReport(
  destination: string,
  results: readonly ScenarioResult[],
  sourceSHA: string,
  error?: string,
): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true })
  const passed =
    error === undefined &&
    results.length === REQUIRED_FRAMEWORKS.length &&
    REQUIRED_FRAMEWORKS.every((name) => results.some((r) => r.name === name && r.ok))
  await writeFile(
    destination,
    JSON.stringify(
      {
        schemaVersion: 1,
        sourceSHA,
        requiredFrameworks: REQUIRED_FRAMEWORKS,
        passed,
        results,
        error,
      },
      null,
      2,
    ) + '\n',
  )
}
