/**
 * Dependency-free semver range matcher for plugin core-compatibility (ADR-004).
 */

import { describe, expect, it } from 'vitest'

import { satisfies } from '../src/plugins/semver.js'

describe('satisfies', () => {
  it('matches wildcards and empty ranges against anything', () => {
    expect(satisfies('0.1.2', '*')).toBe(true)
    expect(satisfies('9.9.9', 'x')).toBe(true)
    expect(satisfies('1.0.0', '')).toBe(true)
  })

  it('matches exact versions', () => {
    expect(satisfies('1.2.3', '1.2.3')).toBe(true)
    expect(satisfies('1.2.3', '=1.2.3')).toBe(true)
    expect(satisfies('1.2.4', '1.2.3')).toBe(false)
  })

  it('applies caret semantics including 0.x special cases', () => {
    expect(satisfies('1.5.0', '^1.2.3')).toBe(true)
    expect(satisfies('2.0.0', '^1.2.3')).toBe(false)
    expect(satisfies('1.2.2', '^1.2.3')).toBe(false)
    // ^0.2.3 → >=0.2.3 <0.3.0
    expect(satisfies('0.2.9', '^0.2.3')).toBe(true)
    expect(satisfies('0.3.0', '^0.2.3')).toBe(false)
    // ^0.0.3 → >=0.0.3 <0.0.4
    expect(satisfies('0.0.3', '^0.0.3')).toBe(true)
    expect(satisfies('0.0.4', '^0.0.3')).toBe(false)
    // partial caret ^1 → >=1.0.0 <2.0.0
    expect(satisfies('1.9.9', '^1')).toBe(true)
    expect(satisfies('2.0.0', '^1')).toBe(false)
  })

  it('applies tilde semantics', () => {
    expect(satisfies('1.2.9', '~1.2.3')).toBe(true)
    expect(satisfies('1.3.0', '~1.2.3')).toBe(false)
    // ~1.2 → >=1.2.0 <1.3.0
    expect(satisfies('1.2.0', '~1.2')).toBe(true)
    expect(satisfies('1.3.0', '~1.2')).toBe(false)
    // ~1 → >=1.0.0 <2.0.0
    expect(satisfies('1.9.0', '~1')).toBe(true)
    expect(satisfies('2.0.0', '~1')).toBe(false)
  })

  it('applies comparator ranges (AND across whitespace)', () => {
    expect(satisfies('1.5.0', '>=1.2.0 <2.0.0')).toBe(true)
    expect(satisfies('2.0.0', '>=1.2.0 <2.0.0')).toBe(false)
    expect(satisfies('1.1.0', '>=1.2.0 <2.0.0')).toBe(false)
    expect(satisfies('1.2.1', '>1.2.0')).toBe(true)
    expect(satisfies('1.2.0', '>1.2.0')).toBe(false)
    expect(satisfies('1.2.0', '<=1.2.0')).toBe(true)
  })

  it('applies OR across ||', () => {
    expect(satisfies('1.5.0', '^1.0.0 || ^2.0.0')).toBe(true)
    expect(satisfies('2.5.0', '^1.0.0 || ^2.0.0')).toBe(true)
    expect(satisfies('3.0.0', '^1.0.0 || ^2.0.0')).toBe(false)
  })

  it('treats a prerelease/build as its release triple', () => {
    expect(satisfies('1.2.3-beta.1', '^1.2.0')).toBe(true)
    expect(satisfies('1.2.3+build.5', '1.2.3')).toBe(true)
  })

  it('throws on an unparseable range or version', () => {
    expect(() => satisfies('1.2.3', '>=notaversion')).toThrow()
    expect(() => satisfies('1.2.3', '^')).toThrow()
    expect(() => satisfies('notaversion', '^1.0.0')).toThrow()
  })
})
