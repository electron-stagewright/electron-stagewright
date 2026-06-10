/**
 * Unit tests for the best-effort ReDoS guard. The detector must reject the catastrophic
 * nested-quantifier family (it gates a client-supplied regex that runs on the server event loop in
 * electron_console_logs) while NOT rejecting the ordinary patterns an agent legitimately uses.
 */

import { describe, expect, it } from 'vitest'

import { MAX_USER_REGEX_LENGTH, describeRegexSafety } from '../src/tools/regex-safety.js'

describe('describeRegexSafety', () => {
  it('rejects the classic nested-quantifier ReDoS shapes', () => {
    for (const evil of [
      '(a+)+',
      '(a+)+$',
      '(a*)*',
      '(a+)*',
      '(a*)+',
      '([a-z]+)*',
      '(\\d+)+',
      '((a+))+', // deeper nesting must still be caught via propagation
      '(a+){2,}',
      '(ab+)+c',
      '(.*)*',
    ]) {
      expect(describeRegexSafety(evil), evil).not.toBeNull()
    }
  })

  it('accepts ordinary, linear-time patterns an agent legitimately uses', () => {
    for (const safe of [
      'error',
      'error|warning',
      '^\\[ERROR\\]',
      'foo.*bar',
      'user-\\d+',
      '[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}',
      '(abc)+', // a repeated group with NO inner quantifier is linear
      '(foo|bar)+',
      '\\d{3}-\\d{4}',
      'a?b?c?',
      'https?://\\S+',
    ]) {
      expect(describeRegexSafety(safe), safe).toBeNull()
    }
  })

  it('rejects an over-long pattern', () => {
    expect(describeRegexSafety('a'.repeat(MAX_USER_REGEX_LENGTH + 1))).toContain('too long')
  })

  it('does not treat an escaped quantifier as a repetition', () => {
    // \( and \) are literal parens; \+ is a literal plus — no real nesting here.
    expect(describeRegexSafety('\\(a\\+\\)\\+')).toBeNull()
  })
})
