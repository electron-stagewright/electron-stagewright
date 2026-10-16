/** Guard the copy-paste onboarding path against unpublished packages and moving npx defaults. */

import { readdir, readFile } from 'node:fs/promises'
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

    // Electron fetches its binary on first use and prints to stdout, so each bootstrap must
    // download it with install-electron before doctor and before any MCP host starts the server.
    for (const doc of [readme, coreReadme, connectionGuide, demoGuide, pluginsGuide]) {
      expect(doc).toContain('electron-stagewright doctor --json')
      expect(doc).toContain('install-electron')
      expect(doc.indexOf('install-electron')).toBeLessThan(
        doc.indexOf('electron-stagewright doctor --json'),
      )
      expect(doc).toMatch(/stdout/)
    }
    expect(demoGuide).toContain(`${DEMO_PACKAGE.name}@${DEMO_PACKAGE.version}`)
    expect(pluginsGuide).toContain(`${TRACE_PACKAGE.name}@${TRACE_PACKAGE.version}`)
  })

  it('keeps npx from reusing a project copy of a pinned package', async () => {
    const sources = [
      'README.md',
      'llms.txt',
      'packages/core/README.md',
      'docs/guides/connect-your-mcp-client.md',
      'docs/guides/demo.md',
      'docs/guides/plugins.md',
    ]
    const missing: string[] = []
    for (const source of sources) {
      const text = await readRepoFile(...source.split('/'))
      // Without --prefix, npx leaves out any listed package the project at the cwd already has.
      const commands = [...text.matchAll(/npx(?:\.cmd)? -y\b|"-y",/g)]
      expect(commands.length, source).toBeGreaterThan(0)
      for (const command of commands) {
        const rest = text.slice((command.index ?? 0) + command[0].length)
        if (!/^(?: --prefix ~\/ |\s*"--prefix",\s*"~\/")/.test(rest)) {
          missing.push(`${source}: ${text.slice(command.index, (command.index ?? 0) + 60)}`)
        }
      }
    }
    expect(missing, 'add --prefix ~/ right after -y').toEqual([])
  })

  it('pins every documented package to the version this tree publishes', async () => {
    const packageVersions = new Map<string, string>()
    const packageDirs = await readdir(path.join(REPO_ROOT, 'packages'))
    for (const dir of packageDirs) {
      const manifest = JSON.parse(
        await readRepoFile('packages', dir, 'package.json').catch(() => '{}'),
      ) as { readonly name?: string; readonly version?: string }
      if (manifest.name !== undefined && manifest.version !== undefined) {
        packageVersions.set(manifest.name, manifest.version)
      }
    }
    const guides = (await readdir(path.join(REPO_ROOT, 'docs', 'guides'))).filter((name) =>
      name.endsWith('.md'),
    )
    const sources = [
      'README.md',
      'llms.txt',
      'packages/core/scripts/build-docs-site.ts',
      ...packageDirs.map((dir) => `packages/${dir}/README.md`),
      ...guides.map((name) => `docs/guides/${name}`),
    ]
    const expected = new Map<string, string>([
      ...packageVersions,
      ['playwright', exactDevVersion('playwright')],
      ['electron', exactDevVersion('electron')],
    ])

    const stale: string[] = []
    for (const source of sources) {
      const text = await readRepoFile(...source.split('/')).catch(() => '')
      for (const match of text.matchAll(
        /(@electron-stagewright\/[a-z0-9-]+|(?<![\w@/-])(?:playwright|electron))@(\d+\.\d+\.\d+)/g,
      )) {
        const [, name, version] = match
        const want = expected.get(name ?? '')
        if (want !== undefined && version !== want) stale.push(`${source}: ${name}@${version}`)
      }
    }
    expect(stale, 'update these pins with the release').toEqual([])
  })
})
