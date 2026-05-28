/**
 * Framework-agnostic snapshot walker. Pure function over a `Document` — no
 * transport coupling, no Electron-specifics. The slice that lands the
 * `snapshot` tool wraps this in `transport.evaluate('renderer', body)`; this
 * module is testable as-is in jsdom.
 *
 * Two-pass design:
 *
 *   1. Pass 1 — collect candidate elements by querying the role allow-list
 *      via a single `querySelectorAll`. Avoids walking every node in the DOM.
 *   2. Pass 2 — enrich each candidate with role resolution, name, state,
 *      bbox, fingerprint.
 *
 * Shadow roots are outside the current document query. The tool layer can add
 * a public shadow-root discovery hook later without changing this entry shape.
 *
 * @module
 */

import { computeAccessibleName } from './accname.js'
import { computeFingerprint } from './fingerprint.js'
import { isRoleInteractive, resolveRole } from './roles.js'
import type { Snapshot, SnapshotBbox, SnapshotEntry, SnapshotMeta, SnapshotRole } from './schema.js'
import { extractState, isVisible } from './state.js'

/**
 * CSS selector covering the role allow-list. Every element matching this
 * selector is a candidate for pass 2; non-matching elements are skipped. The
 * selector intentionally over-collects (e.g. `<div role=...>`) so role
 * resolution in pass 2 has the final say.
 */
const CANDIDATE_SELECTOR = [
  // Interactive form controls
  'button',
  'a[href]',
  'input:not([type=hidden])',
  'select',
  'textarea',
  'option',
  'progress',
  // ARIA-driven interactives — any element carrying a recognised role attribute
  '[role=button]',
  '[role=link]',
  '[role=checkbox]',
  '[role=radio]',
  '[role=textbox]',
  '[role=searchbox]',
  '[role=combobox]',
  '[role=listbox]',
  '[role=option]',
  '[role=switch]',
  '[role=slider]',
  '[role=spinbutton]',
  '[role=menuitem]',
  '[role=menuitemcheckbox]',
  '[role=menuitemradio]',
  '[role=tab]',
  '[role=treeitem]',
  // Container interactives
  '[role=menu]',
  '[role=menubar]',
  '[role=tablist]',
  '[role=tree]',
  '[role=dialog]',
  '[role=alertdialog]',
  // Structural / landmark
  'main, [role=main]',
  'nav, [role=navigation]',
  'header, [role=banner]',
  'footer, [role=contentinfo]',
  'aside, [role=complementary]',
  'section, [role=region]',
  'form, [role=form]',
  'h1, h2, h3, h4, h5, h6, [role=heading]',
  'article, [role=article]',
  '[role=search]',
  // Content
  'img:not([alt=""])',
  '[role=image]',
  'hr, [role=separator]',
  '[role=progressbar]',
  '[role=status]',
  '[role=alert]',
  // Disclosure-style
  'details',
  'summary',
  // Contenteditable surfaces
  '[contenteditable]:not([contenteditable=false])',
].join(', ')

/** Options accepted by the walker. */
export interface WalkerOptions {
  /**
   * Diff baseline marker. The pure walker usually emits `'full'`; snapshot
   * orchestration can pass `'diff'` when returning a delta.
   */
  readonly diffBaseline?: 'full' | 'diff'
}

/**
 * Walk the DOM rooted at `document` and produce the snapshot. Pure function:
 * deterministic given the same DOM state. Safe to call repeatedly — every call
 * walks fresh; the walker does not stash state between invocations.
 */
export function walkAccessibilityTree(document: Document, options: WalkerOptions = {}): Snapshot {
  const candidates = collectCandidates(document)
  const entries: SnapshotEntry[] = []
  let nextRef = 1
  for (const element of candidates) {
    const entry = enrichEntry(element, nextRef)
    if (entry === null) continue
    // Landmarks (non-interactive) emit with `ref: null` so they don't consume a
    // ref slot; interactive elements get the next ref and increment the counter.
    if (entry.ref !== null) nextRef++
    entries.push(entry)
  }
  return {
    schemaVersion: 1,
    entries,
    meta: extractMeta(document, options),
  }
}

/**
 * Pass 1 — collect candidate elements in document order using a single CSS
 * selector. The Set preserves insertion order in modern engines and
 * deduplicates elements that match multiple parts of the union selector.
 */
function collectCandidates(document: Document): readonly Element[] {
  const list = document.querySelectorAll(CANDIDATE_SELECTOR)
  const seen = new Set<Element>()
  for (let i = 0; i < list.length; i++) {
    const el = list.item(i)
    if (el !== null) seen.add(el)
  }
  return Array.from(seen)
}

