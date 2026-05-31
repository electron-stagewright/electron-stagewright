/**
 * `electron_expect_state` — assert an element matches a composite state predicate
 * (visible / enabled / checked / …), polling atomically until it holds or the
 * budget elapses (ADR-007 Principle 8). Same predicate shape as `wait_for_state`,
 * but framed as an assertion: returns `{ matched }` and fails as
 * `EXPECTATION_FAILED` with the last observed state.
 *
 * @module
 */

import { z } from 'zod'

import { refField, selectorField, sessionIdField } from '../schema.js'
import { loadInjectedWalker } from '../snapshot/inject.js'
import { resolveTarget } from '../target.js'
import { type AnyToolDefinition, defineTool } from '../types.js'
import { buildWaitForStateBody } from '../wait/body.js'
import { type WaitRaw, clampWaitTimeout, runWait } from '../wait/poll.js'
import { stateWant } from '../wait/state.js'
import { expectTimeoutField } from './match.js'

/** Dependency seam — injected by tests so the probe bundle is not read from disk. */
export interface ExpectStateDeps {
  /** Loader for the bundled walker/probe IIFE. Defaults to reading the built artifact. */
  readonly loadBundle?: () => string
}

/** Build `electron_expect_state`. */
export function makeExpectStateTool(deps: ExpectStateDeps = {}): AnyToolDefinition {
  const loadBundle = deps.loadBundle ?? loadInjectedWalker
  return defineTool({
    name: 'electron_expect_state',
    title: 'Expect an element state',
    description: [
      'Assert the element identified by ref or selector matches the given state flags (any of visible,',
      'enabled, disabled, checked, selected, expanded, pressed, focused, readonly, required, invalid, busy),',
      'evaluated atomically and polled until they hold or timeoutMs elapses. Returns: { ok, session_id, matched, state }.',
      'Errors: EXPECTATION_FAILED (state not reached within timeoutMs — details carry expected + the last',
      'observed actual state; retryable), REF_NOT_FOUND (stale ref; carries similar_refs),',
      'TRANSPORT_UNSUPPORTED, NOT_RUNNING, BAD_ARGUMENT (invalid selector, no state flags, or ref+selector both/neither).',
    ].join(' '),
    inputSchema: z.object({
      ref: refField,
      selector: selectorField,
      state: stateWant,
      timeoutMs: expectTimeoutField,
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
        {
          timeoutMessage: `Element state did not match within ${timeoutMs}ms.`,
          timeoutCode: 'EXPECTATION_FAILED',
          buildTimeoutDetails: (raw: WaitRaw) => ({
            expected: args.state,
            actual: raw.state ?? null,
          }),
        },
      )
    },
  })
}

/** The default `electron_expect_state` tool registered by the server. */
export const expectStateTool: AnyToolDefinition = makeExpectStateTool()
