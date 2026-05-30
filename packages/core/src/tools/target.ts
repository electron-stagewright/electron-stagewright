/**
 * Family-agnostic machinery shared by every tool that addresses a DOM element by
 * `ref` or `selector` — the interaction tools (click/type/…) and the read tools
 * (get_text/get_state/…). Keeping it in one neutral module (rather than under
 * `interaction/`) means the read family does not import from the interaction
 * family just to reuse the resolver and the failure-diagnosis path.
 *
 * Three concerns:
 *
 * 1. **Target resolution** — `{ ref }` or `{ selector }` → a single CSS selector
 *    (`ref` becomes `[data-sw-ref="<ref>"]`, the tag the snapshot walker writes).
 * 2. **Failure diagnosis** — map whatever the transport throws onto a registered
 *    error code (mirroring `diagnoseLaunchError`), and on a "can't find it" code
 *    attach `similar_refs` candidates from a fresh live walk (falling back to the
 *    stored snapshot) so the agent recovers in one turn.
 * 3. **Ref freshness** — a `ref` only means something relative to a snapshot; if
 *    the latest stored snapshot lacks it, fail fast rather than acting on a tag
 *    that may now point at the wrong element.
 *
 * @module
 */

import { type ErrorResponse, type SimilarRef, makeError } from '../errors/envelope.js'
import { type ErrorCode, StagewrightError } from '../errors/registry.js'
import type { Snapshot } from '../snapshot/index.js'
import type { TransportSession } from '../transports/index.js'
import { buildWalkBody, loadInjectedWalker } from './snapshot/inject.js'
import { reconcileRetagAndStore } from './snapshot/refs.js'
import type { ToolContext } from './types.js'

/** How many candidate refs an error envelope carries at most. */
const SIMILAR_REF_LIMIT = 5
/** Longest error message we echo back — keeps a verbose transport throw from bloating tokens. */
const MAX_MESSAGE_LENGTH = 200

/** The envelope-meta shape every ref/selector tool threads into `makeSuccess` / `makeError`. */
export interface ToolMeta {
  readonly startedAt: number
  readonly now: () => number
  readonly session_id: string
}

/**
 * The arguments common to every single-target tool. Optionals are typed
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
 * element). Still rejects supplying both, or an empty selector, with `BAD_ARGUMENT`.
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
 * Classify a thrown element-access failure into a registered error code. A
 * transport that already classified the failure (any `StagewrightError` that is
 * not the generic `INTERNAL_ERROR`) wins; otherwise the raw message is
 * pattern-matched the same way `diagnoseLaunchError` matches launch failures.
 */
export function classifyTargetError(err: unknown): ErrorCode {
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
export function refName(
  snapshot: Snapshot | undefined,
  ref: number | undefined,
): string | undefined {
  if (snapshot === undefined || ref === undefined) return undefined
  return snapshot.entries.find((entry) => entry.ref === ref)?.name
}

/**
 * Source `similar_refs` for a "can't find it" failure. Re-walks the live DOM so
 * the candidates reflect the current screen (a hot-reload makes the stored
 * baseline misleading) and reconciles + retags + stores the result so the refs it
 * returns are valid handles, not throwaway document-order numbers. Falls back to
 * the stored snapshot when the live walk is unavailable. Best-effort — never throws.
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
 * Build a "can't find it" error envelope (`SELECTOR_NO_MATCH` / `REF_NOT_FOUND`)
 * with `similar_refs` candidates and recovery `next_actions`. Used both for thrown
 * failures (via {@link handleTargetFailure}) and for tools whose miss is a value,
 * not a throw (e.g. a read whose selector matched nothing).
 */
export async function buildMissError(
  code: 'SELECTOR_NO_MATCH' | 'REF_NOT_FOUND',
  cx: {
    readonly ctx: ToolContext
    readonly session: TransportSession
    readonly meta: ToolMeta
    readonly message: string
    readonly nameHint?: string | undefined
  },
): Promise<ErrorResponse> {
  const similar = await gatherSimilarRefs({
    ctx: cx.ctx,
    session: cx.session,
    sessionId: cx.meta.session_id,
    hint: cx.nameHint,
  })
  return makeError(code, {
    ...cx.meta,
    message: cx.message,
    ...(similar.length > 0 ? { similar_refs: similar } : {}),
    next_actions: ['electron_snapshot()', 'electron_find({ role: "button" })'],
  })
}

/**
 * Build the error envelope for a thrown element-access failure. On a
 * `SELECTOR_NO_MATCH` / `REF_NOT_FOUND` it attaches `similar_refs` (re-walked
 * live) and recovery `next_actions`; other codes get a recovery hint only.
 */
export async function handleTargetFailure(
  err: unknown,
  cx: {
    readonly ctx: ToolContext
    readonly session: TransportSession
    readonly meta: ToolMeta
    readonly nameHint?: string | undefined
  },
): Promise<ErrorResponse> {
  const code = classifyTargetError(err)
  const message = shorten(err instanceof Error ? err.message : String(err))
  if (code === 'SELECTOR_NO_MATCH' || code === 'REF_NOT_FOUND') {
    return buildMissError(code, { ...cx, message })
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
export async function refFreshnessError(
  ctx: ToolContext,
  session: TransportSession,
  meta: ToolMeta,
  ref: number | undefined,
): Promise<ErrorResponse | undefined> {
  if (ref === undefined) return undefined
  const stored = ctx.snapshots.get(meta.session_id)
  if (stored === undefined || snapshotHasRef(stored, ref)) return undefined
  return buildMissError('REF_NOT_FOUND', {
    ctx,
    session,
    meta,
    message: `ref ${ref} is not in the latest snapshot; it may be stale. Re-snapshot to refresh refs.`,
  })
}
