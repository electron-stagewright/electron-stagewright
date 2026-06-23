/**
 * Publish-readiness gate. Asserts every PUBLISHABLE workspace package has a manifest npm can
 * publish without surprises, and that INTERNAL packages (examples, bench) stay unpublishable. Runs
 * in `pnpm test` as pure manifest inspection (no build needed), so a manifest that drifts out of
 * publish-correctness fails CI before it reaches a release rather than breaking the first
 * `npx @electron-stagewright/core`.
 *
 * Implements ADR-001 (the `@electron-stagewright` scope + MIT), ADR-002 (the ESM package shape and
 * Node floor), and the release posture of ADR-015. The matching release procedure is
 * `.github/RELEASING.md`; a second suite here pins that doc's "What publishes" list to the real
 * publishable-package set so it cannot silently go stale.
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

// --- RELEASING.md "What publishes" drift guard ------------------------------
// The release doc keeps a hand-maintained list of the packages a release pushes
// to npm. That list has drifted before (it named fewer packages than actually
// publish, and a human caught it, not CI). These checks pin the prose to the real
// workspace so a stale list fails the build. Pairs with the manifest gate above;
// both back the procedure in .github/RELEASING.md and the ADR-001/002/015 posture.

const RELEASING_DOC = path.join(REPO_ROOT, '.github', 'RELEASING.md')

/** One package entry parsed from the RELEASING.md "What publishes" bullet list. */
interface ReleasingEntry {
  /** Scoped package name, e.g. `@electron-stagewright/core`. */
  readonly name: string
  /** The human gloss from the trailing `(...)`, trimmed; empty string when absent. */
  readonly gloss: string
}

/**
 * The publish declarations parsed from RELEASING.md's "What publishes" section:
 * the packages it lists as publishable, plus the `packages/` dirs the prose names
 * as internal/private. Parsed (rather than hard-coded in the test) so the doc
 * itself is the thing under test and a drift in either direction fails CI.
 */
interface ReleasingPublishables {
  /** Each publishable entry, in document order. */
  readonly entries: readonly ReleasingEntry[]
  /** Convenience view: the scoped names from `entries`, deduplicated. */
  readonly publishable: readonly string[]
  /** `packages/<name>` dirs the prose names as private (e.g. `packages/bench`). */
  readonly privatePackages: readonly string[]
}

/**
 * Parse the "What publishes" section out of RELEASING.md markdown. Line-ending
 * agnostic (a committed file checks out CRLF on Windows). Returns empty lists when
 * the section is absent, so the caller MUST assert non-emptiness to stay fail-loud
 * rather than vacuously green if the heading is ever renamed.
 */
