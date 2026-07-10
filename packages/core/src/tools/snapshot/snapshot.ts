/**
 * `electron_snapshot` — the agent's structured view of the current renderer.
 *
 * Injects the bundled accessibility walker into the renderer, runs it, and
 * returns either a full snapshot or — with `{ since: 'last' }` — only the delta
 * since the previous snapshot for this session. Implements the agent-native UX
 * principles: `recently_changed` flags (P6), `since:'last'` as a parameter
 * rather than a separate tool (P7), and hot-reload awareness (P10). Interactive
 * elements are tagged `data-sw-ref` during the walk so a `ref` resolves to a
 * selector for later interaction.
 *
 * @module
 */

import { z } from 'zod'

import { makeSuccess } from '../../errors/envelope.js'
import {
  type Snapshot,
  compactDiff,
  diffSnapshots,
  markRecentlyChanged,
  renderDiffText,
  renderSnapshotText,
  truncateDiffToBudget,
} from '../../snapshot/index.js'
import { type AnyToolDefinition, defineTool } from '../types.js'
import { loadInjectedWalker, runWalk } from './inject.js'
import { reconcileRetagAndStore } from './refs.js'

/** Default cap on entries returned, to keep a huge DOM from blowing the token budget. */
const DEFAULT_MAX_ENTRIES = 2000
/** Hard ceiling an agent may request. */
const MAX_ENTRIES_LIMIT = 10_000

const inputSchema = z.object({
  sessionId: z
    .string()
    .optional()
    .describe('Target session id. Omit when a single session is running.'),
  since: z
    .literal('last')
    .optional()
    .describe('Return only the delta since the previous snapshot for this session.'),
  interactiveOnly: z
    .boolean()
    .optional()
    .describe('Return only interactive elements (drops landmarks) to save tokens.'),
  maxEntries: z
    .number()
    .int()
    .min(1)
    .max(MAX_ENTRIES_LIMIT)
    .optional()
    .describe(`Cap the number of entries returned. Defaults to ${DEFAULT_MAX_ENTRIES}.`),
  format: z
    .enum(['json', 'text'])
    .optional()
    .describe(
      "Payload encoding. 'json' (default) returns the structured snapshot/diff objects." +
        " 'text' returns a compact one-line-per-entry rendering (5-10x fewer tokens): ref, role," +
        ' quoted name, non-empty value/placeholder, and only NON-default state flags;' +
        ' ~ prefixes recently-changed entries, [-] marks non-targetable landmarks.',
    ),
  diffFormat: z
    .enum(['compact', 'full'])
    .optional()
    .describe(
      "Encoding for since:'last' diffs. 'compact' (default) carries only the changed fields per" +
        " entry; 'full' carries complete prev/curr entries. Ignored when format:'text'.",
    ),
  budgetTokens: z
    .number()
    .int()
    .min(50)
    .optional()
    .describe(
      "Server-side token cap for a since:'last' diff payload. Lowest-value entries" +
        ' (non-interactive removed/changed first) are dropped until the estimate fits;' +
        ' _meta.truncated_entries reports how many were omitted.',
    ),
})

const DESCRIPTION = [
  'Capture the renderer accessibility tree: interactive elements (and landmarks) with role, name,',
  'state, bbox, and a stable ref. Pass since:"last" for only what changed since the previous',
  'snapshot (added/removed/changed + ref_map), interactiveOnly to drop landmarks, maxEntries to cap.',
  'format:"text" returns a compact one-line-per-entry rendering instead of JSON (5-10x fewer',
  'tokens): `[ref] role "name" value=… flags`, ~ marks recently-changed, [-] marks landmarks.',
  'Diffs default to a compact encoding (changed fields only; diffFormat:"full" restores complete',
  'prev/curr entries) and accept budgetTokens for server-side truncation that keeps interactive',
  'entries first. Each response carries renderer_reloaded so stale refs are detectable (P10).',
  'Refs are tagged on the DOM (data-sw-ref) so later interaction tools can act by ref.',
  'Closed shadow roots are opaque unless the app opts in: push each root onto',
  'window.__stagewright_closedShadowRoots at attachShadow time (or implement',
  'window.__stagewright_inspectShadow); their entries carry state.shadow_closed: true.',
  'Returns: { ok, kind: "full" | "diff", snapshot?, diff?, snapshot_text?, diff_text?,',
  'diff_format?, renderer_reloaded, truncated }.',
  'Errors: NOT_RUNNING (no session — call electron_launch first; not retryable),',
  'BAD_ARGUMENT (multiple sessions live — pass sessionId).',
].join(' ')

/** Apply interactive-only filtering and the entry cap. Returns the (possibly new) snapshot. */
function applyFilters(
  snapshot: Snapshot,
  interactiveOnly: boolean,
  maxEntries: number,
): { readonly snapshot: Snapshot; readonly truncated: boolean } {
  let entries = snapshot.entries
  if (interactiveOnly) {
    entries = entries.filter((entry) => entry.interactive)
  }
  let truncated = false
  if (entries.length > maxEntries) {
    entries = entries.slice(0, maxEntries)
    truncated = true
  }
  if (entries === snapshot.entries) {
    return { snapshot, truncated: false }
  }
  return { snapshot: { ...snapshot, entries }, truncated }
}

