#!/usr/bin/env node

/**
 * Standalone production-validation CLI (ADR-012).
 *
 * `electron-stagewright production ...` delegates here when the optional production package is
 * installed. The package also exposes `electron-stagewright-production` directly. Both paths use
 * the same parser, report schema, and exit-code contract.
 *
 * @module
 */

import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { CHECK_IDS, type CheckId, type CheckResult } from './checks.js'
import {
  ProductionValidationError,
  validateProductionApp,
  type ProductionValidationOptions,
  type ProductionValidationReport,
} from './validate.js'

export const PRODUCTION_EXIT_CODES = {
  SUCCESS: 0,
  VALIDATION_FAILED: 1,
  USAGE: 2,
} as const

export type ProductionExitCode = (typeof PRODUCTION_EXIT_CODES)[keyof typeof PRODUCTION_EXIT_CODES]

export interface ProductionCliOptions {
  readonly command: 'validate' | 'help'
  readonly appPath?: string
  readonly checks?: readonly CheckId[]
  readonly commandTimeoutMs?: number
  readonly json: boolean
}

export interface ProductionCliError {
  readonly code:
    | 'USAGE'
    | 'ABSOLUTE_PATH_REQUIRED'
    | 'APP_NOT_FOUND'
    | 'NOT_A_BUNDLE'
    | 'INVALID_OPTIONS'
    | 'VALIDATION_ERROR'
  readonly message: string
}

export interface ProductionCliReport {
  readonly format: 'electron-stagewright-production-validation'
  readonly version: 1
  readonly app_path: string
  readonly passed: boolean
  readonly exit_code: ProductionExitCode
  readonly summary?: ProductionValidationReport['summary']
  readonly checks?: readonly CheckResult[]
  readonly error?: ProductionCliError
}

export interface ProductionCliResult {
  readonly exitCode: ProductionExitCode
  readonly report: ProductionCliReport
}

export interface ProductionCliIo {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

export interface ProductionCliDependencies {
  readonly validateProductionApp: (
    appPath: string,
    options?: ProductionValidationOptions,
  ) => Promise<ProductionValidationReport>
}

const PROCESS_IO: ProductionCliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}
const DEFAULT_DEPS: ProductionCliDependencies = { validateProductionApp }
const CHECK_ID_SET = new Set<string>(CHECK_IDS)

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (value === undefined || value.length === 0 || value.startsWith('--')) {
    throw new Error(`${flag} expects a value`)
  }
  return value
}

function parseTimeout(value: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('--command-timeout-ms expects a positive safe integer')
  }
  return parsed
}

function parseChecks(value: string): readonly CheckId[] {
  const raw = value
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
  if (raw.length === 0) throw new Error('--checks expects at least one check id')
  const invalid = raw.find((id) => !CHECK_ID_SET.has(id))
  if (invalid !== undefined) {
    throw new Error(
      `--checks contains unknown id "${invalid}"; expected one of ${CHECK_IDS.join(', ')}`,
    )
  }
  return [...new Set(raw)] as CheckId[]
}

/** Strict parser for the production validation command. */
export function parseProductionCliArgs(argv: readonly string[]): ProductionCliOptions {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help')) {
    return { command: 'help', json: false }
  }

  const command = argv[0]
  if (command !== 'validate') {
    throw new Error(
      command === undefined
        ? 'Expected the production subcommand "validate"'
        : `Unknown production subcommand: ${command}`,
    )
  }
  if (argv.length === 2 && (argv[1] === '--help' || argv[1] === '-h')) {
    return { command: 'help', json: false }
  }

  let appPath: string | undefined
  let checks: readonly CheckId[] | undefined
  let commandTimeoutMs: number | undefined
  let json = false

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === undefined) continue
    if (arg === '--app') {
      if (appPath !== undefined) throw new Error('--app may be specified only once')
      appPath = requireValue(argv, index, arg)
      index += 1
      continue
    }
    if (arg === '--checks') {
      if (checks !== undefined) throw new Error('--checks may be specified only once')
      checks = parseChecks(requireValue(argv, index, arg))
      index += 1
      continue
    }
    if (arg === '--command-timeout-ms') {
      if (commandTimeoutMs !== undefined) {
        throw new Error('--command-timeout-ms may be specified only once')
      }
      commandTimeoutMs = parseTimeout(requireValue(argv, index, arg))
      index += 1
      continue
    }
    if (arg === '--json') {
      if (json) throw new Error('--json may be specified only once')
      json = true
      continue
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
    throw new Error(`Unexpected argument: ${arg}`)
  }

  if (appPath === undefined) throw new Error('validate requires --app <absolute-path>')
  return {
    command: 'validate',
    appPath,
    json,
    ...(checks === undefined ? {} : { checks }),
    ...(commandTimeoutMs === undefined ? {} : { commandTimeoutMs }),
  }
}

