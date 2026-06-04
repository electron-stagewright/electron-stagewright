/**
 * `electron_wait_for_selector` — wait until an element (by `ref` or CSS
 * `selector`) reaches a DOM state: attached, visible, hidden, or detached.
 *
 * @module
 */

import { z } from 'zod'

import { refField, selectorField, sessionIdField } from '../schema.js'
import { resolveTarget } from '../target.js'
import { type AnyToolDefinition, defineTool } from '../types.js'
import { buildWaitForSelectorBody } from './body.js'
import { type WaitRaw, clampWaitTimeout, runWait } from './poll.js'

const timeoutField = z
  .number()
  .int()
  .nonnegative()
  .optional()
  .describe('Max wait in ms (default 5000, clamped to 60000).')

/** `electron_wait_for_selector` — wait for a selector to reach the requested state. */
export const waitForSelectorTool: AnyToolDefinition = defineTool({
  name: 'electron_wait_for_selector',
  title: 'Wait for a selector state',
  description: [
    'Wait until the element identified by ref or selector reaches state:',
    'attached (in the DOM), visible (laid out + not visibility:hidden), hidden (absent or not visible),',
    'or detached (removed). Default state: visible. For an intentionally offscreen / aria-hidden element',
    "(e.g. a code editor's hidden textarea like Monaco), wait for state:'attached' — state:'visible'",
    'will time out because the element is never laid out. Returns: { ok, session_id, matched, state }.',
    'Errors: WAIT_TIMEOUT (condition not met within timeoutMs; retryable — for offscreen editor inputs',
    "use state:'attached'), REF_NOT_FOUND (stale ref; carries similar_refs), TRANSPORT_UNSUPPORTED,",
    'NOT_RUNNING, BAD_ARGUMENT (invalid selector, or ref+selector both/neither).',
  ].join(' '),
  inputSchema: z.object({
    ref: refField,
    selector: selectorField,
    state: z
      .enum(['attached', 'visible', 'hidden', 'detached'])
      .default('visible')
      .describe('Target state to wait for. Default visible.'),
    timeoutMs: timeoutField,
    sessionId: sessionIdField,
  }),
  operationType: 'query',
  handler: (args, ctx) => {
    const selector = resolveTarget(args)
    const timeoutMs = clampWaitTimeout(args.timeoutMs)
    const { state } = args
    return runWait(
      ctx,
      args,
      { body: buildWaitForSelectorBody(), arg: { selector, state, timeoutMs } },
      (_raw: WaitRaw) => ({ matched: true, state }),
      { timeoutMessage: `Selector did not reach state "${state}" within ${timeoutMs}ms.` },
    )
  },
})
