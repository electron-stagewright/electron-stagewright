// Environment diagnostics shared by the standalone CLI and `electron_doctor`.
// Checks inspect only the server process and configured filesystem paths: they
// never launch an app, load plugin code, or create a caller-owned directory.

import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'

export interface DoctorCheck {
  readonly id:
    'node' | 'playwright' | 'electron' | 'display' | 'app_root' | 'screenshot_dir' | 'eval_policy'
  readonly status: 'pass' | 'fail' | 'skip'
  readonly message: string
  readonly hint?: string
}

export interface DoctorReport {
  readonly ok: boolean
  readonly checks: readonly DoctorCheck[]
}

export interface DoctorOptions {
  readonly appRoot?: string
  readonly screenshotDir?: string
  readonly allowEvalMain: boolean
  readonly allowEvalRenderer: boolean
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
}

const NODE_FLOOR = 24

async function resolvePackage(name: 'playwright' | 'electron'): Promise<void> {
  await import(name)
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

// Run all preflights in stable output order.
export async function runDoctorChecks(
  opts: DoctorOptions,
  deps: DoctorDeps = {},
): Promise<DoctorReport> {
  const resolve = deps.resolvePackage ?? resolvePackage
  const inspect = deps.inspectDirectory ?? inspectDirectory
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const checks = [
    nodeCheck(deps.nodeVersion ?? process.version),
    await packageCheck('playwright', resolve),
    await packageCheck('electron', resolve),
    displayCheck(platform, env),
    await directoryCheck('app_root', opts.appRoot, inspect),
    await directoryCheck('screenshot_dir', opts.screenshotDir, inspect),
    evalPolicyCheck(opts),
  ]
  return {
    ok: checks.every((check) => check.status !== 'fail'),
    checks,
  }
}
