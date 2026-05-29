/**
 * Shared machinery for the interaction tools (`electron_click`, `electron_type`,
 * …). Three concerns live here so the fourteen thin tool wrappers cannot drift:
 *
 * 1. **Target resolution** — turn an agent-supplied `{ ref }` or `{ selector }`
 *    into a single CSS selector (`ref` becomes `[data-sw-ref="<ref>"]`, the
 *    convention the snapshot walker tags the DOM with). Exactly one of the two
 *    is required.
 * 2. **Bounded actionability options** — every action carries a `timeoutMs` that
 *    defaults to {@link DEFAULT_TIMEOUT_MS} and is clamped to {@link MAX_TIMEOUT_MS},
 *    so an omitted timeout never inherits Playwright's long default and a huge
 *    one cannot wedge a dispatch.
 * 3. **Failure diagnosis** — map whatever the transport throws onto a registered
 *    error code (mirroring `diagnoseLaunchError`), and on a "can't find it" code
 *    attach `similar_refs` candidates sourced from a fresh live walk (falling
 *    back to the stored snapshot) so the agent recovers in one turn.
 *
 * @module
 */

import {
  type ErrorResponse,
  type SimilarRef,
  makeError,
  makeSuccess,
} from '../../errors/envelope.js'
import { type ErrorCode, StagewrightError } from '../../errors/registry.js'
import type { Snapshot } from '../../snapshot/index.js'
import {
  assertCapability,
  type InteractionOptions,
  type TransportSession,
} from '../../transports/index.js'
import { buildWalkBody, loadInjectedWalker } from '../snapshot/inject.js'
import { reconcileRetagAndStore } from '../snapshot/refs.js'
import type { ToolContext, ToolResult } from '../types.js'

/** Default per-action actionability budget when the caller omits `timeoutMs`. */
export const DEFAULT_TIMEOUT_MS = 5000
/** Hard cap on the per-action budget — an oversized `timeoutMs` is clamped to this. */
export const MAX_TIMEOUT_MS = 30000
/** How many candidate refs an error envelope carries at most. */
const SIMILAR_REF_LIMIT = 5
/** Longest error message we echo back — keeps a verbose transport throw from bloating tokens. */
const MAX_MESSAGE_LENGTH = 200

/** The envelope-meta shape every interaction tool threads into `makeSuccess` / `makeError`. */
export interface InteractionMeta {
  readonly startedAt: number
  readonly now: () => number
  readonly session_id: string
}

/**
 * The arguments common to every targeted interaction tool. Optionals are typed
 * `T | undefined` (not just `?:`) so a Zod-inferred args object — whose optional
 * fields are `T | undefined` — is assignable under `exactOptionalPropertyTypes`.
 */
export interface TargetArgs {
  readonly sessionId?: string | undefined
  readonly ref?: number | undefined
  readonly selector?: string | undefined
  readonly force?: boolean | undefined
  readonly timeoutMs?: number | undefined
}

/**
 * Resolve exactly one of `ref` / `selector` into a CSS selector. A `ref` maps to
 * the `[data-sw-ref="<ref>"]` attribute the walker tags interactive elements
 * with. Throws `BAD_ARGUMENT` when neither or both are supplied (a class of agent
 * mistake we want to fail fast and legibly, not silently coerce).
 */
export function resolveTarget(args: {
  readonly ref?: number | undefined
  readonly selector?: string | undefined
}): string {
  const optional = resolveOptionalTarget(args)
  if (optional === undefined) {
    throw new StagewrightError('BAD_ARGUMENT', 'Provide exactly one of ref or selector.', {
      ref: args.ref,
      selector: args.selector,
    })
  }
  return optional
}

/**
 * Like {@link resolveTarget} but allows neither (returns `undefined`) — for tools
 * that can act globally (e.g. `electron_key` pressing a key with no focused
 * element). Still rejects supplying both with `BAD_ARGUMENT`.
 */
export function resolveOptionalTarget(args: {
  readonly ref?: number | undefined
  readonly selector?: string | undefined
}): string | undefined {
  const hasRef = args.ref !== undefined
  if (args.selector === '') {
    throw new StagewrightError('BAD_ARGUMENT', 'Selector must not be empty.', {
      ref: args.ref,
      selector: args.selector,
    })
  }
  const hasSelector = args.selector !== undefined
  if (hasRef && hasSelector) {
    throw new StagewrightError('BAD_ARGUMENT', 'Provide ref or selector, not both.', {
      ref: args.ref,
      selector: args.selector,
    })
  }
  if (hasRef) return `[data-sw-ref="${args.ref}"]`
  if (hasSelector) return args.selector
  return undefined
}

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
 * Classify a thrown interaction failure into a registered error code. A
 * transport that already classified the failure (any `StagewrightError` that is
 * not the generic `INTERNAL_ERROR`) wins; otherwise the raw message is
 * pattern-matched the same way `diagnoseLaunchError` matches launch failures.
 */
