/**
 * Role resolution — derives the `SnapshotRole` for a DOM element following
 * (a subset of) the HTML AAM (Accessibility API Mappings) rules:
 *
 *   1. If `role` attribute is present and recognised, use it.
 *   2. Otherwise consult the implicit role for the element's tag + type.
 *   3. Else return `'unknown'`.
 *
 * The role allow-list is intentionally pragmatic: covers Electron-app UI
 * patterns and the WAI-ARIA Authoring Practices examples. Adding a new role is
 * additive (no removal without a schema bump).
 *
 * @module
 */

import type { SnapshotRole } from './schema.js'

/** ARIA role strings the walker recognises. Maps onto `SnapshotRole` directly. */
const ARIA_ROLE_ALLOW: ReadonlySet<SnapshotRole> = new Set<SnapshotRole>([
  'button',
  'link',
  'checkbox',
  'radio',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'switch',
  'slider',
  'spinbutton',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'treeitem',
  'menu',
  'menubar',
  'tablist',
  'tree',
  'dialog',
  'alertdialog',
  'main',
  'navigation',
  'banner',
  'contentinfo',
  'complementary',
  'region',
  'search',
  'form',
  'heading',
  'article',
  'text',
  'image',
  'separator',
  'progressbar',
  'status',
  'alert',
])

/**
 * Resolve the accessibility role for an element.
 *
 * Implementation order:
 *  1. Explicit `role` attribute if recognised — wins.
 *  2. HTML implicit role (tag + type-specific).
 *  3. `'unknown'` fallback.
 */
export function resolveRole(element: Element): SnapshotRole {
  const explicit = element.getAttribute('role')
  if (explicit !== null && explicit !== '') {
    // ARIA allows multiple role tokens (space-separated); use the first valid one.
    for (const token of explicit.split(/\s+/)) {
      if (ARIA_ROLE_ALLOW.has(token as SnapshotRole)) {
        return token as SnapshotRole
      }
    }
  }
  return implicitRole(element)
}

function implicitRole(element: Element): SnapshotRole {
  const tag = element.tagName.toLowerCase()
  if (isContentEditable(element) && tag !== 'input' && tag !== 'textarea' && tag !== 'select') {
    return 'textbox'
  }
  switch (tag) {
    case 'button':
      return 'button'
    case 'a':
      return element.hasAttribute('href') ? 'link' : 'unknown'
    case 'input':
      return implicitInputRole(element)
    case 'select':
      return element.hasAttribute('multiple') || asNumberAttr(element, 'size') > 1
        ? 'listbox'
        : 'combobox'
    case 'textarea':
      return 'textbox'
    case 'option':
      return 'option'
    case 'progress':
      return 'progressbar'
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'heading'
    case 'main':
      return 'main'
    case 'nav':
      return 'navigation'
    case 'header':
      // <header> inside <article> / <section> is NOT a landmark per HTML AAM,
      // but this v1 mapper treats it as 'banner' for any top-level header.
      return 'banner'
    case 'footer':
      return 'contentinfo'
    case 'aside':
      return 'complementary'
    case 'section':
      // <section> has role 'region' only when it has an accessible name. The
      // walker emits 'region' unconditionally; agents inspect entry.name to
      // see whether a section is named.
      return 'region'
    case 'form':
      return 'form'
    case 'article':
      return 'article'
    case 'dialog':
      return 'dialog'
    case 'img':
      // <img alt=""> is decorative; treat as unknown so it does not appear as
      // interactive. <img alt="something"> or no alt is 'image'.
      return element.getAttribute('alt') === '' ? 'unknown' : 'image'
    case 'hr':
      return 'separator'
    case 'details':
      // <details> is the disclosure widget container; its <summary> child is
      // the clickable button. Emitting both would double-count the same
      // interaction surface, so the container itself is dropped from the
      // snapshot and only the summary appears as a button.
      return 'unknown'
    case 'summary':
      // <summary> carries the disclosure button. Its expanded state is read
      // from the parent <details>.open attribute by state.ts.
      return 'button'
    default:
      return 'unknown'
  }
}

function implicitInputRole(element: Element): SnapshotRole {
  const type = (element.getAttribute('type') ?? 'text').toLowerCase()
  switch (type) {
    case 'button':
    case 'submit':
    case 'reset':
    case 'image':
      return 'button'
    case 'checkbox':
      return 'checkbox'
    case 'radio':
      return 'radio'
    case 'range':
      return 'slider'
    case 'number':
      return 'spinbutton'
    case 'search':
      return 'searchbox'
    case 'email':
    case 'password':
    case 'tel':
    case 'text':
    case 'url':
    case 'date':
    case 'datetime-local':
    case 'month':
    case 'week':
    case 'time':
      return 'textbox'
    case 'hidden':
      return 'unknown'
    default:
      // Unknown input type — fall back to textbox so the agent can still
      // interact, matching browser fallback behaviour.
      return 'textbox'
  }
}

/**
 * Whether the entry, given its role, should be considered interactive by
 * default. Disabled-but-clickable elements remain interactive: true so the
 * agent SEES them and reads state.disabled.
 */
export function isRoleInteractive(role: SnapshotRole): boolean {
  switch (role) {
    case 'button':
    case 'link':
    case 'checkbox':
    case 'radio':
    case 'textbox':
    case 'searchbox':
    case 'combobox':
    case 'listbox':
    case 'option':
    case 'switch':
    case 'slider':
    case 'spinbutton':
    case 'menuitem':
    case 'menuitemcheckbox':
    case 'menuitemradio':
    case 'tab':
    case 'treeitem':
      return true
    default:
      return false
  }
}

function asNumberAttr(element: Element, attr: string): number {
  const value = element.getAttribute(attr)
  if (value === null) return Number.NaN
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

function isContentEditable(element: Element): boolean {
  const attr = element.getAttribute('contenteditable')
  if (attr === null) return false
  return attr.toLowerCase() !== 'false'
}
