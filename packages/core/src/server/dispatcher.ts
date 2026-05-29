/**
 * Tool dispatcher — the single funnel every tool call passes through.
 *
 * The dispatcher is the only component that knows how to turn a registered
 * {@link AnyToolDefinition} into an executed call with a well-formed response
 * envelope. A tool author writes a pure-ish handler; the dispatcher owns
 * everything around it:
 *
 * 1. **Registration-time validation** — `operationType` is checked against the
 *    closed schema, so a mis-declared tool fails server startup, never an agent
 *    call. Eval-gated tools are skipped entirely unless the server was started
 *    with the eval opt-in flag (they then never appear in `tools/list`).
 * 2. **Input validation** — each call's raw arguments are parsed against the
 *    tool's Zod schema; a failure becomes a `BAD_ARGUMENT` envelope, never a raw
 *    Zod throw escaping to the transport.
 * 3. **Operation-type routing** — eval payloads pass through the keyword
 *    blocklist before the handler runs (the `--allow-eval` flag gates *visibility*
 *    of eval tools, not the per-payload blocklist, which always applies).
 * 4. **Session correlation** — the call runs inside an `AsyncLocalStorage`
 *    context seeded with the request's `sessionId` (when present) so the
 *    response envelope can stamp `_meta.session_id` without explicit threading.
 * 5. **Envelope + timing + slow-op logging** — the handler's result is returned
 *    as-is (handlers build their own envelope via `makeSuccess`/`makeError`); a
 *    thrown `StagewrightError` is mapped to its code and any other throw to
 *    `INTERNAL_ERROR`; a dispatch slower than the threshold logs a warning.
 *
 * @module
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { type ErrorResponse, makeError } from '../errors/envelope.js'
import {
  type OperationType,
  OperationTypeSchema,
  routeByOperationType,
} from '../errors/operation-type.js'
import { StagewrightError } from '../errors/registry.js'
import { runWithSessionContext } from '../errors/session-context.js'
import type { AnyToolDefinition, ToolContext, ToolResult } from '../tools/types.js'
import { type Logger, NOOP_LOGGER, SLOW_OP_THRESHOLD_MS } from './logger.js'
import type { SessionManager } from './session-manager.js'
import { SnapshotStore } from './snapshot-store.js'
import { TransportRegistry } from './transport-registry.js'

/** Options for constructing a {@link Dispatcher}. */
export interface DispatcherOptions {
  /** Session registry threaded into every tool context. */
  readonly sessions: SessionManager
  /** Transport registry threaded into every tool context. Defaults to the built-in set. */
  readonly transports?: TransportRegistry
  /** Per-session snapshot store threaded into every tool context. Defaults to a fresh store. */
  readonly snapshots?: SnapshotStore
  /** Logger for slow-op warnings and diagnostics. Defaults to a no-op logger. */
  readonly logger?: Logger
  /**
   * Whether the server was started with the eval opt-in flag. Controls whether
   * eval-gated tools register at all. Defaults to false (eval tools hidden).
   */
  readonly allowEval?: boolean
  /** Clock injection for deterministic `_meta.elapsed_ms` in tests. */
  readonly now?: () => number
  /** Elapsed-ms threshold above which a dispatch logs a slow-op warning. */
  readonly slowOpThresholdMs?: number
}

/**
 * A machine-readable description of one registered tool, for `tools/list`-style
 * introspection and offline documentation generation. `inputJsonSchema` is the
 * tool's Zod schema rendered to JSON Schema.
 */
export interface ToolManifestEntry {
  readonly name: string
  readonly title?: string
  readonly description: string
  readonly operationType: OperationType
  readonly inputJsonSchema: Record<string, unknown>
}

/** Read a `sessionId` string field off arbitrary parsed args, if present. */
function readSessionId(args: unknown): string | undefined {
  if (typeof args === 'object' && args !== null && 'sessionId' in args) {
    const value = (args as { readonly sessionId?: unknown }).sessionId
    if (typeof value === 'string') return value
  }
  return undefined
}

/** Serialise a response envelope into the MCP tool-result content shape. */
function toCallToolResult(envelope: ToolResult): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    isError: !envelope.ok,
  }
}

export class Dispatcher {
  readonly #tools = new Map<string, AnyToolDefinition>()
  readonly #sessions: SessionManager
  readonly #transports: TransportRegistry
  readonly #snapshots: SnapshotStore
  readonly #logger: Logger
  readonly #allowEval: boolean
  readonly #now: () => number
  readonly #slowMs: number

  constructor(opts: DispatcherOptions) {
    this.#sessions = opts.sessions
    this.#transports = opts.transports ?? new TransportRegistry()
    this.#snapshots = opts.snapshots ?? new SnapshotStore()
    this.#logger = opts.logger ?? NOOP_LOGGER
    this.#allowEval = opts.allowEval ?? false
    this.#now = opts.now ?? Date.now
    this.#slowMs = opts.slowOpThresholdMs ?? SLOW_OP_THRESHOLD_MS
  }

  /** Whether the eval opt-in flag was set for this dispatcher. */
  get allowEval(): boolean {
    return this.#allowEval
  }

