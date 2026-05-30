/**
 * Unit tests for the renderer read probe (`__stagewrightProbe`) installed by
 * `snapshot/renderer-entry.ts`. The probe runs in the renderer against the global
 * `document`; here we point the global at a JSDOM document and call the installed
 * global directly, the same way the bundle is invoked in a real renderer.
 */

import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

import type {
  ProbeElementResult,
  ProbeListResult,
  ProbeMiss,
} from '../src/snapshot/renderer-entry.js'
import '../src/snapshot/renderer-entry.js'

type ProbeArg = { mode?: 'element' | 'focused' | 'list'; selector?: string; limit?: number }
type ProbeResult = ProbeElementResult | ProbeListResult | ProbeMiss
type ProbeGlobal = typeof globalThis & {
  __stagewrightProbe: (arg?: ProbeArg) => ProbeResult
  document?: Document
}

const g = globalThis as ProbeGlobal

/** Run `fn` with the global `document` pointed at a fresh JSDOM document. */
function withDom<T>(html: string, fn: (doc: Document) => T): T {
  const dom = new JSDOM(html)
  const previous = g.document
  g.document = dom.window.document
  try {
    return fn(dom.window.document)
  } finally {
    if (previous === undefined) delete g.document
    else g.document = previous
  }
}

describe('__stagewrightProbe element mode', () => {
  it('reads role, name, text, and state of a matched element', () => {
    withDom('<button>Save draft</button>', () => {
      const result = g.__stagewrightProbe({ mode: 'element', selector: 'button' })
      expect(result.found).toBe(true)
      const el = result as ProbeElementResult
      expect(el.role).toBe('button')
      expect(el.name).toBe('Save draft')
      expect(el.text).toBe('Save draft')
      expect(el.state.visible).toBe(true)
      expect(el.ref).toBeNull()
    })
  })

  it('parses an existing data-sw-ref tag into a numeric ref', () => {
    withDom('<button data-sw-ref="5">Go</button>', () => {
      const result = g.__stagewrightProbe({
        mode: 'element',
        selector: 'button',
      }) as ProbeElementResult
      expect(result.ref).toBe(5)
    })
  })

  it('reads the value of a form control', () => {
    withDom('<input value="Ada" />', () => {
      const result = g.__stagewrightProbe({
        mode: 'element',
        selector: 'input',
      }) as ProbeElementResult
      expect(result.value).toBe('Ada')
    })
  })

  it('returns found:false when nothing matches', () => {
    withDom('<button>Save</button>', () => {
      expect(g.__stagewrightProbe({ mode: 'element', selector: '#missing' }).found).toBe(false)
    })
  })

  it('returns found:false on an invalid selector instead of throwing', () => {
    withDom('<button>Save</button>', () => {
      expect(g.__stagewrightProbe({ mode: 'element', selector: ':::' })).toMatchObject({
        found: false,
        invalid_selector: true,
      })
    })
  })
})

describe('__stagewrightProbe focused mode', () => {
  it('reports the focused element', () => {
    withDom('<input id="n" />', (doc) => {
      doc.querySelector<HTMLInputElement>('#n')?.focus()
      const result = g.__stagewrightProbe({ mode: 'focused' }) as ProbeElementResult
      expect(result.found).toBe(true)
      expect(result.role).toBe('textbox')
    })
  })

  it('returns found:false when only the body is focused', () => {
    withDom('<button>Save</button>', () => {
      expect(g.__stagewrightProbe({ mode: 'focused' }).found).toBe(false)
    })
  })
})

describe('__stagewrightProbe list mode', () => {
  it('returns matches with the true total and a truncation count', () => {
    withDom('<button>A</button><button>B</button><button>C</button>', () => {
      const result = g.__stagewrightProbe({
        mode: 'list',
        selector: 'button',
        limit: 2,
      }) as ProbeListResult
      expect(result.matches).toHaveLength(2)
      expect(result.count).toBe(3)
      expect(result.truncated).toBe(1)
      expect(result.matches.map((m) => m.name)).toEqual(['A', 'B'])
    })
  })

  it('reports zero matches for a selector that matches nothing', () => {
    withDom('<main></main>', () => {
      const result = g.__stagewrightProbe({ mode: 'list', selector: 'button' }) as ProbeListResult
      expect(result.count).toBe(0)
      expect(result.matches).toHaveLength(0)
      expect(result.truncated).toBe(0)
    })
  })

  it('returns found:false when no selector is supplied (legible miss, not an empty success)', () => {
    withDom('<button>A</button>', () => {
      expect(g.__stagewrightProbe({ mode: 'list' }).found).toBe(false)
    })
  })

  it('returns a distinct invalid-selector miss instead of an empty list', () => {
    withDom('<button>A</button>', () => {
      expect(g.__stagewrightProbe({ mode: 'list', selector: ':::' })).toMatchObject({
        found: false,
        invalid_selector: true,
      })
    })
  })
})
