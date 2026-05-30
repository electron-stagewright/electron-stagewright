/**
 * `electron_wait_for_state` — the composable wait: poll an element (by `ref` or
 * `selector`) until every flag in a desired state object matches its live state,
 * evaluated atomically in the renderer via the snapshot probe. On timeout it
 * reports the last observed state so the agent sees which flag never matched.
 *
 * @module
 */

import { z } from 'zod'

import { refField, selectorField, sessionIdField } from '../schema.js'
import { loadInjectedWalker } from '../snapshot/inject.js'
import { resolveTarget } from '../target.js'
import { type AnyToolDefinition, defineTool } from '../types.js'
import { buildWaitForStateBody } from './body.js'
import { type WaitRaw, clampWaitTimeout, runWait } from './poll.js'

/** Dependency seam — injected by tests so the bundle is not read from disk. */
export interface WaitForStateDeps {
  /** Loader for the bundled walker/probe IIFE. Defaults to reading the built artifact. */
  readonly loadBundle?: () => string
}

/**
 * Desired state predicate — a subset of the snapshot state envelope. At least one
 * flag must be supplied; the wait resolves when every supplied flag matches.
 */
const stateWant = z
  .object({
    visible: z.boolean().optional(),
    enabled: z.boolean().optional(),
    disabled: z.boolean().optional(),
    checked: z.boolean().optional(),
    selected: z.boolean().optional(),
    expanded: z.boolean().optional(),
    pressed: z.boolean().optional(),
    focused: z.boolean().optional(),
    readonly: z.boolean().optional(),
    required: z.boolean().optional(),
    invalid: z.boolean().optional(),
    busy: z.boolean().optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, {
    message: 'Provide at least one state flag to wait for.',
  })

const timeoutField = z
  .number()
  .int()
  .nonnegative()
  .optional()
  .describe('Max wait in ms (default 5000, clamped to 60000).')

/** Build `electron_wait_for_state`. */
export function makeWaitForStateTool(deps: WaitForStateDeps = {}): AnyToolDefinition {
  const loadBundle = deps.loadBundle ?? loadInjectedWalker
  return defineTool({
    name: 'electron_wait_for_state',
    title: 'Wait for an element state',
    description: [
      'Wait until the element identified by ref or selector matches the given state flags',
      '(any of visible, enabled, disabled, checked, selected, expanded, pressed, focused, readonly, required,',
      'invalid, busy), evaluated atomically. Returns: { ok, session_id, matched, state }.',
      'Errors: WAIT_TIMEOUT (state not reached within timeoutMs — details.last_state shows the last',
      'observed state; retryable), REF_NOT_FOUND (stale ref; carries similar_refs),',
      'TRANSPORT_UNSUPPORTED, NOT_RUNNING, BAD_ARGUMENT (invalid selector, no state flags, or',
      'ref+selector both/neither).',
    ].join(' '),
    inputSchema: z.object({
      ref: refField,
      selector: selectorField,
      state: stateWant,
      timeoutMs: timeoutField,
      sessionId: sessionIdField,
    }),
    operationType: 'query',
    handler: (args, ctx) => {
      const selector = resolveTarget(args)
      const timeoutMs = clampWaitTimeout(args.timeoutMs)
      return runWait(
        ctx,
        args,
        {
          body: buildWaitForStateBody(loadBundle()),
          arg: { selector, want: args.state, timeoutMs },
        },
        (raw: WaitRaw) => ({ matched: true, state: raw.state ?? null }),
        { timeoutMessage: `Element state did not match within ${timeoutMs}ms.` },
      )
    },
  })
}

/** The default `electron_wait_for_state` tool registered by the server. */
export const waitForStateTool: AnyToolDefinition = makeWaitForStateTool()
