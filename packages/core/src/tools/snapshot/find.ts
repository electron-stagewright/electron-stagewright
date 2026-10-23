/**
 * `electron_find` — query the selected renderer surface accessibility tree by role / name / state
 * instead of CSS selectors (agent-native UX Principle 9). Walks the renderer,
 * filters with the shared `findEntries`, and returns the matching elements'
 * refs, roles, names, and bounding boxes.
 *
 * @module
 */

import { z } from 'zod'

import { makeSuccess } from '../../errors/envelope.js'
import {
  type FindHints,
  type TextMatches,
  findHints,
  hintNextActions,
} from '../../snapshot/find-hints.js'
import {
  type FindQuery,
  type Snapshot,
  type SnapshotRole,
  findEntries,
} from '../../snapshot/index.js'
import { visitTargetElements } from '../../snapshot/resolve-target.js'
import { MAX_SHADOW_DEPTH } from '../../snapshot/walker.js'
import type { TransportSession } from '../../transports/index.js'
import { type AnyToolDefinition, defineTool } from '../types.js'
import { loadInjectedWalker, runWalk } from './inject.js'
import { reconcileRetagAndStore } from './refs.js'

const inputSchema = z
  .object({
    sessionId: z
      .string()
      .optional()
      .describe('Target session id. Omit when a single session is running.'),
    role: z.string().optional().describe('Accessibility role to match exactly (e.g. "button").'),
    name_contains: z.string().optional().describe('Substring the accessible name must contain.'),
    name_exact: z.string().optional().describe('Exact accessible name to match.'),
    visible: z.boolean().optional().describe('Restrict to visible (or hidden) elements.'),
    enabled: z.boolean().optional().describe('Restrict to enabled (or disabled) elements.'),
    interactive: z
      .boolean()
      .optional()
      .describe('Restrict to interactive (or non-interactive) elements.'),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Cap the matches returned (in document order); count still reports the true total so' +
          ' a truncation is detectable. Unset returns every match.',
      ),
  })
  .refine((args) => args.name_contains === undefined || args.name_exact === undefined, {
    message: 'Provide name_contains or name_exact, not both.',
    path: ['name_exact'],
  })

const DESCRIPTION = [
  'Find elements in the renderer by accessibility role + name + state — no CSS selectors.',
  'Filters: role (exact), name_contains, name_exact, visible, enabled, interactive; limit caps',
  'the matches returned (count still reports the true total). Returns:',
  '{ ok, surface_id, matches: [{ ref, role, name, bbox }], count, truncated, renderer_reloaded }. A ref may be',
  'null for non-interactive landmarks. On zero matches, hints may explain why: similar_names,',
  'without_state_filters, other_roles, roles_present, text_matches (text content, not accessible',
  'name, with a selector for electron_get_text / electron_exists) and next_actions.',
  'Errors: NOT_RUNNING (no session — call electron_launch',
  'first; not retryable), BAD_ARGUMENT (multiple sessions live — pass sessionId).',
].join(' ')

const MAX_TEXT_SAMPLES = 5

