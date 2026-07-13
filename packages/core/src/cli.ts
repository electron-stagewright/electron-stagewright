#!/usr/bin/env node
/**
 * Command-line entry point for the Electron Stagewright MCP server.
 *
 * Starts the server and connects it over stdio. All diagnostics go to stderr —
 * stdout is reserved for MCP protocol frames, so a stray `console.log` here would
 * corrupt the stream and break the client.
 *
 * Invocation:
 * - `doctor [--json]` — run preflight checks and exit without opening the MCP
 *   stdio server. Default output is line-oriented; `--json` writes a single
 *   machine-readable report instead. Either mode exits non-zero when a required
 *   check fails.
 * - `--help` / `--version` — print standalone CLI output and exit.
 *
 * `doctor`, `--help`, and `--version` run to completion and exit before the MCP
 * server starts, so they may write normal text to stdout; server mode never
 * does, reserving stdout for MCP protocol frames.
 *
 * Server flags:
 * - `--allow-eval[=<targets>]` — register tools that execute arbitrary JavaScript
 *   (default: off). Bare `--allow-eval` enables both eval targets; `--allow-eval=main`,
 *   `--allow-eval=renderer`, or `--allow-eval=main,renderer` enable only the named
 *   target(s) for least privilege (ADR-014). A tool whose target is not enabled is
 *   omitted from `tools/list`.
 * - `--screenshot-dir <path>` — directory the screenshot tool writes captures
 *   into when no explicit path is given (default: the OS temp dir).
 * - `--app-root <path>` — confine `electron_launch`'s `main` / `executablePath` / `cwd` to within
 *   this directory (default: unset = no confinement). An opt-in allowlist: with it set, a tool call
 *   cannot spawn an arbitrary host binary or run arbitrary JS as the app main from outside the
 *   project root. Launching the app within the root is unaffected.
 * - `--plugin <name|path>` — load a plugin by package name or file path (ADR-004).
 *   Repeatable, and a single value may be comma-separated. Loaded explicitly; the
 *   server never auto-scans. An unresolvable plugin aborts startup.
 * - `--plugin-config <name>=<json>` — supply a plugin's config as inline JSON,
 *   validated against the plugin's configSchema. Repeatable, keyed by plugin name.
 * - `--operation-timeout-ms <n>` — backstop timeout for a single tool dispatch (ADR-011); a
 *   handler that does not settle within it returns a retryable OPERATION_TIMEOUT instead of
 *   hanging the agent on a frozen app. Default 120000; `0` disables it.
 * - `--tool-profile <profile>` — choose an explicit core tool surface: `essential`, `testing`,
 *   `debug`, or `full` (the compatibility default). Eval and explicitly loaded plugins compose
 *   independently.
 * - `--demo` — resolve the separately installed `@electron-stagewright/demo` package and make its
 *   Electron main entry the default for `electron_launch {}`. The normal server never loads it.
 *
 * Unknown options and positional arguments fail startup rather than being
 * silently ignored. This keeps a typo from weakening a requested confinement or
 * changing the tool set without the operator noticing.
 *
 * On SIGINT / SIGTERM the server is closed and every live session disposed, so a
 * Ctrl-C never leaves a launched Electron process orphaned.
 *
 * @module
 */

import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { resolveDemoMain } from './demo.js'
import { runDoctorChecks } from './doctor.js'
import { importPlugin } from './plugins/index.js'
import type { EvalPolicy } from './server/eval-policy.js'
import { createServer } from './server/index.js'
import { StderrLogger } from './server/logger.js'
import { isToolProfile, type ToolProfile } from './tools/index.js'
import { VERSION } from './version.js'

export type CliCommand = 'serve' | 'help' | 'version' | 'doctor'

export interface CliOptions {
  readonly command: CliCommand
  readonly doctorJson: boolean
  readonly demo: boolean
  readonly allowEval: EvalPolicy
  readonly toolProfile: ToolProfile
  readonly screenshotDir?: string
  readonly appRoot?: string
  readonly pluginSpecs: readonly string[]
  readonly pluginConfigs: Readonly<Record<string, unknown>>
  readonly operationTimeoutMs?: number
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(
      `${flag} expects a value, got ${value === undefined ? 'nothing' : `"${value}"`}`,
    )
  }
  return value
}

