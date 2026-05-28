/**
 * State extraction — derives the `SnapshotState` envelope for a DOM element.
 *
 * The state shape is documented in `schema.ts`. Every flag is always present:
 * `null` when the flag does not apply to the entry's role; `true` / `false`
 * when it does. Agents can read `state.disabled === true` and
 * `state.checked === false` without defensive `?.` access.
 *
 * Layout-sensitive checks (`state.visible` via computed styles) compensate for
 * jsdom limitations: when computed style data is unavailable the walker treats
 * the element as visible rather than asserting either way. Real Chromium runs
 * (when the snapshot tool lands) supply true values.
 *
 * @module
 */

import type { SnapshotRole, SnapshotState } from './schema.js'

/** Roles that carry a `checked` state. */
const CHECKED_ROLES = new Set<SnapshotRole>([
  'checkbox',
  'radio',
  'menuitemcheckbox',
  'menuitemradio',
  'switch',
])

/** Roles that carry a `selected` state. */
const SELECTED_ROLES = new Set<SnapshotRole>(['option', 'tab', 'treeitem'])

/** Roles that carry an `expanded` state. */
const EXPANDED_ROLES = new Set<SnapshotRole>([
  'button',
  'combobox',
  'listbox',
  'menu',
  'menubar',
  'menuitem',
  'tree',
  'treeitem',
])

/** Roles that carry a `pressed` state (toggle buttons). */
const PRESSED_ROLES = new Set<SnapshotRole>(['button'])

/** Roles that carry a `readonly` state. */
const READONLY_ROLES = new Set<SnapshotRole>([
  'textbox',
  'searchbox',
  'combobox',
  'spinbutton',
  'slider',
])

/** Roles that carry a `required` state. */
const REQUIRED_ROLES = new Set<SnapshotRole>([
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'spinbutton',
  'radio',
  'checkbox',
])

/** Roles that carry a validity state (`invalid`). */
const INVALID_ROLES = new Set<SnapshotRole>([
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'spinbutton',
  'radio',
  'checkbox',
  'form',
])

/**
 * Compute the full state envelope for an element. Caller supplies the resolved
 * role so this module does not duplicate role resolution.
 */
export function extractState(element: Element, role: SnapshotRole): SnapshotState {
  return {
    visible: isVisible(element),
    disabled: isDisabled(element),
    checked: CHECKED_ROLES.has(role) ? readBooleanAttr(element, ['checked', 'aria-checked']) : null,
    selected: SELECTED_ROLES.has(role)
      ? readBooleanAttr(element, ['aria-selected', 'selected'])
      : null,
    expanded: EXPANDED_ROLES.has(role) ? readExpanded(element) : null,
    pressed: PRESSED_ROLES.has(role) ? readPressed(element) : null,
    focused: isFocused(element),
    readonly: READONLY_ROLES.has(role)
      ? readBooleanAttr(element, ['readonly', 'aria-readonly'])
      : null,
    required: REQUIRED_ROLES.has(role)
      ? readBooleanAttr(element, ['required', 'aria-required'])
      : null,
    invalid: INVALID_ROLES.has(role) ? readBooleanAttr(element, ['aria-invalid']) : null,
    busy: readBooleanAttr(element, ['aria-busy']) === true,
    shadow_closed: false,
  }
}

/**
 * Visibility walks up the ancestor chain: an element is considered visible only
 * if it AND every ancestor pass the visibility checks. Compensates for jsdom's
 * lack of cascade-aware computed styles by inspecting inline `display` /
 * `visibility` directly, plus `hidden` attribute and `aria-hidden`.
 */
export function isVisible(element: Element): boolean {
  let current: Element | null = element
  while (current !== null) {
    if (isElementSelfHidden(current)) return false
    current = current.parentElement
  }
  return true
}

