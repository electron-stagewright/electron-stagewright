/**
 * Shared DOM helpers for the snapshot walker. These live in one module so the
 * walker (which recurses shadow roots) and the state extractor (which walks the
 * visibility/ancestor chain) share a single definition — a divergent copy in
 * either file would silently desynchronise shadow-boundary handling.
 *
 * @module
 */

/**
 * Structural duck-type check for an `Element`. Used to validate values that
 * cross a trust boundary — specifically the `host` of a root returned by
 * `getRootNode()` and the shadow roots an app author hands back through the
 * `__stagewright_inspectShadow` opt-in hook. We avoid `instanceof Element`
 * because the value may originate from a different realm (a separate `Window`
 * or a jsdom instance) where the `Element` constructor identity differs.
 *
 * @returns `true` when `value` looks like an Element (has a string `tagName`
 *   and a `getAttribute` method), narrowing the type for the caller.
 */
export function isElementLike(value: unknown): value is Element {
  if (typeof value !== 'object' || value === null) return false
  const element = value as { readonly tagName?: unknown; readonly getAttribute?: unknown }
  return typeof element.tagName === 'string' && typeof element.getAttribute === 'function'
}

/**
 * Walk to an element's parent in the COMPOSED tree — i.e. cross shadow
 * boundaries. For an element in the light DOM this is just `parentElement`.
 * For an element at the top of a shadow root (whose `parentElement` is `null`),
 * this returns the shadow host instead, so visibility and ancestor-role chains
 * continue up into the host's surrounding document.
 *
 * Why it matters: a button inside the shadow DOM of a host that is
 * `display: none` must be reported as not visible. Plain `parentElement` stops
 * at the shadow boundary and would wrongly report the button visible. The
 * fingerprint's ancestor-role chain likewise needs the host's roles to stay
 * stable and meaningful.
 *
 * Edge case: when `parentElement` is `null` and the root is the `Document`
 * (not a `ShadowRoot`), `getRootNode().host` is `undefined`, so this returns
 * `null` and the caller's walk terminates — correct for the `<html>` element.
 *
 * @returns The composed parent element, or `null` at the top of the document.
 */
export function composedParentElement(element: Element): Element | null {
  if (element.parentElement !== null) return element.parentElement
  const root = element.getRootNode()
  const host = (root as { readonly host?: unknown }).host
  return isElementLike(host) ? host : null
}

/**
 * Find an element by id within the same tree root as `element`. This matters
 * for shadow DOM: `document.getElementById()` cannot see ids inside a shadow
 * root, but `aria-labelledby`, `aria-describedby`, and `label[for]` references
 * are routinely local to that root.
 */
export function queryElementByIdFromSameRoot(element: Element, id: string): Element | null {
  const root = queryRootFor(element)
  if (root === null) return null
  if (root.nodeType === 9) {
    return (root as Document).getElementById(id)
  }
  return querySelectorSafely(root, `[id="${cssEscape(id)}"]`)
}

/** Query the same document/shadow root that owns `element`. */
export function querySelectorFromSameRoot(element: Element, selector: string): Element | null {
  const root = queryRootFor(element)
  return root === null ? null : querySelectorSafely(root, selector)
}

export function cssEscape(value: string): string {
  if (
    typeof (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS?.escape === 'function'
  ) {
    const escape = (globalThis as { CSS: { escape: (s: string) => string } }).CSS.escape
    return escape(value)
  }
  // Minimal manual escape covering the characters that break attribute selectors.
  return value.replace(/["\\\n\r\f]/g, (ch) => `\\${ch}`)
}

function queryRootFor(element: Element): (Document | ShadowRoot) | null {
  const root = element.getRootNode()
  if (isQueryRoot(root)) return root
  return element.ownerDocument
}

function isQueryRoot(value: unknown): value is Document | ShadowRoot {
  if (typeof value !== 'object' || value === null) return false
  return typeof (value as { readonly querySelector?: unknown }).querySelector === 'function'
}

function querySelectorSafely(root: Document | ShadowRoot, selector: string): Element | null {
  try {
    return root.querySelector(selector)
  } catch {
    return null
  }
}
