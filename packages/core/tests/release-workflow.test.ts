import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'release.yml')
const SCRIPT = pathToFileURL(path.join(REPO_ROOT, 'scripts', 'release-publish.mjs')).href

describe('trusted npm publishing release guard', () => {
  it('uses a protected OIDC workflow without a long-lived publish credential', async () => {
    const workflow = await readFile(WORKFLOW, 'utf8')

    expect(workflow).toContain('release:\n    types: [published]')
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('id-token: write')
    expect(workflow).toContain('environment: npm-publish')
    expect(workflow).toContain('npm install --global npm@11.5.1')
    expect(workflow).toContain('pnpm verify')
    expect(workflow).toContain('xvfb-run --auto-servernum pnpm package:smoke')
    expect(workflow).toContain('scripts/release-publish.mjs --packages "$RELEASE_PACKAGES"')
    const workflowsDirectory = path.join(REPO_ROOT, '.github', 'workflows')
    const workflows = await Promise.all(
      (await readdir(workflowsDirectory))
        .filter((entry) => entry.endsWith('.yml') || entry.endsWith('.yaml'))
        .map((entry) => readFile(path.join(workflowsDirectory, entry), 'utf8')),
    )
    expect(workflows.join('\n')).not.toMatch(/(?:NPM|npm)_TOKEN/)
  })

  it('orders first-party runtime dependencies and rejects unsafe release arguments', async () => {
    const release = await import(SCRIPT)
    const ordered = release.orderPackages([
      {
        name: '@electron-stagewright/plugin-example',
        firstPartyDependencies: ['@electron-stagewright/core'],
      },
      { name: '@electron-stagewright/core', firstPartyDependencies: [] },
    ])

    expect(ordered.map((pkg: { name: string }) => pkg.name)).toEqual([
      '@electron-stagewright/core',
      '@electron-stagewright/plugin-example',
    ])
    expect(() => release.parseReleaseArguments(['--publish', '--include-published'])).toThrow(
      '--include-published is dry-run only and cannot be combined with --publish',
    )
    expect(release.isSupportedNpmVersion('11.5.1')).toBe(true)
    expect(release.isSupportedNpmVersion('11.5.0')).toBe(false)
  })
})