function parsePluginConfig(pair: string): readonly [string, unknown] {
  const eq = pair.indexOf('=')
  if (eq <= 0) throw new Error(`--plugin-config expects <name>=<json>, got "${pair}"`)
  const name = pair.slice(0, eq)
  try {
    return [name, JSON.parse(pair.slice(eq + 1))]
  } catch (cause) {
    throw new Error(
      `--plugin-config for "${name}" is not valid JSON: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    )
  }
}

function parseOperationTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `--operation-timeout-ms expects a non-negative integer number of milliseconds, got "${raw}"`,
    )
  }
  return value
}

function parseEvalTargets(value: string): EvalPolicy {
  const targets = value
    .split(',')
    .map((target) => target.trim())
    .filter((target) => target.length > 0)
  if (targets.length === 0) {
    throw new Error(
      '--allow-eval= expects main, renderer, or all (comma-separated), or a bare --allow-eval for both',
    )
  }
  const policy = { main: false, renderer: false }
  for (const target of targets) {
    if (target === 'main') policy.main = true
    else if (target === 'renderer') policy.renderer = true
    else if (target === 'all') {
      policy.main = true
      policy.renderer = true
    } else {
      throw new Error(`--allow-eval target must be main, renderer, or all, got "${target}"`)
    }
  }
  return policy
}

export function parseAllowEval(argv: readonly string[]): EvalPolicy {
  let policy: EvalPolicy = { main: false, renderer: false }
  for (const arg of argv) {
    if (arg === '--allow-eval') {
      policy = { main: true, renderer: true }
    } else if (arg.startsWith('--allow-eval=')) {
      policy = parseEvalTargets(arg.slice('--allow-eval='.length))
    }
  }
  return policy
}

function onlyOnce(value: string | undefined, flag: string): void {
  if (value !== undefined) throw new Error(`${flag} may be specified only once`)
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    return {
      command: 'help',
      doctorJson: false,
      demo: false,
      allowEval: { main: false, renderer: false },
      toolProfile: 'full',
      pluginSpecs: [],
      pluginConfigs: {},
    }
  }
  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-V')) {
    return {
      command: 'version',
      doctorJson: false,
      demo: false,
      allowEval: { main: false, renderer: false },
      toolProfile: 'full',
      pluginSpecs: [],
      pluginConfigs: {},
    }
  }

  let command: CliCommand = 'serve'
  let start = 0
  if (argv[0] === 'doctor') {
    command = 'doctor'
    start = 1
  }

  let screenshotDir: string | undefined
  let appRoot: string | undefined
  let operationTimeoutRaw: string | undefined
  let toolProfileRaw: string | undefined
  let toolProfile: ToolProfile = 'full'
  let allowEval: EvalPolicy = { main: false, renderer: false }
  let doctorJson = false
  let demo = false
  const pluginSpecs: string[] = []
  const pluginConfigs: Record<string, unknown> = {}

  for (let i = start; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined) continue
    if (arg === '--allow-eval') {
      allowEval = { main: true, renderer: true }
      continue
    }
    if (arg.startsWith('--allow-eval=')) {
      allowEval = parseEvalTargets(arg.slice('--allow-eval='.length))
      continue
    }
    if (arg === '--demo') {
      if (command === 'doctor') {
        throw new Error('--demo is only valid when starting the MCP server')
      }
      if (demo) throw new Error('--demo may be specified only once')
      demo = true
      continue
    }
    if (arg === '--screenshot-dir') {
      onlyOnce(screenshotDir, arg)
      screenshotDir = requireValue(argv, i, arg)
      i += 1
      continue
    }
    if (arg === '--app-root') {
      onlyOnce(appRoot, arg)
      appRoot = requireValue(argv, i, arg)
      i += 1
      continue
    }
    if (arg === '--operation-timeout-ms') {
      if (command === 'doctor') {
        throw new Error('--operation-timeout-ms is only valid when starting the MCP server')
      }
      onlyOnce(operationTimeoutRaw, arg)
      operationTimeoutRaw = requireValue(argv, i, arg)
      i += 1
      continue
    }
    if (arg === '--tool-profile') {
      if (command === 'doctor') {
        throw new Error('--tool-profile is only valid when starting the MCP server')
      }
      onlyOnce(toolProfileRaw, arg)
      toolProfileRaw = requireValue(argv, i, arg)
      if (!isToolProfile(toolProfileRaw)) {
        throw new Error(
          `--tool-profile must be essential, testing, debug, or full, got "${toolProfileRaw}"`,
        )
      }
      toolProfile = toolProfileRaw
      i += 1
      continue
    }
    if (arg === '--plugin') {
      if (command === 'doctor') {
        throw new Error('--plugin is only valid when starting the MCP server')
      }
      const values = requireValue(argv, i, arg)
        .split(',')
        .map((spec) => spec.trim())
        .filter((spec) => spec.length > 0)
      if (values.length === 0) throw new Error('--plugin expects at least one non-empty spec')
      pluginSpecs.push(...values)
      i += 1
      continue
    }
    if (arg === '--plugin-config') {
      if (command === 'doctor') {
        throw new Error('--plugin-config is only valid when starting the MCP server')
      }
      const [name, config] = parsePluginConfig(requireValue(argv, i, arg))
      pluginConfigs[name] = config
      i += 1
      continue
    }
    if (arg === '--json' && command === 'doctor') {
      doctorJson = true
      continue
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
    throw new Error(`Unexpected argument: ${arg}`)
  }

  const operationTimeoutMs =
    operationTimeoutRaw === undefined ? undefined : parseOperationTimeout(operationTimeoutRaw)
  return {
    command,
    doctorJson,
    demo,
    allowEval,
    toolProfile,
    ...(screenshotDir !== undefined ? { screenshotDir } : {}),
    ...(appRoot !== undefined ? { appRoot } : {}),
    ...(operationTimeoutMs !== undefined ? { operationTimeoutMs } : {}),
    pluginSpecs,
    pluginConfigs,
  }
}

export function formatCliHelp(): string {
  return [
    'Usage: electron-stagewright [options]',
    '       electron-stagewright doctor [--json] [options]',
    '',
    'Options:',
    '  --allow-eval[=main,renderer|all]  Enable eval tools (default: disabled).',
    '  --app-root <path>                 Confine launch and file paths to this root.',
    '  --screenshot-dir <path>           Default screenshot output directory.',
    '  --operation-timeout-ms <n>        Dispatch timeout in milliseconds (0 disables).',
    '  --tool-profile <profile>          Core tools: essential, testing, debug, or full.',
    '  --demo                            Default electron_launch to the packaged demo app.',
    '  --plugin <name|path>              Load a plugin; repeatable and comma-separated.',
    '  --plugin-config <name>=<json>     Supply a plugin configuration.',
    '  --help, -h                        Print this help and exit.',
    '  --version, -V                     Print the package version and exit.',
  ].join('\n')
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2))
  if (options.command === 'help') {
    process.stdout.write(`${formatCliHelp()}\n`)
    return
  }
  if (options.command === 'version') {
    process.stdout.write(`${VERSION}\n`)
    return
  }
  const {
    allowEval,
    toolProfile,
    screenshotDir,
    appRoot,
    demo,
    pluginSpecs,
    pluginConfigs,
    operationTimeoutMs,
  } = options
  if (options.command === 'doctor') {
    const report = await runDoctorChecks({
      ...(appRoot !== undefined ? { appRoot } : {}),
      ...(screenshotDir !== undefined ? { screenshotDir } : {}),
      allowEvalMain: allowEval.main,
      allowEvalRenderer: allowEval.renderer,
    })
    if (options.doctorJson) {
      process.stdout.write(`${JSON.stringify(report)}\n`)
    } else {
      for (const check of report.checks) {
        const hint = check.hint === undefined ? '' : ` Hint: ${check.hint}`
        process.stdout.write(`[${check.status}] ${check.id}: ${check.message}${hint}\n`)
      }
    }
    if (!report.ok) process.exitCode = 1
    return
  }
  const logger = new StderrLogger({ level: 'info' })

  if (demo && appRoot !== undefined) {
    throw new Error(
      '--demo cannot be combined with --app-root; the packaged demo is outside that root',
    )
  }
  const launchDefaultMain = demo ? await resolveDemoMain() : undefined

  // Resolve plugins before assembling the server. An unresolvable plugin throws (a
  // StagewrightError) and aborts startup via main().catch — fail-closed.
  const plugins = []
  for (const spec of pluginSpecs) {
    plugins.push(await importPlugin(spec))
  }

  const server = await createServer({
    allowEval,
    toolProfile,
    logger,
    ...(screenshotDir !== undefined ? { screenshotDir } : {}),
    ...(appRoot !== undefined ? { appRoot } : {}),
    ...(launchDefaultMain !== undefined ? { launchDefaultMain } : {}),
    ...(operationTimeoutMs !== undefined ? { operationTimeoutMs } : {}),
    ...(plugins.length > 0 ? { plugins } : {}),
    ...(Object.keys(pluginConfigs).length > 0 ? { pluginConfigs } : {}),
  })

  let shuttingDown = false
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info('Shutting down', { signal })
    try {
      await server.close()
    } catch (err) {
      logger.error('Error during shutdown', {
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  await server.connectStdio()
  logger.info('electron-stagewright MCP server ready (stdio)', {
    allowEval,
    toolProfile,
    plugins: plugins.length,
    demo,
  })
}

/**
 * True when `moduleUrl` (an `import.meta.url`) is the process entry point named by
 * `entryPath` (typically `process.argv[1]`).
 *
 * `entryPath` is resolved through symlinks first: npm/pnpm install a package `bin` as a
 * symlink (or shim) in `node_modules/.bin`, while ESM reports the realpath in
 * `import.meta.url`. Comparing the raw paths would make a globally-installed or `npx`-run
 * CLI a SILENT no-op — `main` would never run. Returns false when there is no entry path
 * or it cannot be resolved (e.g. the REPL or `node --eval`).
 */
export function isMainEntryPoint(moduleUrl: string, entryPath: string | undefined): boolean {
  if (entryPath === undefined) return false
  try {
    return moduleUrl === pathToFileURL(realpathSync(entryPath)).href
  } catch {
    return false
  }
}

// Run `main` only when this module is the process entry point (the published `bin`), not
// when it is imported — so tests can import `parseCliArgs` without spawning a server.
if (isMainEntryPoint(import.meta.url, process.argv[1])) {
  main().catch((err: unknown) => {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
    process.stderr.write(`fatal: ${detail}\n`)
    process.exit(1)
  })
}
