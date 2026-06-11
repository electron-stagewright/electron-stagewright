/**
 * Accessible Name (W3C accname-1.2) computation.
 *
 * Implements the algorithm specified in https://www.w3.org/TR/accname-1.2/.
 * Returns the computed accessible name for an element following the standard
 * precedence:
 *
 *   1. `aria-labelledby` — concatenate the text content of the referenced
 *      elements (recursive).
 *   2. `aria-label` — when non-empty.
 *   3. Native host language (HTML) labelling:
 *      - `<label for="id">` matching, or wrapping `<label>` ancestor for form controls.
 *      - `<caption>` for `<table>`.
 *      - `<legend>` for `<fieldset>`.
 *      - `<title>` child for `<svg>`.
 *      - `alt` attribute for `<img>`, `<area>`, `<input type=image>`.
 *      - `<summary>` for `<details>` — explicit summary child.
 *   4. Name from content (when role allows): recurse text content of children.
 *   5. `title` attribute (tooltip fallback).
 *   6. Placeholder — for form controls with no other source.
 *
 * The algorithm guards against infinite recursion (an `aria-labelledby` that
 * points back to its own subtree) via a visited-set.
 *
 * Returns the trimmed, single-line accessible name. Empty string when no name
 * is computable.
 *
 * @module
 */

import { cssEscape, queryElementByIdFromSameRoot, querySelectorFromSameRoot } from './dom-utils.js'

/**
 * Roles whose name comes from their text content (W3C accname § 4.3.10 step F).
 * Excludes roles like `textbox` and `searchbox` whose `name` should NEVER come
 * from their value — those use label associations instead.
 */
const NAME_FROM_CONTENT_ROLES = new Set([
  'button',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'switch',
  'tab',
  'treeitem',
  'heading',
  'cell',
  'columnheader',
  'rowheader',
  'tooltip',
  'checkbox',
])

/** HTML tags whose implicit role allows name-from-content. */
const NAME_FROM_CONTENT_TAGS = new Set([
  'button',
  'a',
  'option',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'summary',
  'th',
])

/**
 * Maximum recursion depth into aria-labelledby and name-from-content
 * traversals. A pathological DOM with deeply-nested aria-labelledby chains
 * could otherwise pin the CPU; the W3C spec leaves the limit
 * implementation-defined.
 */
const MAX_RECURSION_DEPTH = 16

interface NameContext {
  /** Elements whose name is currently being computed — guards against cycles. */
  readonly visited: Set<Element>
  /** Current recursion depth. */
  readonly depth: number
}

/**
 * Compute the accessible name for a DOM element following W3C accname-1.2.
 * Returns the trimmed, whitespace-collapsed result. Empty string if no name is
 * computable.
 */
export function computeAccessibleName(element: Element): string {
  const ctx: NameContext = { visited: new Set(), depth: 0 }
  const name = computeNameInner(element, ctx)
  return collapseWhitespace(name)
}

function computeNameInner(element: Element, ctx: NameContext): string {
  if (ctx.depth >= MAX_RECURSION_DEPTH) return ''
  if (ctx.visited.has(element)) return ''

  // Step 1: aria-labelledby
  const labelledby = element.getAttribute('aria-labelledby')
  if (labelledby) {
    const name = resolveLabelledby(element, labelledby, ctx)
    if (name) return name
  }

  // Step 2: aria-label (when non-empty after trim)
  const ariaLabel = element.getAttribute('aria-label')
  if (ariaLabel !== null && ariaLabel.trim() !== '') {
    return ariaLabel
  }

  // Step 3: native HTML labelling
  const nativeName = computeNativeHtmlName(element, ctx)
  if (nativeName) return nativeName

  // Step 4: name from content (when role allows)
  if (allowsNameFromContent(element)) {
    const fromContent = computeNameFromContent(element, ctx)
    if (fromContent) return fromContent
  }

  // Step 5: title attribute (tooltip)
  const title = element.getAttribute('title')
  if (title !== null && title.trim() !== '') {
    return title
  }

  // Step 6: placeholder fallback (form controls with no other source)
  if (isFormControl(element)) {
    const placeholder = element.getAttribute('placeholder')
    if (placeholder !== null && placeholder.trim() !== '') {
      return placeholder
    }
  }

  return ''
}

function resolveLabelledby(element: Element, idRefs: string, ctx: NameContext): string {
  const ids = idRefs.split(/\s+/).filter((id) => id !== '')
  const parts: string[] = []
  const nextCtx: NameContext = {
    visited: new Set([...ctx.visited, element]),
    depth: ctx.depth + 1,
  }
  for (const id of ids) {
    const referenced = queryElementByIdFromSameRoot(element, id)
    if (referenced === null) continue
    // Per W3C: when computing name from a labelledby target, recurse without
    // re-entering aria-labelledby on the target (to avoid loops).
    if (nextCtx.visited.has(referenced)) continue
    const part = computeNameInner(referenced, nextCtx) || textContent(referenced)
    if (part) parts.push(part)
  }
  return parts.join(' ').trim()
}

