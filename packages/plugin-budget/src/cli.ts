#!/usr/bin/env node

/**
 * `electron-stagewright-budget`: the CI face of the budget plugin.
 *
 * Exit codes: 0 within budget, 1 over budget or nothing measured, 2 usage, unreadable input, or any
 * other error.
 *
 * @module
 */

import { realpathSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { BudgetFileError, PHASES, loadBudget, type Phase } from './budget.js'
import { measureBundle } from './bundle.js'
import { checkRun, type CheckReport } from './check.js'
import { DEFAULT_ROUNDS, measureApp, type LaunchPhase, type Workload } from './measure.js'
import { compareRuns, renderCheckReport, renderComparison } from './render.js'
import { RunFileError, createRun, loadRun, type BudgetRun } from './run.js'

export const BUDGET_EXIT_CODES = { SUCCESS: 0, OVER_BUDGET: 1, USAGE: 2 } as const
export type BudgetExitCode = (typeof BUDGET_EXIT_CODES)[keyof typeof BUDGET_EXIT_CODES]

export interface BudgetCliIo {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

const PROCESS_IO: BudgetCliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}

export type BudgetCliOptions =
  | { readonly command: 'help' }
  | {
      readonly command: 'check'
      readonly runPath: string
      readonly budgetPath: string
      readonly strict: boolean
      readonly requireMeasurement: boolean
      readonly phase?: Phase
      readonly json: boolean
    }
  | {
      readonly command: 'compare'
      readonly beforePath: string
      readonly afterPath: string
      readonly json: boolean
    }
  | {
      readonly command: 'bundle'
      readonly budgetPath: string
      readonly root?: string
      readonly outPath?: string
      readonly strict: boolean
      readonly json: boolean
    }
  | MeasureCliOptions

export interface MeasureCliOptions {
  readonly command: 'measure'
  readonly main?: string
  readonly executablePath?: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly budgetPath?: string
  readonly rounds: number
  readonly phases: readonly LaunchPhase[]
  readonly settleMs?: number
  readonly windowMs?: number
  readonly workloadPath?: string
  readonly label?: string
  readonly outPath?: string
  readonly check: boolean
  readonly strict: boolean
  readonly requireMeasurement: boolean
  readonly json: boolean
}

/** Seam for tests: the launch-and-measure step. */
export interface BudgetCliDependencies {
  readonly measureApp: typeof measureApp
}

class UsageError extends Error {}

export function formatBudgetCliHelp(): string {
  return [
    'Usage:',
    '  electron-stagewright-budget measure (--main <main.js> | --executable <path>) [--arg <v>]...',
    '                              [--env K=V]... [--budget <file>] [--rounds 3]',
    '                              [--phases cold,warm] [--settle-ms 3000] [--window-ms 2000]',
    '                              [--workload <script.mjs>] [--label <text>] [--out <run.json>]',
    '                              [--check [--strict] [--require-measurement]] [--json]',
    '  electron-stagewright-budget check <run.json> --budget <file> [--strict]',
    '                              [--require-measurement] [--phase cold|warm|live] [--json]',
    '  electron-stagewright-budget compare <before.json> <after.json> [--json]',
    '  electron-stagewright-budget bundle --budget <file> [--root <dir>] [--out <run.json>]',
    '                              [--strict] [--json]',
    '',
    'measure   Launch the app on a throwaway profile and measure cold and warm rounds.',
    '          --workload is an ES module whose default export, async ({ dispatch, sessionId,',
    '          phase }), drives the app inside the measurement window. Without --out or',
    '          --check the run document goes to stdout.',
    'check     Compare a measured run to a budget file.',
    'compare   Print a before/after table of two runs.',
    'bundle    Measure the bundle entries of a budget and gate them; needs no Electron.',
    '',
    '--strict               Ignore thresholdPercent; the limit itself gates.',
    '--require-measurement  Fail when a budgeted metric was not measured.',
    '',
    'Exit codes: 0 within budget, 1 over budget or nothing measured,',
    '            2 usage, unreadable input, or any other error.',
  ].join('\n')
}

function positiveInt(flag: string, value: string, min = 1): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    throw new UsageError(`${flag} expects an integer of at least ${min}`)
  }
  return parsed
}

