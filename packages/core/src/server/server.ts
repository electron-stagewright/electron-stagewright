/**
 * MCP server assembly — wires the {@link Dispatcher}, {@link SessionManager},
 * {@link Logger}, and the tool set into a `McpServer` and exposes it over the
 * stdio transport.
 *
 * `createServer` builds the object graph but does not connect a transport, so
 * callers (the CLI, tests) decide when and how to attach one. `connectStdio`
 * is the production path; `close` tears the server down and disposes every live
 * session so no launched Electron process is orphaned.
 *
 * @module
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import type { AnyToolDefinition } from '../tools/types.js'
import { LIFECYCLE_TOOLS } from '../tools/lifecycle/index.js'
import { Dispatcher } from './dispatcher.js'
import { type Logger, type LogLevel, StderrLogger } from './logger.js'
import { SessionManager } from './session-manager.js'
import { TransportRegistry } from './transport-registry.js'

/** Server name advertised to MCP clients. */
const SERVER_NAME = '@electron-stagewright/core'
/**
 * Server version advertised to MCP clients. Kept in step with the package
 * version manually for now (the package is pre-release at 0.0.0); a build-time
 * inject can replace this once a release pipeline exists.
 */
const SERVER_VERSION = '0.0.0'

/** Options for {@link createServer}. */
export interface CreateServerOptions {
  /**
   * Enable eval-gated tools. When false (default), tools that declare
   * `requiresEvalFlag` are not registered and never appear in `tools/list`.
   */
  readonly allowEval?: boolean
  /** Logger to use. Defaults to a {@link StderrLogger} at {@link CreateServerOptions.logLevel}. */
  readonly logger?: Logger
  /** Level for the default logger when no `logger` is supplied. Defaults to `info`. */
  readonly logLevel?: LogLevel
  /** Tools to register. Defaults to the core lifecycle tools. */
  readonly tools?: Iterable<AnyToolDefinition>
  /** Transport registry. Defaults to the built-in set (Playwright/CDP/Injector). */
  readonly transports?: TransportRegistry
  /** Clock injection for deterministic timing in tests. */
  readonly now?: () => number
}

/** The assembled server and its collaborators. */
export interface StagewrightServer {
  /** The underlying MCP server (for advanced operations / notifications). */
  readonly mcp: McpServer
  /** The tool dispatcher. */
  readonly dispatcher: Dispatcher
  /** The session registry. */
  readonly sessions: SessionManager
  /** The transport registry. */
  readonly transports: TransportRegistry
  /** Connect over stdio (reads stdin / writes protocol frames to stdout). */
  connectStdio(): Promise<void>
  /** Close the MCP server and dispose every live session. Idempotent-safe. */
  close(): Promise<void>
}

/**
 * Assemble a server: build a {@link SessionManager} and {@link Dispatcher},
 * register the tool set, and bind the tools onto a fresh `McpServer`. No
 * transport is connected until {@link StagewrightServer.connectStdio} is called.
 */
export function createServer(opts: CreateServerOptions = {}): StagewrightServer {
  const logger = opts.logger ?? new StderrLogger({ level: opts.logLevel ?? 'info' })
  const sessions = new SessionManager()
  const transports = opts.transports ?? new TransportRegistry()
  const dispatcher = new Dispatcher({
    sessions,
    transports,
    logger,
    allowEval: opts.allowEval ?? false,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  })
  dispatcher.registerAll(opts.tools ?? LIFECYCLE_TOOLS)

  const mcp = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })
  dispatcher.bindToMcpServer(mcp)

  return {
    mcp,
    dispatcher,
    sessions,
    transports,
    async connectStdio(): Promise<void> {
      await mcp.connect(new StdioServerTransport())
    },
    async close(): Promise<void> {
      // Dispose sessions even if the MCP close rejects — a failed protocol
      // shutdown must never leave a launched Electron process orphaned.
      try {
        await mcp.close()
      } finally {
        await sessions.disposeAll()
      }
    },
  }
}
