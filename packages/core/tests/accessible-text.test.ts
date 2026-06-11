/**
 * Unit tests for the shared `__swAccessibleText` renderer helper (ADR-007 dogfooding fix):
 * electron_get_text and expect_text read an element's trimmed textContent, falling back to
 * the accessible label that electron_find matches on when there is no text — so a
 * find-by-name then read/assert chain works on icon-only and labelled controls. The helper
 * ships as a renderer-evaluable string; here we run it inside a JSDOM window (the same
 * browser-like context the transport evaluates it in).
 */

import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

import { computeAccessibleName } from '../src/snapshot/index.js'
import { ACCESSIBLE_TEXT_FN } from '../src/tools/accessible-text.js'

/**
 * Run `__swAccessibleText` against the element matched by `selector` in a document built
 * from `html`. The function string is this module's own trusted constant, executed inside
 * the JSDOM window exactly as the transport runs it inside the renderer (no Node-side eval).
 */
function accessibleText(html: string, selector: string): string {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { runScripts: 'outside-only' })
  const fn = dom.window.eval(
    `(function () { ${ACCESSIBLE_TEXT_FN}; return __swAccessibleText; })()`,
  ) as (el: Element) => string
  const el = dom.window.document.querySelector(selector)
  if (el === null) throw new Error(`no element matched ${selector}`)
  return fn(el)
}

describe('__swAccessibleText', () => {
  it('returns trimmed textContent when present', () => {
    expect(accessibleText('<button>  Save draft  </button>', 'button')).toBe('Save draft')
  })

  it('falls back to aria-label when there is no text (icon button)', () => {
    expect(accessibleText('<button aria-label="Save changes"><svg></svg></button>', 'button')).toBe(
      'Save changes',
    )
  })

  it('resolves aria-labelledby against the document', () => {
    const html = '<span id="lbl">Delete item</span><button id="b" aria-labelledby="lbl"></button>'
    expect(accessibleText(html, '#b')).toBe('Delete item')
  })

  it('keeps aria-labelledby precedence over aria-label to match electron_find', () => {
    const html =
      '<span id="lbl">Labelled by wins</span><button id="b" aria-labelledby="lbl" aria-label="Fallback label"></button>'
    expect(accessibleText(html, '#b')).toBe('Labelled by wins')
  })

  it('falls back to native form labels and placeholders', () => {
    expect(accessibleText('<label for="q">Search query</label><input id="q" />', '#q')).toBe(
      'Search query',
    )
    expect(accessibleText('<label>Project name <input id="project" /></label>', '#project')).toBe(
      'Project name',
    )
    expect(accessibleText('<input placeholder="Filter rows" />', 'input')).toBe('Filter rows')
  })

  it('keeps native alt precedence over title for image names', () => {
    expect(accessibleText('<img alt="Company logo" title="Tooltip" />', 'img')).toBe('Company logo')
  })

  it('falls back to title', () => {
    expect(accessibleText('<button title="Close"></button>', 'button')).toBe('Close')
  })

  it('prefers non-empty text content over the accessible label', () => {
    // textContent stays the PRIMARY source; the label fallback only applies when empty.
    expect(accessibleText('<button aria-label="A11y">Visible</button>', 'button')).toBe('Visible')
  })

  it('returns empty string when there is neither text nor a label', () => {
    expect(accessibleText('<button><svg></svg></button>', 'button')).toBe('')
  })
})

describe('__swAccessibleText non-content filtering (style/script)', () => {
  it('skips injected <style> rules so editor text payloads stay clean', () => {
    const html = '<div id="editor"><style>.view-line { color: red; }</style>const x = 1</div>'
    expect(accessibleText(html, '#editor')).toBe('const x = 1')
  })

  it('skips script/noscript/template text the same way', () => {
    const html =
      '<div id="d"><script>var hidden = true;</script><template><p>tpl</p></template><noscript>off</noscript>Visible copy</div>'
    expect(accessibleText(html, '#d')).toBe('Visible copy')
  })

  it('falls through to the accessible label when the only content is a <style>', () => {
    const html = '<div id="d" aria-label="Editor pane"><style>.a { color: red; }</style></div>'
    expect(accessibleText(html, '#d')).toBe('Editor pane')
  })

  it('keeps aria-labelledby resolution clean of style text inside the label source', () => {
    const html =
      '<span id="lbl"><style>.x{}</style>Real label</span><button id="b" aria-labelledby="lbl"></button>'
    expect(accessibleText(html, '#b')).toBe('Real label')
  })
})

describe('computeAccessibleName non-content filtering (snapshot accname)', () => {
  function nameOf(html: string, selector: string): string {
    const dom = new JSDOM(`<!doctype html><body>${html}</body>`)
    const el = dom.window.document.querySelector(selector)
    if (el === null) throw new Error(`no element matched ${selector}`)
    return computeAccessibleName(el)
  }

  it('excludes <style> text from name-from-content', () => {
    expect(nameOf('<button><style>.icon{fill:red}</style>Guardar</button>', 'button')).toBe(
      'Guardar',
    )
  })

  it('excludes script/template text from label-based names', () => {
    const html =
      '<label for="i"><script>var x=1;</script>Nombre del proyecto</label><input id="i" />'
    expect(nameOf(html, '#i')).toBe('Nombre del proyecto')
  })
})
