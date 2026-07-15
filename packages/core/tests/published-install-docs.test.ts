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
const DEMO_PACKAGE = JSON.parse(
  await readFile(path.join(REPO_ROOT, 'packages', 'demo', 'package.json'), 'utf8'),
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
    expect([...docs, gettingStarted].join('\n')).toContain('electron-stagewright doctor --json')
  })

  it('pins the published trace and demo examples', async () => {
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
    for (const packageSpecifier of [
      ...PINNED_LAUNCH_PACKAGES,
      `${DEMO_PACKAGE.name}@${DEMO_PACKAGE.version}`,
    ]) {
      expect(demoGuide).toContain(packageSpecifier)
    }
    expect(demoGuide).not.toMatch(/not yet published to\s+npm/)
  })

  it('primes each npx package set outside an MCP stdio session', async () => {
    const [readme, coreReadme, connectionGuide, demoGuide, pluginsGuide] = await Promise.all([
      readRepoFile('README.md'),
      readRepoFile('packages', 'core', 'README.md'),
      readRepoFile('docs', 'guides', 'connect-your-mcp-client.md'),
      readRepoFile('docs', 'guides', 'demo.md'),
      readRepoFile('docs', 'guides', 'plugins.md'),
    ])

    for (const doc of [readme, coreReadme, connectionGuide, demoGuide, pluginsGuide]) {
      expect(doc).toContain('electron-stagewright doctor --json')
    }
    expect([readme, coreReadme, connectionGuide, demoGuide, pluginsGuide].join('\n')).toMatch(
      /binary-download.*stdout|stdout.*binary-download/is,
    )
    expect(demoGuide).toContain(`${DEMO_PACKAGE.name}@${DEMO_PACKAGE.version}`)
    expect(pluginsGuide).toContain(`${TRACE_PACKAGE.name}@${TRACE_PACKAGE.version}`)
  })
})
