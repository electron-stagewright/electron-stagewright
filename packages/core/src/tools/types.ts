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
   * pass an explicit absolute `path`. Configured by the server; `undefined` means
   * the tool falls back to the OS temp dir.
   */
  readonly screenshotDir?: string | undefined
  /**
   * Epoch-ms timestamp captured by the dispatcher when the call began. Pass it
   * (with {@link ToolContext.now}) to `makeSuccess` / `makeError` so the
   * response's `_meta.elapsed_ms` reflects the whole dispatch, not just the
   * envelope-construction instant.
   */
  readonly startedAt: number
  /** Clock used for elapsed-time measurement. Injectable for deterministic tests. */
  readonly now: () => number
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
    handler: (args, ctx) => def.handler(args as z.infer<z.ZodObject<Shape>>, ctx),
  }
}
