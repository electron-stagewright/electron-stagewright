/**
 * Tool-definition contract — the single shape every built-in or plugin tool is
 * expressed in, and the only shape the dispatcher knows how to register and
 * route.
 *
 * A {@link ToolDefinition} is a plain data object: a name, an agent-facing
 * description (which embeds the error codes the tool can return, per the
 * agent-native UX principles), a Zod input schema, an internal operation-type
 * classifier, and an async handler. The dispatcher (see `server/dispatcher.ts`)
 * owns everything else — input validation, operation-type routing, envelope
 * wrapping, timing, and logging — so a tool author writes only the handler.
 *
 * This module is intentionally the lowest tool-layer dependency: plugin loading
 * reuses `ToolDefinition` rather than defining its own shape, so a core tool and
 * a plugin tool are the same kind of value and cannot drift apart.
 *
 * @module
 */

import type { z } from 'zod'
import type { ErrorResponse, SuccessResponse } from '../errors/envelope.js'
import type { OperationType } from '../errors/operation-type.js'
import type { Logger } from '../server/logger.js'
import type { SessionManager } from '../server/session-manager.js'
import type { SnapshotStore } from '../server/snapshot-store.js'
import type { TransportRegistry } from '../server/transport-registry.js'

/**
 * The value a tool handler resolves to. It is exactly the agent-facing response
 * envelope — `ErrorResponse` or a success envelope carrying an arbitrary
 * JSON-serialisable payload. The dispatcher serialises this with
 * `JSON.stringify`, so every field MUST round-trip through JSON (no `Map`,
 * `Set`, `Date`, or class instances — see the implementation invariants).
 */
export type ToolResult = ErrorResponse | SuccessResponse<Record<string, unknown>>

/**
 * A completed tool dispatch, handed to every {@link DispatchObserver} after the dispatcher
 * resolves a call (success OR error). It is the seam a session-observing plugin uses to record
 * the whole run — the trace plugin (ADR-009) writes these to an artifact.
 *
 * `args` is the parsed, validated input (or the raw input when validation itself failed);
 * `result` is the exact envelope the agent received. `startedAt` / `finishedAt` are epoch-ms
 * from the dispatcher's injected clock, so elapsed time is `finishedAt - startedAt`. Every
 * field is JSON-serialisable (it is built from the agent-facing envelope), so an observer may
 * persist it directly — no `Map`/`Set`/`Date` leaks in.
 */
export interface DispatchRecord {
  /** The registered tool name that was dispatched (e.g. `electron_click`). */
  readonly tool: string
  /** Parsed validated input, or the raw input when input validation failed. */
  readonly args: unknown
  /** The exact response envelope the agent received (success or error). */
  readonly result: ToolResult
  /** Epoch-ms when the dispatcher began the call. */
  readonly startedAt: number
  /** Epoch-ms when the dispatcher finished the call. */
  readonly finishedAt: number
}

/**
 * A best-effort sink notified once per completed dispatch, registered via
 * {@link ToolContext.addDispatchObserver} (or `Dispatcher.addObserver`). It MUST be cheap and
 * MUST NOT throw: it runs synchronously in the dispatch path, so a throw is caught and logged
 * (never propagated to the agent) but slow work here slows every tool call. Persist-and-return
 * is the intended shape; do heavy I/O off the hot path.
 */
export type DispatchObserver = (record: DispatchRecord) => void

/** The about-to-run call handed to a {@link DispatchGuard}, before its handler executes. */
export interface DispatchGuardCall {
  /** The registered tool name about to be dispatched (e.g. `electron_click`). */
  readonly tool: string
  /** The parsed, validated arguments the handler would receive. */
  readonly args: unknown
  /** Epoch-ms the dispatch began — pass to `makeError`/`makePluginError` for a veto envelope. */
  readonly startedAt: number
  /** The dispatcher's clock — pass alongside `startedAt` when building a veto envelope. */
  readonly now: () => number
}

/**
 * A pre-dispatch veto (ADR-009), registered via {@link ToolContext.addDispatchGuard}. It runs for
 * every dispatch BEFORE the tool handler, with the about-to-run call: returning a {@link ToolResult}
 * vetoes it (the dispatcher returns that envelope and the handler never runs); returning `null`
 * allows it. Guards run in registration order and the first veto wins. A guard MUST be cheap and
 * synchronous; a throw is caught, logged, and treated as "allow" (fail-open) so a guard bug cannot
 * wedge the tool surface. The active-enforcement counterpart to {@link DispatchObserver} (which
 * only watches) — use it for a cross-cutting budget or policy (the trace plugin's token-budget
 * enforcement).
 */
export type DispatchGuard = (call: DispatchGuardCall) => ToolResult | null

/**
 * Per-call execution context handed to every tool handler by the dispatcher.
 * The handler never constructs these collaborators itself; it receives them so
 * the dispatcher stays the single owner of session and logging lifecycle.
 */