function parseReleasingPublishables(markdown: string): ReleasingPublishables {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex((line) => /^##\s+What publishes\s*$/.test(line))
  const section: string[] = []
  if (start !== -1) {
    for (const line of lines.slice(start + 1)) {
      if (/^##\s/.test(line)) break
      section.push(line)
    }
  }

  const entries: ReleasingEntry[] = []
  for (const line of section) {
    const bullet = /^-\s+`(@electron-stagewright\/[a-z0-9-]+)`\s*(.*)$/.exec(line.trim())
    const name = bullet?.[1]
    if (name === undefined) continue
    const gloss = /^\(([^)]*)\)/.exec(bullet?.[2] ?? '')
    entries.push({ name, gloss: gloss?.[1]?.trim() ?? '' })
  }

  const sectionText = section.join('\n')
  const privatePackages = [
    ...new Set(
      [...sectionText.matchAll(/`(packages\/[a-z0-9-]+)`/g)]
        .map((match) => match[1])
        .filter((dir): dir is string => dir !== undefined),
    ),
  ]

  return {
    entries,
    publishable: [...new Set(entries.map((entry) => entry.name))],
    privatePackages,
  }
}

/** Read and parse `.github/RELEASING.md`. */
async function loadReleasingPublishables(): Promise<ReleasingPublishables> {
  return parseReleasingPublishables(await readFile(RELEASING_DOC, 'utf8'))
}

/** Symmetric difference between a documented name list and the real one. */
function publishableDrift(
  documented: readonly string[],
  actual: readonly string[],
): { missingFromDoc: string[]; extraInDoc: string[] } {
  const documentedSet = new Set(documented)
  const actualSet = new Set(actual)
  return {
    missingFromDoc: [...actualSet].filter((name) => !documentedSet.has(name)).sort(),
    extraInDoc: [...documentedSet].filter((name) => !actualSet.has(name)).sort(),
  }
}

/** A "What publishes" section missing a publishable package (drives the negative test). */
const STALE_RELEASING_FIXTURE = [
  '# Releasing',
  '',
  '## What publishes',
  '',
  'The publishable packages are every `packages/` entry that is not private:',
  '',
  '- `@electron-stagewright/core` (the CLI)',
  '- `@electron-stagewright/plugin-clock` (virtual time)',
  '',
  'Everything under `examples/` and `packages/bench` is `private: true`.',
  '',
  '## Versioning',
  '',
  'Semver.',
  '',
].join('\n')

/** A "What publishes" entry with no parenthetical gloss (drives the description test). */
const UNDESCRIBED_RELEASING_FIXTURE = [
  '## What publishes',
  '',
  '- `@electron-stagewright/core` (the CLI)',
  '- `@electron-stagewright/plugin-bare`',
  '',
  '## Versioning',
].join('\n')

describe('publish-readiness — RELEASING.md "What publishes" list', () => {
  it('names exactly the publishable packages, with no drift in either direction', async () => {
    const documented = await loadReleasingPublishables()
    const actual = (await loadManifests('packages'))
      .filter((m) => !isPrivate(m.pkg))
      .map((m) => String(m.pkg['name']))

    // Fail loud if the section is ever moved or renamed, instead of passing
    // vacuously on an empty parse.
    expect(
      documented.publishable.length,
      'parsed no packages from the "What publishes" section — has the heading changed?',
    ).toBeGreaterThan(0)

    const drift = publishableDrift(documented.publishable, actual)
    expect(
      drift,
      'RELEASING.md "What publishes" is out of sync with the publishable packages.\n' +
        `Missing from the doc: ${drift.missingFromDoc.join(', ') || '(none)'}\n` +
        `Listed but not publishable: ${drift.extraInDoc.join(', ') || '(none)'}`,
    ).toEqual({ missingFromDoc: [], extraInDoc: [] })
  })

  it('names exactly the internal (private) packages the workspace has', async () => {
    const documented = await loadReleasingPublishables()
    const actualPrivate = (await loadManifests('packages'))
      .filter((m) => isPrivate(m.pkg))
      .map((m) => m.relDir)

    expect(actualPrivate.length, 'expected at least one private packages entry').toBeGreaterThan(0)
    expect(
      [...documented.privatePackages].sort(),
      'RELEASING.md must name the same private packages dirs the workspace has',
    ).toEqual([...actualPrivate].sort())
  })

  it('gives every listed package a human description', async () => {
    const { entries } = await loadReleasingPublishables()
    const undescribed = entries.filter((entry) => entry.gloss === '').map((entry) => entry.name)
    expect(undescribed, 'every "What publishes" entry needs a parenthetical description').toEqual(
      [],
    )
  })

  it('lists the packages in sorted order', async () => {
    const { publishable } = await loadReleasingPublishables()
    expect(publishable, 'keep the "What publishes" list alphabetised by package name').toEqual(
      [...publishable].sort(),
    )
  })

  it('flags a package that is publishable but missing from the list', () => {
    const stale = parseReleasingPublishables(STALE_RELEASING_FIXTURE)
    const drift = publishableDrift(stale.publishable, [
      '@electron-stagewright/core',
      '@electron-stagewright/plugin-clock',
      '@electron-stagewright/plugin-ipc',
    ])
    expect(drift.missingFromDoc).toEqual(['@electron-stagewright/plugin-ipc'])
    expect(drift.extraInDoc).toEqual([])
  })

  it('flags a package that is listed but no longer publishable', () => {
    const drift = publishableDrift(
      ['@electron-stagewright/core', '@electron-stagewright/plugin-ghost'],
      ['@electron-stagewright/core'],
    )
    expect(drift.extraInDoc).toEqual(['@electron-stagewright/plugin-ghost'])
    expect(drift.missingFromDoc).toEqual([])
  })

  it('flags a list entry that has no description', () => {
    const parsed = parseReleasingPublishables(UNDESCRIBED_RELEASING_FIXTURE)
    const undescribed = parsed.entries
      .filter((entry) => entry.gloss === '')
      .map((entry) => entry.name)
    expect(undescribed).toEqual(['@electron-stagewright/plugin-bare'])
  })

  it('parses nothing when the "What publishes" section is absent', () => {
    const parsed = parseReleasingPublishables('# Releasing\n\nNo such section here.\n')
    expect(parsed.publishable).toEqual([])
    expect(parsed.entries).toEqual([])
  })
})
