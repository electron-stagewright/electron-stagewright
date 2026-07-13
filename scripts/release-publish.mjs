import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const ROOT = process.cwd()
const PACKAGES_DIR = path.join(ROOT, 'packages')
const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'
const MINIMUM_NPM_VERSION = [11, 5, 1]

/** Parse the small, explicit CLI surface used by the release workflow. */
export function parseReleaseArguments(argv) {
  const options = {
    packages: 'all',
    publish: false,
    includePublished: false,
    output: 'output/release',
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--publish') {
      options.publish = true
    } else if (arg === '--include-published') {
      options.includePublished = true
    } else if (arg === '--dry-run') {
      options.publish = false
    } else if (arg === '--packages' || arg === '--output') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} requires a value`)
      }
      if (arg === '--packages') options.packages = value
      else options.output = value
      index += 1
    } else {
      throw new Error(`Unknown release option: ${arg}`)
    }
  }

  if (options.includePublished && options.publish) {
    throw new Error('--include-published is dry-run only and cannot be combined with --publish')
  }
  return options
}

/** Return true when a semver triple meets npm's OIDC minimum CLI version. */
export function isSupportedNpmVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  if (match === null) return false
  const actual = match.slice(1).map(Number)
  return (
    actual.some((part, index) =>
      actual
        .slice(0, index)
        .every((previous, previousIndex) => previous === MINIMUM_NPM_VERSION[previousIndex])
        ? part > MINIMUM_NPM_VERSION[index]
        : false,
    ) || actual.every((part, index) => part === MINIMUM_NPM_VERSION[index])
  )
}

/** Sort selected packages so in-workspace runtime dependencies publish first. */
export function orderPackages(packages) {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]))
  const ordered = []
  const visiting = new Set()
  const visited = new Set()

  function visit(name) {
    if (visited.has(name)) return
    if (visiting.has(name)) throw new Error(`Circular first-party publish dependency at ${name}`)
    const pkg = byName.get(name)
    if (pkg === undefined) throw new Error(`Selected package not found: ${name}`)
    visiting.add(name)
    for (const dep of pkg.firstPartyDependencies) {
      if (byName.has(dep)) visit(dep)
    }
    visiting.delete(name)
    visited.add(name)
    ordered.push(pkg)
  }

  for (const pkg of [...packages].sort((a, b) => a.name.localeCompare(b.name))) visit(pkg.name)
  return ordered
}

function selectedNames(selection, publishable) {
  if (selection.trim() === 'all') return new Set(publishable.map((pkg) => pkg.name))
  const names = selection
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  if (names.length === 0)
    throw new Error('--packages must be "all" or a comma-separated package list')
  const known = new Set(publishable.map((pkg) => pkg.name))
  for (const name of names) {
    if (!known.has(name))
      throw new Error(`Unknown or private package requested for release: ${name}`)
  }
  return new Set(names)
}

async function loadPublishablePackages() {
  const entries = await readdir(PACKAGES_DIR, { withFileTypes: true })
  const packages = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const directory = path.join(PACKAGES_DIR, entry.name)
        const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
        if (manifest.private === true) return undefined
        if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
          throw new Error(`${directory} must define a package name and version`)
        }
        const dependencies = manifest.dependencies ?? {}
        const firstPartyDependencies = Object.keys(dependencies)
          .filter((name) => name.startsWith('@electron-stagewright/'))
          .sort()
        return { directory, name: manifest.name, version: manifest.version, firstPartyDependencies }
      }),
  )
  return packages.filter((pkg) => pkg !== undefined).sort((a, b) => a.name.localeCompare(b.name))
}

function registryUrl() {
  const configured =
    process.env['NPM_CONFIG_REGISTRY'] ?? process.env['npm_config_registry'] ?? DEFAULT_REGISTRY
  const parsed = new URL(configured)
  if (parsed.protocol !== 'https:')
    throw new Error(`Release registry must use HTTPS (got ${configured})`)
  return parsed.toString().replace(/\/$/, '')
}

async function publishedMetadata(registry, name, version) {
  const url = `${registry}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  })
  if (response.status === 404) return undefined
  if (!response.ok)
    throw new Error(`Could not query ${name}@${version}: ${response.status} ${response.statusText}`)
  return response.json()
}

async function run(command, args, options = {}) {
  const result = await execFile(command, args, {
    cwd: ROOT,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  })
  if (result.stdout !== '') process.stdout.write(result.stdout)
  if (result.stderr !== '') process.stderr.write(result.stderr)
  return result
}

