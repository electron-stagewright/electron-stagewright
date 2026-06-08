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

import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  type CallToolResult,
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { type ErrorResponse, makeError } from '../errors/envelope.js'
import {
  type OperationType,
  OperationTypeSchema,
  routeByOperationType,
} from '../errors/operation-type.js'
import { StagewrightError } from '../errors/registry.js'
import { runWithSessionContext } from '../errors/session-context.js'
import type {
  AnyToolDefinition,
  DispatchGuard,
  DispatchObserver,
  DispatchRecord,
  ToolContext,
  ToolResult,
} from '../tools/types.js'
import { type Logger, NOOP_LOGGER, SLOW_OP_THRESHOLD_MS } from './logger.js'
import type { SessionManager } from './session-manager.js'
import { SnapshotStore } from './snapshot-store.js'
import { TransportRegistry } from './transport-registry.js'

/**
 * Re-dispatch depth, carried through the async call chain (ADR-009). A top-level dispatch runs at
 * depth 0; each `ctx.dispatch` runs its nested call one deeper. Held in `AsyncLocalStorage` (not a
 * field) so concurrent dispatch chains never share a counter. Bounded by
 * {@link MAX_REDISPATCH_DEPTH}.
 */
const REDISPATCH_DEPTH = new AsyncLocalStorage<number>()

/**
 * Deepest re-dispatch allowed. 1 lets a tool re-dispatch other tools (e.g. `trace_replay` driving
 * a recorded session) while stopping a re-dispatched tool from re-dispatching again — a backstop
 * against an accidental dispatch cycle becoming unbounded recursion.
 */
const MAX_REDISPATCH_DEPTH = 1

/**
 * Default operation-timeout backstop (ms) for a single dispatch (ADR-011). 120s is deliberately
 * well above the longest legitimate per-tool budget (the wait family clamps to 60s) so the
 * backstop only ever fires on a genuine hang, never on a valid long wait/action.
 */
export const DEFAULT_OPERATION_TIMEOUT_MS = 120_000

/**
 * Below this, an operation-timeout budget could preempt a legitimate maximum-length wait (the wait
 * family clamps to 60s). Mirrors the wait family's `MAX_WAIT_TIMEOUT_MS`; kept as a local literal
 * to avoid a server -> tools import cycle. A configured budget at or under this logs a warning.
 */
