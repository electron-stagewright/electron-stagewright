/**
 * `electron_expect_count` — assert how many elements match, polling until the
 * count satisfies a numeric predicate or the budget elapses (ADR-007 Principle 8).
 *
 * Two targeting modes:
 * - **selector** — count `document.querySelectorAll(selector)` (optionally
 *   filtered by visibility) in a single self-bounded renderer poll body.
 * - **role** — count accessibility-tree matches via the shared `findEntries`
 *   (same query surface as `electron_find`), in a bounded server-side poll loop so
 *   the count logic stays the single source of truth instead of being duplicated
 *   into a renderer string.
 *
 * @module
 */

import { z } from 'zod'

import { makeError, makeSuccess } from '../../errors/envelope.js'
import {
  type FindQuery,
  type Snapshot,
  type SnapshotRole,
  findEntries,
} from '../../snapshot/index.js'
import { assertCapability } from '../../transports/index.js'
import { sessionIdField } from '../schema.js'
import { buildWalkBody, loadInjectedWalker } from '../snapshot/inject.js'
import { handleTargetFailure } from '../target.js'
import { type AnyToolDefinition, defineTool } from '../types.js'
import { type WaitRaw, clampWaitTimeout, runWait } from '../wait/poll.js'
import { buildExpectCountBody } from './body.js'
import {
  type CountMatch,
  countPredicateFields,
  countSatisfied,
  describeCount,
  expectTimeoutField,
  resolveCountMatch,
} from './match.js'
import { expectBadArgument } from './run.js'

/** Role-mode filter keys — counting these requires the accessibility walk, not a CSS selector. */
const ROLE_FILTER_KEYS = ['role', 'name_contains', 'name_exact', 'enabled', 'interactive'] as const

/** Interval between accessibility re-walks in role-mode polling (ms). */
const ROLE_POLL_INTERVAL_MS = 150

/** Build the `findEntries` query from the role-mode filter args. */
function toFindQuery(args: {
  readonly role?: string | undefined
  readonly name_contains?: string | undefined
  readonly name_exact?: string | undefined
  readonly visible?: boolean | undefined
  readonly enabled?: boolean | undefined
  readonly interactive?: boolean | undefined
}): FindQuery {
  return {
    ...(args.role !== undefined ? { role: args.role as SnapshotRole } : {}),
    ...(args.name_contains !== undefined ? { name_contains: args.name_contains } : {}),
    ...(args.name_exact !== undefined ? { name_exact: args.name_exact } : {}),
    ...(args.visible !== undefined ? { visible: args.visible } : {}),
    ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
    ...(args.interactive !== undefined ? { interactive: args.interactive } : {}),
  }
}

/** Dependency seam — injected by tests so the walker bundle is not read from disk. */
export interface ExpectCountDeps {
  /** Loader for the bundled walker IIFE (role mode only). Defaults to the built artifact. */
  readonly loadBundle?: () => string
}

