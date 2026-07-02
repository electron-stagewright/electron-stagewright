/**
 * CDP interaction synthesis — the helpers behind `CdpSession`'s interaction
 * surface (`supportsInteraction: true` on attach sessions, per ADR-003):
 *
 * - **Pointer input** goes through `Input.dispatchMouseEvent` at the target
 *   element's centre, resolved (plus scrolled into view) by a renderer eval
 *   with a LIGHT actionability check: missing → `SELECTOR_NO_MATCH`,
 *   zero-size/hidden → `ELEMENT_NOT_VISIBLE` (retryable), disabled →
 *   `ELEMENT_DISABLED`; `force` bypasses the visibility/disabled checks the
 *   way Playwright's force does.
 * - **Keyboard input** goes through `Input.dispatchKeyEvent` with a deliberately
 *   compact chord parser (modifiers + named keys + single characters). An
 *   unmapped key is an explicit `BAD_ARGUMENT`, never a silent no-op.
 * - **Value-setting operations** (`fill`, `selectOption`) are renderer evals
 *   that use the native value setter and fire `input`/`change`, since their
 *   semantic is "set state", not "synthesise hardware events".
 *
 * Known deviations from the Playwright transport, by design: no auto-waiting
 * actionability retry (a not-yet-visible element fails retryably instead of
 * being awaited), and `typeText` emits keyDown/keyUp per character without
 * OS-level key repeat semantics.
 *
 * @module
 */

import { StagewrightError } from '../errors/registry.js'

/** Modifier bit values per the CDP `Input` domain. */
const MODIFIER_BITS: Readonly<Record<string, number>> = {
  alt: 1,
  option: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8,
}

/** Modifier mask for ctrl/meta — the modifiers that suppress text insertion. */
const TEXT_SUPPRESSING_MODIFIERS = 2 | 4

/**
 * One parsed key chord, ready for `Input.dispatchKeyEvent`. `text` is present
 * only when the key press should insert text (printable key, no ctrl/meta).
 */
export interface ParsedKey {
  readonly key: string
  readonly code: string
  readonly windowsVirtualKeyCode: number
  readonly modifiers: number
  readonly text?: string
}

/** Named (non-printable or aliased) keys the chord parser understands. */
const NAMED_KEYS: Readonly<
  Record<string, { key: string; code: string; keyCode: number; text?: string }>
> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
}

/**
 * Parse a Playwright-style chord (`'Enter'`, `'Control+A'`, `'Meta+Shift+Z'`)
 * into a CDP key event description. Throws `BAD_ARGUMENT` for modifiers or
 * keys outside the supported set so a typo fails loudly.
 */
export function parseKeyChord(chord: string): ParsedKey {
  const parts = chord.split('+')
  // A trailing literal `+` (bare `'+'`, or `'Control++'`) splits to an empty final
  // segment; the real key is that `+`. Recover it so the CDP transport accepts `+`
  // like the Playwright transport does, instead of rejecting it as "no key".
  let keyPart = parts.pop() ?? ''
  if (keyPart === '' && parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop()
    keyPart = '+'
  }
  if (keyPart === '') {
    throw new StagewrightError('BAD_ARGUMENT', `Key chord "${chord}" has no key.`, { chord })
  }
  let modifiers = 0
  for (const part of parts) {
    const bit = MODIFIER_BITS[part.toLowerCase()]
    if (bit === undefined) {
      throw new StagewrightError('BAD_ARGUMENT', `Unsupported modifier "${part}" in "${chord}".`, {
        chord,
        modifier: part,
      })
    }
    modifiers |= bit
  }
  const suppressText = (modifiers & TEXT_SUPPRESSING_MODIFIERS) !== 0

  const named = NAMED_KEYS[keyPart.toLowerCase()]
  if (named !== undefined) {
    const text = suppressText ? undefined : named.text
    return {
      key: named.key,
      code: named.code,
      windowsVirtualKeyCode: named.keyCode,
      modifiers,
      ...(text !== undefined ? { text } : {}),
    }
  }
  if ([...keyPart].length === 1) {
    const ch = keyPart
    const upper = ch.toUpperCase()
    const isLetter = /^[a-zA-Z]$/.test(ch)
    const isDigit = /^[0-9]$/.test(ch)
    const code = isLetter ? `Key${upper}` : isDigit ? `Digit${ch}` : ''
    const keyCode = isLetter || isDigit ? upper.charCodeAt(0) : ch.charCodeAt(0)
    const effectiveKey = (modifiers & 8) !== 0 && isLetter ? upper : ch
    return {
      key: effectiveKey,
      code,
      windowsVirtualKeyCode: keyCode,
      modifiers,
      ...(suppressText ? {} : { text: effectiveKey }),
    }
  }
  throw new StagewrightError(
    'BAD_ARGUMENT',
    `Unsupported key "${keyPart}" for the CDP transport (named keys: ${Object.keys(NAMED_KEYS).join(', ')}, or a single character).`,
    { chord, key: keyPart },
  )
}