function parseMeasureArgs(rest: readonly string[]): MeasureCliOptions {
  const single = new Map<string, string>()
  const args: string[] = []
  const env: Record<string, string> = {}
  const flags = new Set<string>()
  const valueFlags = [
    '--main',
    '--executable',
    '--budget',
    '--rounds',
    '--phases',
    '--settle-ms',
    '--window-ms',
    '--workload',
    '--label',
    '--out',
  ]
  const booleanFlags = ['--check', '--strict', '--require-measurement', '--json']
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] as string
    if (booleanFlags.includes(token)) {
      flags.add(token)
      continue
    }
    if (token !== '--arg' && token !== '--env' && !valueFlags.includes(token)) {
      throw new UsageError(`Unknown option for measure: ${token}`)
    }
    const value = rest[index + 1]
    // --arg forwards anything, including values that start with dashes.
    if (value === undefined || (token !== '--arg' && value.startsWith('--'))) {
      throw new UsageError(`${token} expects a value`)
    }
    index += 1
    if (token === '--arg') {
      args.push(value)
    } else if (token === '--env') {
      const separator = value.indexOf('=')
      if (separator <= 0) throw new UsageError('--env expects KEY=VALUE')
      env[value.slice(0, separator)] = value.slice(separator + 1)
    } else {
      if (single.has(token)) throw new UsageError(`${token} may be given only once`)
      single.set(token, value)
    }
  }
  const main = single.get('--main')
  const executablePath = single.get('--executable')
  if (main === undefined && executablePath === undefined) {
    throw new UsageError('measure requires --main <main.js> or --executable <path>')
  }
  const phases = (single.get('--phases') ?? 'cold,warm').split(',').map((phase) => phase.trim())
  if (phases.length === 0 || phases.some((phase) => phase !== 'cold' && phase !== 'warm')) {
    throw new UsageError('--phases expects cold, warm, or cold,warm')
  }
  const check = flags.has('--check')
  const budgetPath = single.get('--budget')
  if (check && budgetPath === undefined) throw new UsageError('--check requires --budget <file>')
  if (!check && (flags.has('--strict') || flags.has('--require-measurement'))) {
    throw new UsageError('--strict and --require-measurement apply only with --check')
  }
  const optional = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } =>
    value === undefined ? {} : ({ [key]: value } as { [P in K]: V })
  const number = (flag: string, min: number): number | undefined => {
    const value = single.get(flag)
    return value === undefined ? undefined : positiveInt(flag, value, min)
  }
  return {
    command: 'measure',
    ...optional('main', main === undefined ? undefined : path.resolve(main)),
    ...optional(
      'executablePath',
      executablePath === undefined ? undefined : path.resolve(executablePath),
    ),
    args,
    env,
    ...optional('budgetPath', budgetPath),
    rounds: number('--rounds', 1) ?? DEFAULT_ROUNDS,
    phases: [...new Set(phases)] as LaunchPhase[],
    ...optional('settleMs', number('--settle-ms', 0)),
    ...optional('windowMs', number('--window-ms', 250)),
    ...optional('workloadPath', single.get('--workload')),
    ...optional('label', single.get('--label')),
    ...optional('outPath', single.get('--out')),
    check,
    strict: flags.has('--strict'),
    requireMeasurement: flags.has('--require-measurement'),
    json: flags.has('--json'),
  }
}