  /**
   * Register a tool. Validates `operationType` against the closed schema (a bad
   * value throws here, at boot). Eval-gated tools are silently skipped when the
   * eval flag is off — they must not appear in the manifest or be dispatchable.
   * Eval-classified tools must declare that gate explicitly. A duplicate name is
   * a programming error and throws.
   */
  register(def: AnyToolDefinition): void {
    const parsed = OperationTypeSchema.safeParse(def.operationType)
    if (!parsed.success) {
      throw new Error(
        `Tool "${def.name}" declares an invalid operationType "${String(def.operationType)}". ` +
          `Expected one of: ${OperationTypeSchema.options.join(', ')}.`,
      )
    }
    if (parsed.data === 'eval' && def.requiresEvalFlag !== true) {
      throw new Error(
        `Tool "${def.name}" declares operationType "eval" but does not set requiresEvalFlag.`,
      )
    }
    if (def.requiresEvalFlag === true && !this.#allowEval) {
      this.#logger.debug('Eval-gated tool hidden (server started without eval flag)', {
        tool: def.name,
      })
      return
    }
    if (this.#tools.has(def.name)) {
      throw new Error(`Duplicate tool registration for "${def.name}".`)
    }
    this.#tools.set(def.name, def)
  }

  /** Register many tools in order. */
  registerAll(defs: Iterable<AnyToolDefinition>): void {
    for (const def of defs) this.register(def)
  }

  /** Whether a tool with `name` is registered (and visible). */
  has(name: string): boolean {
    return this.#tools.has(name)
  }

  /** The registered (visible) tool definitions, in registration order. */
  list(): readonly AnyToolDefinition[] {
    return [...this.#tools.values()]
  }

  /** Machine-readable manifest of all registered tools. */
  listManifest(): readonly ToolManifestEntry[] {
    return this.list().map((def) => ({
      name: def.name,
      ...(def.title !== undefined ? { title: def.title } : {}),
      description: def.description,
      operationType: def.operationType,
      inputJsonSchema: z.toJSONSchema(def.inputSchema) as Record<string, unknown>,
    }))
  }

  /**
   * Execute a tool by name with raw (unvalidated) arguments. Always resolves to a
   * response envelope — never throws — so the transport layer can serialise the
   * result uniformly.
   */
  async dispatch(name: string, rawArgs: unknown): Promise<ToolResult> {
    const startedAt = this.#now()
    const def = this.#tools.get(name)
    if (def === undefined) {
      return makeError('BAD_ARGUMENT', {
        message: `Unknown tool: ${name}`,
        startedAt,
        now: this.#now,
      })
    }

    const parsed = def.inputSchema.safeParse(rawArgs ?? {})
    if (!parsed.success) {
      return makeError('BAD_ARGUMENT', {
        message: `Invalid arguments for ${name}.`,
        details: {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            code: issue.code,
            message: issue.message,
          })),
        },
        startedAt,
        now: this.#now,
      })
    }
    const args = parsed.data

    try {
      // Eval payloads run through the keyword blocklist here; non-eval ops are a
      // no-op. The blocklist always applies — the eval flag gates tool visibility,
      // not per-payload safety.
      routeByOperationType(def.operationType, args)
    } catch (err) {
      return this.#mapThrown(err, startedAt)
    }

    const sessionId = readSessionId(args)
    const ctx: ToolContext = {
      sessions: this.#sessions,
      transports: this.#transports,
      snapshots: this.#snapshots,
      logger: this.#logger,
      allowEval: this.#allowEval,
      startedAt,
      now: this.#now,
    }

    try {
      const result = await runWithSessionContext(sessionId, () => def.handler(args, ctx))
      this.#warnIfSlow(name, this.#now() - startedAt)
      return result
    } catch (err) {
      this.#warnIfSlow(name, this.#now() - startedAt)
      return this.#mapThrown(err, startedAt)
    }
  }

  /**
   * Register every visible tool with an MCP server so `tools/list` and
   * `tools/call` are served from this dispatcher. Each call is routed through
   * {@link dispatch} and the envelope serialised into the MCP content shape.
   */
  bindToMcpServer(server: McpServer): void {
    for (const def of this.#tools.values()) {
      server.registerTool(
        def.name,
        {
          ...(def.title !== undefined ? { title: def.title } : {}),
          description: def.description,
          inputSchema: def.inputSchema.shape,
        },
        async (args: Record<string, unknown>): Promise<CallToolResult> => {
          const result = await this.dispatch(def.name, args)
          return toCallToolResult(result)
        },
      )
    }
  }

  /** Map a thrown value to an error envelope. */
  #mapThrown(err: unknown, startedAt: number): ErrorResponse {
    const code = err instanceof StagewrightError ? err.code : 'INTERNAL_ERROR'
    const message = err instanceof Error ? err.message : String(err)
    const details = err instanceof StagewrightError ? err.details : undefined
    if (details !== undefined) {
      try {
        // makeError throws if details are not JSON-serialisable; fall back to a
        // detail-less envelope rather than letting that escape the dispatcher.
        return makeError(code, { message, details, startedAt, now: this.#now })
      } catch {
        this.#logger.warn('Dropped non-serialisable error details', { code })
      }
    }
    return makeError(code, { message, startedAt, now: this.#now })
  }

  /** Emit a slow-op warning when a dispatch exceeds the configured threshold. */
  #warnIfSlow(name: string, elapsedMs: number): void {
    if (elapsedMs > this.#slowMs) {
      this.#logger.warn('Slow tool execution', { tool: name, elapsed_ms: elapsedMs })
    }
  }
}