async function assertTrustedPublishingNpm() {
  const { stdout } = await execFile('npm', ['--version'], { cwd: ROOT })
  const version = stdout.trim()
  if (!isSupportedNpmVersion(version)) {
    throw new Error(
      `npm ${MINIMUM_NPM_VERSION.join('.')} or newer is required for trusted publishing (found ${version})`,
    )
  }
  return version
}

async function packPackage(pkg, packDirectory) {
  const packagePackDirectory = path.join(packDirectory, pkg.name.replace(/[^A-Za-z0-9_-]/g, '_'))
  await mkdir(packagePackDirectory, { recursive: true })
  await run('pnpm', ['--filter', pkg.name, 'pack', '--pack-destination', packagePackDirectory])
  const candidates = (await readdir(packagePackDirectory))
    .filter((name) => name.endsWith('.tgz'))
    .map((name) => path.join(packagePackDirectory, name))
  if (candidates.length !== 1) {
    throw new Error(`${pkg.name}: expected one tarball from pnpm pack, found ${candidates.length}`)
  }
  return candidates[0]
}

async function assertExternalDependencies(packages, selected, registry) {
  const allByName = new Map(packages.map((pkg) => [pkg.name, pkg]))
  for (const pkg of selected) {
    for (const dependencyName of pkg.firstPartyDependencies) {
      if (selected.some((candidate) => candidate.name === dependencyName)) continue
      const dependency = allByName.get(dependencyName)
      if (dependency === undefined) continue
      const metadata = await publishedMetadata(registry, dependency.name, dependency.version)
      if (metadata === undefined) {
        throw new Error(
          `${pkg.name} depends on ${dependency.name}@${dependency.version}, which is neither selected nor published`,
        )
      }
    }
  }
}

async function main() {
  const options = parseReleaseArguments(process.argv.slice(2))
  const registry = registryUrl()
  const npmVersion = await assertTrustedPublishingNpm()
  const publishable = await loadPublishablePackages()
  const requested = publishable.filter((pkg) =>
    selectedNames(options.packages, publishable).has(pkg.name),
  )
  const outputDirectory = path.resolve(ROOT, options.output)
  const packDirectory = path.join(outputDirectory, 'tarballs')
  const summaryPath = path.join(outputDirectory, 'release-summary.json')
  const summary = {
    schemaVersion: 1,
    mode: options.publish ? 'publish' : 'dry-run',
    registry,
    npmVersion,
    requested: requested.map((pkg) => `${pkg.name}@${pkg.version}`),
    startedAt: new Date().toISOString(),
    packages: [],
  }
  const writeSummary = () => writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)

  await rm(outputDirectory, { recursive: true, force: true })
  await mkdir(packDirectory, { recursive: true })
  await writeSummary()

  try {
    const unpublished = []
    for (const pkg of requested) {
      const metadata = options.includePublished
        ? undefined
        : await publishedMetadata(registry, pkg.name, pkg.version)
      if (metadata !== undefined) {
        summary.packages.push({ name: pkg.name, version: pkg.version, status: 'already_published' })
      } else {
        unpublished.push(pkg)
      }
    }

    const ordered = orderPackages(unpublished)
    await assertExternalDependencies(publishable, ordered, registry)
    for (const pkg of ordered) {
      const record = { name: pkg.name, version: pkg.version, status: 'packing' }
      summary.packages.push(record)
      await writeSummary()
      try {
        const tarball = await packPackage(pkg, packDirectory)
        const dryRunArguments = ['publish', tarball, '--access', 'public', '--dry-run']
        // npm still rejects an existing immutable version during --dry-run. Local release:validate
        // deliberately revalidates already-published tarballs, so force only that non-publishing path.
        if (options.includePublished) dryRunArguments.push('--force')
        await run('npm', dryRunArguments)
        if (options.publish) {
          await run('npm', ['publish', tarball, '--access', 'public'])
          const metadata = await publishedMetadata(registry, pkg.name, pkg.version)
          const integrity = metadata?.dist?.integrity
          if (typeof integrity !== 'string' || integrity === '') {
            throw new Error(
              `${pkg.name}@${pkg.version} is not visible in npm with an integrity value after publish`,
            )
          }
          Object.assign(record, { status: 'published', integrity })
        } else {
          Object.assign(record, { status: 'dry_run' })
        }
      } catch (error) {
        Object.assign(record, {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        })
        await writeSummary()
        throw error
      }
      await writeSummary()
    }
    summary.finishedAt = new Date().toISOString()
    await writeSummary()
  } catch (error) {
    summary.finishedAt = new Date().toISOString()
    await writeSummary()
    throw error
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
