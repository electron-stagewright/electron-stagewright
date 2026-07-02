/**
 * Unit tests for the injected-walker body builders (performance follow-up H3).
 *
 * The ~30KB walker bundle is shipped on every snapshot/find/read/probe call. The body wraps it in
 * a per-document version guard so the renderer parses + executes the bundle only ONCE per document
 * (subsequent calls reuse the installed `__stagewrightWalk`/`__stagewrightProbe` globals), and
 * re-installs automatically when a server upgrade ships a different bundle.
 */

import { describe, expect, it } from 'vitest'

import { buildProbeBody, buildWalkBody } from '../src/tools/snapshot/inject.js'

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