export interface ToolContext {
  /** The session registry — tools resolve, create, or remove sessions through this. */
  readonly sessions: SessionManager
  /**
   * The transport registry — session-creating tools (`launch`/`attach`/`inject`)
   * obtain a capability-appropriate transport through this. Tools that operate on
   * an existing session use `sessions.resolve(...).transport` instead.
   */
  readonly transports: TransportRegistry
  /** Per-session last-snapshot store, backing `electron_snapshot({ since: 'last' })`. */
  readonly snapshots: SnapshotStore
  /** Structured logger. Writes to stderr only (stdout is the MCP protocol channel). */
  readonly logger: Logger
  /**
   * Whether the server was started with the eval opt-in flag. Tools that declare
   * {@link ToolDefinition.requiresEvalFlag} are never registered when this is
   * false, so a handler observing `allowEval === true` can trust the gate already
   * passed; the field is exposed for handlers that branch on it defensively.
   */
  readonly allowEval: boolean
  /**
   * Directory the screenshot tool writes captures into when the caller does not
   * pass an explicit absolute `path`/`dir`. Configured by the server and already
   * resolved to an absolute path; `undefined` means the tool falls back to the OS temp dir.
   */
  readonly screenshotDir?: string | undefined
  /**
   * Root directory `electron_launch`'s `main` / `executablePath` / `cwd` must resolve within, when
   * the operator configured `--app-root`. Already resolved to an absolute path; `undefined` means no
   * confinement (launch paths may be anywhere).
   */
  readonly appRoot?: string | undefined
  /**
   * Epoch-ms timestamp captured by the dispatcher when the call began. Pass it
   * (with {@link ToolContext.now}) to `makeSuccess` / `makeError` so the
   * response's `_meta.elapsed_ms` reflects the whole dispatch, not just the
   * envelope-construction instant.
   */
  readonly startedAt: number
  /** Clock used for elapsed-time measurement. Injectable for deterministic tests. */
  readonly now: () => number
  /**
   * Register a {@link DispatchObserver} and return a function that unregisters it. The seam a
   * session-observing plugin (e.g. the trace plugin, ADR-009) uses to record tool calls without
   * the core depending on it.
   *
   * The observer fires for every dispatch that COMPLETES while it is registered — INCLUDING the
   * call that registered it (the registering handler runs before the dispatcher's notify step,
   * so that same call's record is delivered). An observer that should not see its own plugin's
   * tools must filter them (the trace plugin skips its `trace_*` calls). The observer must be
   * cheap and must not throw (see {@link DispatchObserver}).
   */
  readonly addDispatchObserver: (observer: DispatchObserver) => () => void
  /**
   * Re-dispatch another tool by name through the same dispatcher and resolve to its envelope.
   * The active half of the ADR-009 seam (its passive half is {@link addDispatchObserver}): it
   * lets a tool drive other tools — `trace_replay` re-runs a recorded session through it. The
   * call takes the FULL dispatch path (Zod validation, operation-type routing, session context,
   * and observer notification), so a re-dispatched call is indistinguishable from a top-level one.
   *
   * Bounded against runaway recursion: a re-dispatched tool that itself re-dispatches past a small
   * fixed depth receives a `BAD_ARGUMENT` envelope instead of recursing. Never throws — resolves
   * to an envelope exactly like the dispatcher's own `dispatch`.
   */
  readonly dispatch: (tool: string, args: unknown) => Promise<ToolResult>
  /**
   * Check whether a call WOULD be accepted — the tool exists and `args` satisfy its current input
   * schema — without running its handler (no side effects). Returns `null` when the call would be
   * accepted, or the `BAD_ARGUMENT` {@link ToolResult} the dispatcher would have produced
   * otherwise. The read-only complement to {@link dispatch}: `trace_replay`'s dry-run mode uses it
   * to detect that a recorded call no longer matches the tool's schema (a tool changed signature
   * since the trace was recorded) without launching an app.
   */
  readonly validate: (tool: string, args: unknown) => ErrorResponse | null
  /**
   * Register a {@link DispatchGuard} that can VETO subsequent dispatches before their handler runs,
   * returning an idempotent unregister. The active-enforcement counterpart to
   * {@link addDispatchObserver} (which only watches): the trace plugin uses it for token-budget
   * enforcement. The guard fires for every dispatch while registered — INCLUDING the plugin's own
   * tools, so a guard that must not block its plugin's tools has to filter them (the budget guard
   * skips `trace_*`, or an over-budget agent could never call `trace_stop` to recover). A guard
   * MUST be cheap, synchronous, and must not throw (a throw is caught and treated as allow).
   */
  readonly addDispatchGuard: (guard: DispatchGuard) => () => void
}

/**
 * A tool handler: receives the parsed-and-validated arguments (shape inferred
 * from {@link ToolDefinition.inputSchema}) plus the {@link ToolContext}, and
 * resolves to a response envelope. Handlers should not throw for expected
 * failures — return `makeError(...)` instead — but the dispatcher catches a
 * thrown `StagewrightError` (mapped to its code) and any other throw (mapped to
 * `INTERNAL_ERROR`) as a backstop.
 */