/** Dependency seams for {@link makeSnapshotTool} — injected by tests. */
export interface SnapshotToolDeps {
  /** Loader for the bundled walker IIFE. Defaults to reading the built artifact. */
  readonly loadBundle?: () => string
}

/**
 * Build the `electron_snapshot` tool. Exposed as a factory so tests inject a
 * stub bundle loader (the fake session ignores the eval body and returns a
 * fixture snapshot).
 */
export function makeSnapshotTool(deps: SnapshotToolDeps = {}): AnyToolDefinition {
  const loadBundle = deps.loadBundle ?? loadInjectedWalker
  return defineTool({
    name: 'electron_snapshot',
    title: 'Snapshot renderer accessibility tree',
    description: DESCRIPTION,
    inputSchema,
    operationType: 'query',
    handler: async (args, ctx) => {
      const managed = ctx.sessions.resolve(args.sessionId)
      const meta = { startedAt: ctx.startedAt, now: ctx.now, session_id: managed.id }
      const maxEntries = args.maxEntries ?? DEFAULT_MAX_ENTRIES

      const walked = await runWalk<Snapshot>(managed.session, loadBundle(), {})

      // Stabilise the walk: reconcile refs against the stored baseline, retag the
      // renderer DOM, stamp the reload flag, and store the FULL unfiltered snapshot
      // as the diff baseline. Filters (interactiveOnly / maxEntries) apply only to
      // what is RETURNED — never to the stored baseline — so a later since:'last'
      // diff stays accurate even if this call (or the previous one) filtered.
      const prev = ctx.snapshots.get(managed.id)
      const { curr, comparable, reloaded } = await reconcileRetagAndStore({
        session: managed.session,
        store: ctx.snapshots,
        sessionId: managed.id,
        prev,
        walked,
      })

      // since:'last' → the delta against the previous snapshot. Filters apply to
      // full snapshots, not to a diff (a diff is already only what changed). The
      // `prev !== undefined` check is implied by `comparable` and is present so the
      // type narrows. Compact is the default encoding — the full prev/curr pairs
      // blow MCP-client token caps on busy dialogs; diffFormat:'full' restores them.
      if (args.since === 'last' && comparable && prev !== undefined) {
        const fullDiff = diffSnapshots(prev, curr)
        // Text encoding always shapes from the compact diff (the full prev/curr pairs
        // exist to be machine-applied, which a text consumer is not doing).
        if (args.format === 'text') {
          const compacted = compactDiff(fullDiff)
          const bounded =
            args.budgetTokens !== undefined
              ? truncateDiffToBudget(compacted, args.budgetTokens)
              : { diff: compacted, dropped: 0 }
          return makeSuccess(
            {
              kind: 'diff',
              format: 'text',
              diff_text: renderDiffText(bounded.diff),
              renderer_reloaded: false,
              truncated: bounded.dropped > 0,
            },
            meta,
          )
        }
        const format = args.diffFormat ?? 'compact'
        const encoded = format === 'compact' ? compactDiff(fullDiff) : fullDiff
        const bounded =
          args.budgetTokens !== undefined
            ? truncateDiffToBudget(encoded, args.budgetTokens)
            : { diff: encoded, dropped: 0 }
        return makeSuccess(
          {
            kind: 'diff',
            diff_format: format,
            diff: bounded.diff,
            renderer_reloaded: false,
            truncated: bounded.dropped > 0,
          },
          meta,
        )
      }

      // Full snapshot: mark recently_changed against the previous (when comparable),
      // then apply the agent's filters to the RETURNED snapshot only. The diff feeding
      // markRecentlyChanged is internal — skip its token estimate (a full-delta stringify)
      // since only the change identities are consumed.
      const marked =
        comparable && prev !== undefined
          ? markRecentlyChanged(curr, diffSnapshots(prev, curr, { skipTokenEstimate: true }))
          : curr
      const { snapshot, truncated } = applyFilters(
        marked,
        args.interactiveOnly === true,
        maxEntries,
      )
      // Text encoding: one line per entry, only non-default signal (see render-text.ts).
      if (args.format === 'text') {
        return makeSuccess(
          {
            kind: 'full',
            format: 'text',
            snapshot_text: renderSnapshotText(snapshot),
            entry_count: snapshot.entries.length,
            renderer_reloaded: reloaded,
            truncated,
          },
          meta,
        )
      }
      return makeSuccess({ kind: 'full', snapshot, renderer_reloaded: reloaded, truncated }, meta)
    },
  })
}

/** The default `electron_snapshot` tool registered by the server. */
export const snapshotTool: AnyToolDefinition = makeSnapshotTool()
