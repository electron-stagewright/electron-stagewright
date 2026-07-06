/**
 * Unit tests for the injected-walker body builders (performance follow-up H3).
 *
 * The ~30KB walker bundle is shipped on every snapshot/find/read/probe call. The body wraps it in
 * a per-document version guard so the renderer parses + executes the bundle only ONCE per document
 * (subsequent calls reuse the installed `__stagewrightWalk`/`__stagewrightProbe` globals), and
 * re-installs automatically when a server upgrade ships a different bundle.
 */

import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

import { buildProbeBody, buildRetagBody, buildWalkBody } from '../src/tools/snapshot/inject.js'

const BUNDLE = 'globalThis.__stagewrightWalk = () => ({});'

describe('buildWalkBody / buildProbeBody', () => {
  it('guards the bundle behind a per-document version marker', () => {
    const body = buildWalkBody(BUNDLE)
    expect(body).toContain('__stagewrightBundle')
    expect(body).toContain(BUNDLE)
    expect(body).toContain('return globalThis.__stagewrightWalk(arg);')
    // The guard must wrap the bundle so it only runs when the marker does not match.
    expect(body.indexOf('if (globalThis.__stagewrightBundle')).toBeLessThan(body.indexOf(BUNDLE))
  })

  it('derives the same marker for the same bundle and a different marker for a different bundle', () => {
    const markerOf = (body: string): string => {
      const m = /__stagewrightBundle !== "([^"]+)"/.exec(body)
      if (m === null) throw new Error('no marker found')
      return m[1] as string
    }
    expect(markerOf(buildWalkBody(BUNDLE))).toBe(markerOf(buildWalkBody(BUNDLE)))
    expect(markerOf(buildWalkBody(BUNDLE))).not.toBe(markerOf(buildWalkBody(`${BUNDLE}// v2`)))
  })

  it('probe body invokes the probe global', () => {
    expect(buildProbeBody(BUNDLE)).toContain('return globalThis.__stagewrightProbe(arg);')
  })

  it('is a syntactically valid function body that skips the bundle on a marker hit', () => {
    // Compile the body as a function and run it twice against a fake globalThis; the bundle
    // side-effect (installing the global) must run once, then be skipped on the second call.
    let installs = 0
    const bundle = 'globalThis.__installs = (globalThis.__installs || 0) + 1;'
    const body = buildWalkBody(bundle).replace(
      'return globalThis.__stagewrightWalk(arg);',
      'return globalThis.__installs;',
    )
    const fakeGlobal: Record<string, unknown> = {}
    const run = new Function('globalThis', 'arg', body) as (g: unknown, a: unknown) => number
    installs = run(fakeGlobal, {})
    expect(installs).toBe(1)
    installs = run(fakeGlobal, {})
    expect(installs).toBe(1) // second call reused the marker, did not re-run the bundle
  })
})

describe('buildRetagBody (executed against a real DOM)', () => {
  /** Run the retag body in jsdom and return { updated, refOf } helpers. */
  function runRetag(html: string, assignments: readonly { from: number; to: number }[]) {
    const dom = new JSDOM(html)
    const run = new Function('document', 'arg', buildRetagBody()) as (
      d: Document,
      a: unknown,
    ) => number
    const updated = run(dom.window.document, assignments)
    const refOf = (id: string): string | null =>
      dom.window.document.getElementById(id)?.getAttribute('data-sw-ref') ?? null
    return { updated, refOf }
  }

  it('applies retags from a single scan, including ref SWAPS', () => {
    const { updated, refOf } = runRetag(
      '<button id="a" data-sw-ref="1">A</button><button id="b" data-sw-ref="2">B</button>',
      // Swap: lookups must resolve against the PRE-retag tags or B would end up wrong.
      [
        { from: 1, to: 2 },
        { from: 2, to: 1 },
      ],
    )
    expect(updated).toBe(2)
    expect(refOf('a')).toBe('2')
    expect(refOf('b')).toBe('1')
  })

  it('skips assignments whose from-ref matches no element and malformed entries', () => {
    const { updated, refOf } = runRetag('<button id="a" data-sw-ref="7">A</button>', [
      { from: 99, to: 1 },
      { from: Number.NaN, to: 2 },
      { from: 7, to: 3 },
    ])
    expect(updated).toBe(1)
    expect(refOf('a')).toBe('3')
  })
})
