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

import { loadPlugins } from '../plugins/index.js'
import type { StagewrightPlugin } from '../plugins/index.js'
import { DEFAULT_TOOLS } from '../tools/index.js'
import type { AnyToolDefinition } from '../tools/types.js'
import { Dispatcher } from './dispatcher.js'
import { type Logger, type LogLevel, StderrLogger } from './logger.js'
import { SessionManager } from './session-manager.js'
import { SnapshotStore } from './snapshot-store.js'
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
  /** Tools to register. Defaults to the full core tool surface exported by DEFAULT_TOOLS. */
  readonly tools?: Iterable<AnyToolDefinition>
  /**
   * First-party plugins to load (ADR-004). Each is validated, its tools registered under
   * `<plugin>_<tool>` and its error codes under `<plugin>.CODE`, its `setup` run, and its
   * `teardown` invoked on {@link StagewrightServer.close}. Plugins are passed explicitly —
   * the server never auto-scans for them.
   */
  readonly plugins?: Iterable<StagewrightPlugin>
  /** Transport registry. Defaults to the built-in set (Playwright/CDP/Injector). */
  readonly transports?: TransportRegistry
  /** Default directory the screenshot tool writes into; falls back to the OS temp dir. */
  readonly screenshotDir?: string
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
  /** The per-session snapshot store. */
  readonly snapshots: SnapshotStore
  /** Connect over stdio (reads stdin / writes protocol frames to stdout). */
  connectStdio(): Promise<void>
  /** Close the MCP server and dispose every live session. Idempotent-safe. */
  close(): Promise<void>
}

/**
 * Assemble a server: build a {@link SessionManager} and {@link Dispatcher}, load any
 * configured plugins, register the core + plugin tool set, and bind the tools onto a
 * fresh `McpServer`. No transport is connected until {@link StagewrightServer.connectStdio}.
 *
 * Async because a plugin's `setup` hook may be async; loading fails CLOSED, so a bad
 * plugin rejects `createServer` (and tears down any already-loaded plugins) rather than
 * yielding a half-initialised server.
 */
export async function createServer(opts: CreateServerOptions = {}): Promise<StagewrightServer> {
  const logger = opts.logger ?? new StderrLogger({ level: opts.logLevel ?? 'info' })
  const sessions = new SessionManager()
  const transports = opts.transports ?? new TransportRegistry()
  const snapshots = new SnapshotStore()
  const dispatcher = new Dispatcher({
    sessions,
    transports,
    snapshots,
    logger,
    allowEval: opts.allowEval ?? false,
    ...(opts.screenshotDir !== undefined ? { screenshotDir: opts.screenshotDir } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  })

  // Load plugins first (validates, namespaces, registers codes, runs setup). On any
  // failure the loader has already torn down the partial set, so we just propagate.
  const pluginResult = opts.plugins
    ? await loadPlugins(opts.plugins, { coreVersion: SERVER_VERSION })
    : undefined

  // Register core tools, then plugin tools. If registration throws after plugins loaded
  // (e.g. a defensive duplicate-name guard), tear the plugins back down before failing.
  try {
    dispatcher.registerAll(opts.tools ?? DEFAULT_TOOLS)
    if (pluginResult) dispatcher.registerAll(pluginResult.tools)
  } catch (err) {
    if (pluginResult) await pluginResult.teardownAll()
    throw err
  }

  const mcp = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })
  dispatcher.bindToMcpServer(mcp)

  return {
    mcp,
    dispatcher,
    sessions,
    transports,
    snapshots,
    async connectStdio(): Promise<void> {
      await mcp.connect(new StdioServerTransport())
    },
    async close(): Promise<void> {
      // Dispose sessions and tear down plugins even if the MCP close rejects — a failed
      // protocol shutdown must never leave a launched Electron process orphaned or leak
      // a plugin's registered error codes.
      try {
        await mcp.close()
      } finally {
        snapshots.clearAll()
        await sessions.disposeAll()
        if (pluginResult) await pluginResult.teardownAll()
      }
    },
  }
}
