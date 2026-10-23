#!/usr/bin/env node

/**
 * Headless runner for reviewable replay specifications (ADR-009).
 *
 * The MCP server is optimized for an agent conversation. This executable provides the complementary
 * CI surface: read one checked-in spec, launch the app through the same dispatcher, and write a
 * compact human or JSON report with a stable process exit code.
 *
 * @module
 */

import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  StderrLogger,
  createServer,
  importPlugin,
  isToolProfile,
  type CreateServerOptions,
  type EvalPolicy,
  type StagewrightPlugin,
  type ToolProfile,
  type ToolResult,
} from '@electron-stagewright/core'

import {
  ReplayParameterError,
  parseReplaySpec,
  prepareReplaySpec,
  replaySpec,
  sensitiveArgumentKeys,
  type ReplaySpecOutcome,
  type ReplaySpecReport,
} from './spec.js'

/** Stable exit statuses for CI: assertion mismatch, invalid input, launch failure, infrastructure. */
export const REPLAY_EXIT_CODES = {
  SUCCESS: 0,
  MISMATCH: 1,
  MALFORMED_SPEC: 2,
  APP_LAUNCH: 3,
  INFRASTRUCTURE: 4,
  USAGE: 64,
} as const

export type ReplayExitCode = (typeof REPLAY_EXIT_CODES)[keyof typeof REPLAY_EXIT_CODES]

export interface ReplayCliOptions {
  readonly command: 'run' | 'help'
  readonly specPath?: string
  readonly json: boolean
  readonly include?: readonly string[]
  readonly exclude?: readonly string[]
  readonly allowEval: EvalPolicy
  readonly toolProfile: ToolProfile
  readonly pluginSpecs: readonly string[]
  readonly pluginConfigs: Readonly<Record<string, unknown>>
  readonly appRoot?: string
  readonly operationTimeoutMs?: number
  /** `--param name=value` values, applied after the params file and environment. */
  readonly parameters?: Readonly<Record<string, string>>
  /** `--params-file`: a JSON object of parameter values. */
  readonly paramsFile?: string
  /** `--param-env name=ENV_VAR`: parameters read from the environment, e.g. secrets. */
  readonly paramEnv?: Readonly<Record<string, string>>
}

export interface ReplayCliReport {
  readonly format: 'stagewright-replay-report'
  readonly version: 1
  readonly source: string
  readonly passed: boolean
  readonly exit_code: ReplayExitCode
  readonly summary?: {
    readonly matched: number
    readonly mismatched: number
    readonly skipped: number
  }
  readonly steps?: readonly ReplaySpecOutcome[]
  /** The values a parameterized spec ran with; sensitive ones are redacted. */
  readonly parameters?: Readonly<Record<string, unknown>>
  readonly error?: {
    readonly code: 'MALFORMED_SPEC' | 'INVALID_PARAMETERS' | 'INFRASTRUCTURE'
    readonly message: string
  }
}

export interface ReplayCliResult {
  readonly exitCode: ReplayExitCode
  readonly report: ReplayCliReport
}

interface ReplayServer {
  readonly dispatcher: {
    dispatch(tool: string, args: unknown): Promise<ToolResult>
  }
  close(): Promise<void>
}

