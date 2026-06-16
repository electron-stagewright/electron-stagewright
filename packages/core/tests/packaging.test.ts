/**
 * Publish-readiness gate. Asserts every PUBLISHABLE workspace package has a manifest npm can
 * publish without surprises, and that INTERNAL packages (examples, bench) stay unpublishable. Runs
 * in `pnpm test` as pure manifest inspection (no build needed), so a manifest that drifts out of
 * publish-correctness fails CI before it reaches a release rather than breaking the first
 * `npx @electron-stagewright/core`.
 *
 * Implements ADR-001 (the `@electron-stagewright` scope + MIT), ADR-002 (the ESM package shape and
 * Node floor), and the release posture of ADR-015. The matching release procedure is
 * `.github/RELEASING.md`.
 */

import { access, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')

/** A workspace package manifest loaded for inspection, paired with its location. */
interface PackageManifest {
  /** Absolute directory containing the `package.json`. */
  readonly dir: string
  /** Path relative to the repo root, e.g. `packages/core` — the expected `repository.directory`. */
  readonly relDir: string
  /** Parsed `package.json`. */
  readonly pkg: Readonly<Record<string, unknown>>
}

/** Load the package.json in each immediate subdirectory of `workspaceDir`, skipping non-packages. */
async function loadManifests(workspaceDir: string): Promise<PackageManifest[]> {
  const base = path.join(REPO_ROOT, workspaceDir)
  let entries: string[]
  try {
    entries = await readdir(base)
  } catch {
    return []
  }
  const manifests: PackageManifest[] = []
  for (const entry of entries.sort()) {
    const dir = path.join(base, entry)
    try {
      const text = await readFile(path.join(dir, 'package.json'), 'utf8')
      const pkg = JSON.parse(text) as Record<string, unknown>
      manifests.push({ dir, relDir: `${workspaceDir}/${entry}`, pkg })
    } catch {
      // Not a package directory (no readable package.json) — skip.
    }
  }
  return manifests
}

function isPrivate(pkg: Readonly<Record<string, unknown>>): boolean {
  return pkg['private'] === true
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/** Plain semver `x.y.z` with optional pre-release / build metadata. `0.0.0` is intentionally valid. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const NODE_ENGINE = '>=24.0.0'
const REQUIRED_FILE_ENTRIES = ['README.md', 'LICENSE'] as const

/** Collect the publish-correctness violations for one manifest (empty array = publish-ready). */
async function manifestViolations({ dir, relDir, pkg }: PackageManifest): Promise<string[]> {
  const out: string[] = []
  const fail = (msg: string): void => void out.push(`${relDir}: ${msg}`)

  const name = pkg['name']
  if (typeof name !== 'string' || !name.startsWith('@electron-stagewright/')) {
    fail(`name must be scoped @electron-stagewright/* (got ${String(name)})`)
  }
  const version = pkg['version']
  if (typeof version !== 'string' || !SEMVER.test(version)) {
    fail(`version must be valid semver (got ${String(version)})`)
  }
  if (pkg['license'] !== 'MIT') fail(`license must be MIT (got ${String(pkg['license'])})`)
  const description = pkg['description']
  if (typeof description !== 'string' || description.trim() === '') {
    fail('description must be a non-empty string')
  }
  if (pkg['type'] !== 'module') fail(`type must be "module" (got ${String(pkg['type'])})`)

  const repository = pkg['repository'] as { directory?: unknown } | undefined
  if (repository?.directory !== relDir) {
    fail(`repository.directory must be "${relDir}" (got ${String(repository?.directory)})`)
  }

  // ADR-002 Node floor must be declared exactly so npm rejects older runtimes at install.
  const engines = pkg['engines'] as { node?: unknown } | undefined
  if (engines?.node !== NODE_ENGINE) {
    fail(
      `engines.node must be ${NODE_ENGINE} (the ADR-002 Node floor; got ${String(engines?.node)})`,
    )
  }
  // Scoped packages default to restricted; this makes `pnpm publish` push them public.
  const publishConfig = pkg['publishConfig'] as { access?: unknown } | undefined
  if (publishConfig?.access !== 'public') {
    fail('publishConfig.access must be "public" (scoped packages default to restricted)')
  }

  const main = pkg['main']
  if (typeof main !== 'string' || !main.startsWith('./dist/')) {
    fail(`main must point under ./dist/ (got ${String(main)})`)
  }
  const types = pkg['types']
  if (typeof types !== 'string' || !types.startsWith('./dist/')) {
    fail(`types must point under ./dist/ (got ${String(types)})`)
  }

  const exportsObject = pkg['exports'] as
    | { '.'?: { types?: unknown; import?: unknown } }
    | undefined
  const exportsRoot = exportsObject?.['.']
  if (typeof exportsRoot?.types !== 'string' || !exportsRoot.types.startsWith('./dist/')) {
    fail(`exports["."].types must point under ./dist/ (got ${String(exportsRoot?.types)})`)
  }
  if (typeof exportsRoot?.import !== 'string' || !exportsRoot.import.startsWith('./dist/')) {
    fail(`exports["."].import must point under ./dist/ (got ${String(exportsRoot?.import)})`)
  }

  const bin = pkg['bin']
  if (bin !== undefined) {
    const targets = typeof bin === 'string' ? [bin] : Object.values(bin as Record<string, string>)
    for (const target of targets) {
      if (!String(target).startsWith('./dist/'))
        fail(`bin target must point under ./dist/ (got ${target})`)
    }
  }

  const files = pkg['files']
  if (!Array.isArray(files)) {
    fail('files must be an array')
  } else {
    const normalised = files.map((f) => String(f).replace(/\/$/, ''))
    if (!normalised.includes('dist')) fail('files must include "dist" (or "dist/")')
    for (const entry of REQUIRED_FILE_ENTRIES) {
      if (!normalised.includes(entry)) fail(`files must include "${entry}"`)
    }
    // Every concrete (non-directory) entry must exist on disk, or the published tarball ships a
    // dangling reference (a missing LICENSE is an npm warning and a licensing gap).
    for (const entry of files as string[]) {
      const isDirectory = entry.endsWith('/') || entry === 'dist'
      if (!isDirectory && !(await fileExists(path.join(dir, entry)))) {
        fail(`files lists "${entry}" but it does not exist in the package`)
      }
    }
  }
  for (const entry of REQUIRED_FILE_ENTRIES) {
    if (!(await fileExists(path.join(dir, entry)))) fail(`package must contain "${entry}"`)
  }

  // A first-party sibling dep must use the workspace protocol, so pnpm pins the real version at
  // publish instead of shipping an unresolvable `*` or a hand-edited drift. Cover every dependency
  // field, not just runtime deps — a first-party peer/optional dep would publish the same way.
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
    const deps = (pkg[field] ?? {}) as Record<string, string>
    for (const [depName, spec] of Object.entries(deps)) {
      if (depName.startsWith('@electron-stagewright/') && !spec.startsWith('workspace:')) {
        fail(`${field} ${depName} must use the workspace: protocol (got ${spec})`)
      }
    }
  }

  return out
}

describe('publish-readiness — publishable package manifests', () => {
  const validPublishablePkg: Readonly<Record<string, unknown>> = {
    name: '@electron-stagewright/example',
    version: '0.0.0',
    license: 'MIT',
    description: 'Example publishable package',
    type: 'module',
    repository: { directory: 'packages/core' },
    engines: { node: NODE_ENGINE },
    publishConfig: { access: 'public' },
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
    files: ['dist/', 'README.md', 'LICENSE'],
    dependencies: {},
  }

  const manifestFor = (pkg: Readonly<Record<string, unknown>>): PackageManifest => ({
    dir: path.join(REPO_ROOT, 'packages/core'),
    relDir: 'packages/core',
    pkg,
  })

  it('every publishable package has a publish-correct manifest', async () => {
    const publishable = (await loadManifests('packages')).filter((m) => !isPrivate(m.pkg))
    expect(publishable.length, 'expected at least one publishable package').toBeGreaterThan(0)

    const violations = (await Promise.all(publishable.map(manifestViolations))).flat()
    expect(
      violations,
      `publishable manifests must be publish-correct:\n${violations.join('\n')}`,
    ).toEqual([])
  })

  it('internal packages (examples + bench) are private so a publish never pushes them', async () => {
    const internal = [
      ...(await loadManifests('examples')),
      ...(await loadManifests('packages')).filter((m) => m.relDir === 'packages/bench'),
    ]
    expect(internal.length, 'expected internal packages to exist').toBeGreaterThan(0)

    const leaks = internal.filter((m) => !isPrivate(m.pkg)).map((m) => m.relDir)
    expect(leaks, `internal packages must be "private": true:\n${leaks.join('\n')}`).toEqual([])
  })

  it('rejects a publishable package that drifts below the ADR-002 Node floor', async () => {
    const violations = await manifestViolations(
      manifestFor({ ...validPublishablePkg, engines: { node: '>=22.0.0' } }),
    )

    expect(violations).toContain(
      'packages/core: engines.node must be >=24.0.0 (the ADR-002 Node floor; got >=22.0.0)',
    )
  })

  it('rejects a publishable package that drops README or LICENSE from the tarball allowlist', async () => {
    const violations = await manifestViolations(
      manifestFor({ ...validPublishablePkg, files: ['dist/'] }),
    )

    expect(violations).toEqual(
      expect.arrayContaining([
        'packages/core: files must include "README.md"',
        'packages/core: files must include "LICENSE"',
      ]),
    )
  })
})