/** Strict parser: an unknown flag or a missing value is a usage error. */
export function parseBudgetCliArgs(argv: readonly string[]): BudgetCliOptions {
  const [command, ...rest] = argv
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    if (command === undefined)
      throw new UsageError('Expected a subcommand: measure, check, compare, bundle')
    return { command: 'help' }
  }
  if (rest.includes('--help') || rest.includes('-h')) return { command: 'help' }
  if (command === 'measure') return parseMeasureArgs(rest)
  if (command !== 'check' && command !== 'compare' && command !== 'bundle') {
    throw new UsageError(`Unknown subcommand: ${command}`)
  }

  const valueFlags: Record<typeof command, readonly string[]> = {
    check: ['--budget', '--phase'],
    compare: [],
    bundle: ['--budget', '--root', '--out'],
  }
  const booleanFlags: Record<typeof command, readonly string[]> = {
    check: ['--strict', '--require-measurement', '--json'],
    compare: ['--json'],
    bundle: ['--strict', '--json'],
  }
  const values = new Map<string, string>()
  const flags = new Set<string>()
  const positional: string[] = []
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] as string
    if (valueFlags[command].includes(token)) {
      const value = rest[index + 1]
      if (value === undefined || value.length === 0 || value.startsWith('--')) {
        throw new UsageError(`${token} expects a value`)
      }
      values.set(token, value)
      index += 1
    } else if (booleanFlags[command].includes(token)) {
      flags.add(token)
    } else if (token.startsWith('-')) {
      throw new UsageError(`Unknown option for ${command}: ${token}`)
    } else {
      positional.push(token)
    }
  }
  const requireBudget = (): string => {
    const budgetPath = values.get('--budget')
    if (budgetPath === undefined) throw new UsageError(`${command} requires --budget <file>`)
    return budgetPath
  }
  const json = flags.has('--json')

  if (command === 'compare') {
    const [beforePath, afterPath, extra] = positional
    if (beforePath === undefined || afterPath === undefined || extra !== undefined) {
      throw new UsageError('compare expects exactly two run files')
    }
    return { command, beforePath, afterPath, json }
  }
  if (command === 'bundle') {
    if (positional.length > 0) throw new UsageError(`Unexpected argument: ${positional[0]}`)
    const root = values.get('--root')
    const outPath = values.get('--out')
    return {
      command,
      budgetPath: requireBudget(),
      ...(root === undefined ? {} : { root }),
      ...(outPath === undefined ? {} : { outPath }),
      strict: flags.has('--strict'),
      json,
    }
  }
  const [runPath, extra] = positional
  if (runPath === undefined || extra !== undefined) {
    throw new UsageError('check expects exactly one run file')
  }
  const phase = values.get('--phase')
  if (phase !== undefined && !(PHASES as readonly string[]).includes(phase)) {
    throw new UsageError(`--phase expects one of ${PHASES.join(', ')}`)
  }
  return {
    command,
    runPath,
    budgetPath: requireBudget(),
    strict: flags.has('--strict'),
    requireMeasurement: flags.has('--require-measurement'),
    ...(phase === undefined ? {} : { phase: phase as Phase }),
    json,
  }
}

function emitReport(report: CheckReport, json: boolean, io: BudgetCliIo): BudgetExitCode {
  io.stdout(`${json ? JSON.stringify(report) : renderCheckReport(report)}\n`)
  return report.passed ? BUDGET_EXIT_CODES.SUCCESS : BUDGET_EXIT_CODES.OVER_BUDGET
}

/** Execute already-parsed options. Throws the typed file errors; the caller maps them to exit 2. */
async function writeRun(outPath: string, run: BudgetRun): Promise<void> {
  await mkdir(path.dirname(path.resolve(outPath)), { recursive: true })
  await writeFile(outPath, `${JSON.stringify(run, null, 2)}\n`)
}