export interface ReplayCliDependencies {
  readonly readFile: (path: string, encoding: BufferEncoding) => Promise<string>
  readonly importPlugin: (spec: string) => Promise<StagewrightPlugin>
  readonly createServer: (options: CreateServerOptions) => Promise<ReplayServer>
  /** Environment for `--param-env`; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

export interface ReplayCliIo {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

const DEFAULT_DEPS: ReplayCliDependencies = { readFile, importPlugin, createServer }
const PROCESS_IO: ReplayCliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (value === undefined || value.length === 0 || value.startsWith('--')) {
    throw new Error(`${flag} expects a value`)
  }
  return value
}

function parseToolList(value: string): readonly string[] {
  const tools = value
    .split(',')
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0)
  if (tools.length === 0) throw new Error('tool list expects at least one non-empty tool name')
  return tools
}

function parsePluginConfig(value: string): readonly [string, unknown] {
  const separator = value.indexOf('=')
  if (separator <= 0) throw new Error('--plugin-config expects <name>=<json>')
  const name = value.slice(0, separator)
  try {
    return [name, JSON.parse(value.slice(separator + 1))]
  } catch (error) {
    throw new Error(
      `--plugin-config for "${name}" is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

function parseAssignment(value: string, flag: string, what: string): readonly [string, string] {
  const separator = value.indexOf('=')
  if (separator <= 0) throw new Error(`${flag} expects <name>=<${what}>`)
  return [value.slice(0, separator), value.slice(separator + 1)]
}

function parseAllowEval(value: string): EvalPolicy {
  let main = false
  let renderer = false
  const targets = value
    .split(',')
    .map((target) => target.trim())
    .filter((target) => target.length > 0)
  if (targets.length === 0) throw new Error('--allow-eval expects main, renderer, or all')
  for (const target of targets) {
    if (target === 'main') main = true
    else if (target === 'renderer') renderer = true
    else if (target === 'all') {
      main = true
      renderer = true
    } else {
      throw new Error(`--allow-eval target must be main, renderer, or all, got "${target}"`)
    }
  }
  return { main, renderer }
}

function parseOperationTimeout(value: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error('--operation-timeout-ms expects a non-negative integer')
  }
  return parsed
}

/** Strictly parse the standalone replay CLI without ever starting an MCP stdio server. */
export function parseReplayCliArgs(argv: readonly string[]): ReplayCliOptions {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    return {
      command: 'help',
      json: false,
      allowEval: { main: false, renderer: false },
      toolProfile: 'full',
      pluginSpecs: [],
      pluginConfigs: {},
    }
  }

  let specPath: string | undefined
  let json = false
  let allowEval: EvalPolicy = { main: false, renderer: false }
  let toolProfile: ToolProfile = 'full'
  let appRoot: string | undefined
  let operationTimeoutMs: number | undefined
  const include: string[] = []
  const exclude: string[] = []
  const pluginSpecs: string[] = []
  const pluginConfigs: Record<string, unknown> = {}
  const parameters: Record<string, string> = {}
  const paramEnv: Record<string, string> = {}
  let paramsFile: string | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === undefined) continue
    if (arg === '--json') {
      if (json) throw new Error('--json may be specified only once')
      json = true
      continue
    }
    if (arg === '--include') {
      include.push(...parseToolList(requireValue(argv, index, arg)))
      index += 1
      continue
    }
    if (arg === '--exclude') {
      exclude.push(...parseToolList(requireValue(argv, index, arg)))
      index += 1
      continue
    }
    if (arg === '--allow-eval') {
      allowEval = { main: true, renderer: true }
      continue
    }
    if (arg.startsWith('--allow-eval=')) {
      allowEval = parseAllowEval(arg.slice('--allow-eval='.length))
      continue
    }
    if (arg === '--app-root') {
      if (appRoot !== undefined) throw new Error('--app-root may be specified only once')
      appRoot = requireValue(argv, index, arg)
      index += 1
      continue
    }
    if (arg === '--operation-timeout-ms') {
      if (operationTimeoutMs !== undefined) {
        throw new Error('--operation-timeout-ms may be specified only once')
      }
      operationTimeoutMs = parseOperationTimeout(requireValue(argv, index, arg))
      index += 1
      continue
    }
    if (arg === '--tool-profile') {
      const profile = requireValue(argv, index, arg)
      if (!isToolProfile(profile)) {
        throw new Error(
          `--tool-profile must be essential, testing, debug, or full, got "${profile}"`,
        )
      }
      toolProfile = profile
      index += 1
      continue
    }
    if (arg === '--plugin') {
      pluginSpecs.push(...parseToolList(requireValue(argv, index, arg)))
      index += 1
      continue
    }
    if (arg === '--param') {
      const [name, value] = parseAssignment(requireValue(argv, index, arg), arg, 'value')
      parameters[name] = value
      index += 1
      continue
    }
    if (arg === '--param-env') {
      const [name, variable] = parseAssignment(requireValue(argv, index, arg), arg, 'ENV_VAR')
      paramEnv[name] = variable
      index += 1
      continue
    }
    if (arg === '--params-file') {
      if (paramsFile !== undefined) throw new Error('--params-file may be specified only once')
      paramsFile = requireValue(argv, index, arg)
      index += 1
      continue
    }
    if (arg === '--plugin-config') {
      const [name, config] = parsePluginConfig(requireValue(argv, index, arg))
      pluginConfigs[name] = config
      index += 1
      continue
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
    if (specPath !== undefined) throw new Error(`Unexpected argument: ${arg}`)
    specPath = arg
  }

  if (specPath === undefined) throw new Error('Expected one replay specification path')
  return {
    command: 'run',
    specPath,
    json,
    allowEval,
    toolProfile,
    ...(include.length > 0 ? { include } : {}),
    ...(exclude.length > 0 ? { exclude } : {}),
    ...(appRoot !== undefined ? { appRoot } : {}),
    ...(operationTimeoutMs !== undefined ? { operationTimeoutMs } : {}),
    ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
    ...(Object.keys(paramEnv).length > 0 ? { paramEnv } : {}),
    ...(paramsFile !== undefined ? { paramsFile } : {}),
    pluginSpecs,
    pluginConfigs,
  }
}

