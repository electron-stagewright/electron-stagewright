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

import { definePluginsInfoTool, loadPlugins } from '../plugins/index.js'
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
  /**
   * Raw config values per plugin name (ADR-004). A plugin with a `configSchema` validates
   * `pluginConfigs[plugin.name]` against it and receives the parsed result in `setup`.
   */
  readonly pluginConfigs?: Readonly<Record<string, unknown>>
  /** Transport registry. Defaults to the built-in set (Playwright/CDP/Injector). */
  readonly transports?: TransportRegistry
  /** Default directory the screenshot tool writes into; relative paths resolve at startup. */
  readonly screenshotDir?: string
  /**
   * Optional root directory `electron_launch`'s `main` / `executablePath` / `cwd` are confined to.
   * Unset means no confinement (paths may be anywhere). Resolved to an absolute path at startup.
   */
  readonly appRoot?: string
  /** Clock injection for deterministic timing in tests. */
  readonly now?: () => number
  /**
   * Backstop timeout (ms) for a single tool dispatch (ADR-011): a handler that does not settle
   * within this budget resolves with a retryable `OPERATION_TIMEOUT` instead of hanging the agent
   * on a frozen app. Must exceed the longest per-tool budget (the wait family's 60s clamp); `0`
   * disables the backstop. Defaults to the dispatcher's `DEFAULT_OPERATION_TIMEOUT_MS` (120s).
   */
  readonly operationTimeoutMs?: number
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
    ...(opts.appRoot !== undefined ? { appRoot: opts.appRoot } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.operationTimeoutMs !== undefined
      ? { operationTimeoutMs: opts.operationTimeoutMs }
      : {}),
  })

  // Load plugins first (validates, namespaces, registers codes, runs setup). On any
  // failure the loader has already torn down the partial set, so we just propagate.
  const pluginResult = opts.plugins
    ? await loadPlugins(opts.plugins, {
        coreVersion: SERVER_VERSION,
        ...(opts.pluginConfigs !== undefined ? { configs: opts.pluginConfigs } : {}),
      })
    : undefined

  // Surface likely operator mistakes: configs are keyed by plugin name, so a typo (or a
  // forgotten --plugin) would silently fall back to the plugin's default config otherwise.
  // Warn rather than throw — an extra config key is not fatal.
  if (opts.pluginConfigs !== undefined) {
    const loadedNames = new Set((pluginResult?.loaded ?? []).map((plugin) => plugin.name))
    const orphanedKeys = Object.keys(opts.pluginConfigs).filter((key) => !loadedNames.has(key))
    if (orphanedKeys.length > 0) {
      logger.warn('Plugin config supplied for unloaded plugins; the config was ignored', {
        configKeys: orphanedKeys,
      })
    }
  }

  // Register core tools, then plugin tools. When plugins are present, also register the
  // plugins-introspection tool — only then, so a plugin-free server keeps its tool surface
  // minimal. If registration throws after plugins loaded (e.g. a defensive duplicate-name
  // guard), tear the plugins back down before failing.
  try {
    dispatcher.registerAll(opts.tools ?? DEFAULT_TOOLS)
    if (pluginResult && pluginResult.loaded.length > 0) {
      dispatcher.register(
        definePluginsInfoTool(
          pluginResult.loaded.map((plugin) => ({
            name: plugin.name,
            version: plugin.version,
            tools: plugin.tools.map((tool) => tool.name),
          })),
        ),
      )
      dispatcher.registerAll(pluginResult.tools)
    }
  } catch (err) {
    if (pluginResult) await pluginResult.teardownAll()
    throw err
  }

  // Declare the `tools` capability explicitly: the dispatcher serves tools/list and
  // tools/call via its own low-level request handlers (so validation failures become
  // agent-UX envelopes, not raw -32602), bypassing registerTool — which is what would
  // otherwise declare this capability. listChanged is false: the tool set is fixed once
  // plugins are loaded, before any transport connects.
  const mcp = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: { listChanged: false } },
      // Surfaced in InitializeResult so a host can prime the model with the cross-tool conventions
      // every tool would otherwise re-teach — the protocol-native channel for ADR-007's agent-UX rules.
      instructions: [
        'Every tool returns a JSON envelope discriminated by `ok`. On failure, branch on the stable',
        '`code` (not the prose `error`); `retryable` says whether retrying may help and `next_actions`',
        'suggests the recovery call. Start a session with electron_launch (or electron_attach), then',
        'thread the returned `session_id` through every later call, and end it with electron_stop.',
        'Read state with electron_snapshot / electron_find and assert with the expect_* family. The',
        'electron_eval_* tools appear only when the server was started with --allow-eval.',
      ].join(' '),
    },
  )
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