async function loadWorkload(workloadPath: string): Promise<Workload> {
  let module: { default?: unknown }
  try {
    module = (await import(pathToFileURL(path.resolve(workloadPath)).href)) as { default?: unknown }
  } catch (error) {
    throw new UsageError(
      `Cannot load workload ${workloadPath}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (typeof module.default !== 'function') {
    throw new UsageError(`Workload ${workloadPath} must default-export an async function`)
  }
  return module.default as Workload
}

async function runMeasure(
  options: MeasureCliOptions,
  io: BudgetCliIo,
  deps: BudgetCliDependencies,
): Promise<BudgetExitCode> {
  const budget = options.budgetPath === undefined ? undefined : await loadBudget(options.budgetPath)
  const workload =
    options.workloadPath === undefined ? undefined : await loadWorkload(options.workloadPath)
  let run = await deps.measureApp({
    launch: {
      ...(options.main === undefined ? {} : { main: options.main }),
      ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
      args: options.args,
      env: options.env,
    },
    rounds: options.rounds,
    phases: options.phases,
    ...(options.settleMs === undefined ? {} : { settleMs: options.settleMs }),
    ...(options.windowMs === undefined ? {} : { windowMs: options.windowMs }),
    ...(budget === undefined ? {} : { budget }),
    ...(workload === undefined ? {} : { workload }),
    ...(options.label === undefined ? {} : { label: options.label }),
    onProgress: (message) => io.stderr(`${message}\n`),
  })
  if (budget?.bundle !== undefined && options.budgetPath !== undefined) {
    const root = path.dirname(path.resolve(options.budgetPath))
    run = { ...run, bundle: await measureBundle(root, budget.bundle.entries) }
  }
  // A run with no round would later read as "nothing over budget"; never write one.
  if (run.rounds.length === 0) {
    io.stderr('No round produced a measurement; no run was written.\n')
    return BUDGET_EXIT_CODES.OVER_BUDGET
  }
  if (options.outPath !== undefined) await writeRun(options.outPath, run)
  if (options.check && budget !== undefined) {
    const report = checkRun(run, budget, {
      strict: options.strict,
      requireMeasurement: options.requireMeasurement,
    })
    return emitReport(report, options.json, io)
  }
  if (options.outPath === undefined) io.stdout(`${JSON.stringify(run, null, 2)}\n`)
  else io.stderr(`Wrote ${options.outPath}\n`)
  return BUDGET_EXIT_CODES.SUCCESS
}

export async function runBudgetCli(
  options: BudgetCliOptions,
  io: BudgetCliIo = PROCESS_IO,
  deps: BudgetCliDependencies = { measureApp },
): Promise<BudgetExitCode> {
  if (options.command === 'help') {
    io.stdout(`${formatBudgetCliHelp()}\n`)
    return BUDGET_EXIT_CODES.SUCCESS
  }
  if (options.command === 'measure') return runMeasure(options, io, deps)
  if (options.command === 'compare') {
    const rows = compareRuns(await loadRun(options.beforePath), await loadRun(options.afterPath))
    if (rows.length === 0) {
      io.stderr('Neither run holds a measurement; nothing to compare.\n')
      return BUDGET_EXIT_CODES.OVER_BUDGET
    }
    io.stdout(`${options.json ? JSON.stringify({ rows }) : renderComparison(rows)}\n`)
    return BUDGET_EXIT_CODES.SUCCESS
  }
  const budget = await loadBudget(options.budgetPath)
  if (options.command === 'check') {
    const report = checkRun(await loadRun(options.runPath), budget, {
      strict: options.strict,
      requireMeasurement: options.requireMeasurement,
      ...(options.phase === undefined ? {} : { phase: options.phase }),
    })
    return emitReport(report, options.json, io)
  }

  if (budget.bundle === undefined) {
    throw new UsageError(`${options.budgetPath} has no "bundle" section to measure`)
  }
  const root = path.resolve(options.root ?? path.dirname(options.budgetPath))
  const run = createRun({ rounds: [], bundle: await measureBundle(root, budget.bundle.entries) })
  if (options.outPath !== undefined) await writeRun(options.outPath, run)
  const bundleOnly = {
    ...(budget.thresholdPercent === undefined ? {} : { thresholdPercent: budget.thresholdPercent }),
    bundle: budget.bundle,
  }
  // Every entry was asked for by name here, so one that matched nothing fails the command.
  const report = checkRun(run, bundleOnly, { strict: options.strict, requireMeasurement: true })
  return emitReport(report, options.json, io)
}

/** Parse and execute; never throws. */
export async function runBudgetCliCommand(
  argv: readonly string[],
  io: BudgetCliIo = PROCESS_IO,
  deps: BudgetCliDependencies = { measureApp },
): Promise<BudgetExitCode> {
  try {
    return await runBudgetCli(parseBudgetCliArgs(argv), io, deps)
  } catch (error) {
    const known =
      error instanceof UsageError ||
      error instanceof BudgetFileError ||
      error instanceof RunFileError
    const message = error instanceof Error ? error.message : String(error)
    io.stderr(`${known ? 'usage' : 'fatal'}: ${message}\n`)
    if (error instanceof UsageError) io.stderr(`\n${formatBudgetCliHelp()}\n`)
    // Exit 1 means over budget; a crash must never read as a measured verdict.
    return BUDGET_EXIT_CODES.USAGE
  }
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
  process.exitCode = await runBudgetCliCommand(process.argv.slice(2))
}