/** Help text intentionally fits in a CI log without mixing with a JSON report. */
export function formatReplayCliHelp(): string {
  return [
    'Usage: electron-stagewright-replay <spec.json> [options]',
    '',
    'Options:',
    '  --json                           Write one machine-readable JSON report.',
    '  --include <tool[,tool]>          Run only named tools (required session creators stay).',
    '  --exclude <tool[,tool]>          Skip named tools.',
    '  --plugin <name|path>             Load a plugin used by the specification; repeatable.',
    '  --plugin-config <name>=<json>    Supply configuration for a loaded plugin.',
    '  --param <name>=<value>           Value for a declared spec parameter; repeatable.',
    '  --params-file <file.json>        A JSON object of parameter values.',
    '  --param-env <name>=<ENV_VAR>     Read a parameter from the environment (secrets).',
    '  --allow-eval[=main,renderer|all] Enable the required eval tools (default: disabled).',
    '  --app-root <path>                Confine launches and file paths to this root.',
    '  --operation-timeout-ms <n>       Dispatch timeout in milliseconds (0 disables).',
    '  --tool-profile <profile>         Core tools: essential, testing, debug, or full.',
    '  --help, -h                       Print this help and exit.',
    '',
    'Exit codes: 0 passed; 1 checkpoint mismatch; 2 malformed spec; 3 app launch failed;',
    '4 infrastructure error; 64 invalid CLI usage or parameter values.',
  ].join('\n')
}

function errorReport(
  source: string,
  exitCode: ReplayExitCode,
  code: 'MALFORMED_SPEC' | 'INVALID_PARAMETERS' | 'INFRASTRUCTURE',
  message: string,
): ReplayCliReport {
  return {
    format: 'stagewright-replay-report',
    version: 1,
    source,
    passed: false,
    exit_code: exitCode,
    error: { code, message },
  }
}

function successReport(
  source: string,
  exitCode: ReplayExitCode,
  report: ReplaySpecReport,
): ReplayCliReport {
  return {
    format: 'stagewright-replay-report',
    version: 1,
    source,
    passed: report.passed,
    exit_code: exitCode,
    summary: {
      matched: report.matched,
      mismatched: report.mismatched,
      skipped: report.skipped,
    },
    steps: report.steps,
    ...(report.parameters !== undefined ? { parameters: report.parameters } : {}),
  }
}

/** Merge parameter values: the params file, then `--param-env`, then `--param` (last wins). */
async function suppliedParameters(
  options: ReplayCliOptions,
  deps: ReplayCliDependencies,
): Promise<Record<string, unknown>> {
  const supplied: Record<string, unknown> = {}
  if (options.paramsFile !== undefined) {
    let parsed: unknown
    try {
      parsed = JSON.parse(await deps.readFile(path.resolve(options.paramsFile), 'utf8'))
    } catch (error) {
      throw new ReplayParameterError(
        'value',
        `Could not read --params-file: ${asErrorMessage(error)}`,
      )
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ReplayParameterError('value', '--params-file must hold a JSON object.')
    }
    Object.assign(supplied, parsed)
  }
  const env = deps.env ?? process.env
  for (const [name, variable] of Object.entries(options.paramEnv ?? {})) {
    const value = env[variable]
    if (value === undefined) {
      throw new ReplayParameterError('value', `--param-env ${name}: ${variable} is not set.`)
    }
    supplied[name] = value
  }
  return Object.assign(supplied, options.parameters ?? {})
}

