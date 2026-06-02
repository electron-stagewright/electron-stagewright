/**
 * Runner for the cross-framework robustness matrix. Runs the shared scenario against
 * every framework fixture in order, prints a summary table, and exits non-zero if ANY
 * fixture fails — so one broken framework fails the command without hiding the rest.
 *
 * Run (after `pnpm install` + `pnpm build` at the repo root):
 *   pnpm matrix
 * or, scoped:
 *   pnpm --filter @electron-stagewright/framework-matrix matrix
 *
 * The `matrix` script builds the bundled fixtures (e.g. React) first, then runs this.
 *
 * @module
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { type FrameworkFixture, runFixture, type ScenarioResult } from './harness.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** The fixtures in the matrix. Add a row + a `fixtures/<name>/` directory to extend it. */
const FIXTURES: ReadonlyArray<FrameworkFixture> = [
  {
    name: 'vanilla',
    main: path.join(HERE, 'fixtures/vanilla/main.js'),
    notes: 'baseline — direct DOM, no framework or build step',
  },
  {
    name: 'react',
    main: path.join(HERE, 'fixtures/react/main.js'),
    notes: 'controlled input + synthetic events, esbuild JSX bundle',
  },
]

/** Print one line to stderr (stdout is reserved; nothing prints there). */
function log(line: string): void {
  process.stderr.write(`${line}\n`)
}

async function main(): Promise<void> {
  log(`Running the framework matrix (${FIXTURES.length} fixtures)...`)
  const results: ScenarioResult[] = []
  for (const fixture of FIXTURES) {
    log(`\n• ${fixture.name} — ${fixture.notes}`)
    results.push(await runFixture(fixture))
  }

  // Summary table.
  log('\nFramework matrix results')
  log('────────────────────────')
  for (const r of results) {
    const verdict = r.ok ? 'PASS' : 'FAIL'
    const tail = r.error ? ` — ${r.error}` : ''
    log(`  ${verdict}  ${r.name.padEnd(10)} ${String(r.roundTrips).padStart(2)} round-trips${tail}`)
  }

  const failed = results.filter((r) => !r.ok)
  if (failed.length > 0) {
    log(`\n${failed.length} of ${results.length} fixtures FAILED.`)
    process.exitCode = 1
  } else {
    log(`\nAll ${results.length} fixtures passed.`)
  }
}

main().catch((err: unknown) => {
  log(`Matrix runner crashed: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