/** Result of {@link RESOLVE_POINT_BODY}. */
export interface ResolvedPoint {
  readonly status: 'ok' | 'no-match' | 'bad-selector'
  readonly x?: number
  readonly y?: number
  readonly visible?: boolean
  readonly disabled?: boolean
}

/**
 * Renderer body: resolve a selector to its centre point with a light
 * actionability snapshot (visible + disabled), scrolling it into view first
 * so the synthesized pointer event lands inside the viewport.
 */
export const RESOLVE_POINT_BODY = `
let el = null;
try {
  el = document.querySelector(String(arg.selector));
} catch {
  return { status: 'bad-selector' };
}
if (el === null) return { status: 'no-match' };
if (typeof el.scrollIntoView === 'function') {
  try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
}
const rect = el.getBoundingClientRect();
const style = window.getComputedStyle(el);
const visible =
  rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
return {
  status: 'ok',
  x: rect.x + rect.width / 2,
  y: rect.y + rect.height / 2,
  visible,
  disabled,
};
`

/** Renderer body: focus a selector (focus tolerates offscreen/hidden elements). */
export const FOCUS_BODY = `
let el = null;
try {
  el = document.querySelector(String(arg.selector));
} catch {
  return { status: 'bad-selector' };
}
if (el === null) return { status: 'no-match' };
try { el.focus(); } catch {}
return { status: 'ok' };
`

/**
 * Renderer body: set an input/textarea/contenteditable value through the
 * native setter (so framework value-tracking sees it) and fire input/change.
 */
export const FILL_BODY = `
let el = null;
try {
  el = document.querySelector(String(arg.selector));
} catch {
  return { status: 'bad-selector' };
}
if (el === null) return { status: 'no-match' };
if (el.disabled === true) return { status: 'disabled' };
el.focus();
if ('value' in el) {
  const proto = Object.getPrototypeOf(el);
  const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : undefined;
  if (desc && typeof desc.set === 'function') desc.set.call(el, String(arg.value));
  else el.value = String(arg.value);
} else if (el.isContentEditable) {
  el.textContent = String(arg.value);
} else {
  return { status: 'not-editable' };
}
el.dispatchEvent(new Event('input', { bubbles: true }));
el.dispatchEvent(new Event('change', { bubbles: true }));
return { status: 'ok' };
`

/** Renderer body: select option(s) by value in a <select> and fire input/change. */
export const SELECT_OPTION_BODY = `
let el = null;
try {
  el = document.querySelector(String(arg.selector));
} catch {
  return { status: 'bad-selector' };
}
if (el === null) return { status: 'no-match' };
if (!el.options) return { status: 'not-select' };
if (el.disabled === true) return { status: 'disabled' };
const wanted = Array.from(new Set(arg.values.map(String)));
const available = Array.from(el.options).map((option) => option.value);
const missing = wanted.filter((value) => available.indexOf(value) === -1);
if (missing.length > 0) return { status: 'option-missing', selected: [], missing };
const selected = [];
for (const option of el.options) {
  option.selected = wanted.indexOf(option.value) !== -1;
}
const selectedOptions = el.selectedOptions ? Array.from(el.selectedOptions) : Array.from(el.options).filter((option) => option.selected);
for (const option of selectedOptions) selected.push(option.value);
el.dispatchEvent(new Event('input', { bubbles: true }));
el.dispatchEvent(new Event('change', { bubbles: true }));
return { status: 'ok', selected };
`

/** Renderer body: read a checkbox/radio's live checked + disabled state. */
export const CHECKED_STATE_BODY = `
let el = null;
try {
  el = document.querySelector(String(arg.selector));
} catch {
  return { status: 'bad-selector' };
}
if (el === null) return { status: 'no-match' };
return { status: 'ok', checked: el.checked === true, disabled: el.disabled === true };
`

/** Renderer body: the viewport centre, for selector-less wheel scrolling. */
export const VIEWPORT_CENTER_BODY = `
return { x: Math.floor(window.innerWidth / 2), y: Math.floor(window.innerHeight / 2) };
`

/** Map a renderer-body failure status onto the registered error for `selector`. */
export function statusToError(status: string, selector: string): StagewrightError {
  if (status === 'no-match') {
    return new StagewrightError('SELECTOR_NO_MATCH', `"${selector}" matched no element.`, {
      selector,
    })
  }
  if (status === 'disabled') {
    return new StagewrightError('ELEMENT_DISABLED', `"${selector}" is disabled.`, { selector })
  }
  if (status === 'option-missing') {
    return new StagewrightError(
      'BAD_ARGUMENT',
      `"${selector}" does not contain every requested option value.`,
      { selector, status },
    )
  }
  if (status === 'not-select' || status === 'not-editable') {
    return new StagewrightError(
      'BAD_ARGUMENT',
      `"${selector}" is not the right kind of element for this operation (${status}).`,
      { selector, status },
    )
  }
  return new StagewrightError('BAD_ARGUMENT', `Invalid selector: ${selector}`, { selector })
}
