/** Renderer-side ref lookup shared by probes, reads, waits, retags and transport bodies. */

import { MAX_SHADOW_DEPTH } from './walker.js'

/** Whether `selector` is the canonical `[data-sw-ref="N"]` selector emitted for a snapshot ref. */
export function isRefSelector(selector: string): boolean {
  return /^\[data-sw-ref="[1-9]\d*"\]$/.test(selector)
}

/**
 * Visit every element in exactly the roots eligible for the walker: the document,
 * open shadow roots up to `maxShadowDepth` boundaries, and closed roots exposed via
 * `__stagewright_closedShadowRoots` / `__stagewright_inspectShadow()` (each exposed
 * root starts a fresh depth budget). Detached, foreign-document and malformed
 * exposed roots are skipped. Stops as soon as `visit` returns `true`.
 *
 * Keep this function self-contained: its compiled source is also embedded in
 * small renderer bodies that do not need the full accessibility bundle.
 */
export function visitTargetElements(
  document: Document,
  maxShadowDepth: number,
  visit: (element: Element) => boolean,
): void {
  const roots: { root: Document | ShadowRoot; depth: number }[] = [{ root: document, depth: 0 }]
  const view = document.defaultView as
    | (Window & {
        __stagewright_closedShadowRoots?: unknown
        __stagewright_inspectShadow?: () => unknown
      })
    | null
  const exposed: unknown[] = []
  if (Array.isArray(view?.__stagewright_closedShadowRoots)) {
    exposed.push(...view.__stagewright_closedShadowRoots)
  }
  try {
    const inspected = view?.__stagewright_inspectShadow?.()
    if (Array.isArray(inspected)) exposed.push(...inspected)
  } catch {
    // Match the walker's best-effort opt-in hook.
  }
  for (const value of exposed) {
    if (typeof value !== 'object' || value === null) continue
    const root = value as ShadowRoot
    if (
      root.ownerDocument === document &&
      typeof root.host === 'object' &&
      root.host !== null &&
      typeof root.host.tagName === 'string' &&
      typeof root.host.getAttribute === 'function' &&
      root.host.isConnected !== false &&
      typeof root.querySelectorAll === 'function'
    ) {
      roots.push({ root, depth: 0 })
    }
  }
  const seenDepth = new Map<Document | ShadowRoot, number>()
  for (let index = 0; index < roots.length; index++) {
    const entry = roots[index]
    if (entry === undefined) continue
    const { root, depth } = entry
    const previousDepth = seenDepth.get(root)
    // An explicitly exposed root starts a fresh budget. A shallower revisit
    // must remain eligible even if we reached it through another root first.
    if (previousDepth !== undefined && previousDepth <= depth) continue
    seenDepth.set(root, depth)
    for (const element of root.querySelectorAll('*')) {
      if (visit(element)) return
      if (depth < maxShadowDepth && element.shadowRoot !== null) {
        roots.push({ root: element.shadowRoot, depth: depth + 1 })
      }
    }
  }
}

/**
 * Resolve the canonical selector emitted for a snapshot ref across exactly the
 * roots eligible for the walker. Other selectors retain document.querySelector's
 * syntax errors and first-match semantics; this is not a new CSS selector engine.
 *
 * Self-contained apart from {@link visitTargetElements}; {@link TARGET_RESOLVER_FN}
 * embeds both.
 */
export function queryTarget(
  document: Document,
  selector: string,
  maxShadowDepth: number,
): Element | null {
  const match = /^\[data-sw-ref="([1-9]\d*)"\]$/.exec(selector)
  // The document's light DOM is scanned first by the root walk, so a native hit
  // there is already the walk's first match; only misses need the shadow scan.
  const light = document.querySelector(selector)
  if (match === null || light !== null) return light
  const ref = match[1]
  let found: Element | null = null
  visitTargetElements(document, maxShadowDepth, (element) => {
    if (element.getAttribute('data-sw-ref') !== ref) return false
    found = element
    return true
  })
  return found
}

/** Install the same self-contained resolver in an inline renderer body. */
export const TARGET_RESOLVER_FN = `
${visitTargetElements.toString()}
const __swQueryTarget = (selector) => (${queryTarget.toString()})(document, selector, ${MAX_SHADOW_DEPTH});
`