/** Innermost elements whose text contains `arg.query`, visible ones first, with a CSS path for each. */
const TEXT_SEARCH_BODY = `
${visitTargetElements.toString()}
const q = arg.query.toLowerCase();
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'title']);
const has = (node) => !SKIP.has(node.localName) && (node.textContent || '').toLowerCase().includes(q);
const hits = [];
const descend = (el) => {
  let inner = false;
  for (const child of el.children) {
    if (has(child)) { inner = true; descend(child); }
  }
  if (!inner) hits.push(el);
};
const roots = new Set([document]);
visitTargetElements(document, ${MAX_SHADOW_DEPTH}, (el) => { roots.add(el.getRootNode()); return false; });
for (const root of roots) {
  if (root === document) { if (document.body !== null && has(document.body)) descend(document.body); }
  else for (const child of root.children) if (has(child)) descend(child);
}
const cssPath = (el) => {
  if (el.getRootNode() !== document) return null;
  const parts = [];
  for (let node = el; node !== null; node = node.parentElement) {
    if (node.id !== '' && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1) {
      parts.unshift('#' + CSS.escape(node.id));
      break;
    }
    if (node === document.body) { parts.unshift('body'); break; }
    let index = 1;
    for (let sib = node.previousElementSibling; sib !== null; sib = sib.previousElementSibling) {
      if (sib.localName === node.localName) index++;
    }
    parts.unshift(CSS.escape(node.localName) + ':nth-of-type(' + index + ')');
  }
  return parts.join(' > ');
};
const visible = (el) =>
  typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.getClientRects().length > 0;
const ranked = hits.map((el) => ({ el, visible: visible(el) }));
ranked.sort((a, b) => Number(b.visible) - Number(a.visible));
return {
  count: hits.length,
  samples: ranked.slice(0, arg.max).map(({ el, visible }) => {
    const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    return {
      tag: el.localName,
      text: text.length > 80 ? text.slice(0, 80) + '…' : text,
      selector: cssPath(el),
      visible,
    };
  }),
};
`

/** Best-effort renderer text search; a failure only drops this hint. */
async function textMatches(
  session: Pick<TransportSession, 'evaluate'>,
  query: string,
): Promise<TextMatches | undefined> {
  if (query.trim() === '') return undefined
  try {
    const found = await session.evaluate<TextMatches>('renderer', TEXT_SEARCH_BODY, {
      query: query.trim(),
      max: MAX_TEXT_SAMPLES,
    })
    return found.count > 0 ? found : undefined
  } catch {
    return undefined
  }
}

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
      const surface = await managed.session.activeSurface()

      // Same stabilise-the-walk step as electron_snapshot: reconcile refs against
      // the stored baseline, retag the DOM, and store, so find and snapshot agree
      // on ref numbers and the DOM tags stay consistent.
      const { curr: snapshot, reloaded } = await ctx.snapshots.withRefLock(
        managed.id,
        surface.id,
        async () =>
          reconcileRetagAndStore({
            session: managed.session,
            store: ctx.snapshots,
            sessionId: managed.id,
            surfaceId: surface.id,
            prev: ctx.snapshots.get(managed.id, surface.id),
            walked: await runWalk<Snapshot>(managed.session, loadBundle(), {}),
          }),
        ctx.signal,
      )

      const query: FindQuery = {
        ...(args.role !== undefined ? { role: args.role as SnapshotRole } : {}),
        ...(args.name_contains !== undefined ? { name_contains: args.name_contains } : {}),
        ...(args.name_exact !== undefined ? { name_exact: args.name_exact } : {}),
        ...(args.visible !== undefined ? { visible: args.visible } : {}),
        ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
        ...(args.interactive !== undefined ? { interactive: args.interactive } : {}),
      }
      const all = findEntries(snapshot, query)
      const capped = args.limit !== undefined ? all.slice(0, args.limit) : all
      const matches = capped.map((entry) => ({
        ref: entry.ref,
        role: entry.role,
        name: entry.name,
        bbox: entry.bbox,
      }))
      let hints: FindHints | undefined
      if (all.length === 0) {
        const name = query.name_exact ?? query.name_contains
        const text = name !== undefined ? await textMatches(managed.session, name) : undefined
        const found = {
          ...findHints(snapshot, query),
          ...(text !== undefined ? { text_matches: text } : {}),
        }
        const nextActions = hintNextActions(query, found)
        if (Object.keys(found).length > 0) {
          hints = { ...found, ...(nextActions.length > 0 ? { next_actions: nextActions } : {}) }
        }
      }
      return makeSuccess(
        {
          surface_id: surface.id,
          matches,
          // `count` is the TRUE total so an agent can tell a capped result from a small one.
          count: all.length,
          truncated: all.length - matches.length,
          renderer_reloaded: reloaded,
          ...(hints !== undefined ? { hints } : {}),
        },
        meta,
      )
    },
  })
}

/** The default `electron_find` tool registered by the server. */
export const findTool: AnyToolDefinition = makeFindTool()
