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
 * Shadow DOM: the walker recurses into OPEN shadow roots automatically (their
 * contents are part of the agent's reachable surface). CLOSED shadow roots are
 * opaque to `element.shadowRoot`; an app author can expose them via the opt-in
 * global hook `window.__stagewright_inspectShadow: () => readonly ShadowRoot[]`,
 * and entries discovered through that hook are marked `state.shadow_closed: true`.
 * Recursion is capped at {@link MAX_SHADOW_DEPTH} levels to defend against
 * pathological nested-shadow DOMs.
 *
 * @module
 */

import { computeAccessibleName } from './accname.js'
import { composedParentElement, isElementLike, queryElementByIdFromSameRoot } from './dom-utils.js'
import { computeFingerprint } from './fingerprint.js'
import { isRoleInteractive, resolveRole } from './roles.js'
import type { Snapshot, SnapshotBbox, SnapshotEntry, SnapshotMeta, SnapshotRole } from './schema.js'
import { extractState, isVisible } from './state.js'

/** Maximum shadow-root recursion depth — guards against pathological nesting. */
const MAX_SHADOW_DEPTH = 10

/**
 * Shape of the optional global hook an app author implements to expose closed
 * shadow roots to the walker. Typed locally (and accessed via a cast) so the
 * global namespace stays clean and the contract lives next to its only caller.
 */
interface StagewrightShadowWindow {
  readonly __stagewright_inspectShadow?: () => readonly ShadowRoot[]
}

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

/** Mutable ref allocator threaded through the recursive walk. */
interface RefCounter {
  next: number
}

/** Per-root walk context: whether we are inside a closed shadow, and recursion depth. */
interface WalkContext {
  readonly shadowClosed: boolean
  readonly depth: number
}

/**
 * Walk the DOM rooted at `document` and produce the snapshot. Pure function:
 * deterministic given the same DOM state. Safe to call repeatedly — every call
 * walks fresh; the walker does not stash state between invocations.
 *
 * Walks the light DOM and open shadow roots in document order, then walks any
 * closed shadow roots exposed via the `__stagewright_inspectShadow` hook.
 */
export function walkAccessibilityTree(document: Document, options: WalkerOptions = {}): Snapshot {
  const entries: SnapshotEntry[] = []
  const refCounter: RefCounter = { next: 1 }

  // Light DOM + open shadow roots, recursively.
  walkRoot(document, entries, refCounter, { shadowClosed: false, depth: 0 })

  // Closed shadow roots the app author opted to expose.
  for (const shadowRoot of getInspectableClosedShadows(document)) {
    walkRoot(shadowRoot, entries, refCounter, { shadowClosed: true, depth: 0 })
  }

  return {
    schemaVersion: 1,
    entries,
    meta: extractMeta(document, options),
  }
}

/**
 * Walk a single root (a `Document` or `ShadowRoot`) in composed-tree order.
 * Candidate entries are enriched only when they match the allow-list, but open
 * shadow roots are recursed at the host's position so refs follow what an agent
 * sees on screen.
 */
function walkRoot(
  root: Document | ShadowRoot,
  entries: SnapshotEntry[],
  refCounter: RefCounter,
  ctx: WalkContext,
): void {
  const candidates = collectCandidateSet(root)
  for (const element of collectElements(root)) {
    if (candidates.has(element)) {
      const entry = enrichEntry(element, refCounter.next, ctx.shadowClosed)
      if (entry !== null) {
        // Landmarks (non-interactive) emit with `ref: null` so they don't consume a
        // ref slot; interactive elements get the next ref and increment the counter.
        if (entry.ref !== null) refCounter.next++
        entries.push(entry)
      }
    }

    if (ctx.depth >= MAX_SHADOW_DEPTH) continue
    const shadow = element.shadowRoot
    if (shadow !== null) {
      walkRoot(shadow, entries, refCounter, {
        shadowClosed: ctx.shadowClosed,
        depth: ctx.depth + 1,
      })
    }
  }
}

/**
 * Pass 1 — collect candidate elements using a single CSS
 * selector. The Set preserves insertion order in modern engines and
 * deduplicates elements that match multiple parts of the union selector.
 *
 * Accepts a `Document` OR a `ShadowRoot` so the same query runs against shadow
 * trees during recursion.
 */
function collectCandidateSet(root: Document | ShadowRoot): ReadonlySet<Element> {
  const list = root.querySelectorAll(CANDIDATE_SELECTOR)
  const seen = new Set<Element>()
  for (let i = 0; i < list.length; i++) {
    const el = list.item(i)
    if (el !== null) seen.add(el)
  }
  return seen
}

/**
 * Collect all elements in root order. This is intentionally broader than the
 * candidate selector because custom-element hosts often have no accessible role
 * themselves, but their shadow roots still need to be walked at the host slot.
 */
function collectElements(root: Document | ShadowRoot): readonly Element[] {
  const all = root.querySelectorAll('*')
  const elements: Element[] = []
  for (let i = 0; i < all.length; i++) {
    const el = all.item(i)
    if (el !== null) elements.push(el)
  }
  return elements
}

/**
 * Resolve closed shadow roots the app author exposed via the optional global
 * hook. Returns an empty array when the hook is absent or throws.
 */
function getInspectableClosedShadows(document: Document): readonly ShadowRoot[] {
  const view = document.defaultView as (StagewrightShadowWindow & Window) | null
  const hook = view?.__stagewright_inspectShadow
  if (typeof hook !== 'function') return []
  try {
    const roots = hook()
    if (!Array.isArray(roots)) return []
    const inspected: ShadowRoot[] = []
    const seen = new Set<ShadowRoot>()
    for (const root of roots) {
      if (!isInspectableShadowRoot(root, document)) continue
      if (seen.has(root)) continue
      seen.add(root)
      inspected.push(root)
    }
    return inspected
  } catch {
    // A misbehaving hook must never break the snapshot.
    return []
  }
}

function isInspectableShadowRoot(value: unknown, document: Document): value is ShadowRoot {
  if (typeof value !== 'object' || value === null) return false
  const root = value as {
    readonly host?: unknown
    readonly ownerDocument?: unknown
    readonly querySelectorAll?: unknown
  }
  return (
    root.ownerDocument === document &&
    isElementLike(root.host) &&
    typeof root.querySelectorAll === 'function'
  )
}

/**
 * Pass 2 — enrich a single candidate element with role + name + state + bbox +
 * fingerprint. Returns null when the element is not a real snapshot entry
 * (e.g. role resolves to `'unknown'` AND the element has no explicit role).
 *
 * `shadowClosed` marks the entry as living inside a closed shadow root exposed
 * via the opt-in hook, so the agent knows the surrounding tree is otherwise
 * opaque.
 */
function enrichEntry(element: Element, ref: number, shadowClosed: boolean): SnapshotEntry | null {
  const role = resolveRole(element)
  if (role === 'unknown' && !element.hasAttribute('role')) {
    // Drop noise — elements that the selector matched but role resolution
    // could not classify (e.g. `<a>` without href, `<img alt="">`).
    return null
  }
  const interactive = isRoleInteractive(role)
  const name = computeAccessibleName(element)
  const description = computeDescription(element)
  const baseState = extractState(element, role)
  const state = shadowClosed ? { ...baseState, shadow_closed: true } : baseState
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
    const parts: string[] = []
    for (const id of ariaDescribedby.split(/\s+/)) {
      if (id === '') continue
      const referenced = queryElementByIdFromSameRoot(element, id)
      if (referenced !== null) parts.push((referenced.textContent ?? '').trim())
    }
    const joined = parts.join(' ').trim()
    if (joined !== '') return joined
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
  let current: Element | null = composedParentElement(element)
  while (current !== null) {
    const role = resolveRole(current)
    if (role !== 'unknown') roles.push(role)
    current = composedParentElement(current)
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
    navigation_started_at_ms: readNavigationStartedAt(view),
    diff_baseline: options.diffBaseline ?? 'full',
    renderer_reloaded_since_last_snapshot: false,
  }
}

function readNavigationStartedAt(view: Window | null): number {
  const timeOrigin = view?.performance?.timeOrigin
  return typeof timeOrigin === 'number' && Number.isFinite(timeOrigin) ? timeOrigin : 0
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