function printable(value: unknown): string {
  const json = JSON.stringify(value)
  return json === undefined ? String(value) : json
}

function formatHumanReport(report: ReplayCliReport): string {
  if (report.error !== undefined) {
    return `FAIL [${report.error.code}] ${report.error.message}`
  }
  const summary = report.summary
  if (summary === undefined) return 'FAIL [INFRASTRUCTURE] report has no summary'
  const lines = [
    `${report.passed ? 'PASS' : 'FAIL'} ${summary.matched} matched, ${summary.mismatched} mismatched, ${summary.skipped} skipped`,
  ]
  for (const step of report.steps ?? []) {
    if (step.matched) continue
    lines.push(
      `step ${step.step + 1} ${step.tool} (${step.matcher}): expected ${printable(step.expected)}; actual ${printable(step.actual)}${step.message === undefined ? '' : ` — ${step.message}`}`,
    )
  }
  return lines.join('\n')
}

function emit(options: ReplayCliOptions, report: ReplayCliReport, io: ReplayCliIo): void {
  io.stdout(`${options.json ? JSON.stringify(report) : formatHumanReport(report)}\n`)
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Execute a spec through a fresh core server. Exported for deterministic tests; the binary wires
 * real filesystem, plugin loader, and server dependencies below.
 */
export async function runReplayCli(
  options: ReplayCliOptions,
  io: ReplayCliIo = PROCESS_IO,
  deps: ReplayCliDependencies = DEFAULT_DEPS,
): Promise<ReplayCliResult> {
  if (options.command === 'help') {
    io.stdout(`${formatReplayCliHelp()}\n`)
    const report: ReplayCliReport = {
      format: 'stagewright-replay-report',
      version: 1,
      source: '',
      passed: true,
      exit_code: REPLAY_EXIT_CODES.SUCCESS,
    }
    return { exitCode: REPLAY_EXIT_CODES.SUCCESS, report }
  }

  const source = path.resolve(options.specPath ?? '')
  let raw: string
  try {
    raw = await deps.readFile(source, 'utf8')
  } catch (error) {
    const report = errorReport(
      source,
      REPLAY_EXIT_CODES.INFRASTRUCTURE,
      'INFRASTRUCTURE',
      `Could not read replay specification: ${asErrorMessage(error)}`,
    )
    emit(options, report, io)
    return { exitCode: REPLAY_EXIT_CODES.INFRASTRUCTURE, report }
  }

  let spec: ReturnType<typeof parseReplaySpec>
  try {
    spec = parseReplaySpec(JSON.parse(raw) as unknown)
    if (!spec.steps.some((step) => step.tool === 'electron_launch')) {
      throw new Error('A standalone replay specification must include an electron_launch step.')
    }
  } catch (error) {
    const report = errorReport(
      source,
      REPLAY_EXIT_CODES.MALFORMED_SPEC,
      'MALFORMED_SPEC',
      asErrorMessage(error),
    )
    emit(options, report, io)
    return { exitCode: REPLAY_EXIT_CODES.MALFORMED_SPEC, report }
  }

  let supplied: Record<string, unknown>
  try {
    supplied = await suppliedParameters(options, deps)
    prepareReplaySpec(spec, supplied)
  } catch (error) {
    if (!(error instanceof ReplayParameterError)) throw error
    const exitCode =
      error.kind === 'spec' ? REPLAY_EXIT_CODES.MALFORMED_SPEC : REPLAY_EXIT_CODES.USAGE
    const report = errorReport(
      source,
      exitCode,
      error.kind === 'spec' ? 'MALFORMED_SPEC' : 'INVALID_PARAMETERS',
      error.message,
    )
    emit(options, report, io)
    return { exitCode, report }
  }
  let server: ReplayServer | undefined
  let result: ReplayCliResult
  try {
    const plugins = await Promise.all(
      options.pluginSpecs.map((plugin) => deps.importPlugin(plugin)),
    )
    // A loaded trace plugin records the args that carry secrets under their own names.
    const secretKeys = sensitiveArgumentKeys(spec)
    const pluginConfigs: Record<string, unknown> = { ...options.pluginConfigs }
    if (secretKeys.length > 0 && plugins.some((plugin) => plugin.name === 'trace')) {
      const current = (pluginConfigs['trace'] ?? {}) as { redact?: unknown }
      const redact = Array.isArray(current.redact) ? (current.redact as string[]) : []
      pluginConfigs['trace'] = { ...current, redact: [...new Set([...redact, ...secretKeys])] }
    }
    const serverOptions: CreateServerOptions = {
      allowEval: options.allowEval,
      toolProfile: options.toolProfile,
      logger: new StderrLogger({ level: 'info' }),
      ...(options.appRoot !== undefined ? { appRoot: options.appRoot } : {}),
      ...(options.operationTimeoutMs !== undefined
        ? { operationTimeoutMs: options.operationTimeoutMs }
        : {}),
      ...(plugins.length > 0 ? { plugins } : {}),
      ...(Object.keys(pluginConfigs).length > 0 ? { pluginConfigs } : {}),
    }
    server = await deps.createServer(serverOptions)
    const liveServer = server
    const replay = await replaySpec(
      spec,
      { dispatch: (tool, args) => liveServer.dispatcher.dispatch(tool, args) },
      {
        ...(options.include !== undefined ? { include: options.include } : {}),
        ...(options.exclude !== undefined ? { exclude: options.exclude } : {}),
        parameters: supplied,
      },
    )
    const launchFailed = replay.steps.some(
      (step) => step.tool === 'electron_launch' && !step.matched,
    )
    const exitCode: ReplayExitCode = replay.passed
      ? REPLAY_EXIT_CODES.SUCCESS
      : launchFailed
        ? REPLAY_EXIT_CODES.APP_LAUNCH
        : REPLAY_EXIT_CODES.MISMATCH
    result = { exitCode, report: successReport(source, exitCode, replay) }
  } catch (error) {
    const report = errorReport(
      source,
      REPLAY_EXIT_CODES.INFRASTRUCTURE,
      'INFRASTRUCTURE',
      asErrorMessage(error),
    )
    result = { exitCode: REPLAY_EXIT_CODES.INFRASTRUCTURE, report }
  }

  if (server !== undefined) {
    try {
      await server.close()
    } catch (error) {
      if (result.exitCode === REPLAY_EXIT_CODES.SUCCESS) {
        const report = errorReport(
          source,
          REPLAY_EXIT_CODES.INFRASTRUCTURE,
          'INFRASTRUCTURE',
          `Could not close replay server: ${asErrorMessage(error)}`,
        )
        result = { exitCode: REPLAY_EXIT_CODES.INFRASTRUCTURE, report }
      }
    }
  }
  emit(options, result.report, io)
  return result
}

async function main(): Promise<void> {
  let options: ReplayCliOptions
  try {
    options = parseReplayCliArgs(process.argv.slice(2))
  } catch (error) {
    PROCESS_IO.stderr(`usage: ${asErrorMessage(error)}\n`)
    process.exitCode = REPLAY_EXIT_CODES.USAGE
    return
  }
  const result = await runReplayCli(options)
  process.exitCode = result.exitCode
}

if (isMainEntryPoint(import.meta.url, process.argv[1])) {
  main().catch((error: unknown) => {
    PROCESS_IO.stderr(`fatal: ${asErrorMessage(error)}\n`)
    process.exitCode = REPLAY_EXIT_CODES.INFRASTRUCTURE
  })
}

/** Support npm's symlinked bin path as well as direct execution of dist/cli.js. */
function isMainEntryPoint(moduleUrl: string, entryPath: string | undefined): boolean {
  if (entryPath === undefined) return false
  try {
    return moduleUrl === pathToFileURL(realpathSync(entryPath)).href
  } catch {
    return false
  }
}
