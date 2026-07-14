/**
 * Resolve and inspect the Electron runtime owned by an operator-configured app root.
 *
 * Project runtime selection is deliberately operator-bound: callers supply only the
 * `runtime: 'project'` mode, while `--app-root` supplies the filesystem boundary.
 * This module never accepts an agent-selected root or executes app code.
 */

import type { Dirent } from 'node:fs'
import { execFile as execFileCallback } from 'node:child_process'
import { readdir, readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import { isWithinRoot } from '../tools/app-root.js'

const execFile = promisify(execFileCallback)

/** Maximum native-addon paths a diagnostic report returns. */
export const MAX_NATIVE_ADDONS = 64
/** Maximum directory depth scanned while inventorying native addons. */
export const MAX_NATIVE_ADDON_DEPTH = 8
/** Maximum directories visited while inventorying native addons. */
export const MAX_NATIVE_ADDON_DIRECTORIES = 2_048
/** Time budget for the fixed target-runtime probe. */
export const PROJECT_RUNTIME_PROBE_TIMEOUT_MS = 5_000

export interface ResolvedProjectElectron {
  /** Canonical executable path; project resolution verifies that it remains inside the app root. */
  readonly executablePath: string
  /** Canonical package manifest path for the resolved Electron package. */
  readonly packageJsonPath: string
  /** Installed Electron package version when its manifest declares one. */
  readonly version?: string
}

export type ProjectElectronResolution =
  | { readonly ok: true; readonly electron: ResolvedProjectElectron }
  | { readonly ok: false; readonly message: string }

export interface ProjectElectronDeps {
  readonly realpath?: (path: string) => Promise<string>
  readonly readFile?: (path: string, encoding: BufferEncoding) => Promise<string>
  readonly createRequire?: (filename: string) => NodeRequire
}

interface PackageManifest {
  readonly version?: unknown
  readonly dependencies?: Record<string, unknown>
  readonly devDependencies?: Record<string, unknown>
  readonly optionalDependencies?: Record<string, unknown>
}

function asMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function parsePackageManifest(text: string): PackageManifest | undefined {
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed !== null && typeof parsed === 'object' ? (parsed as PackageManifest) : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve Electron's binary from its package metadata without evaluating the package entry point.
 *
 * Electron's `index.js` may download a missing runtime when imported. The server only needs the
 * installed binary path, which the package records in `path.txt`; reading those files avoids
 * executing target-project dependency code during a diagnostic or launch preflight.
 */
export async function resolveElectronExecutableFromPackageManifest(
  packageJsonPath: string,
  deps: Pick<ProjectElectronDeps, 'realpath' | 'readFile'>,
): Promise<ResolvedProjectElectron> {
  const canonicalRealpath = deps.realpath ?? realpath
  const read = deps.readFile ?? readFile
  const canonicalPackageJson = await canonicalRealpath(packageJsonPath)
  const packageDirectory = dirname(canonicalPackageJson)
  const distributionDirectory = join(packageDirectory, 'dist')
  const executableRelativePath = (await read(join(packageDirectory, 'path.txt'), 'utf8')).trim()
  if (
    executableRelativePath.length === 0 ||
    isAbsolute(executableRelativePath) ||
    !isWithinRoot(distributionDirectory, join(distributionDirectory, executableRelativePath))
  ) {
    throw new Error('Electron path.txt does not name an executable inside its dist directory.')
  }
  const [canonicalExecutable, manifest] = await Promise.all([
    canonicalRealpath(join(distributionDirectory, executableRelativePath)),
    read(canonicalPackageJson, 'utf8').then(parsePackageManifest),
  ])
  return {
    executablePath: canonicalExecutable,
    packageJsonPath: canonicalPackageJson,
    ...(typeof manifest?.version === 'string' ? { version: manifest.version } : {}),
  }
}

/**
 * Resolve Electron from the app root, rejecting Node module-resolution fallback above the root.
 * Node resolves only `electron/package.json` from the target root. The package's `path.txt` then
 * identifies its installed binary, so this preflight never evaluates the target app or dependency
 * entry points.
 */
export async function resolveProjectElectron(
  appRoot: string,
  deps: ProjectElectronDeps = {},
): Promise<ProjectElectronResolution> {
  const canonicalRealpath = deps.realpath ?? realpath
  const requireFrom = deps.createRequire ?? createRequire
  const resolvedRoot = resolve(appRoot)
  try {
    const canonicalRoot = await canonicalRealpath(resolvedRoot)
    const appRequire = requireFrom(join(canonicalRoot, 'package.json'))
    const packageJsonPath = appRequire.resolve('electron/package.json')
    const electron = await resolveElectronExecutableFromPackageManifest(packageJsonPath, deps)
    if (!isWithinRoot(canonicalRoot, electron.executablePath)) {
      return {
        ok: false,
        message:
          'The app-root Electron executable resolved outside the configured --app-root and was refused.',
      }
    }
    if (!isWithinRoot(canonicalRoot, electron.packageJsonPath)) {
      return {
        ok: false,
        message:
          'The app-root Electron package resolved outside the configured --app-root and was refused.',
      }
    }
    return { ok: true, electron }
  } catch (cause) {
    return {
      ok: false,
      message: `Could not resolve Electron from the configured --app-root: ${asMessage(cause)}`,
    }
  }
}

/** Read the Electron spec declared by the target project's root package manifest. */
export async function readDeclaredElectronVersion(
  appRoot: string,
  deps: Pick<ProjectElectronDeps, 'readFile'> = {},
): Promise<string | undefined> {
  const read = deps.readFile ?? readFile
  try {
    const manifest = parsePackageManifest(
      await read(join(resolve(appRoot), 'package.json'), 'utf8'),
    )
    for (const field of [
      manifest?.dependencies,
      manifest?.devDependencies,
      manifest?.optionalDependencies,
    ]) {
      const value = field?.['electron']
      if (typeof value === 'string') return value
    }
  } catch {
    // The caller reports absence as diagnostic data; doctor must not throw because a target manifest
    // is missing or malformed.
  }
  return undefined
}

export interface ElectronRuntimeVersions {
  readonly electron?: string
  readonly node?: string
  readonly v8?: string
  readonly nodeModuleVersion?: string
}

export interface ProbeElectronRuntimeDeps {
  readonly execFile?: (
    executablePath: string,
    args: readonly string[],
    options: {
      readonly env: NodeJS.ProcessEnv
      readonly timeout: number
      readonly maxBuffer: number
    },
  ) => Promise<{ readonly stdout: string }>
  readonly env?: NodeJS.ProcessEnv
}

const TARGET_RUNTIME_EXPRESSION =
  'JSON.stringify({electron:process.versions.electron,node:process.versions.node,v8:process.versions.v8,nodeModuleVersion:process.versions.modules})'

/**
 * Probe a target Electron binary without loading app code. The fixed `-p` expression runs under
 * Electron's Node mode, receives no tool input, and inherits only a narrow OS environment.
 */
export async function probeElectronRuntime(
  executablePath: string,
  deps: ProbeElectronRuntimeDeps = {},
): Promise<ElectronRuntimeVersions> {
  const run = deps.execFile ?? (async (path, args, options) => execFile(path, args, options))
  const sourceEnv = deps.env ?? process.env
  const env: NodeJS.ProcessEnv = {
    ELECTRON_RUN_AS_NODE: '1',
  }
  for (const key of [
    'PATH',
    'HOME',
    'USERPROFILE',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'TMP',
    'TEMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
  ]) {
    const value = sourceEnv[key]
    if (value !== undefined) env[key] = value
  }
  const { stdout } = await run(executablePath, ['-p', TARGET_RUNTIME_EXPRESSION], {
    env,
    timeout: PROJECT_RUNTIME_PROBE_TIMEOUT_MS,
    maxBuffer: 16 * 1024,
  })
  const parsed = JSON.parse(stdout) as unknown
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('Target Electron probe returned a non-object JSON value.')
  }
  const result = parsed as Record<string, unknown>
  return {
    ...(typeof result['electron'] === 'string' ? { electron: result['electron'] } : {}),
    ...(typeof result['node'] === 'string' ? { node: result['node'] } : {}),
    ...(typeof result['v8'] === 'string' ? { v8: result['v8'] } : {}),
    ...(typeof result['nodeModuleVersion'] === 'string'
      ? { nodeModuleVersion: result['nodeModuleVersion'] }
      : {}),
  }
}

export interface NativeAddonInventory {
  /** Relative paths, bounded by {@link MAX_NATIVE_ADDONS}. */
  readonly paths: readonly string[]
  /** True when traversal stopped at a safety limit. */
  readonly truncated: boolean
}

/**
 * Inventory likely native addons without loading them. Symlinks are never followed; traversal is
 * bounded by both depth and directory count so doctor remains safe on a large project tree.
 */
export async function inventoryNativeAddons(appRoot: string): Promise<NativeAddonInventory> {
  const root = resolve(appRoot)
  const paths: string[] = []
  let directories = 0
  let truncated = false

  function directoryPriority(name: string): number {
    if (name === 'node_modules') return -3
    if (name === 'build' || name === 'dist' || name === 'out' || name === 'release') return -2
    // pnpm's content-addressed store is large. Direct dependencies are traversed first, so the
    // common project-level addon paths are discovered before the scan spends its bounded budget.
    if (name === '.pnpm') return 2
    return 0
  }

  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > MAX_NATIVE_ADDON_DEPTH || directories >= MAX_NATIVE_ADDON_DIRECTORIES) {
      truncated = true
      return
    }
    directories += 1
    let entries: Dirent<string>[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((left, right) => {
      const priorityDelta = directoryPriority(left.name) - directoryPriority(right.name)
      return priorityDelta !== 0 ? priorityDelta : left.name.localeCompare(right.name)
    })
    for (const entry of entries) {
      if (paths.length >= MAX_NATIVE_ADDONS) {
        truncated = true
        return
      }
      const candidate = join(directory, entry.name)
      if (entry.isDirectory() && entry.name === '.git') continue
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await visit(candidate, depth + 1)
        continue
      }
      if (entry.isFile() && entry.name.endsWith('.node')) {
        paths.push(relative(root, candidate))
      }
    }
  }

  // Most native addons live in node_modules, but app-owned build outputs can live at the root.
  await visit(root, 0)
  return { paths: paths.sort((a, b) => a.localeCompare(b)), truncated }
}
