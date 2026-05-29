/**
 * `electron_find` — query the renderer accessibility tree by role / name / state
 * instead of CSS selectors (agent-native UX Principle 9). Walks the renderer,
 * filters with the shared `findEntries`, and returns the matching elements'
 * refs, roles, names, and bounding boxes.
 *
 * @module
 */

import { z } from 'zod'

import { makeSuccess } from '../../errors/envelope.js'
import {
  type FindQuery,
  type Snapshot,
  type SnapshotRole,
  findEntries,
} from '../../snapshot/index.js'
import { type AnyToolDefinition, defineTool } from '../types.js'
import { buildWalkBody, loadInjectedWalker } from './inject.js'
import { reconcileRetagAndStore } from './refs.js'

const inputSchema = z.object({
  sessionId: z
    .string()
    .optional()
    .describe('Target session id. Omit when a single session is running.'),
  role: z.string().optional().describe('Accessibility role to match exactly (e.g. "button").'),
  name_contains: z.string().optional().describe('Substring the accessible name must contain.'),
  name_exact: z.string().optional().describe('Exact accessible name to match.'),
  visible: z.boolean().optional().describe('Restrict to visible (or hidden) elements.'),
  interactive: z
    .boolean()
    .optional()
    .describe('Restrict to interactive (or non-interactive) elements.'),
})

const DESCRIPTION = [
  'Find elements in the renderer by accessibility role + name + state — no CSS selectors.',
  'Filters: role (exact), name_contains, name_exact, visible, interactive. Returns:',
  '{ ok, matches: [{ ref, role, name, bbox }], count, renderer_reloaded }. A ref may be null',
  'for non-interactive landmarks. Errors: NOT_RUNNING (no session — call electron_launch first; not retryable),',
  'BAD_ARGUMENT (multiple sessions live — pass sessionId).',
].join(' ')

/** Dependency seams for {@link makeFindTool} — injected by tests. */
export interface FindToolDeps {
  /** Loader for the bundled walker IIFE. Defaults to reading the built artifact. */
  readonly loadBundle?: () => string
}

/** Build the `electron_find` tool. */
export function makeFindTool(deps: FindToolDeps = {}): AnyToolDefinition {
  const loadBundle = deps.loadBundle ?? loadInjectedWalker
  return defineTool({
    name: 'electron_find',
    title: 'Find elements by role and name',
    description: DESCRIPTION,
    inputSchema,
    operationType: 'query',
    handler: async (args, ctx) => {
      const managed = ctx.sessions.resolve(args.sessionId)
      const meta = { startedAt: ctx.startedAt, now: ctx.now, session_id: managed.id }
      const body = buildWalkBody(loadBundle())
      const walked = await managed.session.evaluate<Snapshot>('renderer', body, {})

      // Same stabilise-the-walk step as electron_snapshot: reconcile refs against
      // the stored baseline, retag the DOM, and store, so find and snapshot agree
      // on ref numbers and the DOM tags stay consistent.
      const prev = ctx.snapshots.get(managed.id)
      const { curr: snapshot, reloaded } = await reconcileRetagAndStore({
        session: managed.session,
        store: ctx.snapshots,
        sessionId: managed.id,
        prev,
        walked,
      })

      const query: FindQuery = {
        ...(args.role !== undefined ? { role: args.role as SnapshotRole } : {}),
        ...(args.name_contains !== undefined ? { name_contains: args.name_contains } : {}),
        ...(args.name_exact !== undefined ? { name_exact: args.name_exact } : {}),
        ...(args.visible !== undefined ? { visible: args.visible } : {}),
        ...(args.interactive !== undefined ? { interactive: args.interactive } : {}),
      }
      const matches = findEntries(snapshot, query).map((entry) => ({
        ref: entry.ref,
        role: entry.role,
        name: entry.name,
        bbox: entry.bbox,
      }))
      return makeSuccess({ matches, count: matches.length, renderer_reloaded: reloaded }, meta)
    },
  })
}

/** The default `electron_find` tool registered by the server. */
export const findTool: AnyToolDefinition = makeFindTool()
