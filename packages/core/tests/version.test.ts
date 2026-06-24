/**
 * Version source-of-truth coverage. `readPackageVersion` is the shared reader that lets core and every
 * first-party plugin advertise their version from their own package.json instead of a duplicated
 * literal; the indirect coverage (server-version.test.ts, the per-plugin version tests) proves the
 * wiring, while this pins the reader's own contract — it resolves the manifest one directory above the
 * module URL and rejects a manifest with no usable version — and guards that no plugin source
 * reintroduces a hardcoded version literal.
 */

import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { readPackageVersion } from '../src/version.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')

/**
 * Write a package.json fixture to a fresh temp dir and return a module URL one directory below it. The
 * module file need not exist — `readPackageVersion` only resolves `../package.json` relative to it.
 */
async function fixtureModuleUrl(manifest: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'esw-version-'))
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(manifest), 'utf8')
  return pathToFileURL(path.join(dir, 'dist', 'index.js')).href
}

describe('readPackageVersion', () => {
  it('reads the version from the package.json one directory above the module', async () => {
    const moduleUrl = await fixtureModuleUrl({ name: 'fixture', version: '9.9.9' })
    expect(readPackageVersion(moduleUrl)).toBe('9.9.9')
  })

  it('throws when the manifest has no version field', async () => {
    const moduleUrl = await fixtureModuleUrl({ name: 'fixture' })
    expect(() => readPackageVersion(moduleUrl)).toThrow(/non-empty string/)
  })

  it('throws when the version is an empty string', async () => {
    const moduleUrl = await fixtureModuleUrl({ name: 'fixture', version: '' })
    expect(() => readPackageVersion(moduleUrl)).toThrow(/non-empty string/)
  })
})

describe('plugin version source of truth', () => {
  it('no first-party plugin hardcodes its version as a literal', async () => {
    const packagesDir = path.join(REPO_ROOT, 'packages')
    const pluginDirs = (await readdir(packagesDir))
      .filter((name) => name.startsWith('plugin-'))
      .sort()
    expect(pluginDirs.length, 'expected first-party plugin packages to exist').toBeGreaterThan(0)

    const offenders: string[] = []
    for (const dir of pluginDirs) {
      const entry = path.join(packagesDir, dir, 'src', 'index.ts')
      const src = (await readFile(entry, 'utf8')).replace(/\r\n/g, '\n')
      // A *_PLUGIN_VERSION assigned a string literal is the duplicated source of truth this retired;
      // it must read from the manifest via readPackageVersion(import.meta.url) instead.
      if (/_PLUGIN_VERSION\s*=\s*['"]/.test(src)) offenders.push(`packages/${dir}/src/index.ts`)
    }
    expect(offenders, 'plugins must read their version from package.json, not a literal').toEqual(
      [],
    )
  })
})
