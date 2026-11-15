/**
 * Manifest drift test — pins the workspace's toolchain floors to each other so
 * they cannot silently diverge:
 *
 * 1. `packageManager` (the exact pnpm CI/corepack resolves) must satisfy the
 *    `engines.pnpm` floor — a bumped engines range with a stale packageManager
 *    (or vice versa) breaks contributors in a way local dev rarely surfaces.
 * 2. `engines.node`'s major must be the line `.nvmrc` names, and every workflow must read
 *    `.nvmrc`, so CI always runs the floor the manifest declares.
 * 3. Every workspace package that declares `engines.node` must declare the SAME
 *    floor as the root — a package cannot be more (or less) demanding than the
 *    workspace that gates it.
 */

import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

interface ManifestSlice {
  readonly packageManager?: string
  readonly engines?: { readonly node?: string; readonly pnpm?: string }
}

async function readJson(filePath: string): Promise<ManifestSlice> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as ManifestSlice
}

/** Parse a `>=X.Y.Z`-style floor (the only range shape this workspace uses). */
function parseFloor(range: string): readonly [number, number, number] {
  const match = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(range)
  if (match === null) throw new Error(`unsupported engines range shape: "${range}"`)
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)]
}

/** Parse an exact `X.Y.Z` version. */
function parseExact(version: string): readonly [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (match === null) throw new Error(`unsupported version shape: "${version}"`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function atLeast(
  version: readonly [number, number, number],
  floor: readonly [number, number, number],
): boolean {
  if (version[0] !== floor[0]) return version[0] > floor[0]
  if (version[1] !== floor[1]) return version[1] > floor[1]
  return version[2] >= floor[2]
}

describe('manifest drift — packageManager vs engines vs CI matrix', () => {
  it('packageManager pnpm version satisfies the engines.pnpm floor', async () => {
    const root = await readJson(path.join(ROOT, 'package.json'))
    expect(root.packageManager, 'root package.json must pin packageManager').toBeDefined()
    expect(root.engines?.pnpm, 'root package.json must declare engines.pnpm').toBeDefined()

    const pinned = /^pnpm@(.+)$/.exec(root.packageManager ?? '')
    expect(
      pinned,
      `packageManager must be pnpm@<version>, got "${root.packageManager}"`,
    ).not.toBeNull()
    const version = parseExact(pinned?.[1] ?? '')
    const floor = parseFloor(root.engines?.pnpm ?? '')
    expect(
      atLeast(version, floor),
      `packageManager ${root.packageManager} does not satisfy engines.pnpm ${root.engines?.pnpm}`,
    ).toBe(true)
  })

  it('engines.node floor is the Node line named in .nvmrc', async () => {
    const root = await readJson(path.join(ROOT, 'package.json'))
    expect(root.engines?.node, 'root package.json must declare engines.node').toBeDefined()
    const floor = parseFloor(root.engines?.node ?? '')
    const line = (await fs.readFile(path.join(ROOT, '.nvmrc'), 'utf8')).trim()
    expect(line, '.nvmrc must name a Node major line').toMatch(/^\d+$/)
    expect(Number(line), `.nvmrc (${line}) must equal the engines.node major`).toBe(floor[0])
  })

  it('every workflow takes Node from .nvmrc', async () => {
    const dir = path.join(ROOT, '.github', 'workflows')
    const pinned: string[] = []
    let setups = 0
    for (const file of await fs.readdir(dir)) {
      if (!/\.ya?ml$/.test(file)) continue
      const workflow = await fs.readFile(path.join(dir, file), 'utf8')
      setups += (workflow.match(/node-version-file: \.nvmrc/g) ?? []).length
      if (/^\s+node-version:/m.test(workflow)) pinned.push(file)
    }
    expect(pinned, 'hard-coded node-version in workflows').toEqual([])
    expect(setups).toBeGreaterThan(0)
  })

  it('every workspace package with engines.node declares the same floor as the root', async () => {
    const root = await readJson(path.join(ROOT, 'package.json'))
    const rootNode = root.engines?.node
    expect(rootNode).toBeDefined()

    const packagesDir = path.join(ROOT, 'packages')
    const entries = await fs.readdir(packagesDir, { withFileTypes: true })
    const mismatched: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const manifestPath = path.join(packagesDir, entry.name, 'package.json')
      let manifest: ManifestSlice
      try {
        manifest = await readJson(manifestPath)
      } catch {
        continue
      }
      const node = manifest.engines?.node
      if (node !== undefined && node !== rootNode) {
        mismatched.push(`${entry.name}: "${node}" (root: "${rootNode}")`)
      }
    }
    expect(mismatched, `engines.node drift:\n${mismatched.join('\n')}`).toEqual([])
  })
})