function isElementSelfHidden(element: Element): boolean {
  if (element.hasAttribute('hidden')) return true
  if (element.getAttribute('aria-hidden') === 'true') return true
  // Inline style inspection — works in jsdom without layout support.
  const inlineStyle = (element as { style?: CSSStyleDeclaration }).style
  if (inlineStyle !== undefined) {
    if (inlineStyle.display === 'none') return true
    if (inlineStyle.visibility === 'hidden') return true
  }
  // Computed style inspection — available in Chromium and partially in jsdom.
  // Treat absent computed styles as "not hidden" rather than asserting.
  const ownerDocument = element.ownerDocument
  const view = ownerDocument?.defaultView
  if (view !== undefined && view !== null && typeof view.getComputedStyle === 'function') {
    try {
      const computed = view.getComputedStyle(element)
      if (computed.display === 'none') return true
      if (computed.visibility === 'hidden') return true
    } catch {
      // Some jsdom configurations throw on getComputedStyle; treat as not hidden.
    }
  }
  return false
}

/**
 * Disabled state walks up the ancestor chain for `<fieldset disabled>` and
 * also checks the form-control `disabled` attribute plus `aria-disabled`.
 */
export function isDisabled(element: Element): boolean {
  if ((element as { disabled?: boolean }).disabled === true) return true
  if (element.getAttribute('aria-disabled') === 'true') return true
  let current: Element | null = element.parentElement
  while (current !== null) {
    if (
      current.tagName.toLowerCase() === 'fieldset' &&
      (current as { disabled?: boolean }).disabled === true
    ) {
      return true
    }
    current = current.parentElement
  }
  return false
}

function isFocused(element: Element): boolean {
  const doc = element.ownerDocument
  if (doc === null) return false
  return doc.activeElement === element
}

function readBooleanAttr(element: Element, attrs: readonly string[]): boolean {
  for (const attr of attrs) {
    if (attr.startsWith('aria-')) {
      // ARIA boolean attributes always use the string `"true"` / `"false"`
      // and have no matching DOM property to consult.
      if (element.hasAttribute(attr)) {
        const value = element.getAttribute(attr)
        if (value === 'true') return true
        if (value === 'false') return false
        return true
      }
      continue
    }
    // HTML boolean attributes (`checked`, `disabled`, `selected`, `readonly`,
    // `required`): the ATTRIBUTE represents the default state, the PROPERTY
    // represents the current state. When JS mutates the property after the
    // initial render (`el.checked = false`), the attribute stays but the
    // property reflects reality. Prefer the property; fall back to the
    // attribute only when the element lacks the typed property entirely.
    const prop = (element as unknown as Record<string, unknown>)[attr]
    if (typeof prop === 'boolean') return prop
    if (element.hasAttribute(attr)) {
      const value = element.getAttribute(attr)
      if (value === 'true') return true
      if (value === 'false') return false
      // HTML legacy boolean: presence is true.
      return true
    }
  }
  return false
}

function readExpanded(element: Element): boolean | null {
  const ariaExpanded = element.getAttribute('aria-expanded')
  if (ariaExpanded === 'true') return true
  if (ariaExpanded === 'false') return false
  const tag = element.tagName.toLowerCase()
  // <details> uses the `open` attribute instead of aria-expanded.
  if (tag === 'details') {
    return element.hasAttribute('open')
  }
  // <summary> inherits its expanded state from the parent <details>.open.
  // The walker emits the summary (not the details) as the button entry.
  if (tag === 'summary') {
    const parent = element.parentElement
    if (parent !== null && parent.tagName.toLowerCase() === 'details') {
      return parent.hasAttribute('open')
    }
  }
  return null
}

function readPressed(element: Element): boolean | null {
  const ariaPressed = element.getAttribute('aria-pressed')
  if (ariaPressed === 'true') return true
  if (ariaPressed === 'false') return false
  if (ariaPressed === 'mixed') return null
  // No aria-pressed on a button means it is NOT a toggle button — pressed is
  // not applicable.
  return null
}
