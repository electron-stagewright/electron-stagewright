/**
 * Keyboard / text-entry interaction tools: `electron_type` (set a value),
 * `electron_keyboard_type` (real per-character keystrokes), `electron_key`
 * (a single key / chord), `electron_press_sequence` (an ordered list of keys),
 * and `electron_clear_input`.
 *
 * `type` vs `keyboard_type`: `type` sets `.value` and fires one input event (fast,
 * the common case); `keyboard_type` emits a real keystroke per character, for
 * inputs with per-keystroke handlers (autocompletes, search boxes). Code editors
 * whose hidden hosts swallow text should use `electron_type_into_editor`.
 *
 * @module
 */

import process from 'node:process'

import { z } from 'zod'

import { StagewrightError } from '../../errors/registry.js'
import type { PressOptions, TransportSession } from '../../transports/index.js'
import { type AnyToolDefinition, defineTool } from '../types.js'
import { refField, selectorField, sessionIdField, forceField, timeoutField } from './schema.js'
import {
  resolveActionOptions,
  resolveOptionalTarget,
  runInteraction,
  runTargetedInteraction,
} from './target.js'

/** Build {@link PressOptions} (optional focus target + bounded timeout + force) for keyboard tools. */
function pressOptionsFor(args: {
  readonly ref?: number | undefined
  readonly selector?: string | undefined
  readonly force?: boolean | undefined
  readonly timeoutMs?: number | undefined
}): PressOptions {
  const selector = resolveOptionalTarget(args)
  const { force, timeoutMs } = resolveActionOptions(args)
  return {
    ...(selector !== undefined ? { selector } : {}),
    ...(force !== undefined ? { force } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  }
}

/** Short settle delay before checking whether editor text visibly changed. */
const EDITOR_TYPE_SETTLE_MS = 10

/**
 * Cap on a value set in one operation (`electron_type` uses `fill`, a single assignment). Generous
 * — accommodates pasting a large value — while bounding the argument payload.
 */
const MAX_TYPE_TEXT_LENGTH = 100_000

/**
 * Cap on text typed as REAL per-character keystrokes (`electron_keyboard_type`,
 * `electron_type_into_editor`). Each character is a separate transport round-trip, so an unbounded
 * string is an unbounded loop the operation-timeout cannot cancel (it abandons, not cancels). 10k
 * is far beyond any realistic keystroke-by-keystroke entry while bounding that loop.
 */
const MAX_KEYSTROKE_TEXT_LENGTH = 10_000

/** Cap on keys in one press sequence — one transport round-trip per key. Matches the other
 *  collection caps (set_files 20, computed-style 50, discover ports 64). */
const MAX_KEY_SEQUENCE = 100

/** Renderer body returning a visible editor area's text signature, or null if it cannot be read. */
const EDITOR_SIGNATURE_BODY = `
const settleMs = typeof arg.settleMs === 'number' ? arg.settleMs : 0;
if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
let el = null;
try {
  el = document.querySelector(String(arg.selector));
} catch {
  return null;
}
if (el === null) return null;
return typeof el.value === 'string' ? el.value : (el.textContent || '');
`

async function readEditorSignature(
  session: TransportSession,
  selector: string,
  settleMs: number,
): Promise<string | null> {
  const value = await session.evaluate<unknown>('renderer', EDITOR_SIGNATURE_BODY, {
    selector,
    settleMs,
  })
  return typeof value === 'string' ? value : null
}

async function assertEditorTyped(
  session: TransportSession,
  selector: string,
  text: string,
  before: string | null,
): Promise<void> {
  if (text.length === 0) return
  const after = await readEditorSignature(session, selector, EDITOR_TYPE_SETTLE_MS)
  if (after === null) return
  const landed = after !== before || after.includes(text)
  if (!landed) {
    throw new StagewrightError(
      'TYPE_NO_EFFECT',
      `Text did not land in "${selector}": the editor content area did not change.`,
      { selector },
    )
  }
}

async function assertEditorChanged(
  session: TransportSession,
  selector: string,
  before: string | null,
): Promise<void> {
  // If it was already empty, clearing is a no-op but still a correct final state.
  if (before === null || before.length === 0) return
  const after = await readEditorSignature(session, selector, EDITOR_TYPE_SETTLE_MS)
  if (after === null) return
  if (after === before) {
    throw new StagewrightError(
      'TYPE_NO_EFFECT',
      `Clear did not land in "${selector}": the editor content area did not change.`,
      { selector },
    )
  }
}

/** `electron_type` — set the value of an input/textarea (fires one input event). */
export const typeTool: AnyToolDefinition = defineTool({
  name: 'electron_type',
  title: 'Type text into an input',
  description: [
    'Set the value of the input/textarea identified by ref or selector (fires an input event).',
    'For a code editor (Monaco / EditContext, CodeMirror) use electron_type_into_editor — setting',
    '.value on an editor host does not update its model. Options: force, timeoutMs.',
    'Returns: { ok, session_id, target }. Errors: REF_NOT_FOUND / SELECTOR_NO_MATCH (carries similar_refs),',
    'ELEMENT_NOT_VISIBLE (retryable), ELEMENT_DISABLED, TYPE_NO_EFFECT (value did not change — wrong target),',
    'NOT_RUNNING, BAD_ARGUMENT.',
  ].join(' '),
  inputSchema: z.object({
    ref: refField,
    selector: selectorField,
    text: z.string().max(MAX_TYPE_TEXT_LENGTH).describe('The text to set as the element value.'),
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
    'into the active element. For a code editor (Monaco / EditContext), the reliable path is',
    "electron_type_into_editor (it clicks the editor content area, e.g. '.monaco-editor .view-lines',",
    'then types into the focused editor) — do NOT target the hidden textarea, which modern editors',
    'ignore. force:true focuses an offscreen/aria-hidden input but a swallowed keystroke returns',
    'TYPE_NO_EFFECT. Options: force, timeoutMs. Returns: { ok, session_id, typed }.',
    'Errors: SELECTOR_NO_MATCH / REF_NOT_FOUND (carries similar_refs), ELEMENT_NOT_VISIBLE (retryable),',
    'TYPE_NO_EFFECT (typing changed nothing — use electron_type_into_editor), NOT_RUNNING, BAD_ARGUMENT.',
  ].join(' '),
  inputSchema: z.object({
    ref: refField,
    selector: selectorField,
    text: z
      .string()
      .max(MAX_KEYSTROKE_TEXT_LENGTH)
      .describe('The text to type, character by character.'),
    force: forceField,
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

/**
 * The platform's select-all chord. The MCP server always runs on the same host
 * as the Electron app it drives, so `process.platform` is the app's platform.
 */
function selectAllChord(): string {
  return process.platform === 'darwin' ? 'Meta+A' : 'Control+A'
}

/** `electron_type_into_editor` — click an editor's content area, then type into the focused editor. */
export const typeIntoEditorTool: AnyToolDefinition = defineTool({
  name: 'electron_type_into_editor',
  title: 'Type into a code editor',
  description: [
    'Type into a code editor (Monaco / EditContext, CodeMirror, contenteditable) the reliable way:',
    "click the editor's content area identified by ref or selector (e.g. '.monaco-editor .view-lines'),",
    'then type the text into the now-focused editor as real keystrokes. Use this instead of typing into',
    "an editor's hidden textarea, which modern EditContext editors ignore (returns TYPE_NO_EFFECT).",
    'Pass replace:true to REPLACE the editor contents: after the focusing click it selects all',
    '(Meta/Control+A, platform-aware) and types over the selection — no second click that would',
    'collapse the selection; with empty text it clears the editor (select-all + Delete).',
    'Editor auto-pairing caveat: real keystrokes trigger auto-closing of quotes/brackets, so typed',
    "source can gain debris like a trailing }') — type pairing-safe fragments, or use replace:true",
    'and include the full intended contents.',
    'Returns: { ok, session_id, target, typed, replaced }. Errors: REF_NOT_FOUND / SELECTOR_NO_MATCH',
    '(carries similar_refs), ELEMENT_NOT_VISIBLE (retryable), TYPE_NO_EFFECT, NOT_RUNNING, BAD_ARGUMENT.',
  ].join(' '),
  inputSchema: z.object({
    ref: refField,
    selector: selectorField,
    text: z
      .string()
      .max(MAX_KEYSTROKE_TEXT_LENGTH)
      .describe('The text to type into the focused editor.'),
    replace: z
      .boolean()
      .optional()
      .describe('Select all before typing, replacing the editor contents instead of appending.'),
    timeoutMs: timeoutField,
    sessionId: sessionIdField,
  }),
  operationType: 'command',
  handler: (args, ctx) =>
    runTargetedInteraction(ctx, args, async (session, selector, opts) => {
      // Click the visible content area to focus the editor's real input (the path that engages
      // an EditContext editor), then type into the active element with no selector.
      const before = await readEditorSignature(session, selector, 0)
      await session.click(selector, opts)
      if (args.replace === true) {
        // Select all against the ACTIVE element — re-targeting the selector here
        // would click again and collapse the selection (the dogfooded failure
        // this option exists to prevent).
        await session.press(selectAllChord())
        if (args.text.length === 0) {
          // replace with empty text = clear the editor.
          await session.press('Delete')
          await assertEditorChanged(session, selector, before)
          return { target: selector, typed: 0, replaced: true }
        }
      }
      await session.typeText(args.text)
      await assertEditorTyped(session, selector, args.text, before)
      return { target: selector, typed: args.text.length, replaced: args.replace === true }
    }),
})

/** `electron_key` — press a single key or chord, optionally focusing a target first. */
export const keyTool: AnyToolDefinition = defineTool({
  name: 'electron_key',
  title: 'Press a key or chord',
  description: [
    "Press a key or chord (e.g. 'Enter', 'Control+A', 'ArrowDown'). Focuses ref/selector first when given;",
    'otherwise presses against the active element. For editors, click the visible content area first;',
    'reserve force:true for offscreen inputs that truly accept focus. Options: force, timeoutMs.',
    'Returns: { ok, session_id, key }.',
    'Errors: SELECTOR_NO_MATCH / REF_NOT_FOUND (carries similar_refs), ELEMENT_NOT_VISIBLE (retryable),',
    'NOT_RUNNING, BAD_ARGUMENT (ref+selector both).',
  ].join(' '),
  inputSchema: z.object({
    ref: refField,
    selector: selectorField,
    key: z.string().describe("Key or chord, e.g. 'Enter' or 'Control+A'."),
    force: forceField,
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
    'first when given. For editors, click the visible content area first; reserve force:true for',
    'offscreen inputs that truly accept focus.',
    'Options: force, timeoutMs. Returns: { ok, session_id, keys }.',
    'Errors: SELECTOR_NO_MATCH / REF_NOT_FOUND (carries similar_refs), ELEMENT_NOT_VISIBLE (retryable),',
    'NOT_RUNNING, BAD_ARGUMENT (empty keys or ref+selector both).',
  ].join(' '),
  inputSchema: z.object({
    ref: refField,
    selector: selectorField,
    keys: z
      .array(z.string())
      .min(1)
      .max(MAX_KEY_SEQUENCE)
      .describe('Ordered keys/chords to press.'),
    force: forceField,
    timeoutMs: timeoutField,
    sessionId: sessionIdField,
  }),
  operationType: 'command',
  handler: (args, ctx) =>
    runInteraction(ctx, args, async (session) => {
      const opts = pressOptionsFor(args)
      // When forcing focus on an offscreen selector, focus ONCE via the first
      // key, then press the rest against the active element. Re-focusing the selector
      // between keys would fight editors that move focus to a transient popup mid-sequence
      // (e.g. an autocomplete list opened by the first key). Non-force sequences keep their
      // per-key page.press(selector) behaviour unchanged.
      const focusOncePerSequence = opts.selector !== undefined && opts.force === true
      let pressed = 0
      for (const key of args.keys) {
        await session.press(key, focusOncePerSequence && pressed > 0 ? {} : opts)
        pressed += 1
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