export function formatProductionCliHelp(): string {
  return [
    'Usage: electron-stagewright production validate --app <path> [options]',
    '       electron-stagewright-production validate --app <path> [options]',
    '',
    'Options:',
    '  --app <path>                    Absolute path to a packaged macOS .app bundle.',
    '  --checks <id[,id]>              Run only selected production checks.',
    '  --command-timeout-ms <n>        Timeout for each platform command (default: 10000).',
    '  --json                          Write one machine-readable JSON report.',
    '  --help, -h                      Print this help and exit.',
    '',
    'Exit codes: 0 no failed checks; 1 one or more checks failed; 2 invalid usage or input.',
  ].join('\n')
}

function errorReport(
  appPath: string,
  code: ProductionCliError['code'],
  message: string,
): ProductionCliReport {
  return {
    format: 'electron-stagewright-production-validation',
    version: 1,
    app_path: appPath,
    passed: false,
    exit_code: PRODUCTION_EXIT_CODES.USAGE,
    error: { code, message },
  }
}

function successReport(report: ProductionValidationReport): ProductionCliReport {
  const exitCode = report.passed
    ? PRODUCTION_EXIT_CODES.SUCCESS
    : PRODUCTION_EXIT_CODES.VALIDATION_FAILED
  return {
    format: 'electron-stagewright-production-validation',
    version: 1,
    ...report,
    exit_code: exitCode,
  }
}

function formatHumanReport(report: ProductionCliReport): string {
  if (report.error !== undefined) return `ERROR [${report.error.code}] ${report.error.message}`
  const summary = report.summary
  if (summary === undefined) return 'ERROR [VALIDATION_ERROR] report has no summary'
  const lines = [
    `${report.passed ? 'PASS' : 'FAIL'} ${report.app_path}`,
    `${summary.pass} passed, ${summary.fail} failed, ${summary.unknown} unknown`,
  ]
  for (const check of report.checks ?? []) {
    lines.push(`[${check.status.toUpperCase()}] ${check.id}: ${check.detail}`)
    if (check.evidence !== undefined) lines.push(`  evidence: ${check.evidence}`)
    for (const action of check.next_actions ?? []) lines.push(`  next: ${action}`)
  }
  return lines.join('\n')
}

function emit(
  options: ProductionCliOptions,
  report: ProductionCliReport,
  io: ProductionCliIo,
): void {
  const output = `${options.json ? JSON.stringify(report) : formatHumanReport(report)}\n`
  if (!options.json && report.error !== undefined) {
    io.stderr(output)
    return
  }
  io.stdout(output)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Execute already-parsed production validation options. Exported for deterministic tests. */
export async function runProductionCli(
  options: ProductionCliOptions,
  io: ProductionCliIo = PROCESS_IO,
  deps: ProductionCliDependencies = DEFAULT_DEPS,
): Promise<ProductionCliResult> {
  if (options.command === 'help') {
    io.stdout(`${formatProductionCliHelp()}\n`)
    const report: ProductionCliReport = {
      format: 'electron-stagewright-production-validation',
      version: 1,
      app_path: '',
      passed: true,
      exit_code: PRODUCTION_EXIT_CODES.SUCCESS,
    }
    return { exitCode: PRODUCTION_EXIT_CODES.SUCCESS, report }
  }

  const appPath = options.appPath ?? ''
  let report: ProductionCliReport
  try {
    report = successReport(
      await deps.validateProductionApp(appPath, {
        ...(options.checks === undefined ? {} : { checks: options.checks }),
        ...(options.commandTimeoutMs === undefined
          ? {}
          : { commandTimeoutMs: options.commandTimeoutMs }),
      }),
    )
  } catch (error) {
    report =
      error instanceof ProductionValidationError
        ? errorReport(error.appPath ?? appPath, error.code, error.message)
        : errorReport(appPath, 'VALIDATION_ERROR', errorMessage(error))
  }
  emit(options, report, io)
  return { exitCode: report.exit_code, report }
}

/**
 * Parse and execute a production command. The core CLI delegates to this function so it does not
 * need a dependency on the optional production package.
 */
export async function runProductionCliCommand(
  argv: readonly string[],
  io: ProductionCliIo = PROCESS_IO,
  deps: ProductionCliDependencies = DEFAULT_DEPS,
): Promise<ProductionExitCode> {
  let options: ProductionCliOptions
  try {
    options = parseProductionCliArgs(argv)
  } catch (error) {
    const message = errorMessage(error)
    if (argv.includes('--json')) {
      io.stdout(`${JSON.stringify(errorReport('', 'USAGE', message))}\n`)
    } else {
      io.stderr(`usage: ${message}\n`)
    }
    return PRODUCTION_EXIT_CODES.USAGE
  }
  return (await runProductionCli(options, io, deps)).exitCode
}

function isMainEntryPoint(moduleUrl: string, entryPath: string | undefined): boolean {
  if (entryPath === undefined) return false
  try {
    return moduleUrl === pathToFileURL(realpathSync(entryPath)).href
  } catch {
    return false
  }
}

if (isMainEntryPoint(import.meta.url, process.argv[1])) {
  runProductionCliCommand(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode
    })
    .catch((error: unknown) => {
      PROCESS_IO.stderr(`fatal: ${errorMessage(error)}\n`)
      process.exitCode = PRODUCTION_EXIT_CODES.USAGE
    })
}
