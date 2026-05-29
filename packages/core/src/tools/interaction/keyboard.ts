/**
 * Keyboard / text-entry interaction tools: `electron_type` (set a value),
 * `electron_keyboard_type` (real per-character keystrokes), `electron_key`
 * (a single key / chord), `electron_press_sequence` (an ordered list of keys),
 * and `electron_clear_input`.
 *
 * `type` vs `keyboard_type`: `type` sets `.value` and fires one input event (fast,
 * the common case); `keyboard_type` emits a real keystroke per character, for
 * inputs with per-keystroke handlers (editors, autocompletes).
 *
 * @module
 */

import { z } from 'zod'

import type { PressOptions } from '../../transports/index.js'
import { type AnyToolDefinition, defineTool } from '../types.js'
import { refField, selectorField, sessionIdField, forceField, timeoutField } from './schema.js'
import {
  resolveActionOptions,
  resolveOptionalTarget,
  runInteraction,
  runTargetedInteraction,
} from './target.js'

/** Build {@link PressOptions} (optional focus target + bounded timeout) for keyboard tools. */
function pressOptionsFor(args: {
  readonly ref?: number | undefined
  readonly selector?: string | undefined
  readonly timeoutMs?: number | undefined
}): PressOptions {
  const selector = resolveOptionalTarget(args)
  const { timeoutMs } = resolveActionOptions(args)
  return {
    ...(selector !== undefined ? { selector } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  }
}

/** `electron_type` — set the value of an input/textarea (fires one input event). */
export const typeTool: AnyToolDefinition = defineTool({
  name: 'electron_type',
  title: 'Type text into an input',
  description: [
    'Set the value of the input/textarea identified by ref or selector (fires an input event).',
    'For inputs with per-keystroke handlers use electron_keyboard_type instead. Options: force, timeoutMs.',
    'Returns: { ok, session_id, target }. Errors: REF_NOT_FOUND / SELECTOR_NO_MATCH (carries similar_refs),',
    'ELEMENT_NOT_VISIBLE (retryable), ELEMENT_DISABLED, NOT_RUNNING, BAD_ARGUMENT.',
  ].join(' '),
  inputSchema: z.object({
    ref: refField,
    selector: selectorField,
    text: z.string().describe('The text to set as the element value.'),
    force: forceField,
    timeoutMs: timeoutField,
    sessionId: sessionIdField,
  }),
  operationType: 'command',
  handler: (args, ctx) =>
    runTargetedInteraction(ctx, args, async (session, selector, opts) => {
      await session.fill(selector, args.text, opts)
      return { target: selector }
    }),
})

/** `electron_keyboard_type` — type text as real per-character keystrokes. */
export const keyboardTypeTool: AnyToolDefinition = defineTool({
  name: 'electron_keyboard_type',
  title: 'Type text as real keystrokes',
  description: [
    'Type text as real per-character keystrokes (fires keydown/keypress/input/keyup per char), unlike',
    'electron_type which sets the value directly. Focuses ref/selector first when given; otherwise types',
    'into the active element. Options: timeoutMs. Returns: { ok, session_id, typed }.',
    'Errors: SELECTOR_NO_MATCH / REF_NOT_FOUND (carries similar_refs), ELEMENT_NOT_VISIBLE (retryable),',
    'NOT_RUNNING, BAD_ARGUMENT (ref+selector both).',
  ].join(' '),
  inputSchema: z.object({
    ref: refField,
    selector: selectorField,
    text: z.string().describe('The text to type, character by character.'),
    timeoutMs: timeoutField,
    sessionId: sessionIdField,
  }),
  operationType: 'command',
  handler: (args, ctx) =>
    runInteraction(ctx, args, async (session) => {
      await session.typeText(args.text, pressOptionsFor(args))
      return { typed: args.text.length }
    }),
})

/** `electron_key` — press a single key or chord, optionally focusing a target first. */
export const keyTool: AnyToolDefinition = defineTool({
  name: 'electron_key',
  title: 'Press a key or chord',
  description: [
    "Press a key or chord (e.g. 'Enter', 'Control+A', 'ArrowDown'). Focuses ref/selector first when given;",
    'otherwise presses against the active element. Options: timeoutMs. Returns: { ok, session_id, key }.',
    'Errors: SELECTOR_NO_MATCH / REF_NOT_FOUND (carries similar_refs), ELEMENT_NOT_VISIBLE (retryable),',
    'NOT_RUNNING, BAD_ARGUMENT (ref+selector both).',
  ].join(' '),
  inputSchema: z.object({
    ref: refField,
    selector: selectorField,
    key: z.string().describe("Key or chord, e.g. 'Enter' or 'Control+A'."),
    timeoutMs: timeoutField,
    sessionId: sessionIdField,
  }),
  operationType: 'command',
  handler: (args, ctx) =>
    runInteraction(ctx, args, async (session) => {
      await session.press(args.key, pressOptionsFor(args))
      return { key: args.key }
    }),
})

/** `electron_press_sequence` — press an ordered list of keys, in order. */
export const pressSequenceTool: AnyToolDefinition = defineTool({
  name: 'electron_press_sequence',
  title: 'Press a sequence of keys',
  description: [
    "Press each key in `keys`, in order (e.g. ['Control+A', 'Delete', 'Enter']). Focuses ref/selector",
    'first when given. Options: timeoutMs. Returns: { ok, session_id, keys }.',
    'Errors: SELECTOR_NO_MATCH / REF_NOT_FOUND (carries similar_refs), ELEMENT_NOT_VISIBLE (retryable),',
    'NOT_RUNNING, BAD_ARGUMENT (empty keys or ref+selector both).',
  ].join(' '),
  inputSchema: z.object({
    ref: refField,
    selector: selectorField,
    keys: z.array(z.string()).min(1).describe('Ordered keys/chords to press.'),
    timeoutMs: timeoutField,
    sessionId: sessionIdField,
  }),
  operationType: 'command',
  handler: (args, ctx) =>
    runInteraction(ctx, args, async (session) => {
      const opts = pressOptionsFor(args)
      for (const key of args.keys) {
        await session.press(key, opts)
      }
      return { keys: args.keys }
    }),
})

/** `electron_clear_input` — clear the value of an input/textarea. */
export const clearInputTool: AnyToolDefinition = defineTool({
  name: 'electron_clear_input',
  title: 'Clear an input',
  description: [
    'Clear the value of the input/textarea identified by ref or selector (sets it to empty).',
    'Options: force, timeoutMs. Returns: { ok, session_id, target, cleared }.',
    'Errors: REF_NOT_FOUND / SELECTOR_NO_MATCH (carries similar_refs), ELEMENT_NOT_VISIBLE (retryable),',
    'ELEMENT_DISABLED, NOT_RUNNING, BAD_ARGUMENT.',
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
      await session.fill(selector, '', opts)
      return { target: selector, cleared: true }
    }),
})
