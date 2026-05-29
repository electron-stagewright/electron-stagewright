/**
 * Scroll interaction tools: `electron_scroll` (wheel by delta, or an element
 * into view) and `electron_scroll_into_view` (a thin always-targeted alias for
 * the common "bring this element into view" case, for electron-driver parity).
 *
 * @module
 */

import { z } from 'zod'

import type { ScrollOptions } from '../../transports/index.js'
import { type AnyToolDefinition, defineTool } from '../types.js'
import { refField, selectorField, sessionIdField, timeoutField } from './schema.js'
import {
  resolveActionOptions,
  resolveOptionalTarget,
  runInteraction,
  runTargetedInteraction,
} from './target.js'

/** `electron_scroll` — scroll an element into view (ref/selector) or the page by a wheel delta. */
export const scrollTool: AnyToolDefinition = defineTool({
  name: 'electron_scroll',
  title: 'Scroll the page or an element into view',
  description: [
    'Scroll: with ref/selector, centre that element into view; otherwise dispatch a wheel delta (dx/dy).',
    'Options: timeoutMs. Returns: { ok, session_id, target } (into-view) or { ok, session_id, dx, dy } (wheel).',
    'Errors: SELECTOR_NO_MATCH / REF_NOT_FOUND (no element matched the selector; carries similar_refs),',
    'NOT_RUNNING, BAD_ARGUMENT (ref+selector both).',
  ].join(' '),
  inputSchema: z.object({
    ref: refField,
    selector: selectorField,
    dx: z
      .number()
      .optional()
      .describe('Horizontal wheel delta in CSS px (used when no ref/selector).'),
    dy: z
      .number()
      .optional()
      .describe('Vertical wheel delta in CSS px (used when no ref/selector).'),
    timeoutMs: timeoutField,
    sessionId: sessionIdField,
  }),
  operationType: 'command',
  handler: (args, ctx) =>
    runInteraction(ctx, args, async (session) => {
      const selector = resolveOptionalTarget(args)
      const { timeoutMs } = resolveActionOptions(args)
      const scrollOpts: ScrollOptions = {
        ...(selector !== undefined ? { selector } : {}),
        ...(args.dx !== undefined ? { dx: args.dx } : {}),
        ...(args.dy !== undefined ? { dy: args.dy } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      }
      await session.scroll(scrollOpts)
      return selector !== undefined ? { target: selector } : { dx: args.dx ?? 0, dy: args.dy ?? 0 }
    }),
})

/** `electron_scroll_into_view` — bring an element into view (always targeted). */
export const scrollIntoViewTool: AnyToolDefinition = defineTool({
  name: 'electron_scroll_into_view',
  title: 'Scroll an element into view',
  description: [
    'Centre the element identified by ref or selector into the viewport. Options: timeoutMs.',
    'Returns: { ok, session_id, target }. Errors: SELECTOR_NO_MATCH / REF_NOT_FOUND (carries similar_refs),',
    'NOT_RUNNING, BAD_ARGUMENT (ref+selector both/neither).',
  ].join(' '),
  inputSchema: z.object({
    ref: refField,
    selector: selectorField,
    timeoutMs: timeoutField,
    sessionId: sessionIdField,
  }),
  operationType: 'command',
  handler: (args, ctx) =>
    runTargetedInteraction(ctx, args, async (session, selector, opts) => {
      await session.scroll({
        selector,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      })
      return { target: selector }
    }),
})
