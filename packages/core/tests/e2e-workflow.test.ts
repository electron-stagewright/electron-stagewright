import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.resolve(TEST_DIRECTORY, '../../..')
const WORKFLOW = path.join(REPOSITORY_ROOT, '.github', 'workflows', 'e2e-electron.yml')

function jobBlock(workflow: string, job: string, nextJob: string): string {
  const start = workflow.indexOf(`  ${job}:\n`)
  const end = workflow.indexOf(`  ${nextJob}:\n`, start + 1)
  if (start < 0 || end < 0) throw new Error(`Unable to isolate ${job} from the E2E workflow.`)
  return workflow.slice(start, end)
}

describe('real-Electron workflow', () => {
  it('runs the complete gated suite and packed CLI on Windows', async () => {
    const workflow = (await readFile(WORKFLOW, 'utf8')).replaceAll('\r\n', '\n')
    const windows = jobBlock(workflow, 'e2e-windows', 'benchmark-diagnostics')

    expect(windows).toContain('name: Real-Electron smokes (windows)')
    expect(windows).toContain('runs-on: windows-latest')
    expect(windows).toContain('node-version: 24')
    expect(windows).toContain("require('electron')")
    expect(windows).toContain("STAGEWRIGHT_E2E: '1'")
    expect(windows).toContain('run: pnpm test')
    expect(windows).toContain('run: pnpm package:smoke')
    expect(windows).not.toMatch(/^\s+continue-on-error:/m)
  })
})
