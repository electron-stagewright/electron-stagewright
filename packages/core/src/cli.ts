#!/usr/bin/env node
/**
 * Command-line entry point for the Electron Stagewright MCP server.
 *
 * Starts the server and connects it over stdio. All diagnostics go to stderr —
 * stdout is reserved for MCP protocol frames, so a stray `console.log` here would
 * corrupt the stream and break the client.
 *
 * Flags:
 * - `--allow-eval` — register tools that execute arbitrary JavaScript (default:
 *   off). When disabled, eval-classified tools are omitted from `tools/list`.
 *
 * On SIGINT / SIGTERM the server is closed and every live session disposed, so a
 * Ctrl-C never leaves a launched Electron process orphaned.
 *
 * @module
 */

import { createServer } from './server/index.js'
import { StderrLogger } from './server/logger.js'

/** Parsed CLI options. */
interface CliOptions {
  readonly allowEval: boolean
}

/** Parse the supported flags from argv (excluding `node` and the script path). */
export function parseCliArgs(argv: readonly string[]): CliOptions {
  return { allowEval: argv.includes('--allow-eval') }
}

async function main(): Promise<void> {
  const { allowEval } = parseCliArgs(process.argv.slice(2))
  const logger = new StderrLogger({ level: 'info' })
  const server = createServer({ allowEval, logger })

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
  logger.info('electron-stagewright MCP server ready (stdio)', { allowEval })
}

main().catch((err: unknown) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
  process.stderr.write(`fatal: ${detail}\n`)
  process.exit(1)
})