export type ToolHandler<Shape extends z.ZodRawShape> = (
  args: z.infer<z.ZodObject<Shape>>,
  ctx: ToolContext,
) => Promise<ToolResult>

/**
 * MCP tool behaviour hints (spec `ToolAnnotations`, protocol 2025-03-26+). Advisory metadata an
 * MCP host uses to decide e.g. whether to prompt for confirmation: `readOnlyHint` marks a tool that
 * does not modify its environment, `destructiveHint` a tool whose change is hard to undo,
 * `idempotentHint` a repeatable-without-extra-effect tool, `openWorldHint` a tool reaching an
 * unbounded external world. The dispatcher derives sensible defaults from {@link OperationType};
 * a tool may override any field via {@link ToolDefinition.annotations}.
 */
export interface ToolAnnotations {
  readonly title?: string
  readonly readOnlyHint?: boolean
  readonly destructiveHint?: boolean
  readonly idempotentHint?: boolean
  readonly openWorldHint?: boolean
}

/**
 * The contract every tool is expressed in.
 *
 * @typeParam Shape - the Zod raw shape of the tool's input object. Defaults to
 * the open `z.ZodRawShape` so a heterogeneous registry can store many tools
 * under {@link AnyToolDefinition} while each tool keeps a precisely-typed handler.
 */
export interface ToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
  /**
   * Unique tool name as it appears in the MCP `tools/list`. Core tools use the
   * `electron_*` prefix; plugin tools are namespaced by their loader.
   */
  readonly name: string
  /** Optional short human-facing title. Falls back to `name` when omitted. */
  readonly title?: string
  /**
   * Agent-facing description. MUST document the possible error codes and their
   * retryability inline (agent-native UX Principle 1) so an agent can build a
   * recovery policy at tool-selection time.
   */
  readonly description: string
  /**
   * Zod object schema for the tool's arguments. The dispatcher validates each
   * call against this (a failure becomes `BAD_ARGUMENT`, never a raw Zod throw),
   * and the raw shape is handed to the MCP SDK for client-side schema exposure.
   * Use `z.object({})` for a no-argument tool.
   */
  readonly inputSchema: z.ZodObject<Shape>
  /**
   * Internal operation-type classifier (command / query / eval / …). Declared
   * here on the manifest, NEVER on the agent-facing input — the dispatcher reads
   * it to choose a validator. Validated at registration time, so a mis-declared
   * value fails server startup rather than reaching an agent.
   */
  readonly operationType: OperationType
  /**
   * When true, the tool is only registered if the server was started with the
   * eval opt-in flag; otherwise it is absent from `tools/list` and unreachable.
   * Eval-classified tools must set this explicitly. Non-eval tools default to
   * false.
   */
  readonly requiresEvalFlag?: boolean
  /**
   * Optional MCP behaviour hints surfaced in `tools/list`. Each field overrides the
   * dispatcher's {@link OperationType}-derived default (e.g. a `command` tool that is destructive
   * sets `destructiveHint: true`). See {@link ToolAnnotations}.
   */
  readonly annotations?: ToolAnnotations
  /** The work the tool performs. See {@link ToolHandler}. */
  readonly handler: ToolHandler<Shape>
}

/**
 * A {@link ToolDefinition} with its argument shape erased — the uniform type the
 * dispatcher's registry stores so tools with different input shapes live in one
 * collection. The handler accepts `unknown` (the dispatcher feeds it the
 * already-validated args); {@link defineTool} performs the one narrowing cast so
 * tool authors keep full type-safety at the definition site.
 *
 * `inputSchema` is widened to the bare `z.ZodObject` (its default shape generic
 * stands in for "some object schema"), which sidesteps the function-parameter
 * variance that an erased generic would otherwise trip.
 */
export interface AnyToolDefinition {
  readonly name: string
  readonly title?: string
  readonly description: string
  readonly inputSchema: z.ZodObject
  readonly operationType: OperationType
  readonly requiresEvalFlag?: boolean
  readonly annotations?: ToolAnnotations
  readonly handler: (args: unknown, ctx: ToolContext) => Promise<ToolResult>
}

/**
 * Construct a tool. The argument is checked against {@link ToolDefinition} with
 * the input shape inferred from `inputSchema`, so the handler's `args` are
 * precisely typed while you write it. The return is the erased
 * {@link AnyToolDefinition} ready to register — the single `unknown → inferred`
 * cast lives here so no tool author writes it.
 */
export function defineTool<Shape extends z.ZodRawShape>(
  def: ToolDefinition<Shape>,
): AnyToolDefinition {
  return {
    name: def.name,
    ...(def.title !== undefined ? { title: def.title } : {}),
    description: def.description,
    inputSchema: def.inputSchema,
    operationType: def.operationType,
    ...(def.requiresEvalFlag !== undefined ? { requiresEvalFlag: def.requiresEvalFlag } : {}),
    ...(def.annotations !== undefined ? { annotations: def.annotations } : {}),
    handler: (args, ctx) => def.handler(args as z.infer<z.ZodObject<Shape>>, ctx),
  }
}
