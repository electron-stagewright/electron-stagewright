/**
 * Unit tests for the injected-walker body builders (performance follow-up H3).
 *
 * The marker-first protocol sends a compact invocation on warm calls and ships
 * the ~30KB bundle only when a renderer lacks the matching installation.
 */

import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

import {
  buildProbeBody,
  buildProbeInstallBody,
  buildRetagBody,
  buildWalkBody,
  buildWalkInstallBody,
  runWalk,
} from '../src/tools/snapshot/inject.js'

const BUNDLE = 'globalThis.__stagewrightWalk = (arg) => ({ value: arg.value });'

describe('buildWalkBody / buildProbeBody', () => {
  it('keeps the warm body compact and reserves the bundle for a marker miss', () => {
    const warm = buildWalkBody(BUNDLE)
    const install = buildWalkInstallBody(BUNDLE)

    expect(warm).toContain('__stagewrightBundle')
    expect(warm).toContain('typeof globalThis.__stagewrightWalk')
    expect(warm).toContain('return null;')
    expect(warm).not.toContain(BUNDLE)
    expect(install).toContain(BUNDLE)
    expect(install).toContain('typeof globalThis.__stagewrightWalk')
  })

  it('derives the same marker for the same bundle and a different marker for a different bundle', () => {
    const markerOf = (body: string): string => {
      const m = /__stagewrightBundle !== "([^"]+)"/.exec(body)
      if (m === null) throw new Error('no marker found')
      return m[1] as string
    }
    expect(markerOf(buildWalkBody(BUNDLE))).toBe(markerOf(buildWalkInstallBody(BUNDLE)))
    expect(markerOf(buildWalkBody(BUNDLE))).not.toBe(markerOf(buildWalkBody(`${BUNDLE}// v2`)))
  })

  it('probe bodies use the same compact/miss split', () => {
    expect(buildProbeBody(BUNDLE)).toContain('return globalThis.__stagewrightProbe(arg);')
    expect(buildProbeBody(BUNDLE)).not.toContain(BUNDLE)
    expect(buildProbeInstallBody(BUNDLE)).toContain(BUNDLE)
  })

  it('installs once, then uses one compact renderer call per warm walk', async () => {
    const { session, calls } = makeRenderer()

    await expect(
      runWalk<{ readonly value: number }>(session, BUNDLE, { value: 1 }),
    ).resolves.toEqual({
      value: 1,
    })
    await expect(
      runWalk<{ readonly value: number }>(session, BUNDLE, { value: 2 }),
    ).resolves.toEqual({
      value: 2,
    })

    expect(calls).toHaveLength(3)
    expect(calls[0]).not.toContain(BUNDLE)
    expect(calls[1]).toContain(BUNDLE)
    expect(calls[2]).not.toContain(BUNDLE)
  })

  it('reinstalls when the marker survives but its expected global does not', async () => {
    const { global, session, calls } = makeRenderer()
    await runWalk<{ readonly value: number }>(session, BUNDLE, { value: 1 })
    delete global['__stagewrightWalk']

    await expect(
      runWalk<{ readonly value: number }>(session, BUNDLE, { value: 2 }),
    ).resolves.toEqual({
      value: 2,
    })
    expect(calls).toHaveLength(4)
    expect(calls[2]).not.toContain(BUNDLE)
    expect(calls[3]).toContain(BUNDLE)
  })

  it('reinstalls a changed bundle hash against an already-live renderer', async () => {
    const { session, calls } = makeRenderer()
    const nextBundle = 'globalThis.__stagewrightWalk = (arg) => ({ value: arg.value * 10 });'
    await runWalk<{ readonly value: number }>(session, BUNDLE, { value: 1 })

    await expect(
      runWalk<{ readonly value: number }>(session, nextBundle, { value: 2 }),
    ).resolves.toEqual({
      value: 20,
    })
    expect(calls).toHaveLength(4)
    expect(calls[2]).not.toContain(nextBundle)
    expect(calls[3]).toContain(nextBundle)
  })

  it('reduces 30 walker invocations by at least 80 percent of renderer source bytes', async () => {
    const { session, calls } = makeRenderer()
    const largeBundle = `${BUNDLE}\n/*${'x'.repeat(30_000)}*/`
    for (let i = 0; i < 30; i++) {
      await runWalk<{ readonly value: number }>(session, largeBundle, { value: i })
    }

    const sentBytes = calls.reduce((total, body) => total + Buffer.byteLength(body), 0)
    const fullEveryTimeBytes = Buffer.byteLength(buildWalkInstallBody(largeBundle)) * 30
    expect(sentBytes).toBeLessThanOrEqual(fullEveryTimeBytes * 0.2)
  })
})

function makeRenderer(): {
  readonly global: Record<string, unknown>
  readonly calls: string[]
  readonly session: {
    evaluate<T>(target: 'renderer' | 'main', body: string, arg: unknown): Promise<T>
  }
} {
  const global: Record<string, unknown> = {}
  const calls: string[] = []
  return {
    global,
    calls,
    session: {
      async evaluate<T>(_target: 'renderer' | 'main', body: string, arg: unknown): Promise<T> {
        calls.push(body)
        const run = new Function('globalThis', 'arg', body) as (
          target: Record<string, unknown>,
          input: unknown,
        ) => unknown
        return run(global, arg) as T
      },
    },
  }
}

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
