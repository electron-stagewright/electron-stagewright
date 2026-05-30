/**
 * Interaction-specific orchestration over the shared target machinery in
 * `tools/target.ts`. This module owns the bounded actionability options (the
 * `force` + clamped `timeoutMs` interaction tools pass to the transport) and the
 * three run-shapes the tools dispatch through:
 *
 * - {@link runTargetedInteraction} — one required `ref`/`selector` target.
 * - {@link runDragInteraction} — a source target plus a drop target.
 * - {@link runInteraction} — an optional target (a global key press, a wheel scroll).
 *
 * The pure target resolution, error classification, `similar_refs` ranking, and
 * ref-freshness guard live in `../target.ts` and are re-exported here so existing
 * imports (and the read-tool family) share one implementation.
 *
 * @module
 */

import { makeSuccess } from '../../errors/envelope.js'
import {
  assertCapability,
  type InteractionOptions,
  type TransportSession,
} from '../../transports/index.js'
import {
  type TargetArgs,
  type ToolMeta,
  handleTargetFailure,
  refFreshnessError,
  refName,
  resolveOptionalTarget,
  resolveTarget,
} from '../target.js'
import type { ToolContext, ToolResult } from '../types.js'

/** Default per-action actionability budget when the caller omits `timeoutMs`. */
export const DEFAULT_TIMEOUT_MS = 5000
/** Hard cap on the per-action budget — an oversized `timeoutMs` is clamped to this. */
export const MAX_TIMEOUT_MS = 30000

/**
 * Normalise `{ force?, timeoutMs? }` into transport {@link InteractionOptions}
 * with a bounded timeout: missing → {@link DEFAULT_TIMEOUT_MS}, oversize → clamped
 * to {@link MAX_TIMEOUT_MS}, negative → 0.
 */
export function resolveActionOptions(args: {
  readonly force?: boolean | undefined
  readonly timeoutMs?: number | undefined
}): InteractionOptions {
  const requested = args.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(0, requested))
  return {
    ...(args.force !== undefined ? { force: args.force } : {}),
    timeoutMs,
  }
}

/**
 * Run a single-target interaction: resolve the session and the `ref`/`selector`,
 * refuse a transport that cannot interact, guard ref freshness, perform the
 * action, and wrap the result (or diagnose the failure). `perform` receives the
 * resolved selector plus bounded options and returns the tool-specific payload.
 */
export async function runTargetedInteraction(
  ctx: ToolContext,
  args: TargetArgs,
  perform: (
    session: TransportSession,
    selector: string,
    opts: InteractionOptions,
  ) => Promise<Record<string, unknown>>,
): Promise<ToolResult> {
  const managed = ctx.sessions.resolve(args.sessionId)
  const meta: ToolMeta = { startedAt: ctx.startedAt, now: ctx.now, session_id: managed.id }
  const selector = resolveTarget(args)
  const opts = resolveActionOptions(args)
  assertCapability(managed.transport, 'supportsInteraction')

  const stale = await refFreshnessError(ctx, managed.session, meta, args.ref)
  if (stale !== undefined) return stale

  try {
    const payload = await perform(managed.session, selector, opts)
    return makeSuccess({ session_id: managed.id, ...payload }, meta)
  } catch (err) {
    return handleTargetFailure(err, {
      ctx,
      session: managed.session,
      meta,
      nameHint: refName(ctx.snapshots.get(managed.id), args.ref),
    })
  }
}

/** Arguments for {@link runDragInteraction} — a source target plus a drop target. */
export interface DragArgs {
  readonly sessionId?: string | undefined
  readonly ref?: number | undefined
  readonly selector?: string | undefined
  readonly targetRef?: number | undefined
  readonly targetSelector?: string | undefined
  readonly force?: boolean | undefined
  readonly timeoutMs?: number | undefined
}

/**
 * Run a two-target drag: resolve the session, resolve both the source and the
 * drop target, guard ref freshness on BOTH sides, perform the drag, and wrap the
 * result (or diagnose the failure).
 */
export async function runDragInteraction(ctx: ToolContext, args: DragArgs): Promise<ToolResult> {
  const managed = ctx.sessions.resolve(args.sessionId)
  const meta: ToolMeta = { startedAt: ctx.startedAt, now: ctx.now, session_id: managed.id }
  const source = resolveTarget({ ref: args.ref, selector: args.selector })
  const target = resolveTarget({ ref: args.targetRef, selector: args.targetSelector })
  assertCapability(managed.transport, 'supportsInteraction')

  const staleSource = await refFreshnessError(ctx, managed.session, meta, args.ref)
  if (staleSource !== undefined) return staleSource
  const staleTarget = await refFreshnessError(ctx, managed.session, meta, args.targetRef)
  if (staleTarget !== undefined) return staleTarget

  try {
    await managed.session.dragTo(source, target, resolveActionOptions(args))
    return makeSuccess({ session_id: managed.id, source, target }, meta)
  } catch (err) {
    return handleTargetFailure(err, {
      ctx,
      session: managed.session,
      meta,
      nameHint: refName(ctx.snapshots.get(managed.id), args.ref),
    })
  }
}

/**
 * Run an interaction that may act globally or on an optional target (e.g.
 * `electron_key`, `electron_scroll`). Resolves the session and wraps the result
 * or diagnoses the failure; the `perform` closure resolves its own optional
 * target via {@link resolveOptionalTarget}.
 */
export async function runInteraction(
  ctx: ToolContext,
  args: {
    readonly sessionId?: string | undefined
    readonly ref?: number | undefined
    readonly selector?: string | undefined
  },
  perform: (session: TransportSession, meta: ToolMeta) => Promise<Record<string, unknown>>,
): Promise<ToolResult> {
  const managed = ctx.sessions.resolve(args.sessionId)
  const meta: ToolMeta = { startedAt: ctx.startedAt, now: ctx.now, session_id: managed.id }
  resolveOptionalTarget(args)
  assertCapability(managed.transport, 'supportsInteraction')

  const stale = await refFreshnessError(ctx, managed.session, meta, args.ref)
  if (stale !== undefined) return stale

  try {
    const payload = await perform(managed.session, meta)
    return makeSuccess({ session_id: managed.id, ...payload }, meta)
  } catch (err) {
    return handleTargetFailure(err, { ctx, session: managed.session, meta })
  }
}

// Re-export the shared target machinery so existing interaction-tool imports and
// the interaction-target tests keep resolving against this module. The read-tool
// family imports the same helpers directly from `../target.js`.
export {
  type TargetArgs,
  type ToolMeta,
  type ToolMeta as InteractionMeta,
  resolveTarget,
  resolveOptionalTarget,
  computeSimilarRefs,
  snapshotHasRef,
  classifyTargetError as classifyInteractionError,
} from '../target.js'
