/**
 * Orchestration shared by the read tools (`electron_get_text`, `get_state`, …).
 *
 * Two run-shapes, both reusing the family-agnostic target machinery in
 * `tools/target.ts`:
 *
 * - {@link runTargetedRead} — one required `ref`/`selector` target. Resolves the
 *   target, refuses a transport that cannot evaluate the renderer, guards ref
 *   freshness, evaluates the read body, and (unless the tool opts out, like
 *   `exists`) turns a `{ found: false }` result into `SELECTOR_NO_MATCH` with
 *   `similar_refs`.
 * - {@link runRendererRead} — a read with no single target (`focused_element`,
 *   `elements_list`).
 *
 * Read bodies return `{ found: boolean, …data }`; the tool's `toPayload` maps the
 * data onto the agent-facing payload.
 *
 * @module
 */

import { makeError, makeSuccess } from '../../errors/envelope.js'
import { assertCapability } from '../../transports/index.js'
import {
  buildMissError,
  handleTargetFailure,
  refFreshnessError,
  refName,
  resolveTarget,
} from '../target.js'
import type { ToolContext, ToolResult } from '../types.js'

/** A renderer-eval body plus the `arg` the transport wrapper passes to it. */
export interface RendererCall {
  readonly body: string
  readonly arg: unknown
}

/** The `{ found, …data }` shape every read body resolves to. */
export interface ReadRaw {
  readonly found?: boolean
  readonly [key: string]: unknown
}

/** Read a selector string out of an arbitrary renderer-call argument. */
function selectorFromArg(arg: unknown): string | undefined {
  if (typeof arg !== 'object' || arg === null || !('selector' in arg)) return undefined
  const selector = (arg as { readonly selector?: unknown }).selector
  return typeof selector === 'string' ? selector : undefined
}

/** Whether a renderer probe reported CSS selector syntax failure. */
function isInvalidSelector(raw: ReadRaw | undefined): boolean {
  return raw?.['invalid_selector'] === true
}

/** Keep an invalid selector echo useful without letting it dominate the envelope. */
function selectorLabel(selector: string | undefined): string {
  if (selector === undefined) return ''
  const visible = selector.length > 80 ? `${selector.slice(0, 80)}...` : selector
  return ` "${visible}"`
}

/** BAD_ARGUMENT message for malformed CSS selectors, preserving the renderer's reason. */
function invalidSelectorMessage(raw: ReadRaw | undefined, selector: string | undefined): string {
  const rawReason = raw?.['error']
  const reason = typeof rawReason === 'string' ? rawReason : undefined
  const target = selectorLabel(selector)
  return reason !== undefined
    ? `Invalid CSS selector${target}: ${reason}`
    : `Invalid CSS selector${target}.`
}

/** Args common to every targeted read tool. */
export interface TargetedReadArgs {
  readonly sessionId?: string | undefined
  readonly ref?: number | undefined
  readonly selector?: string | undefined
}

/**
 * Run a single-target read. `build` produces the renderer call for the resolved
 * selector; `toPayload` shapes the success payload from the raw result. With
 * `treatMissAsError: false` (e.g. `electron_exists`) a `{ found: false }` is a
 * normal success rather than a `SELECTOR_NO_MATCH`.
 */
export async function runTargetedRead(
  ctx: ToolContext,
  args: TargetedReadArgs,
  build: (selector: string) => RendererCall,
  toPayload: (raw: ReadRaw) => Record<string, unknown>,
  opts: { readonly treatMissAsError?: boolean } = {},
): Promise<ToolResult> {
  const managed = ctx.sessions.resolve(args.sessionId)
  const meta = { startedAt: ctx.startedAt, now: ctx.now, session_id: managed.id }
  // Reuse the shared resolver (ref → [data-sw-ref], exactly-one-of guard).
  const selector = resolveTarget(args)
  assertCapability(managed.transport, 'supportsRendererEval')

  const stale = await refFreshnessError(ctx, managed.session, meta, args.ref)
  if (stale !== undefined) return stale

  try {
    const { body, arg } = build(selector)
    const raw = await managed.session.evaluate<ReadRaw>('renderer', body, arg)
    if (isInvalidSelector(raw)) {
      return makeError('BAD_ARGUMENT', {
        ...meta,
        message: invalidSelectorMessage(raw, selector),
      })
    }
    if (raw?.found === false && opts.treatMissAsError !== false) {
      return buildMissError('SELECTOR_NO_MATCH', {
        ctx,
        session: managed.session,
        meta,
        message: `No element matched ${selector}.`,
        nameHint: refName(ctx.snapshots.get(managed.id), args.ref),
      })
    }
    return makeSuccess({ session_id: managed.id, ...toPayload(raw) }, meta)
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
 * Run a read with no single target (queries the document as a whole, e.g. the
 * focused element or every match of a selector). No freshness guard — there is no
 * `ref` to stale-check.
 */
export async function runRendererRead(
  ctx: ToolContext,
  args: { readonly sessionId?: string | undefined },
  call: RendererCall,
  toPayload: (raw: ReadRaw) => Record<string, unknown>,
): Promise<ToolResult> {
  const managed = ctx.sessions.resolve(args.sessionId)
  const meta = { startedAt: ctx.startedAt, now: ctx.now, session_id: managed.id }
  assertCapability(managed.transport, 'supportsRendererEval')
  try {
    const raw = await managed.session.evaluate<ReadRaw>('renderer', call.body, call.arg)
    if (isInvalidSelector(raw)) {
      return makeError('BAD_ARGUMENT', {
        ...meta,
        message: invalidSelectorMessage(raw, selectorFromArg(call.arg)),
      })
    }
    return makeSuccess({ session_id: managed.id, ...toPayload(raw) }, meta)
  } catch (err) {
    return handleTargetFailure(err, { ctx, session: managed.session, meta })
  }
}
