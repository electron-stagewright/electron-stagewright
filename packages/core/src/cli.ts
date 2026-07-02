#!/usr/bin/env node
/**
 * Command-line entry point for the Electron Stagewright MCP server.
 *
 * Starts the server and connects it over stdio. All diagnostics go to stderr —
 * stdout is reserved for MCP protocol frames, so a stray `console.log` here would
 * corrupt the stream and break the client.
 *
 * Flags:
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
 *
 * On SIGINT / SIGTERM the server is closed and every live session disposed, so a
 * Ctrl-C never leaves a launched Electron process orphaned.
 *
 * @module
 */

import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { importPlugin } from './plugins/index.js'
import type { EvalPolicy } from './server/eval-policy.js'
import { createServer } from './server/index.js'
import { StderrLogger } from './server/logger.js'

/** Parsed CLI options. */
interface CliOptions {
  /** The eval authorization policy parsed from `--allow-eval[=<targets>]` (ADR-014). */
  readonly allowEval: EvalPolicy
  readonly screenshotDir?: string
  /** Optional root directory `electron_launch` paths are confined to (`--app-root`). */
  readonly appRoot?: string
  /** Plugin specs to load (package names or file paths), in order. */
  readonly pluginSpecs: readonly string[]
  /** Per-plugin config parsed from `--plugin-config <name>=<json>`, keyed by plugin name. */
  readonly pluginConfigs: Readonly<Record<string, unknown>>
  /** Dispatch backstop timeout (ms) from `--operation-timeout-ms` (ADR-011); absent → the default. */
  readonly operationTimeoutMs?: number
}

/**
 * Read the value following a `--flag <value>` argument, or `undefined` when the flag is absent.
 * A flag PRESENT with a missing value (end of argv, or the next token is another `--flag`) throws:
 * `--app-root` and `--screenshot-dir` are security/confinement-relevant, so failing open — parsing
 * `--app-root --allow-eval` as "no app-root confinement" — would silently disable a control the
 * operator asked for.
 */
function readFlagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(
      `${flag} expects a value, got ${value === undefined ? 'nothing' : `"${value}"`}`,
    )
  }
  return value
}

/** Read EVERY value following a repeated `--flag <value>` argument, in order. Throws on a missing value (see {@link readFlagValue}). */
function readFlagValues(argv: readonly string[], flag: string): string[] {
  const values: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== flag) continue
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(
        `${flag} expects a value, got ${value === undefined ? 'nothing' : `"${value}"`}`,
      )
    }
    values.push(value)
  }
  return values
}

/** Parse `--plugin-config <name>=<json>` pairs into a config record. Throws on bad JSON. */
function parsePluginConfigs(argv: readonly string[]): Record<string, unknown> {
  const configs: Record<string, unknown> = {}
  for (const pair of readFlagValues(argv, '--plugin-config')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) {
      throw new Error(`--plugin-config expects <name>=<json>, got "${pair}"`)
    }
    const name = pair.slice(0, eq)
    try {
      configs[name] = JSON.parse(pair.slice(eq + 1))
    } catch (cause) {
      throw new Error(
        `--plugin-config for "${name}" is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
  }
  return configs
}

/**
 * Parse the optional `--operation-timeout-ms <n>` flag into a non-negative integer. Throws on a
 * non-numeric, non-integer, or negative value so a typo fails startup loudly rather than silently
 * disabling the dispatch backstop.
 */
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

/** Parse a comma-separated `--allow-eval=<targets>` value into a policy; throws on an unknown target. */
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

/**
 * Parse `--allow-eval[=<targets>]` into an eval authorization policy (ADR-014). Bare
 * `--allow-eval` enables both targets; `--allow-eval=main` / `=renderer` /
 * `=main,renderer` (or `=all`) enable the named target(s); absent → neither. The last
 * occurrence wins. An unrecognised target value throws so a typo fails startup loudly
 * rather than silently granting or denying the wrong eval surface.
 */
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

/** Parse the supported flags from argv (excluding `node` and the script path). */
export function parseCliArgs(argv: readonly string[]): CliOptions {
  const screenshotDir = readFlagValue(argv, '--screenshot-dir')
  const appRoot = readFlagValue(argv, '--app-root')
  const operationTimeoutMs = parseOperationTimeout(readFlagValue(argv, '--operation-timeout-ms'))
  // `--plugin` is repeatable and each value may be comma-separated.
  const pluginSpecs = readFlagValues(argv, '--plugin')
    .flatMap((value) => value.split(','))
    .map((spec) => spec.trim())
    .filter((spec) => spec.length > 0)
  return {
    allowEval: parseAllowEval(argv),
    ...(screenshotDir !== undefined ? { screenshotDir } : {}),
    ...(appRoot !== undefined ? { appRoot } : {}),
    ...(operationTimeoutMs !== undefined ? { operationTimeoutMs } : {}),
    pluginSpecs,
    pluginConfigs: parsePluginConfigs(argv),
  }
}

async function main(): Promise<void> {
  const { allowEval, screenshotDir, appRoot, pluginSpecs, pluginConfigs, operationTimeoutMs } =
    parseCliArgs(process.argv.slice(2))
  const logger = new StderrLogger({ level: 'info' })

  // Resolve plugins before assembling the server. An unresolvable plugin throws (a
  // StagewrightError) and aborts startup via main().catch — fail-closed.
  const plugins = []
  for (const spec of pluginSpecs) {
    plugins.push(await importPlugin(spec))
  }

  const server = await createServer({
    allowEval,
    logger,
    ...(screenshotDir !== undefined ? { screenshotDir } : {}),
    ...(appRoot !== undefined ? { appRoot } : {}),
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
    plugins: plugins.length,
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
