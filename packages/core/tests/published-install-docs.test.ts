/** Guard the copy-paste onboarding path against unpublished packages and moving npx defaults. */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')
const CORE_PACKAGE = JSON.parse(
  await readFile(path.join(REPO_ROOT, 'packages', 'core', 'package.json'), 'utf8'),
) as {
  readonly name: string
  readonly version: string
  readonly devDependencies: Record<string, string>
}
const TRACE_PACKAGE = JSON.parse(
  await readFile(path.join(REPO_ROOT, 'packages', 'plugin-trace', 'package.json'), 'utf8'),
) as { readonly name: string; readonly version: string }

function exactDevVersion(name: string): string {
  const range = CORE_PACKAGE.devDependencies[name]
  if (range === undefined || !/^\^?\d+\.\d+\.\d+$/.test(range)) {
    throw new Error(`Expected ${name} to use an exact caret-or-exact release version in core.`)
  }
  return range.replace(/^\^/, '')
}

const PINNED_LAUNCH_PACKAGES = [
  `${CORE_PACKAGE.name}@${CORE_PACKAGE.version}`,
  `playwright@${exactDevVersion('playwright')}`,
  `electron@${exactDevVersion('electron')}`,
] as const

async function readRepoFile(...parts: string[]): Promise<string> {
  return readFile(path.join(REPO_ROOT, ...parts), 'utf8')
}

describe('published-install documentation', () => {
  it('pins the published core launch command and keeps Claude setup project-local', async () => {
    const [docs, gettingStarted] = await Promise.all([
      Promise.all([
        readRepoFile('README.md'),
        readRepoFile('packages', 'core', 'README.md'),
        readRepoFile('docs', 'guides', 'connect-your-mcp-client.md'),
      ]),
      readRepoFile('docs', 'guides', 'getting-started.md'),
    ])

    for (const doc of docs) {
      for (const packageSpecifier of PINNED_LAUNCH_PACKAGES) {
        expect(doc).toContain(packageSpecifier)
      }
      expect(doc).not.toContain('--scope user')
    }
    expect([...docs, gettingStarted].join('\n')).not.toContain('electron-stagewright doctor --json')
  })

  it('pins the published trace example and does not advertise an unpublished demo install', async () => {
    const [pluginsGuide, demoGuide] = await Promise.all([
      readRepoFile('docs', 'guides', 'plugins.md'),
      readRepoFile('docs', 'guides', 'demo.md'),
    ])

    for (const packageSpecifier of [
      ...PINNED_LAUNCH_PACKAGES,
      `${TRACE_PACKAGE.name}@${TRACE_PACKAGE.version}`,
    ]) {
      expect(pluginsGuide).toContain(packageSpecifier)
    }
    expect(demoGuide).toMatch(/not yet published to\s+npm/)
    expect(demoGuide).not.toMatch(
      /(?:--package\s+|"--package",\s*")@electron-stagewright\/demo|npm install -g @electron-stagewright\/demo/,
    )
  })
})
