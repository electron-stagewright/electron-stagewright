import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.resolve(TEST_DIRECTORY, '../../..')
const WORKFLOWS_DIRECTORY = path.join(REPOSITORY_ROOT, '.github', 'workflows')

const NODE_24_ACTION_REFS = new Map([
  ['actions/cache', 'v5'],
  ['actions/checkout', 'v6'],
  ['actions/deploy-pages', 'v5'],
  ['actions/setup-node', 'v6'],
  ['actions/upload-artifact', 'v7'],
  ['actions/upload-pages-artifact', 'v5'],
  ['pnpm/action-setup', 'v6'],
])

function actionReferences(workflow: string): ReadonlyArray<{
  readonly action: string
  readonly ref: string
}> {
  return [...workflow.matchAll(/uses:\s*["']?([^@"'\s]+)@([^"'#\s]+)["']?/g)].flatMap((match) => {
    const action = match[1]
    const ref = match[2]
    return action === undefined || ref === undefined ? [] : [{ action, ref }]
  })
}

describe('GitHub Actions runtime policy', () => {
  it('pins repository-owned JavaScript actions to Node 24-backed majors', async () => {
    const workflowFiles = (await readdir(WORKFLOWS_DIRECTORY))
      .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
      .sort()
    const observed = new Set<string>()

    for (const file of workflowFiles) {
      const workflow = await readFile(path.join(WORKFLOWS_DIRECTORY, file), 'utf8')
      for (const { action, ref } of actionReferences(workflow)) {
        if (!action.startsWith('actions/') && action !== 'pnpm/action-setup') continue
        expect(
          NODE_24_ACTION_REFS.has(action),
          `${file} must register ${action} in the audited Node runtime allowlist`,
        ).toBe(true)
        observed.add(action)
        expect(ref, `${file} must use ${action}@${NODE_24_ACTION_REFS.get(action)}`).toBe(
          NODE_24_ACTION_REFS.get(action),
        )
      }
    }

    expect(observed).toEqual(new Set(NODE_24_ACTION_REFS.keys()))
  })

  it('audits quoted action declarations instead of silently skipping them', () => {
    expect(
      actionReferences(
        ['- uses: "actions/checkout@v4"', "- uses: 'pnpm/action-setup@v3'"].join('\n'),
      ),
    ).toEqual([
      { action: 'actions/checkout', ref: 'v4' },
      { action: 'pnpm/action-setup', ref: 'v3' },
    ])
  })

  it('captures complete action refs so semver, branches, and SHAs cannot masquerade as majors', () => {
    expect(
      actionReferences(
        [
          '- uses: actions/checkout@v6.0.0',
          '- uses: actions/setup-node@main',
          '- uses: actions/cache@0123456789abcdef',
        ].join('\n'),
      ),
    ).toEqual([
      { action: 'actions/checkout', ref: 'v6.0.0' },
      { action: 'actions/setup-node', ref: 'main' },
      { action: 'actions/cache', ref: '0123456789abcdef' },
    ])
  })

  it('preserves the supported Node runtime matrix', async () => {
    const workflow = await readFile(path.join(WORKFLOWS_DIRECTORY, 'ci.yml'), 'utf8')

    expect(workflow).toContain('node: [24, 26]')
    expect(workflow).toContain('node-version: ${{ matrix.node }}')
  })

  it('keeps published startup measurement manual, cross-platform, and artifact-backed', async () => {
    const workflow = await readFile(path.join(WORKFLOWS_DIRECTORY, 'startup-benchmark.yml'), 'utf8')

    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('os: [ubuntu-latest, macos-latest, windows-latest]')
    expect(workflow).toContain('node-version: 24')
    expect(workflow).toContain('pnpm bench:startup')
    expect(workflow).toContain('actions/upload-artifact@v7')
    expect(workflow).toContain('path: output/startup-*')
    expect(workflow.match(/type: choice/g)).toHaveLength(3)
    expect(workflow).toContain('COLD_RUNS: ${{ inputs.cold_runs }}')
    expect(workflow).toContain('--cold-runs "$COLD_RUNS"')
    expect(workflow).not.toContain('pull_request:')
    expect(workflow).not.toContain('push:')
  })
})
