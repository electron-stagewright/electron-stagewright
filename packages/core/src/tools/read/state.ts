/**
 * `electron_get_state` — the full state envelope of one element (visible,
 * enabled, disabled, checked, selected, expanded, pressed, focused, readonly,
 * required, invalid, busy) in a single call, so an agent answers "is this
 * clickable" / "is this checked" without re-snapshotting. Reuses the walker bundle's
 * single-element probe so the state semantics are identical to a snapshot.
 *
 * @module
 */

import { z } from 'zod'

import { refField, selectorField, sessionIdField } from '../schema.js'
import { buildProbeBody, loadInjectedWalker } from '../snapshot/inject.js'
import { type AnyToolDefinition, defineTool } from '../types.js'
import { type ReadRaw, runTargetedRead } from './probe.js'

/** Dependency seam for the bundle-backed read tools — injected by tests. */
export interface ReadProbeDeps {
  /** Loader for the bundled walker/probe IIFE. Defaults to reading the built artifact. */
  readonly loadBundle?: () => string
}

/** Build `electron_get_state`. */
export function makeGetStateTool(deps: ReadProbeDeps = {}): AnyToolDefinition {
  const loadBundle = deps.loadBundle ?? loadInjectedWalker
  return defineTool({
    name: 'electron_get_state',
    title: 'Get an element’s full state',
    description: [
      'Return the full state envelope of the element identified by ref or selector:',
      '{ visible, enabled, disabled, checked, selected, expanded, pressed, focused, readonly, required, invalid, busy }',
      'plus its role and name. One call answers "is this clickable / checked / focused".',
      'Returns: { ok, session_id, ref, role, name, state }. Errors: REF_NOT_FOUND / SELECTOR_NO_MATCH',
      '(carries similar_refs), TRANSPORT_UNSUPPORTED, NOT_RUNNING, BAD_ARGUMENT (invalid selector or',
      'ref+selector both/neither).',
    ].join(' '),
    inputSchema: z.object({ ref: refField, selector: selectorField, sessionId: sessionIdField }),
    operationType: 'query',
    handler: (args, ctx) =>
      runTargetedRead(
        ctx,
        args,
        (selector) => ({
          body: buildProbeBody(loadBundle()),
          arg: { mode: 'element', selector },
        }),
        (raw: ReadRaw) => ({
          ref: raw['ref'] ?? null,
          role: raw['role'] ?? null,
          name: raw['name'] ?? '',
          state: raw['state'] ?? null,
        }),
      ),
  })
}

/** The default `electron_get_state` tool registered by the server. */
export const getStateTool: AnyToolDefinition = makeGetStateTool()