/** Build `electron_expect_count`. */
export function makeExpectCountTool(deps: ExpectCountDeps = {}): AnyToolDefinition {
  const loadBundle = deps.loadBundle ?? loadInjectedWalker
  return defineTool({
    name: 'electron_expect_count',
    title: 'Expect a match count',
    description: [
      'Assert how many elements match, polling until the count satisfies the predicate or timeoutMs',
      'elapses. Target EITHER by selector (counts querySelectorAll; visible:true counts visible only,',
      'visible:false counts hidden only) OR',
      'by accessibility role/name filters (role, name_contains, name_exact, visible, enabled, interactive).',
      'Provide at least one of equals, min, max. Returns: { ok, session_id, matched, actual }.',
      'Errors: EXPECTATION_FAILED (count predicate not met within timeoutMs — details carry expected + actual;',
      'retryable), TRANSPORT_UNSUPPORTED, NOT_RUNNING, BAD_ARGUMENT (no count predicate, or selector mixed',
      'with role filters).',
    ].join(' '),
    inputSchema: z.object({
      selector: z
        .string()
        .min(1)
        .optional()
        .describe('CSS selector to count. Omit to count by role/name.'),
      role: z.string().optional().describe('Accessibility role to match (role mode).'),
      name_contains: z
        .string()
        .optional()
        .describe('Substring the accessible name must contain (role mode).'),
      name_exact: z.string().optional().describe('Exact accessible name to match (role mode).'),
      visible: z.boolean().optional().describe('Count only visible (or hidden) matches.'),
      enabled: z
        .boolean()
        .optional()
        .describe('Restrict to enabled (or disabled) matches (role mode).'),
      interactive: z.boolean().optional().describe('Restrict to interactive matches (role mode).'),
      ...countPredicateFields,
      timeoutMs: expectTimeoutField,
      sessionId: sessionIdField,
    }),
    operationType: 'query',
    handler: async (args, ctx) => {
      const resolved = resolveCountMatch(args)
      if (!resolved.ok) return expectBadArgument(ctx, args.sessionId, resolved.reason)
      const timeoutMs = clampWaitTimeout(args.timeoutMs)

      if (args.selector !== undefined) {
        const stray = ROLE_FILTER_KEYS.filter((k) => args[k] !== undefined)
        if (stray.length > 0) {
          return expectBadArgument(
            ctx,
            args.sessionId,
            `Role filters (${stray.join(', ')}) require omitting selector; selector mode counts CSS matches only.`,
          )
        }
        return runWait(
          ctx,
          { sessionId: args.sessionId },
          {
            body: buildExpectCountBody(),
            arg: {
              selector: args.selector,
              match: resolved.match,
              timeoutMs,
              ...(args.visible !== undefined ? { visible: args.visible } : {}),
            },
          },
          (raw: WaitRaw) => ({ matched: true, actual: raw['actual'] ?? null }),
          {
            timeoutMessage: `The match count did not satisfy the predicate within ${timeoutMs}ms.`,
            timeoutCode: 'EXPECTATION_FAILED',
            buildTimeoutDetails: (raw: WaitRaw) => ({
              expected: describeCount(resolved.match),
              actual: raw['actual'] ?? null,
            }),
          },
        )
      }

      // Role mode requires a target filter; otherwise findEntries({}) would count
      // every accessibility node, which is almost never intended and reads as an
      // opaque number. Force the agent to scope the count.
      if (args.name_contains !== undefined && args.name_exact !== undefined) {
        return expectBadArgument(
          ctx,
          args.sessionId,
          'Provide name_contains or name_exact, not both.',
        )
      }
      const hasRoleFilter =
        ROLE_FILTER_KEYS.some((k) => args[k] !== undefined) || args.visible !== undefined
      if (!hasRoleFilter) {
        return expectBadArgument(
          ctx,
          args.sessionId,
          'Provide a selector or at least one role/name filter (role, name_contains, name_exact, visible, enabled, interactive).',
        )
      }
      return pollRoleCount(
        ctx,
        args.sessionId,
        toFindQuery(args),
        resolved.match,
        timeoutMs,
        loadBundle,
      )
    },
  })
}

/**
 * Role-mode poll: re-walk the accessibility tree at a bounded interval and count
 * `findEntries` matches until the predicate holds or the budget elapses. Reuses
 * `findEntries` so the role/name/state matching stays identical to `electron_find`.
 */
async function pollRoleCount(
  ctx: Parameters<AnyToolDefinition['handler']>[1],
  sessionId: string | undefined,
  query: FindQuery,
  match: CountMatch,
  timeoutMs: number,
  loadBundle: () => string,
): Promise<ReturnType<AnyToolDefinition['handler']>> {
  const managed = ctx.sessions.resolve(sessionId)
  const meta = { startedAt: ctx.startedAt, now: ctx.now, session_id: managed.id }
  assertCapability(managed.transport, 'supportsRendererEval')
  const body = buildWalkBody(loadBundle())
  const startedAt = Date.now()
  for (;;) {
    let actual: number
    try {
      const walked = await managed.session.evaluate<Snapshot>('renderer', body, {})
      actual = findEntries(walked, query).length
    } catch (err) {
      return handleTargetFailure(err, { ctx, session: managed.session, meta })
    }
    if (countSatisfied(actual, match)) {
      return makeSuccess({ session_id: managed.id, matched: true, actual }, meta)
    }
    const remaining = timeoutMs - (Date.now() - startedAt)
    if (remaining <= 0) {
      return makeError('EXPECTATION_FAILED', {
        ...meta,
        message: `The match count did not satisfy the predicate within ${timeoutMs}ms.`,
        next_actions: ['electron_snapshot()'],
        details: { expected: describeCount(match), actual },
      })
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(ROLE_POLL_INTERVAL_MS, remaining)))
  }
}

/** The default `electron_expect_count` tool registered by the server. */
export const expectCountTool: AnyToolDefinition = makeExpectCountTool()
