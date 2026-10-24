/**
 * Inspect the Electron runtime Playwright loads for a launch that names no executable.
 *
 * Playwright then evaluates `require('electron/index.js')` from playwright-core. From Electron 42 that
 * entry downloads a missing binary on first load and prints progress to stdout, which on the MCP
 * stdio transport corrupts the protocol stream. This module mirrors the entry's own "already
 * installed" test from package metadata, so the server can refuse the launch instead.
 *
 * @module
 */

import { access, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** How to fetch the binary for the package set the server runs from. */
export const INSTALL_ELECTRON_REMEDY =
  'Run Electron\'s install-electron bin with the same npx --package list as the server (replace the trailing electron-stagewright with install-electron), or "pnpm exec install-electron" in a project.'

/** `npx --package` skips a package the project at the working directory already has. */
export const NPX_PREFIX_REMEDY =
  'If the server runs through npx inside a project that already has this package, add --prefix ~/ after -y in every npx command for this server so npx installs it beside the server.'

export type DefaultElectronStatus =
  | { readonly ok: true; readonly version?: string }
  | {
      readonly ok: false
      readonly reason: 'package_missing' | 'binary_missing'
      readonly message: string
      readonly version?: string
    }

export interface DefaultElectronDeps {
  readonly env?: NodeJS.ProcessEnv
  /** Resolve `electron/package.json` exactly as playwright-core's `require` would. */
  readonly resolveElectronPackageJson?: () => string
  readonly readFile?: (path: string, encoding: BufferEncoding) => Promise<string>
  readonly exists?: (path: string) => Promise<boolean>
}

function resolveFromPlaywright(): string {
  let base: string = import.meta.url
  try {
    const playwright = createRequire(base).resolve('playwright/package.json')
    base = createRequire(playwright).resolve('playwright-core/package.json')
  } catch {
    // Without playwright-core the launch fails before it loads Electron; the server's own view is
    // the closest approximation.
  }
  return createRequire(base).resolve('electron/package.json')
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

/**
 * Report whether Playwright's default Electron load would succeed without a download. Electron's
 * entry skips the download only when `path.txt` is non-empty and `dist/<path.txt>` exists, read
 * verbatim, or when `ELECTRON_OVERRIDE_DIST_PATH` is set.
 */
export async function inspectDefaultElectron(
  deps: DefaultElectronDeps = {},
): Promise<DefaultElectronStatus> {
  const env = deps.env ?? process.env
  const read = deps.readFile ?? readFile
  const exists = deps.exists ?? pathExists
  let packageJsonPath: string
  try {
    packageJsonPath = (deps.resolveElectronPackageJson ?? resolveFromPlaywright)()
  } catch (cause) {
    return {
      ok: false,
      reason: 'package_missing',
      message: `The electron package is not resolvable by the server process: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    }
  }
  const packageDirectory = dirname(packageJsonPath)
  const version = await read(packageJsonPath, 'utf8')
    .then((text) => {
      const manifest = JSON.parse(text) as { version?: unknown } | null
      return typeof manifest?.version === 'string' ? manifest.version : undefined
    })
    .catch(() => undefined)
  const withVersion = version !== undefined ? { version } : {}
  const override = env['ELECTRON_OVERRIDE_DIST_PATH']
  if (override !== undefined && override !== '') return { ok: true, ...withVersion }

  const recordedPath = await read(join(packageDirectory, 'path.txt'), 'utf8').catch(() => '')
  if (recordedPath !== '' && (await exists(join(packageDirectory, 'dist', recordedPath)))) {
    return { ok: true, ...withVersion }
  }
  return {
    ok: false,
    reason: 'binary_missing',
    message: `electron${
      version !== undefined ? `@${version}` : ''
    } is installed but its binary has not been downloaded; loading it now would download it mid-session and write progress to stdout.`,
    ...withVersion,
  }
}