const MIN_SAFE_OPERATION_TIMEOUT_MS = 60_000

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
  /** Default directory the screenshot tool writes into; relative paths resolve at startup. */
  readonly screenshotDir?: string
  /** Clock injection for deterministic `_meta.elapsed_ms` in tests. */
  readonly now?: () => number
  /** Elapsed-ms threshold above which a dispatch logs a slow-op warning. */
  readonly slowOpThresholdMs?: number
  /**
   * Backstop timeout (ms) for a single tool dispatch (ADR-011). If a handler does not settle
   * within this budget the dispatch resolves with a retryable `OPERATION_TIMEOUT` envelope instead
   * of hanging — a guard against a frozen renderer whose `evaluate` never returns. Must exceed the
   * longest legitimate per-tool budget (the wait family's 60s clamp) or it would preempt a valid
   * long wait; `0` disables the backstop. Defaults to {@link DEFAULT_OPERATION_TIMEOUT_MS}.
   */
  readonly operationTimeoutMs?: number
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
  readonly #screenshotDir?: string
  readonly #now: () => number
  readonly #slowMs: number
  /** Per-dispatch backstop timeout (ms); `0` disables it (ADR-011). */
  readonly #operationTimeoutMs: number
  /** Best-effort dispatch observers (ADR-009). Empty by default — zero overhead per call. */
  readonly #observers = new Set<DispatchObserver>()
  /** Pre-dispatch guards that can veto a call (ADR-009). Empty by default — zero overhead per call. */
  readonly #guards = new Set<DispatchGuard>()

  constructor(opts: DispatcherOptions) {
    this.#sessions = opts.sessions
    this.#transports = opts.transports ?? new TransportRegistry()
    this.#snapshots = opts.snapshots ?? new SnapshotStore()
    this.#logger = opts.logger ?? NOOP_LOGGER
    this.#allowEval = opts.allowEval ?? false
    if (opts.screenshotDir !== undefined) this.#screenshotDir = path.resolve(opts.screenshotDir)
    this.#now = opts.now ?? Date.now
    this.#slowMs = opts.slowOpThresholdMs ?? SLOW_OP_THRESHOLD_MS
    this.#operationTimeoutMs = opts.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS
    if (!Number.isInteger(this.#operationTimeoutMs) || this.#operationTimeoutMs < 0) {
      throw new Error(
        `operationTimeoutMs must be a non-negative integer number of milliseconds, got ${String(
          opts.operationTimeoutMs,
        )}`,
      )
    }
    if (this.#operationTimeoutMs > 0 && this.#operationTimeoutMs <= MIN_SAFE_OPERATION_TIMEOUT_MS) {
      this.#logger.warn(
        'operationTimeoutMs is at or below the maximum wait budget; a legitimate long wait could be preempted',
        {
          operation_timeout_ms: this.#operationTimeoutMs,
          min_safe_ms: MIN_SAFE_OPERATION_TIMEOUT_MS,
        },
      )
    }
  }

  /** Whether the eval opt-in flag was set for this dispatcher. */
  get allowEval(): boolean {
    return this.#allowEval
  }

  /**
   * Register a {@link DispatchObserver} notified after every subsequent dispatch (ADR-009),
   * returning an idempotent unsubscribe. Exposed both directly (for embedders/tests) and to
   * tool handlers via {@link ToolContext.addDispatchObserver}, so a session-observing plugin
   * (the trace plugin) can record calls. Observers are best-effort: a throw is caught and
   * logged, never propagated to the agent.
   */
  addObserver(observer: DispatchObserver): () => void {
    this.#observers.add(observer)
    return () => {
      this.#observers.delete(observer)
    }
  }

  /**
   * Register a {@link DispatchGuard} that can veto a call before its handler runs (ADR-009),
   * returning an idempotent unregister. Exposed to tool handlers as
   * {@link ToolContext.addDispatchGuard}. Guards run in registration order, first veto wins; a
   * throwing guard is caught, logged, and treated as allow (fail-open).
   */
  addGuard(guard: DispatchGuard): () => void {
    this.#guards.add(guard)
    return () => {
      this.#guards.delete(guard)
    }
  }

  /**
   * Run the registered guards against an about-to-dispatch call. Returns the first guard's veto
   * envelope, or `null` to allow. A guard that throws is caught and skipped (fail-open) — a guard
   * bug must never wedge the whole tool surface.
   */
  #runGuards(tool: string, args: unknown, startedAt: number): ToolResult | null {
    if (this.#guards.size === 0) return null
    const call = { tool, args, startedAt, now: this.#now }
    for (const guard of this.#guards) {
      try {
        const veto = guard(call)
        if (veto !== null) return veto
      } catch (err) {
        this.#logger.warn('Dispatch guard threw; allowing the call (fail-open)', {
          tool,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return null
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
   * Check whether a call would be accepted — tool exists AND `args` satisfy its current input
   * schema — WITHOUT running the handler (no side effects). Returns `null` when it would be
   * accepted, else the `BAD_ARGUMENT` envelope the dispatcher would have produced. Exposed to
   * handlers via {@link ToolContext.validate} (ADR-009) so `trace_replay`'s dry-run can detect a
   * recorded call that no longer matches its tool's schema without launching an app.
   */
  validate(name: string, rawArgs: unknown): ErrorResponse | null {
    const startedAt = this.#now()
    const def = this.#tools.get(name)
    if (def === undefined) return this.#unknownToolError(name, startedAt)
    const parsed = def.inputSchema.safeParse(rawArgs ?? {})
    return parsed.success ? null : this.#invalidArgsError(name, parsed.error, startedAt)
  }

  /** The `BAD_ARGUMENT` envelope for an unregistered tool name. */
  #unknownToolError(name: string, startedAt: number): ErrorResponse {
    return makeError('BAD_ARGUMENT', {
      message: `Unknown tool: ${name}`,
      startedAt,
      now: this.#now,
    })
  }

  /**
   * Re-shape a Zod failure into the agent-UX `BAD_ARGUMENT` envelope: every issue names the
   * offending `field` and (for type errors) what was `expected`, and next_actions points the agent
   * back at the schema. This is the BAD_ARGUMENT an agent sees when it calls a tool with a
   * wrong/missing arg over MCP (see bindToMcpServer).
   */
  #invalidArgsError(name: string, error: z.ZodError, startedAt: number): ErrorResponse {
    const issues = error.issues.map((issue) => ({
      field: issue.path.length > 0 ? issue.path.join('.') : '(root)',
      code: issue.code,
      ...('expected' in issue && issue.expected !== undefined ? { expected: issue.expected } : {}),
      message: issue.message,
    }))
    const primary = issues[0]
    return makeError('BAD_ARGUMENT', {
      message: primary
        ? `Invalid arguments for ${name}: ${primary.field} — ${primary.message}.`
        : `Invalid arguments for ${name}.`,
      details: { issues },
      next_actions: [
        `Re-read the ${name} input schema in tools/list, then retry with a corrected "${primary?.field ?? 'argument'}".`,
      ],
      startedAt,
      now: this.#now,
    })
  }

  /**
   * Re-dispatch from inside a tool handler (the active half of the ADR-009 seam, wired into
   * {@link ToolContext.dispatch}). Tracks re-dispatch depth in {@link REDISPATCH_DEPTH}; past
   * {@link MAX_REDISPATCH_DEPTH} it returns a `BAD_ARGUMENT` envelope instead of recursing, so an
   * accidental dispatch cycle cannot blow the stack. Never throws.
   */
  #redispatch(tool: string, args: unknown): Promise<ToolResult> {
    const depth = (REDISPATCH_DEPTH.getStore() ?? 0) + 1
    if (depth > MAX_REDISPATCH_DEPTH) {
      return Promise.resolve(
        makeError('BAD_ARGUMENT', {
          message: `Re-dispatch depth limit (${MAX_REDISPATCH_DEPTH}) exceeded calling "${tool}"; a re-dispatched tool may not itself re-dispatch.`,
          startedAt: this.#now(),
          now: this.#now,
        }),
      )
    }
    return REDISPATCH_DEPTH.run(depth, () => this.dispatch(tool, args))
  }

  /**
   * Execute a tool by name with raw (unvalidated) arguments. Always resolves to a response envelope
   * — never throws — so the transport layer can serialise the result uniformly.
   */
  async dispatch(name: string, rawArgs: unknown): Promise<ToolResult> {
    const startedAt = this.#now()
    const def = this.#tools.get(name)
    if (def === undefined) {
      return this.#complete(name, rawArgs, this.#unknownToolError(name, startedAt), startedAt)
    }

    const parsed = def.inputSchema.safeParse(rawArgs ?? {})
    if (!parsed.success) {
      return this.#complete(
        name,
        rawArgs,
        this.#invalidArgsError(name, parsed.error, startedAt),
        startedAt,
      )
    }
    const args = parsed.data

    try {
      // Eval payloads run through the keyword blocklist here; non-eval ops are a
      // no-op. The blocklist always applies — the eval flag gates tool visibility,
      // not per-payload safety.
      routeByOperationType(def.operationType, args)
    } catch (err) {
      return this.#complete(name, args, this.#mapThrown(err, startedAt), startedAt)
    }

    // Pre-dispatch guards (ADR-009) run AFTER validation/routing but BEFORE the handler, so a
    // vetoed call never executes. A veto is still a completed dispatch — funnel it through
    // #complete so observers (the trace recorder) see it like any other outcome.
    const veto = this.#runGuards(name, args, startedAt)
    if (veto !== null) {
      this.#warnIfSlow(name, this.#now() - startedAt)
      return this.#complete(name, args, veto, startedAt)
    }

    const sessionId = readSessionId(args)
    const ctx: ToolContext = {
      sessions: this.#sessions,
      transports: this.#transports,
      snapshots: this.#snapshots,
      logger: this.#logger,
      allowEval: this.#allowEval,
      ...(this.#screenshotDir !== undefined ? { screenshotDir: this.#screenshotDir } : {}),
      startedAt,
      now: this.#now,
      addDispatchObserver: (observer) => this.addObserver(observer),
      dispatch: (tool, dispatchArgs) => this.#redispatch(tool, dispatchArgs),
      validate: (tool, validateArgs) => this.validate(tool, validateArgs),
      addDispatchGuard: (guard) => this.addGuard(guard),
    }

    try {
      const result = await this.#withTimeout(() =>
        runWithSessionContext(sessionId, () => def.handler(args, ctx)),
      )
      this.#warnIfSlow(name, this.#now() - startedAt)
      return this.#complete(name, args, result, startedAt)
    } catch (err) {
      this.#warnIfSlow(name, this.#now() - startedAt)
      return this.#complete(name, args, this.#mapThrown(err, startedAt), startedAt)
    }
  }

  /**
   * Race a handler against the operation-timeout backstop (ADR-011): resolve to the handler's
   * result if it settles first, otherwise throw a retryable `OPERATION_TIMEOUT` (mapped to an
   * envelope by {@link Dispatcher.#mapThrown}). A budget of `0` disables the backstop. The losing
   * (hung) promise is ABANDONED — a Playwright `evaluate` cannot be cancelled — so a no-op `catch`
   * swallows its eventual rejection to avoid an unhandledRejection after we have already returned;
   * the timer is `unref`-ed and cleared so it never keeps the process alive.
   */
  async #withTimeout<T>(run: () => Promise<T>): Promise<T> {
    const budget = this.#operationTimeoutMs
    const work = run()
    if (budget <= 0) return work
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new StagewrightError(
            'OPERATION_TIMEOUT',
            `Operation exceeded the ${budget}ms dispatch timeout; the app may be hung.`,
            { timeout_ms: budget },
          ),
        )
      }, budget)
      timer.unref?.()
    })
    try {
      return await Promise.race([work, timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      // The handler may still be pending (it lost the race); swallow its eventual rejection.
      void work.catch(() => undefined)
    }
  }

  /**
   * Finalise a dispatch: notify observers (best-effort) with the completed {@link
   * DispatchRecord}, then return the envelope unchanged. The single funnel for every dispatch
   * outcome, so observers see ALL calls — success, validation failure, or thrown-and-mapped —
   * exactly once. A throwing observer is caught and logged; it never affects the agent result.
   */
  #complete(tool: string, args: unknown, result: ToolResult, startedAt: number): ToolResult {
    if (this.#observers.size > 0) {
      const record: DispatchRecord = { tool, args, result, startedAt, finishedAt: this.#now() }
      for (const observer of this.#observers) {
        try {
          observer(record)
        } catch (err) {
          this.#logger.warn('Dispatch observer threw; ignored', {
            tool,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }
    return result
  }

  /**
   * Serve `tools/list` and `tools/call` from this dispatcher by owning the two MCP
   * request handlers directly, rather than per-tool `McpServer.registerTool`.
   *
   * `registerTool` makes the SDK pre-validate each call's arguments against the tool's
   * Zod schema and reject a bad call with a raw JSON-RPC `-32602` (surfaced as opaque
   * error text) BEFORE our handler runs — bypassing the agent-UX error envelope. By
   * owning the handlers, a validation failure instead flows through {@link dispatch}'s
   * own parse into a structured `BAD_ARGUMENT` envelope (ADR-006 / ADR-007), while
   * `tools/list` still advertises each tool's JSON Schema for discovery.
   *
   * The server must declare the `tools` capability at construction (see `createServer`)
   * since this path does not go through `registerTool`, which would declare it.
   */
  bindToMcpServer(server: McpServer): void {
    // Read the tool map LIVE on each tools/list (not a bind-time snapshot) so that
    // tools/list and tools/call — which routes through dispatch(), also live — can never
    // disagree if a tool is registered after binding.
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [...this.#tools.values()].map((def) => ({
        name: def.name,
        ...(def.title !== undefined ? { title: def.title } : {}),
        description: def.description,
        // z.toJSONSchema yields `{ type: 'object', … }`; the MCP Tool shape wants that
        // literal type, so we assert it rather than widen the whole result to unknown.
        inputSchema: z.toJSONSchema(def.inputSchema) as { type: 'object' } & Record<
          string,
          unknown
        >,
      })),
    }))

    server.server.setRequestHandler(
      CallToolRequestSchema,
      async (request): Promise<CallToolResult> => {
        const result = await this.dispatch(request.params.name, request.params.arguments)
        return toCallToolResult(result)
      },
    )
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
