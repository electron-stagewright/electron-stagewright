// Environment diagnostics shared by the standalone CLI and `electron_doctor`.
// Base checks inspect only the server process and configured filesystem paths:
// they never launch an app or create a caller-owned directory. The standalone
// CLI may append a server-configuration check that loads only plugins explicitly
// selected by the operator, then tears them down without connecting stdio.

import { access, readFile, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createRequire } from 'node:module'

import {
  inventoryNativeAddons,
  probeElectronRuntime,
  readDeclaredElectronVersion,
  resolveElectronExecutableFromPackageManifest,
  resolveProjectElectron,
  type ElectronRuntimeVersions,
  type NativeAddonInventory,
  type ProjectElectronResolution,
  type ResolvedProjectElectron,
} from './runtime/project-electron.js'
import { VERSION } from './version.js'

export interface DoctorCheck {
  readonly id:
    | 'node'
    | 'playwright'
    | 'electron'
    | 'display'
    | 'app_root'
    | 'screenshot_dir'
    | 'eval_policy'
    | 'project_runtime'
    | 'server_config'
  readonly status: 'pass' | 'fail' | 'skip' | 'warn'
  readonly message: string
  readonly hint?: string
  readonly code?: string
  readonly details?: Readonly<Record<string, unknown>>
}

/** Exact facts about the Node process hosting the MCP server. */
export interface ServerRuntimeDetails {
  readonly core: string
  readonly node: string
  readonly v8?: string
  readonly nodeModuleVersion?: string
  readonly playwright?: string
  readonly electron?: string
  /** Runtime facts for the server-resolvable Electron binary used by a default launch. */
  readonly electronRuntime?: ElectronRuntimeVersions
}

/** Bounded, machine-readable facts about an app-root Electron runtime. */
export interface ProjectRuntimeDetails {
  readonly declaredElectron?: string
  readonly installedElectron?: string
  readonly target?: ElectronRuntimeVersions
  readonly nativeAddons: NativeAddonInventory
  /** Present when the bounded addon inventory could not complete. */
  readonly nativeAddonInventoryError?: string
}

export interface DoctorReport {
  readonly ok: boolean
  readonly checks: readonly DoctorCheck[]
  readonly runtime: {
    readonly server: ServerRuntimeDetails
    readonly project?: ProjectRuntimeDetails
  }
}

export interface DoctorOptions {
  readonly appRoot?: string
  readonly screenshotDir?: string
  readonly allowEvalMain: boolean
  readonly allowEvalRenderer: boolean
  /** Standalone-CLI result from validating the exact serve configuration. */
  readonly serverConfiguration?: {
    readonly ok: boolean
    readonly status?: 'pass' | 'warn'
    readonly message: string
    readonly hint?: string
    readonly code?: string
    readonly details?: Readonly<Record<string, unknown>>
  }
}

// Injectable dependencies make missing-runtime and cross-platform cases
// unit-testable without mutating process state or workspace packages.
export interface DoctorDeps {
  readonly nodeVersion?: string
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  readonly resolvePackage?: (name: 'playwright' | 'electron') => Promise<void>
  readonly inspectDirectory?: (
    path: string,
    requireWritable: boolean,
  ) => Promise<'accessible' | 'not_directory' | 'missing'>
  readonly serverRuntime?: () => Promise<ServerRuntimeDetails>
  readonly resolveProjectElectron?: (appRoot: string) => Promise<ProjectElectronResolution>
  readonly readDeclaredElectronVersion?: (appRoot: string) => Promise<string | undefined>
  readonly probeElectronRuntime?: (executablePath: string) => Promise<ElectronRuntimeVersions>
  readonly inventoryNativeAddons?: (appRoot: string) => Promise<NativeAddonInventory>
}

const NODE_FLOOR = 24

async function resolvePackage(name: 'playwright' | 'electron'): Promise<void> {
  // Doctor only needs to establish that the optional peer can be resolved. Importing Electron's
  // package entry may download a missing binary and print progress to stdout, which would corrupt
  // the documented machine-readable `doctor --json` channel.
  const requireFromHere = createRequire(import.meta.url)
  const packageJsonPath = requireFromHere.resolve(`${name}/package.json`)
  if (name === 'electron') {
    // A resolvable package without its dist binary cannot launch an app. Validate that binary by
    // reading Electron's metadata instead of importing the package entry and triggering a download.
    await resolveElectronExecutableFromPackageManifest(packageJsonPath, {})
  }
}

