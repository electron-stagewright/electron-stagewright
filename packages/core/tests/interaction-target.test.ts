/**
 * Unit tests for the shared interaction machinery in
 * `tools/interaction/target.ts`: target resolution, bounded-timeout option
 * mapping, error classification, and similar-ref ranking.
 */

import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

import { StagewrightError } from '../src/errors/registry.js'
import { type Snapshot, walkAccessibilityTree } from '../src/snapshot/index.js'
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  classifyInteractionError,
  computeSimilarRefs,
  resolveActionOptions,
  resolveOptionalTarget,
  resolveTarget,
  snapshotHasRef,
} from '../src/tools/interaction/target.js'

function snap(html: string): Snapshot {
  return walkAccessibilityTree(new JSDOM(html).window.document, {})
}

describe('resolveTarget', () => {
  it('maps ref to the data-sw-ref selector', () => {
    expect(resolveTarget({ ref: 7 })).toBe('[data-sw-ref="7"]')
  })

  it('passes a selector through unchanged', () => {
    expect(resolveTarget({ selector: '#go' })).toBe('#go')
  })

  it('rejects neither ref nor selector with BAD_ARGUMENT', () => {
    expect(() => resolveTarget({})).toThrow(StagewrightError)
    try {
      resolveTarget({})
    } catch (err) {
      expect((err as StagewrightError).code).toBe('BAD_ARGUMENT')
    }
  })

  it('rejects both ref and selector with BAD_ARGUMENT', () => {
    try {
      resolveTarget({ ref: 1, selector: '#go' })
      expect.unreachable('should throw')
    } catch (err) {
      expect((err as StagewrightError).code).toBe('BAD_ARGUMENT')
    }
  })
})

describe('resolveOptionalTarget', () => {
  it('returns undefined when neither is given (global action)', () => {
    expect(resolveOptionalTarget({})).toBeUndefined()
  })

  it('still rejects supplying both', () => {
    try {
      resolveOptionalTarget({ ref: 1, selector: '#x' })
      expect.unreachable('should throw')
    } catch (err) {
      expect((err as StagewrightError).code).toBe('BAD_ARGUMENT')
    }
  })

  it('rejects an explicitly empty selector instead of treating it as a global action', () => {
    try {
      resolveOptionalTarget({ selector: '' })
      expect.unreachable('should throw')
    } catch (err) {
      expect((err as StagewrightError).code).toBe('BAD_ARGUMENT')
    }
  })
})

describe('resolveActionOptions (bounded timeout)', () => {
  it('defaults timeoutMs when omitted', () => {
    expect(resolveActionOptions({})).toEqual({ timeoutMs: DEFAULT_TIMEOUT_MS })
  })

  it('clamps an oversize timeout to the max', () => {
    expect(resolveActionOptions({ timeoutMs: 10_000_000 }).timeoutMs).toBe(MAX_TIMEOUT_MS)
  })

  it('floors a negative timeout at 0 and passes force through', () => {
    expect(resolveActionOptions({ timeoutMs: -5, force: true })).toEqual({
      force: true,
      timeoutMs: 0,
    })
  })
})

describe('classifyInteractionError', () => {
  it('passes through a classified StagewrightError', () => {
    expect(classifyInteractionError(new StagewrightError('SELECTOR_NO_MATCH', 'x'))).toBe(
      'SELECTOR_NO_MATCH',
    )
  })

  it('maps a disabled-element message to ELEMENT_DISABLED', () => {
    expect(classifyInteractionError(new Error('element is not enabled'))).toBe('ELEMENT_DISABLED')
  })

  it('maps a not-visible message to ELEMENT_NOT_VISIBLE', () => {
    expect(classifyInteractionError(new Error('element is not visible'))).toBe(
      'ELEMENT_NOT_VISIBLE',
    )
  })

  it('maps a no-element / resolved-to-0 message to SELECTOR_NO_MATCH', () => {
    expect(
      classifyInteractionError(new Error('waiting for selector "#x" resolved to 0 elements')),
    ).toBe('SELECTOR_NO_MATCH')
  })

  it('maps a bare actionability timeout to ELEMENT_NOT_VISIBLE', () => {
    expect(classifyInteractionError(new Error('Timeout 5000ms exceeded'))).toBe(
      'ELEMENT_NOT_VISIBLE',
    )
  })

  it('falls back to INTERNAL_ERROR for an unrecognised throw', () => {
    expect(classifyInteractionError(new Error('something weird'))).toBe('INTERNAL_ERROR')
  })

  it('does not let a generic INTERNAL_ERROR StagewrightError short-circuit classification', () => {
    expect(classifyInteractionError(new StagewrightError('INTERNAL_ERROR', 'is disabled'))).toBe(
      'ELEMENT_DISABLED',
    )
  })
})

describe('computeSimilarRefs', () => {
  const snapshot = snap(
    '<button>Save draft</button><button>Save</button><button>Cancel</button><main>landmark</main>',
  )

  it('ranks entries whose name matches the hint first', () => {
    const refs = computeSimilarRefs(snapshot, 'Save')
    expect(refs[0]?.name).toBe('Save')
  })

  it('omits non-interactive landmarks (ref null)', () => {
    const refs = computeSimilarRefs(snapshot)
    expect(refs.every((r) => typeof r.ref === 'number')).toBe(true)
    expect(refs.some((r) => r.name === 'landmark')).toBe(false)
  })

  it('honours the limit', () => {
    expect(computeSimilarRefs(snapshot, undefined, 2)).toHaveLength(2)
  })

  it('preserves document order with no hint', () => {
    const refs = computeSimilarRefs(snapshot)
    expect(refs.map((r) => r.name)).toEqual(['Save draft', 'Save', 'Cancel'])
  })

  it('produces JSON-serialisable candidates', () => {
    const refs = computeSimilarRefs(snapshot, 'Save')
    expect(JSON.parse(JSON.stringify(refs))).toEqual(refs)
  })
})

describe('snapshotHasRef', () => {
  it('detects a present / absent ref', () => {
    const snapshot = snap('<button>Save</button>')
    expect(snapshotHasRef(snapshot, 1)).toBe(true)
    expect(snapshotHasRef(snapshot, 99)).toBe(false)
  })
})
