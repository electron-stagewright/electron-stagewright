/**
 * Document-level read tools (no single `ref`/`selector` target):
 * `electron_focused_element` (what currently has focus) and
 * `electron_elements_list` (every element matching a CSS selector, capped).
 * Both reuse the walker bundle's probe for role + accessible name.
 *
 * @module
 */

import { z } from 'zod'

import { sessionIdField } from '../schema.js'
import { buildProbeBody, loadInjectedWalker } from '../snapshot/inject.js'
import { type AnyToolDefinition, defineTool } from '../types.js'
import { type ReadProbeDeps } from './state.js'
import { type ReadRaw, runRendererRead } from './probe.js'

/** Default cap on `electron_elements_list` matches when the caller omits `limit`. */
const DEFAULT_LIST_LIMIT = 50
/** Hard ceiling on `limit` so a huge selector match cannot blow the token budget. */
const MAX_LIST_LIMIT = 200

/** Build `electron_focused_element`. */
export function makeFocusedElementTool(deps: ReadProbeDeps = {}): AnyToolDefinition {
  const loadBundle = deps.loadBundle ?? loadInjectedWalker
  return defineTool({
    name: 'electron_focused_element',
    title: 'Get the focused element',
    description: [
      'Return the element that currently has focus as { ref, role, name }, or focused: null when',
      'nothing (or only the body) is focused. Useful after a Tab press or to confirm focus moved.',
      'Returns: { ok, session_id, focused }. Errors: TRANSPORT_UNSUPPORTED, NOT_RUNNING,',
      'BAD_ARGUMENT (multiple sessions).',
    ].join(' '),
    inputSchema: z.object({ sessionId: sessionIdField }),
    operationType: 'query',
    handler: (args, ctx) =>
      runRendererRead(
        ctx,
        args,
        { body: buildProbeBody(loadBundle()), arg: { mode: 'focused' } },
        (raw: ReadRaw) =>
          raw.found === true
            ? {
                focused: {
                  ref: raw['ref'] ?? null,
                  role: raw['role'] ?? null,
                  name: raw['name'] ?? '',
                },
              }
            : { focused: null },
      ),
  })
}

/** Build `electron_elements_list`. */
export function makeElementsListTool(deps: ReadProbeDeps = {}): AnyToolDefinition {
  const loadBundle = deps.loadBundle ?? loadInjectedWalker
  return defineTool({
    name: 'electron_elements_list',
    title: 'List elements matching a selector',
    description: [
      'Return every element matching a CSS selector as { ref, role, name, bbox }, capped at `limit`',
      `(default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}). When more matched than returned, `,
      '`truncated` is the number dropped and `count` is the true total.',
      'Returns: { ok, session_id, matches, count, truncated }. Errors: TRANSPORT_UNSUPPORTED,',
      'NOT_RUNNING, BAD_ARGUMENT (invalid selector, limit, or multiple sessions).',
    ].join(' '),
    inputSchema: z.object({
      selector: z.string().min(1).describe('CSS selector to match (e.g. "button", "[role=tab]").'),
      limit: z
        .number()
        .int()
        .positive()
        .max(MAX_LIST_LIMIT)
        .optional()
        .describe(`Max matches to return (default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}).`),
      sessionId: sessionIdField,
    }),
    operationType: 'query',
    handler: (args, ctx) =>
      runRendererRead(
        ctx,
        args,
        {
          body: buildProbeBody(loadBundle()),
          arg: { mode: 'list', selector: args.selector, limit: args.limit ?? DEFAULT_LIST_LIMIT },
        },
        (raw: ReadRaw) => ({
          matches: raw['matches'] ?? [],
          count: raw['count'] ?? 0,
          truncated: raw['truncated'] ?? 0,
        }),
      ),
  })
}

/** The default document-level read tools registered by the server. */
export const focusedElementTool: AnyToolDefinition = makeFocusedElementTool()
export const elementsListTool: AnyToolDefinition = makeElementsListTool()