async function packageVersion(name: 'playwright' | 'electron'): Promise<string | undefined> {
  try {
    const requireFromHere = createRequire(import.meta.url)
    const packageJsonPath = requireFromHere.resolve(`${name}/package.json`)
    const manifest = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

async function resolveServerElectron(): Promise<ResolvedProjectElectron | undefined> {
  try {
    const requireFromHere = createRequire(import.meta.url)
    return await resolveElectronExecutableFromPackageManifest(
      requireFromHere.resolve('electron/package.json'),
      {},
    )
  } catch {
    return undefined
  }
}

async function serverRuntimeDetails(): Promise<ServerRuntimeDetails> {
  const [playwright, installedElectron] = await Promise.all([
    packageVersion('playwright'),
    resolveServerElectron(),
  ])
  let electronRuntime: ElectronRuntimeVersions | undefined
  if (installedElectron !== undefined) {
    try {
      electronRuntime = await probeElectronRuntime(installedElectron.executablePath)
    } catch {
      // The doctor report still exposes the package version. The project check turns an unavailable
      // default-runtime ABI comparison into an actionable warning when native addons are present.
    }
  }
  return {
    core: VERSION,
    node: process.version,
    ...(process.versions.v8 !== undefined ? { v8: process.versions.v8 } : {}),
    ...(process.versions.modules !== undefined
      ? { nodeModuleVersion: process.versions.modules }
      : {}),
    ...(playwright !== undefined ? { playwright } : {}),
    ...(installedElectron?.version !== undefined ? { electron: installedElectron.version } : {}),
    ...(electronRuntime !== undefined ? { electronRuntime } : {}),
  }
}

async function inspectDirectory(
  path: string,
  requireWritable: boolean,
): Promise<'accessible' | 'not_directory' | 'missing'> {
  try {
    const info = await stat(path)
    if (!info.isDirectory()) return 'not_directory'
    await access(path, requireWritable ? constants.W_OK : constants.R_OK)
    return 'accessible'
  } catch {
    return 'missing'
  }
}

function nodeCheck(nodeVersion: string): DoctorCheck {
  const major = Number.parseInt(nodeVersion.replace(/^v/, '').split('.')[0] ?? '', 10)
  if (Number.isInteger(major) && major >= NODE_FLOOR) {
    return {
      id: 'node',
      status: 'pass',
      message: `Node ${nodeVersion} satisfies the >=${NODE_FLOOR} floor.`,
    }
  }
  return {
    id: 'node',
    status: 'fail',
    message: `Node ${nodeVersion} is below the required >=${NODE_FLOOR} version.`,
    hint: `Install Node ${NODE_FLOOR} or newer, then rerun doctor.`,
  }
}

async function packageCheck(
  name: 'playwright' | 'electron',
  resolve: (name: 'playwright' | 'electron') => Promise<void>,
): Promise<DoctorCheck> {
  try {
    await resolve(name)
    return {
      id: name,
      status: 'pass',
      message: `${name} is resolvable by the server process.`,
    }
  } catch (cause) {
    const hint =
      name === 'playwright'
        ? 'Install it beside the server: npm install playwright.'
        : 'Install it beside the server, pass executablePath to electron_launch, or run npx with --package electron.'
    return {
      id: name,
      status: 'fail',
      message: `${name} is not resolvable by the server process: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      hint,
    }
  }
}

function displayCheck(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): DoctorCheck {
  if (platform !== 'linux') {
    return {
      id: 'display',
      status: 'skip',
      message: 'Display preflight applies only to Linux.',
    }
  }
  if (env['DISPLAY'] !== undefined || env['WAYLAND_DISPLAY'] !== undefined) {
    return { id: 'display', status: 'pass', message: 'Linux display environment is configured.' }
  }
  return {
    id: 'display',
    status: 'fail',
    message: 'Linux has neither DISPLAY nor WAYLAND_DISPLAY configured.',
    hint: 'Run under a desktop session or xvfb-run before launching a headed Electron app.',
  }
}

async function directoryCheck(
  id: 'app_root' | 'screenshot_dir',
  path: string | undefined,
  inspect: (
    path: string,
    requireWritable: boolean,
  ) => Promise<'accessible' | 'not_directory' | 'missing'>,
): Promise<DoctorCheck> {
  if (path === undefined) {
    return {
      id,
      status: 'skip',
      message:
        id === 'app_root'
          ? 'No app-root confinement is configured.'
          : 'No screenshot directory is configured; screenshots use the OS temporary directory by default.',
    }
  }
  const requireWritable = id === 'screenshot_dir'
  const status = await inspect(path, requireWritable)
  if (status === 'accessible') {
    return {
      id,
      status: 'pass',
      message: `${id === 'app_root' ? 'App root is readable' : 'Screenshot directory is writable'}: ${path}`,
    }
  }
  return {
    id,
    status: 'fail',
    message: `${id === 'app_root' ? 'App root' : 'Screenshot directory'} is ${
      status === 'missing'
        ? id === 'app_root'
          ? 'missing or unreadable'
          : 'missing or unwritable'
        : 'not a directory'
    }: ${path}`,
    hint: 'Create or correct the configured path before starting the server.',
  }
}

function evalPolicyCheck(opts: DoctorOptions): DoctorCheck {
  const enabled = [
    ...(opts.allowEvalMain ? ['main'] : []),
    ...(opts.allowEvalRenderer ? ['renderer'] : []),
  ]
  return {
    id: 'eval_policy',
    status: 'pass',
    message:
      enabled.length === 0
        ? 'Eval is disabled (safe default).'
        : `Eval is enabled for: ${enabled.join(', ')}.`,
  }
}

function projectRuntimeCheck(
  appRoot: string | undefined,
  server: ServerRuntimeDetails,
  project: ProjectRuntimeDetails | undefined,
  resolution: ProjectElectronResolution | undefined,
  probeError: string | undefined,
): DoctorCheck {
  if (appRoot === undefined) {
    return {
      id: 'project_runtime',
      status: 'skip',
      message: 'No app-root is configured; target Electron runtime alignment was not inspected.',
    }
  }
  if (resolution === undefined || !resolution.ok) {
    return {
      id: 'project_runtime',
      status: 'warn',
      message:
        resolution?.ok === false
          ? resolution.message
          : 'Target Electron runtime could not be resolved from the configured --app-root.',
      hint: 'Install Electron inside the app root, or pass executablePath explicitly when launching.',
    }
  }
  if (probeError !== undefined) {
    return {
      id: 'project_runtime',
      status: 'warn',
      message: `Resolved project Electron but its fixed runtime probe failed: ${probeError}`,
      hint: 'Check that the app-root Electron binary is executable, then retry doctor.',
    }
  }
  const targetModules = project?.target?.nodeModuleVersion
  const sourceModules = server.electronRuntime?.nodeModuleVersion
  const hasNativeAddons = (project?.nativeAddons.paths.length ?? 0) > 0
  const warnings: string[] = []
  const hints: string[] = []
  const declared = project?.declaredElectron
  const installed = project?.installedElectron
  if (isExactVersion(declared) && installed !== undefined && declared !== installed) {
    warnings.push(
      `package.json declares Electron ${declared}, but the app root has ${installed} installed.`,
    )
    hints.push('Reinstall the declared Electron version or align the project manifest.')
  }
  if (
    project?.target?.electron !== undefined &&
    installed !== undefined &&
    project.target.electron !== installed
  ) {
    warnings.push(
      `The Electron binary reports ${project.target.electron}, but its package manifest reports ${installed}.`,
    )
    hints.push('Repair the Electron installation inside the configured app root.')
  }
  if (hasNativeAddons && targetModules !== undefined && sourceModules === undefined) {
    warnings.push(
      'The default server Electron ABI could not be inspected while native addons are present.',
    )
    hints.push('Launch with runtime:"project" to use the app-local Electron binary.')
  }
  if (
    targetModules !== undefined &&
    sourceModules !== undefined &&
    targetModules !== sourceModules &&
    hasNativeAddons
  ) {
    warnings.push(
      'The default and target Electron runtimes use different NODE_MODULE_VERSION values while native addons are present.',
    )
    hints.push('Launch with runtime:"project" so Playwright uses the app-local Electron binary.')
  }
  if (project?.nativeAddonInventoryError !== undefined) {
    warnings.push(`Native-addon inventory failed: ${project.nativeAddonInventoryError}`)
    hints.push('Correct app-root permissions, then rerun doctor.')
  }
  if (warnings.length > 0) {
    return {
      id: 'project_runtime',
      status: 'warn',
      message: warnings.join(' '),
      hint: hints.join(' '),
    }
  }
  const inventorySuffix =
    project?.nativeAddons.truncated === true
      ? ' Native-addon inventory reached its safety limit.'
      : ''
  return {
    id: 'project_runtime',
    status: 'pass',
    message: `Project Electron ${project?.installedElectron ?? 'unknown'} resolved from --app-root; ${project?.nativeAddons.paths.length ?? 0} native addon(s) found.${inventorySuffix}`,
  }
}

function isExactVersion(value: string | undefined): value is string {
  return value !== undefined && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)
}

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

async function inspectProjectRuntime(
  appRoot: string | undefined,
  server: ServerRuntimeDetails,
  deps: DoctorDeps,
): Promise<{ readonly check: DoctorCheck; readonly details?: ProjectRuntimeDetails }> {
  if (appRoot === undefined) {
    return { check: projectRuntimeCheck(undefined, server, undefined, undefined, undefined) }
  }
  const resolveTarget = deps.resolveProjectElectron ?? resolveProjectElectron
  const declaredElectron = deps.readDeclaredElectronVersion ?? readDeclaredElectronVersion
  const probeTarget = deps.probeElectronRuntime ?? probeElectronRuntime
  const inventory = deps.inventoryNativeAddons ?? inventoryNativeAddons
  const [resolutionResult, declaredResult, nativeAddonsResult] = await Promise.allSettled([
    resolveTarget(appRoot),
    declaredElectron(appRoot),
    inventory(appRoot),
  ])
  const resolution: ProjectElectronResolution =
    resolutionResult.status === 'fulfilled'
      ? resolutionResult.value
      : {
          ok: false,
          message: `Could not resolve Electron from the configured --app-root: ${failureMessage(resolutionResult.reason)}`,
        }
  const declared = declaredResult.status === 'fulfilled' ? declaredResult.value : undefined
  const nativeAddonInventoryError =
    nativeAddonsResult.status === 'rejected' ? failureMessage(nativeAddonsResult.reason) : undefined
  const nativeAddons: NativeAddonInventory =
    nativeAddonsResult.status === 'fulfilled'
      ? nativeAddonsResult.value
      : { paths: [], truncated: true }
  if (!resolution.ok) {
    return {
      check: projectRuntimeCheck(appRoot, server, undefined, resolution, undefined),
      details: {
        ...(declared !== undefined ? { declaredElectron: declared } : {}),
        nativeAddons,
        ...(nativeAddonInventoryError !== undefined ? { nativeAddonInventoryError } : {}),
      },
    }
  }
  try {
    const target = await probeTarget(resolution.electron.executablePath)
    const details: ProjectRuntimeDetails = {
      ...(declared !== undefined ? { declaredElectron: declared } : {}),
      ...(resolution.electron.version !== undefined
        ? { installedElectron: resolution.electron.version }
        : {}),
      target,
      nativeAddons,
      ...(nativeAddonInventoryError !== undefined ? { nativeAddonInventoryError } : {}),
    }
    return {
      check: projectRuntimeCheck(appRoot, server, details, resolution, undefined),
      details,
    }
  } catch (cause) {
    const details: ProjectRuntimeDetails = {
      ...(declared !== undefined ? { declaredElectron: declared } : {}),
      ...(resolution.electron.version !== undefined
        ? { installedElectron: resolution.electron.version }
        : {}),
      nativeAddons,
      ...(nativeAddonInventoryError !== undefined ? { nativeAddonInventoryError } : {}),
    }
    return {
      check: projectRuntimeCheck(appRoot, server, details, resolution, failureMessage(cause)),
      details,
    }
  }
}

// Run all preflights in stable output order.
export async function runDoctorChecks(
  opts: DoctorOptions,
  deps: DoctorDeps = {},
): Promise<DoctorReport> {
  const resolve = deps.resolvePackage ?? resolvePackage
  const inspect = deps.inspectDirectory ?? inspectDirectory
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const serverRuntime = await (deps.serverRuntime ?? serverRuntimeDetails)()
  const projectRuntime = await inspectProjectRuntime(opts.appRoot, serverRuntime, deps)
  const checks = [
    nodeCheck(deps.nodeVersion ?? process.version),
    await packageCheck('playwright', resolve),
    await packageCheck('electron', resolve),
    displayCheck(platform, env),
    await directoryCheck('app_root', opts.appRoot, inspect),
    await directoryCheck('screenshot_dir', opts.screenshotDir, inspect),
    evalPolicyCheck(opts),
    projectRuntime.check,
    ...(opts.serverConfiguration !== undefined
      ? [
          {
            id: 'server_config' as const,
            status: opts.serverConfiguration.ok
              ? (opts.serverConfiguration.status ?? ('pass' as const))
              : ('fail' as const),
            message: opts.serverConfiguration.message,
            ...(opts.serverConfiguration.hint !== undefined
              ? { hint: opts.serverConfiguration.hint }
              : {}),
            ...(opts.serverConfiguration.code !== undefined
              ? { code: opts.serverConfiguration.code }
              : {}),
            ...(opts.serverConfiguration.details !== undefined
              ? { details: opts.serverConfiguration.details }
              : {}),
          },
        ]
      : []),
  ]
  return {
    ok: checks.every((check) => check.status !== 'fail'),
    checks,
    runtime: {
      server: serverRuntime,
      ...(projectRuntime.details !== undefined ? { project: projectRuntime.details } : {}),
    },
  }
}