function computeNativeHtmlName(element: Element, ctx: NameContext): string {
  const tag = element.tagName.toLowerCase()

  // <label> association: explicit (label[for]) or implicit (wrapping label).
  if (isFormControl(element)) {
    const id = element.getAttribute('id')
    if (id !== null && id !== '') {
      // CSS.escape may be undefined in some jsdom configurations; fall back
      // to a manual character-escape so attribute-selector remains valid.
      const explicit = querySelectorFromSameRoot(element, `label[for="${cssEscape(id)}"]`)
      if (explicit) {
        const nextCtx: NameContext = {
          visited: new Set([...ctx.visited, element]),
          depth: ctx.depth + 1,
        }
        const labelText = computeNameInner(explicit, nextCtx) || textContent(explicit)
        if (labelText) return labelText
      }
    }
    // Wrapping label
    const wrappingLabel = closestAncestor(element, 'label')
    if (wrappingLabel) {
      // The label's name comes from its text content excluding the form
      // control itself (to avoid recursive value inclusion).
      return textContent(wrappingLabel, element)
    }
  }

  // <img>, <area>, <input type=image>: alt attribute
  if (
    tag === 'img' ||
    tag === 'area' ||
    (tag === 'input' && element.getAttribute('type') === 'image')
  ) {
    const alt = element.getAttribute('alt')
    if (alt !== null) return alt
  }

  // <table>: caption child
  if (tag === 'table') {
    const caption = element.querySelector(':scope > caption')
    if (caption) return textContent(caption)
  }

  // <fieldset>: legend child
  if (tag === 'fieldset') {
    const legend = element.querySelector(':scope > legend')
    if (legend) return textContent(legend)
  }

  // <details>: summary child
  if (tag === 'details') {
    const summary = element.querySelector(':scope > summary')
    if (summary) return textContent(summary)
  }

  // <svg>: title child
  if (tag === 'svg') {
    const title = element.querySelector(':scope > title')
    if (title) return textContent(title)
  }

  return ''
}

function computeNameFromContent(element: Element, ctx: NameContext): string {
  const nextCtx: NameContext = {
    visited: new Set([...ctx.visited, element]),
    depth: ctx.depth + 1,
  }
  // Iterate the element's children directly. We must NOT pass the element
  // itself into computeContentRecursive, because that helper short-circuits
  // when given a form control (to prevent recursing into nested input
  // values). The form-control short-circuit applies to CHILDREN, not to the
  // element whose name we are computing.
  const parts: string[] = []
  for (let i = 0; i < element.childNodes.length; i++) {
    const child = element.childNodes.item(i)
    if (child === null) continue
    const childText = computeContentRecursive(child, nextCtx)
    if (childText) parts.push(childText)
  }
  return parts.join(' ').trim()
}

function computeContentRecursive(node: Node, ctx: NameContext): string {
  // Text node: emit its text content.
  if (node.nodeType === 3 /* TEXT_NODE */) {
    return node.textContent ?? ''
  }
  // Element node: recurse with aria/label rules.
  if (node.nodeType === 1 /* ELEMENT_NODE */) {
    const el = node as Element
    if (ctx.visited.has(el)) return ''
    // Markup plumbing (injected CSS/JS) is never part of an accessible name.
    if (isNonContentElement(el)) return ''
    // Don't traverse into nested form controls' values (avoid leaking input
    // text into a button's accessible name).
    if (isFormControl(el)) return ''
    // Embedded content with its own accessible name: use that name.
    const ownName = computeNameInner(el, ctx)
    if (ownName) return ownName
    // Otherwise recurse into children.
    const parts: string[] = []
    for (let i = 0; i < el.childNodes.length; i++) {
      const child = el.childNodes.item(i)
      if (child === null) continue
      const childText = computeContentRecursive(child, ctx)
      if (childText) parts.push(childText)
    }
    return parts.join(' ')
  }
  return ''
}

function allowsNameFromContent(element: Element): boolean {
  const role = element.getAttribute('role')
  if (role !== null && NAME_FROM_CONTENT_ROLES.has(role)) return true
  const tag = element.tagName.toLowerCase()
  return NAME_FROM_CONTENT_TAGS.has(tag)
}

function isFormControl(element: Element): boolean {
  const tag = element.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button'
}

/**
 * Elements whose text content is markup plumbing (injected CSS/JS), never
 * user-visible copy — excluded from every name-from-content traversal so an
 * editor's injected `<style>` rules cannot leak into an accessible name.
 */
function isNonContentElement(element: Element): boolean {
  const tag = element.tagName.toLowerCase()
  return tag === 'style' || tag === 'script' || tag === 'noscript' || tag === 'template'
}

/**
 * Collect text content of `element` excluding any single child element
 * (typically the form control inside a wrapping `<label>`) and skipping
 * non-content elements (style/script/noscript/template).
 */
function textContent(element: Element, exclude?: Element): string {
  const parts: string[] = []
  for (let i = 0; i < element.childNodes.length; i++) {
    const child = element.childNodes.item(i)
    if (child === null) continue
    if (exclude !== undefined && child === exclude) continue
    if (child.nodeType === 3 /* TEXT_NODE */) {
      parts.push(child.textContent ?? '')
    } else if (child.nodeType === 1 /* ELEMENT_NODE */) {
      if (isNonContentElement(child as Element)) continue
      parts.push(textContent(child as Element, exclude))
    }
  }
  return parts.join(' ').trim()
}

function closestAncestor(element: Element, tagName: string): Element | null {
  let current: Element | null = element.parentElement
  const tag = tagName.toLowerCase()
  while (current !== null) {
    if (current.tagName.toLowerCase() === tag) return current
    current = current.parentElement
  }
  return null
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}
