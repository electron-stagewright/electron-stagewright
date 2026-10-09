import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import inventory from '../../../scripts/real-test-inventory.json' with { type: 'json' }
import { assertRealExecution } from '../../../scripts/real-test-report.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

async function testFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (['node_modules', 'dist'].includes(entry.name)) continue
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await testFiles(full)))
    else if (entry.name.endsWith('.test.ts')) files.push(full)
  }
  return files
}

describe('reviewed real-runtime inventory', () => {
  it('exactly matches all executable opt-ins, including every scenario', async () => {
    const discovered = []
    for (const file of await testFiles(path.join(root, 'packages'))) {
      const source = await readFile(file, 'utf8')
      // Any read of the opt-in variable, however it is spelled, must be a reviewed real-runtime
      // file; otherwise the unit project would skip it forever and no lane would execute it.
      if (/process\.env(?:\.STAGEWRIGHT_E2E\b|\[\s*['"]STAGEWRIGHT_E2E['"]\s*\])/.test(source)) {
        discovered.push({
          path: path.relative(root, file).split(path.sep).join('/'),
          tests: source.split('it.skipIf(').length - 1,
        })
      }
    }
    expect(discovered.sort((a, b) => a.path.localeCompare(b.path))).toEqual(
      inventory
        .map(({ path: file, tests }) => ({ path: file, tests }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    )
    expect(inventory).toHaveLength(24)
  })

  it('fails if discovery or opt-in silently leaves every test pending', () => {
    const passing = {
      success: true,
      testResults: inventory.map((row) => ({
        name: path.join(root, row.path),
        assertionResults: Array.from({ length: row.tests }, () => ({ status: 'passed' })),
      })),
    }
    expect(() => assertRealExecution(passing, inventory, root, 'linux')).not.toThrow()
    expect(() =>
      assertRealExecution({ ...passing, testResults: [] }, inventory, root, 'linux'),
    ).toThrow('count')
    const skipped = {
      ...passing,
      testResults: passing.testResults.map((row) => ({
        ...row,
        assertionResults: row.assertionResults.map(() => ({ status: 'pending' })),
      })),
    }
    expect(() => assertRealExecution(skipped, inventory, root, 'linux')).toThrow('did not execute')
    const missing = {
      ...passing,
      testResults: passing.testResults.map((row) => ({ ...row, assertionResults: [] })),
    }
    expect(() => assertRealExecution(missing, inventory, root, 'linux')).toThrow('Missing')
  })

  it('keeps six ordinary OS/Node cells and requires real commands in each runtime lane', async () => {
    const ci = await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8')
    expect(ci).toContain('os: [ubuntu-latest, macos-latest, windows-latest]')
    expect(ci).toContain('node: [24, 26]')
    const runtime = await readFile(path.join(root, '.github/workflows/e2e-electron.yml'), 'utf8')
    expect(runtime.match(/run: (?:xvfb-run --auto-servernum )?pnpm test:real/g)).toHaveLength(3)
    expect(runtime.match(/run: (?:xvfb-run --auto-servernum )?pnpm package:smoke/g)).toHaveLength(3)
  })
})