/**
 * Pass 2 — enrich a single candidate element with role + name + state + bbox +
 * fingerprint. Returns null when the element is not a real snapshot entry
 * (e.g. role resolves to `'unknown'` AND the element has no explicit role).
 */
function enrichEntry(element: Element, ref: number): SnapshotEntry | null {
  const role = resolveRole(element)
  if (role === 'unknown' && !element.hasAttribute('role')) {
    // Drop noise — elements that the selector matched but role resolution
    // could not classify (e.g. `<a>` without href, `<img alt="">`).
    return null
  }
  const interactive = isRoleInteractive(role)
  const name = computeAccessibleName(element)
  const description = computeDescription(element)
  const state = extractState(element, role)
  const bbox = computeBbox(element)
  const ancestorRoles = collectAncestorRoles(element)
  const fingerprint = computeFingerprint(role, name, ancestorRoles)
  const tag = element.tagName.toLowerCase()
  const value = readValue(element)
  const placeholder = element.getAttribute('placeholder') ?? ''
  return {
    ref: interactive ? ref : null,
    tag,
    role,
    name,
    description,
    interactive,
    state,
    bbox,
    fingerprint,
    recently_changed: false,
    value,
    placeholder,
  }
}

/**
 * `aria-describedby` resolution (text content of referenced elements) plus
 * `title` attribute fallback. Empty string when no description.
 */
function computeDescription(element: Element): string {
  const ariaDescribedby = element.getAttribute('aria-describedby')
  if (ariaDescribedby !== null && ariaDescribedby !== '') {
    const doc = element.ownerDocument
    if (doc !== null) {
      const parts: string[] = []
      for (const id of ariaDescribedby.split(/\s+/)) {
        if (id === '') continue
        const referenced = doc.getElementById(id)
        if (referenced !== null) parts.push((referenced.textContent ?? '').trim())
      }
      const joined = parts.join(' ').trim()
      if (joined !== '') return joined
    }
  }
  const title = element.getAttribute('title')
  if (title !== null && title.trim() !== '') return title
  return ''
}

/**
 * Bounding box always present. Real values in Chromium; zeros in jsdom (which
 * has no layout engine). Predictability over token cost — the shape is stable
 * across runtimes.
 */
function computeBbox(element: Element): SnapshotBbox {
  if (
    typeof (element as { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect !==
    'function'
  ) {
    return { x: 0, y: 0, w: 0, h: 0 }
  }
  try {
    const rect = (element as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect()
    return { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
  } catch {
    return { x: 0, y: 0, w: 0, h: 0 }
  }
}

/**
 * Collect the role chain of ancestors (closest first). Used by fingerprint to
 * encode structural context without bloating the input to the hash.
 */
function collectAncestorRoles(element: Element): readonly string[] {
  const roles: string[] = []
  let current: Element | null = element.parentElement
  while (current !== null) {
    const role = resolveRole(current)
    if (role !== 'unknown') roles.push(role)
    current = current.parentElement
  }
  return roles
}

/** Read the value of form controls. Empty string when not applicable. */
function readValue(element: Element): string {
  const tag = element.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const value = (element as unknown as { value?: unknown }).value
    if (typeof value === 'string') return value
  }
  if (isContentEditable(element)) {
    return (element.textContent ?? '').trim()
  }
  return ''
}

function isContentEditable(element: Element): boolean {
  const attr = element.getAttribute('contenteditable')
  if (attr !== null) return attr.toLowerCase() !== 'false'
  return (element as HTMLElement).isContentEditable === true
}

function extractMeta(document: Document, options: WalkerOptions): SnapshotMeta {
  const view = document.defaultView
  const viewport = {
    width: view?.innerWidth ?? 0,
    height: view?.innerHeight ?? 0,
  }
  return {
    viewport,
    url: typeof document.URL === 'string' ? document.URL : '',
    title: typeof document.title === 'string' ? document.title : '',
    diff_baseline: options.diffBaseline ?? 'full',
    renderer_reloaded_since_last_snapshot: false,
  }
}

/**
 * Whether an element is part of the visible interactive surface. Exposed so
 * semantic query tools can reuse the same visibility and interactivity rules.
 */
export function isEntryReachable(element: Element, role: SnapshotRole): boolean {
  if (!isVisible(element)) return false
  if (!isRoleInteractive(role)) return false
  return true
}
