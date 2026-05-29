/**
 * Pointer interaction tools: `electron_click`, `electron_hover`, `electron_drag`.
 * Each resolves a `ref`/`selector` target (drag resolves two) and drives the
 * transport's real-input methods.
 *
 * @module
 */

import { z } from 'zod'

import type { ClickOptions } from '../../transports/index.js'
import { type AnyToolDefinition, defineTool } from '../types.js'
import { refField, selectorField, sessionIdField, forceField, timeoutField } from './schema.js'
import { runDragInteraction, runTargetedInteraction } from './target.js'

/** `electron_click` — click an element, with optional button + multi-click. */
export const clickTool: AnyToolDefinition = defineTool({
  name: 'electron_click',
  title: 'Click an element',
  description: [
    'Click the element identified by ref (from a snapshot) or selector.',
    'Options: button (left|right|middle, default left), clickCount (2 = double-click),',
    'force (bypass actionability), timeoutMs. Returns: { ok, session_id, target }.',
    'Errors: REF_NOT_FOUND / SELECTOR_NO_MATCH (no such element — re-snapshot; not retryable, carries similar_refs),',
    'ELEMENT_NOT_VISIBLE (retryable), ELEMENT_DISABLED (not retryable), NOT_RUNNING, BAD_ARGUMENT (ref+selector both/neither).',
  ].join(' '),
  inputSchema: z.object({
    ref: refField,
    selector: selectorField,
    button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button. Default left.'),
    clickCount: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Number of clicks (2 for a double-click). Default 1.'),
    force: forceField,
    timeoutMs: timeoutField,
    sessionId: sessionIdField,
  }),
  operationType: 'command',
  handler: (args, ctx) =>
    runTargetedInteraction(ctx, args, async (session, selector, opts) => {
      const clickOpts: ClickOptions = {
        ...opts,
        ...(args.button !== undefined ? { button: args.button } : {}),
        ...(args.clickCount !== undefined ? { clickCount: args.clickCount } : {}),
      }
      await session.click(selector, clickOpts)
      return {
        target: selector,
        ...(args.button !== undefined ? { button: args.button } : {}),
        ...(args.clickCount !== undefined ? { clickCount: args.clickCount } : {}),
      }
    }),
})

/** `electron_hover` — move the pointer over an element. */
export const hoverTool: AnyToolDefinition = defineTool({
  name: 'electron_hover',
  title: 'Hover an element',
  description: [
    'Hover the element identified by ref or selector (e.g. to reveal a tooltip or menu).',
    'Options: force, timeoutMs. Returns: { ok, session_id, target }.',
    'Errors: REF_NOT_FOUND / SELECTOR_NO_MATCH (carries similar_refs), ELEMENT_NOT_VISIBLE (retryable),',
    'NOT_RUNNING, BAD_ARGUMENT.',
  ].join(' '),
  inputSchema: z.object({
    ref: refField,
    selector: selectorField,
    force: forceField,
    timeoutMs: timeoutField,
    sessionId: sessionIdField,
  }),
  operationType: 'command',
  handler: (args, ctx) =>
    runTargetedInteraction(ctx, args, async (session, selector, opts) => {
      await session.hover(selector, opts)
      return { target: selector }
    }),
})

/** `electron_drag` — drag a source element onto a target element. */
export const dragTool: AnyToolDefinition = defineTool({
  name: 'electron_drag',
  title: 'Drag one element onto another',
  description: [
    'Drag the source element (ref or selector) onto the target element (targetRef or targetSelector),',
    'using the real mouse API. Options: force, timeoutMs. Returns: { ok, session_id, source, target }.',
    'Errors: SELECTOR_NO_MATCH / REF_NOT_FOUND (carries similar_refs), ELEMENT_NOT_VISIBLE (retryable),',
    'NOT_RUNNING, BAD_ARGUMENT (a side missing or both ref+selector given).',
  ].join(' '),
  inputSchema: z.object({
    ref: refField,
    selector: selectorField,
    targetRef: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Drop-target ref. Provide targetRef OR targetSelector.'),
    targetSelector: z
      .string()
      .optional()
      .describe('Drop-target CSS/text selector. Provide targetRef OR targetSelector.'),
    force: forceField,
    timeoutMs: timeoutField,
    sessionId: sessionIdField,
  }),
  operationType: 'command',
  handler: (args, ctx) => runDragInteraction(ctx, args),
})