export function classifyInteractionError(err: unknown): ErrorCode {
  if (err instanceof StagewrightError && err.code !== 'INTERNAL_ERROR') return err.code
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  if (/not enabled|is disabled|element is disabled/.test(msg)) return 'ELEMENT_DISABLED'
  if (/not visible|is hidden|outside of the viewport|not stable|intercepts pointer/.test(msg)) {
    return 'ELEMENT_NOT_VISIBLE'
  }
  if (
    /not attached|no element|resolved to 0|waiting for selector|no node found|matches no element|element\(s\) not found/.test(
      msg,
    )
  ) {
    return 'SELECTOR_NO_MATCH'
  }
  // A bare actionability timeout almost always means the element never became
  // visible/stable; treat it as a (retryable) visibility failure rather than an
  // opaque internal error so the agent gets an actionable, retryable code.
  if (/timeout|timed out|exceeded/.test(msg)) return 'ELEMENT_NOT_VISIBLE'
  return 'INTERNAL_ERROR'
}

/**
 * Rank a snapshot's interactive entries as `similar_refs` candidates. With a
 * `hint` (e.g. the accessible name the stale ref used to carry), entries whose
 * name contains or is contained by the hint sort first; without a hint the
 * snapshot's document order is preserved (a stable sort over equal scores).
 */
export function computeSimilarRefs(
  snapshot: Snapshot,
  hint?: string,
  limit: number = SIMILAR_REF_LIMIT,
): SimilarRef[] {
  const interactive = snapshot.entries.filter(
    (entry): entry is typeof entry & { ref: number } => entry.interactive && entry.ref !== null,
  )
  const scored = interactive
    .map((entry) => ({ entry, score: scoreName(entry.name, hint) }))
    .sort((a, b) => a.score - b.score)
  return scored
    .slice(0, limit)
    .map(({ entry }) => ({ ref: entry.ref, role: entry.role, name: entry.name }))
}

/** Lower score = closer match. 0 with no hint preserves document order under a stable sort. */
function scoreName(name: string, hint?: string): number {
  if (hint === undefined || hint === '') return 0
  const n = name.toLowerCase()
  const h = hint.toLowerCase()
  if (n === h) return 0
  if (n.includes(h) || h.includes(n)) return 1 + Math.abs(n.length - h.length)
  return 1000
}

/** Whether `snapshot` contains an interactive entry tagged with `ref`. */
export function snapshotHasRef(snapshot: Snapshot, ref: number): boolean {
  return snapshot.entries.some((entry) => entry.ref === ref)
}

/** The accessible name a `ref` carried in `snapshot`, for use as a similar-ref hint. */
function refName(snapshot: Snapshot | undefined, ref: number | undefined): string | undefined {
  if (snapshot === undefined || ref === undefined) return undefined
  return snapshot.entries.find((entry) => entry.ref === ref)?.name
}

/**
 * Source `similar_refs` for a "can't find it" failure. Re-walks the live DOM so
 * the candidates reflect the current screen (a hot-reload makes the stored
 * baseline misleading); falls back to the stored snapshot when the live walk is
 * unavailable (missing bundle, dead session). Best-effort — never throws.
 */
async function gatherSimilarRefs(cx: {
  readonly ctx: ToolContext
  readonly session: TransportSession
  readonly sessionId: string
  readonly hint?: string | undefined
}): Promise<SimilarRef[]> {
  let source = cx.ctx.snapshots.get(cx.sessionId)
  try {
    const body = buildWalkBody(loadInjectedWalker())
    const walked = await cx.session.evaluate<Snapshot | undefined>('renderer', body, {})
    if (walked !== undefined && Array.isArray(walked.entries)) {
      const stabilised = await reconcileRetagAndStore({
        session: cx.session,
        store: cx.ctx.snapshots,
        sessionId: cx.sessionId,
        prev: source,
        walked,
      })
      source = stabilised.curr
    }
  } catch {
    // Live re-walk failed (bundle missing in a pre-build test run, or a dead
    // renderer) — fall through to the stored snapshot.
  }
  return source !== undefined ? computeSimilarRefs(source, cx.hint) : []
}

/** Trim a transport error message to a single bounded line. */
function shorten(message: string): string {
  const firstLine = message.split('\n', 1)[0] ?? message
  return firstLine.length > MAX_MESSAGE_LENGTH
    ? `${firstLine.slice(0, MAX_MESSAGE_LENGTH)}…`
    : firstLine
}

