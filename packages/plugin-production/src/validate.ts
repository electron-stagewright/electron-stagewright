/**
 * Reusable production-validation API (ADR-012).
 *
 * The MCP tool and standalone CLI are delivery adapters around this module. Keeping path
 * validation, command-runner construction, check ordering, and report aggregation here prevents
 * their three-valued evidence semantics from drifting between consumers.
 *
 * @module
 */

import { stat } from 'node:fs/promises'
import path from 'node:path'

import {
  CHECK_IDS,
  isAppImageArtifactPath,
  isWindowsArtifactPath,
  runChecks,
  type CheckId,
  type CheckResult,
  type CheckStartObserver,
  type CheckStatus,
} from './checks.js'
import { makeRunCommand, type RunCommand } from './command.js'

/** Default timeout for each bounded platform-tool invocation. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 10_000

/** Stable caller-error taxonomy shared by the library, CLI, and MCP adapter. */
export type ProductionValidationErrorCode =
  | 'ABSOLUTE_PATH_REQUIRED'
  | 'APP_NOT_FOUND'
  | 'NOT_A_BUNDLE'
  | 'UNSUPPORTED_ARTIFACT'
  | 'INVALID_OPTIONS'

/** Release artifact families with first-class default checks. */
export type ProductionArtifactType = 'macos-app' | 'windows-artifact' | 'linux-appimage'

/** Artifact-aware defaults prevent irrelevant platform checks from creating false failures. */
export const DEFAULT_CHECK_IDS_BY_ARTIFACT: Readonly<
  Record<ProductionArtifactType, readonly CheckId[]>
> = {
  'macos-app': [
    'bundle-structure',
    'info-plist',
    'protocol-schemes',
    'updater-feed',
    'crash-reporter',
    'code-signing',
    'notarization',
    'gatekeeper',
  ],
  'windows-artifact': ['windows-authenticode'],
  'linux-appimage': ['appimage-signature'],
}

/** A caller-correctable failure that prevented production validation from running. */
export class ProductionValidationError extends Error {
  readonly code: ProductionValidationErrorCode
  readonly appPath?: string

  constructor(code: ProductionValidationErrorCode, message: string, appPath?: string) {
    super(message)
    this.name = 'ProductionValidationError'
    this.code = code
    if (appPath !== undefined) this.appPath = appPath
  }
}

/** Summary counts for the three-valued evidence model. */
export interface ProductionValidationSummary {
  readonly pass: number
  readonly fail: number
  readonly unknown: number
}

/** Transport-neutral result returned by the public library API. */
export interface ProductionValidationReport {
  readonly app_path: string
  readonly artifact_type: ProductionArtifactType
  readonly passed: boolean
  readonly summary: ProductionValidationSummary
  readonly checks: readonly CheckResult[]
}

/** Options for {@link validateProductionApp}. */
export interface ProductionValidationOptions {
  /** Selected checks; omitted means the defaults for the detected artifact family. */
  readonly checks?: readonly CheckId[]
  /** Timeout used to construct the default command runner when `runCommand` is omitted. */
  readonly commandTimeoutMs?: number
  /** Test or embedding seam for external-command execution. */
  readonly runCommand?: RunCommand
  /** Advisory notification before each selected check starts. */
  readonly onCheckStart?: CheckStartObserver
}

function validateCommandTimeout(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ProductionValidationError(
      'INVALID_OPTIONS',
      `commandTimeoutMs must be a positive safe integer, got ${String(value)}.`,
    )
  }
}

function validateCheckSelection(ids: readonly CheckId[]): void {
  if (ids.length === 0) {
    throw new ProductionValidationError(
      'INVALID_OPTIONS',
      'checks must contain at least one production check id.',
    )
  }
  const known = new Set<string>(CHECK_IDS)
  const invalid = ids.find((id) => !known.has(id))
  if (invalid !== undefined) {
    throw new ProductionValidationError(
      'INVALID_OPTIONS',
      `Unknown production check id "${String(invalid)}".`,
    )
  }
}

function tally(checks: readonly CheckResult[], status: CheckStatus): number {
  return checks.filter((check) => check.status === status).length
}

function classifyArtifact(
  appPath: string,
  info: Awaited<ReturnType<typeof stat>>,
): ProductionArtifactType {
  const extension = path.extname(appPath).toLowerCase()
  if (info.isDirectory() && extension === '.app') return 'macos-app'
  if (info.isFile() && isWindowsArtifactPath(appPath)) return 'windows-artifact'
  if (info.isFile() && isAppImageArtifactPath(appPath)) return 'linux-appimage'
  if (extension === '.app') {
    throw new ProductionValidationError(
      'NOT_A_BUNDLE',
      `${appPath} is not a directory; a macOS .app is a bundle directory.`,
      appPath,
    )
  }
  throw new ProductionValidationError(
    'UNSUPPORTED_ARTIFACT',
    `${appPath} is not a supported production artifact; pass a macOS .app directory, Windows .exe/.msi file, or Linux .AppImage file.`,
    appPath,
  )
}

/**
 * Validate one packaged release artifact without requiring MCP or a running Electron session.
 *
 * Validation failures are returned as check data. This function throws only when validation
 * cannot start because the path or options are invalid.
 */
export async function validateProductionApp(
  appPathInput: string,
  options: ProductionValidationOptions = {},
): Promise<ProductionValidationReport> {
  if (!path.isAbsolute(appPathInput)) {
    throw new ProductionValidationError(
      'ABSOLUTE_PATH_REQUIRED',
      'appPath must be an absolute path to a packaged production artifact.',
      appPathInput,
    )
  }
  const appPath = path.resolve(appPathInput)

  let info
  try {
    info = await stat(appPath)
  } catch {
    throw new ProductionValidationError(
      'APP_NOT_FOUND',
      `No file or directory at ${appPath}; pass the path to the packaged production artifact.`,
      appPath,
    )
  }
  const artifactType = classifyArtifact(appPath, info)

  const ids = options.checks ?? DEFAULT_CHECK_IDS_BY_ARTIFACT[artifactType]
  validateCheckSelection(ids)
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  validateCommandTimeout(commandTimeoutMs)
  const run = options.runCommand ?? makeRunCommand(commandTimeoutMs)
  const checks = await runChecks(appPath, run, ids, options.onCheckStart)
  const summary = {
    pass: tally(checks, 'pass'),
    fail: tally(checks, 'fail'),
    unknown: tally(checks, 'unknown'),
  }

  return {
    app_path: appPath,
    artifact_type: artifactType,
    passed: summary.fail === 0,
    summary,
    checks,
  }
}