/**
 * Build the error envelope for a thrown interaction failure. On a
 * `SELECTOR_NO_MATCH` / `REF_NOT_FOUND` it attaches `similar_refs` (re-walked
 * live) and recovery `next_actions`; other codes get a recovery hint only.
 */
async function handleInteractionFailure(
  err: unknown,
  cx: {
    readonly ctx: ToolContext
    readonly session: TransportSession
    readonly meta: InteractionMeta
    readonly nameHint?: string | undefined
  },
): Promise<ErrorResponse> {
  const code = classifyInteractionError(err)
  const message = shorten(err instanceof Error ? err.message : String(err))
  if (code === 'SELECTOR_NO_MATCH' || code === 'REF_NOT_FOUND') {
    const similar = await gatherSimilarRefs({
      ctx: cx.ctx,
      session: cx.session,
      sessionId: cx.meta.session_id,
      hint: cx.nameHint,
    })
    return makeError(code, {
      ...cx.meta,
      message,
      ...(similar.length > 0 ? { similar_refs: similar } : {}),
      next_actions: ['electron_snapshot()', 'electron_find({ role: "button" })'],
    })
  }
  const next_actions =
    code === 'ELEMENT_NOT_VISIBLE' || code === 'ELEMENT_DISABLED'
      ? ['electron_snapshot()']
      : undefined
  return makeError(code, {
    ...cx.meta,
    message,
    ...(next_actions !== undefined ? { next_actions } : {}),
  })
}

/**
 * Ref-freshness guard. A `ref` only means anything relative to a snapshot; if the
 * latest stored snapshot does not contain it, return a `REF_NOT_FOUND` envelope
 * (with live candidates) so the caller fails fast rather than acting on a tag that
 * may now point at the wrong element. Returns `undefined` when the ref is fresh,
 * absent, or there is no baseline to check against.
 */
async function refFreshnessError(
  ctx: ToolContext,
  session: TransportSession,
  meta: InteractionMeta,
  ref: number | undefined,
): Promise<ErrorResponse | undefined> {
  if (ref === undefined) return undefined
  const stored = ctx.snapshots.get(meta.session_id)
  if (stored === undefined || snapshotHasRef(stored, ref)) return undefined
  const similar = await gatherSimilarRefs({ ctx, session, sessionId: meta.session_id })
  return makeError('REF_NOT_FOUND', {
    ...meta,
    message: `ref ${ref} is not in the latest snapshot; it may be stale. Re-snapshot to refresh refs.`,
    ...(similar.length > 0 ? { similar_refs: similar } : {}),
    next_actions: ['electron_snapshot()'],
  })
}

/**
 * Run a single-target interaction: resolve the session and the `ref`/`selector`,
 * guard ref freshness against the stored snapshot, perform the action, and wrap
 * the result (or diagnose the failure). `perform` receives the resolved selector
 * plus bounded options and returns the tool-specific success payload.
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
  const meta: InteractionMeta = { startedAt: ctx.startedAt, now: ctx.now, session_id: managed.id }
  const selector = resolveTarget(args)
  const opts = resolveActionOptions(args)
  assertCapability(managed.transport, 'supportsInteraction')

  const stale = await refFreshnessError(ctx, managed.session, meta, args.ref)
  if (stale !== undefined) return stale

  try {
    const payload = await perform(managed.session, selector, opts)
    return makeSuccess({ session_id: managed.id, ...payload }, meta)
  } catch (err) {
    return handleInteractionFailure(err, {
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
 * result (or diagnose the failure). Mirrors {@link runTargetedInteraction} but for
 * an operation that names two elements.
 */
export async function runDragInteraction(ctx: ToolContext, args: DragArgs): Promise<ToolResult> {
  const managed = ctx.sessions.resolve(args.sessionId)
  const meta: InteractionMeta = { startedAt: ctx.startedAt, now: ctx.now, session_id: managed.id }
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
    return handleInteractionFailure(err, {
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
  perform: (session: TransportSession, meta: InteractionMeta) => Promise<Record<string, unknown>>,
): Promise<ToolResult> {
  const managed = ctx.sessions.resolve(args.sessionId)
  const meta: InteractionMeta = { startedAt: ctx.startedAt, now: ctx.now, session_id: managed.id }
  resolveOptionalTarget(args)
  assertCapability(managed.transport, 'supportsInteraction')

  const stale = await refFreshnessError(ctx, managed.session, meta, args.ref)
  if (stale !== undefined) return stale

  try {
    const payload = await perform(managed.session, meta)
    return makeSuccess({ session_id: managed.id, ...payload }, meta)
  } catch (err) {
    return handleInteractionFailure(err, { ctx, session: managed.session, meta })
  }
}
