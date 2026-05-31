/**
 * Unit tests for the error code registry, response envelope helpers, and
 * operation-type routing. The companion errors-mirror.test.ts asserts that
 * every code:'X' literal in the source tree is registered here — adding
 * a new code without a registry entry will fail there, not here.
 */

import { describe, expect, it } from 'vitest'

import {
  ERROR_CODES,
  type ErrorCode,
  isErrorCode,
  StagewrightError,
  estimateTokens,
  getSessionId,
  makeError,
  makeSuccess,
  OperationTypeSchema,
  type OperationType,
  validateCommandContent,
  validateEvalContent,
  routeByOperationType,
  DANGEROUS_EVAL_KEYWORDS_FOR_TESTS,
} from '../src/errors/index.js'
import * as opTypeModule from '../src/errors/operation-type.js'

const FIXED_NOW = 1_700_000_000_000

describe('ERROR_CODES registry', () => {
  it('every entry exposes the required four-field shape', () => {
    for (const [code, def] of Object.entries(ERROR_CODES)) {
      expect(typeof def.http, `${code}.http`).toBe('number')
      expect(Number.isInteger(def.http), `${code}.http should be an integer`).toBe(true)
      expect(def.http, `${code}.http`).toBeGreaterThanOrEqual(400)
      expect(def.http, `${code}.http`).toBeLessThanOrEqual(599)
      expect(typeof def.retryable, `${code}.retryable`).toBe('boolean')
      expect(typeof def.hint, `${code}.hint`).toBe('string')
      expect(def.hint.length, `${code}.hint should not be empty`).toBeGreaterThan(0)
    }
  })

  it('exposes the agent-UX-critical codes called out in ADR-007', () => {
    // Sanity: ADR-007 cites specific codes in tool descriptions. They must exist.
    const required: ErrorCode[] = [
      'NOT_RUNNING',
      'REF_NOT_FOUND',
      'SELECTOR_NO_MATCH',
      'ELEMENT_NOT_VISIBLE',
      'ELEMENT_DISABLED',
      'TRANSPORT_UNSUPPORTED',
      'EVAL_BLOCKED_KEYWORD',
      'INTERNAL_ERROR',
    ]
    for (const code of required) {
      expect(ERROR_CODES[code], `${code} must exist for ADR-007 compliance`).toBeDefined()
    }
  })

  it('isErrorCode narrows correctly for registered and unregistered strings', () => {
    expect(isErrorCode('NOT_RUNNING')).toBe(true)
    expect(isErrorCode('REF_NOT_FOUND')).toBe(true)
    expect(isErrorCode('FAKE_CODE_THAT_DOES_NOT_EXIST')).toBe(false)
    expect(isErrorCode('')).toBe(false)
  })
})

describe('StagewrightError', () => {
  it('uses the registry hint when no message is supplied', () => {
    const err = new StagewrightError('REF_NOT_FOUND')
    expect(err.code).toBe('REF_NOT_FOUND')
    expect(err.message).toBe(ERROR_CODES.REF_NOT_FOUND.hint)
    expect(err.name).toBe('StagewrightError')
  })

  it('carries optional structured details', () => {
    const err = new StagewrightError('BAD_ARGUMENT', 'custom', { field: 'selector' })
    expect(err.message).toBe('custom')
    expect(err.details).toEqual({ field: 'selector' })
  })

  it('preserves StagewrightError identity through instanceof', () => {
    const err = new StagewrightError('NOT_RUNNING')
    expect(err).toBeInstanceOf(StagewrightError)
    expect(err).toBeInstanceOf(Error)
  })
})

describe('estimateTokens', () => {
  it('returns 0 for null / undefined / empty string payloads', () => {
    expect(estimateTokens(null)).toBe(0)
    expect(estimateTokens(undefined)).toBe(0)
    expect(estimateTokens('')).toBe(0)
  })

  it('floors non-empty payloads at 1', () => {
    // JSON.stringify({}) === '{}' — 2 chars / 4 = 0.5, ceil = 1
    expect(estimateTokens({})).toBe(1)
    expect(estimateTokens('a')).toBe(1)
    expect(estimateTokens('abcd')).toBe(1)
  })

  it('scales linearly via char/4 heuristic', () => {
    const eightChars = 'abcdefgh'
    expect(estimateTokens(eightChars)).toBe(2)
    const longString = 'x'.repeat(400)
    expect(estimateTokens(longString)).toBe(100)
  })

  it('handles JSON-unsafe values via String() fallback without throwing', () => {
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    // Must not throw; falls back to String(payload).
    expect(() => estimateTokens(circular)).not.toThrow()
    expect(estimateTokens(circular)).toBeGreaterThan(0)

    expect(() => estimateTokens(123n)).not.toThrow()
    expect(estimateTokens(Symbol('x'))).toBeGreaterThan(0)
  })
})

describe('getSessionId placeholder', () => {
  it('returns undefined until the dispatcher wires session lifecycle', () => {
    expect(getSessionId()).toBeUndefined()
  })
})

describe('makeError', () => {
  it('hydrates http, retryable, and hint from the registry', () => {
    const env = makeError('REF_NOT_FOUND', { now: () => FIXED_NOW, startedAt: FIXED_NOW })
    expect(env.ok).toBe(false)
    expect(env.code).toBe('REF_NOT_FOUND')
    expect(env.http).toBe(404)
    expect(env.retryable).toBe(false)
    expect(env.hint).toBe(ERROR_CODES.REF_NOT_FOUND.hint)
    expect(env.error).toBe(ERROR_CODES.REF_NOT_FOUND.hint)
  })

  it('overrides the human-readable message via opts.message', () => {
    const env = makeError('BAD_ARGUMENT', {
      message: 'selector and ref are mutually exclusive',
      now: () => FIXED_NOW,
      startedAt: FIXED_NOW,
    })
    expect(env.error).toBe('selector and ref are mutually exclusive')
    // Hint comes from registry regardless of message override.
    expect(env.hint).toBe(ERROR_CODES.BAD_ARGUMENT.hint)
  })

  it('reports deterministic elapsed_ms from injected now()', () => {
    let tick = FIXED_NOW
    const now = () => tick
    const startedAt = tick
    tick += 42
    const env = makeError('CDP_DISCONNECTED', { now, startedAt })
    expect(env._meta.elapsed_ms).toBe(42)
  })

  it('floors elapsed_ms at 0 when now() runs backwards', () => {
    const env = makeError('LAUNCH_TIMEOUT', {
      now: () => FIXED_NOW,
      startedAt: FIXED_NOW + 100,
    })
    expect(env._meta.elapsed_ms).toBe(0)
  })

  it('attaches next_actions and similar_refs when provided', () => {
    const env = makeError('REF_NOT_FOUND', {
      next_actions: ['snapshot()', 'wait_for_state({ ref: 5 })'],
      similar_refs: [
        { ref: 9, role: 'button', name: 'Submit' },
        { ref: 12, role: 'button', name: 'Cancel' },
      ],
      now: () => FIXED_NOW,
      startedAt: FIXED_NOW,
    })
    expect(env.next_actions).toEqual(['snapshot()', 'wait_for_state({ ref: 5 })'])
    expect(env.similar_refs).toHaveLength(2)
    expect(env.similar_refs?.[0]?.name).toBe('Submit')
  })

  it('attaches structured details when provided', () => {
    const env = makeError('BAD_ARGUMENT', {
      details: { field: 'selector', issue: 'missing' },
      now: () => FIXED_NOW,
      startedAt: FIXED_NOW,
    })
    expect(env.details).toEqual({ field: 'selector', issue: 'missing' })
  })

  it('omits optional fields when not provided (exactOptionalPropertyTypes)', () => {
    const env = makeError('NOT_RUNNING', { now: () => FIXED_NOW, startedAt: FIXED_NOW })
    expect(Object.prototype.hasOwnProperty.call(env, 'next_actions')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(env, 'similar_refs')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(env, 'details')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(env._meta, 'session_id')).toBe(false)
  })

  it('attaches session_id when supplied via opts', () => {
    const env = makeError('NOT_RUNNING', {
      session_id: 'sess-123',
      now: () => FIXED_NOW,
      startedAt: FIXED_NOW,
    })
    expect(env._meta.session_id).toBe('sess-123')
  })

  it('estimated_tokens > 0 for every non-trivial payload', () => {
    const env = makeError('NOT_RUNNING', { now: () => FIXED_NOW, startedAt: FIXED_NOW })
    expect(env._meta.estimated_tokens).toBeGreaterThan(0)
  })

  it('throws a clear error when details is not JSON-serialisable', () => {
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    expect(() =>
      makeError('INTERNAL_ERROR', {
        details: circular,
        now: () => FIXED_NOW,
        startedAt: FIXED_NOW,
      }),
    ).toThrowError(/not JSON-serialisable/)
  })
})

describe('makeSuccess', () => {
  it('spreads tool-specific data at the envelope root', () => {
    const env = makeSuccess(
      { ref: 5, settled: true },
      { now: () => FIXED_NOW, startedAt: FIXED_NOW - 10 },
    )
    expect(env.ok).toBe(true)
    expect(env.ref).toBe(5)
    expect(env.settled).toBe(true)
    expect(env._meta.elapsed_ms).toBe(10)
    expect(env._meta.estimated_tokens).toBeGreaterThan(0)
  })

  it('omits session_id from _meta when getSessionId returns undefined', () => {
    const env = makeSuccess({ x: 1 }, { now: () => FIXED_NOW, startedAt: FIXED_NOW })
    expect(Object.prototype.hasOwnProperty.call(env._meta, 'session_id')).toBe(false)
  })

  it('attaches session_id when supplied via opts', () => {
    const env = makeSuccess(
      { x: 1 },
      { session_id: 'sess-abc', now: () => FIXED_NOW, startedAt: FIXED_NOW },
    )
    expect(env._meta.session_id).toBe('sess-abc')
  })

  it('keeps the ok discriminator stable even if tool data includes an ok key', () => {
    const env = makeSuccess(
      { ok: false as boolean, value: 1 },
      { now: () => FIXED_NOW, startedAt: FIXED_NOW },
    )
    expect(env.ok).toBe(true)
    expect(env.value).toBe(1)
  })
})

describe('OperationType discriminator', () => {
  it('accepts each registered operation type', () => {
    const valid: OperationType[] = [
      'command',
      'query',
      'eval',
      'screenshot',
      'logs',
      'dialog',
      'window_info',
    ]
    for (const op of valid) {
      expect(OperationTypeSchema.parse(op)).toBe(op)
    }
  })

  it('rejects unknown operation types', () => {
    expect(() => OperationTypeSchema.parse('rm-rf')).toThrow()
    expect(() => OperationTypeSchema.parse('')).toThrow()
    expect(() => OperationTypeSchema.parse(undefined)).toThrow()
  })
})

describe('validateCommandContent (stub)', () => {
  it('accepts every input while command validation remains a routing hook', () => {
    expect(() => validateCommandContent({})).not.toThrow()
    expect(() => validateCommandContent('any string')).not.toThrow()
    expect(() => validateCommandContent(null)).not.toThrow()
    expect(() => validateCommandContent(undefined)).not.toThrow()
  })
})

describe('validateEvalContent', () => {
  it('passes through non-string inputs (dispatcher catches BAD_ARGUMENT upstream)', () => {
    expect(() => validateEvalContent(123)).not.toThrow()
    expect(() => validateEvalContent(null)).not.toThrow()
    expect(() => validateEvalContent({})).not.toThrow()
  })

  it('accepts benign string payloads', () => {
    expect(() => validateEvalContent('return 1 + 1')).not.toThrow()
    expect(() => validateEvalContent('document.title')).not.toThrow()
  })

  it('checks common object-shaped eval source fields without treating data args as code', () => {
    expect(() => validateEvalContent({ body: 'process.exit(0)' })).toThrow(StagewrightError)
    expect(() => validateEvalContent({ code: 'require("fs")' })).toThrow(StagewrightError)
    expect(() => validateEvalContent({ body: 'return arg', arg: 'process.exit(0)' })).not.toThrow()
  })

  it('rejects every keyword in the DANGEROUS list with EVAL_BLOCKED_KEYWORD', () => {
    for (const keyword of DANGEROUS_EVAL_KEYWORDS_FOR_TESTS) {
      expect(() => validateEvalContent(`code containing ${keyword} inline`)).toThrow(
        StagewrightError,
      )
      try {
        validateEvalContent(`code containing ${keyword} inline`)
      } catch (err) {
        expect(err).toBeInstanceOf(StagewrightError)
        if (err instanceof StagewrightError) {
          expect(err.code).toBe('EVAL_BLOCKED_KEYWORD')
          expect(err.details).toEqual({ keyword })
        }
      }
    }
  })

  it('bypasses the blocklist when allowDangerous is true', () => {
    expect(() => validateEvalContent('process.exit(0)', { allowDangerous: true })).not.toThrow()
    expect(() => validateEvalContent('require("fs")', { allowDangerous: true })).not.toThrow()
  })
})

describe('routeByOperationType', () => {
  it("routes 'eval' through validateEvalContent (blocks dangerous keywords)", () => {
    expect(() => routeByOperationType('eval', 'process.exit(0)')).toThrow(StagewrightError)
  })

  it("routes object-shaped 'eval' payloads through validateEvalContent", () => {
    expect(() => routeByOperationType('eval', { body: 'process.exit(0)' })).toThrow(
      StagewrightError,
    )
  })

  it("routes 'command' through validateCommandContent (accepts everything today)", () => {
    expect(() => routeByOperationType('command', 'process.exit(0)')).not.toThrow()
  })

  it("routes 'query', 'screenshot', 'logs', 'dialog', 'window_info' through validateCommandContent", () => {
    const nonEvalOps: OperationType[] = ['query', 'screenshot', 'logs', 'dialog', 'window_info']
    for (const op of nonEvalOps) {
      expect(() => routeByOperationType(op, 'process.exit(0)')).not.toThrow()
    }
  })

  it('passes eval validation options through the router', () => {
    expect(() =>
      routeByOperationType('eval', 'process.exit(0)', { allowDangerous: true }),
    ).not.toThrow()
  })
})

describe('manifest-level OperationTypeSchema validation (boot-time fail-closed)', () => {
  // The fails-closed property used to live in routeByOperationType as a runtime
  // guard against missing/unknown operationType from the agent input. Now that
  // operationType is internal manifest metadata, the guard moves earlier: the
  // dispatcher validates each tool's declared operationType at registration time
  // via OperationTypeSchema.parse(). These tests pin the boot-time contract.

  it('parses every valid operation type', () => {
    const valid: OperationType[] = [
      'command',
      'query',
      'eval',
      'screenshot',
      'logs',
      'dialog',
      'window_info',
    ]
    for (const op of valid) {
      expect(OperationTypeSchema.parse(op)).toBe(op)
    }
  })

  it('rejects undefined / null / unknown values at parse time', () => {
    expect(() => OperationTypeSchema.parse(undefined)).toThrow()
    expect(() => OperationTypeSchema.parse(null)).toThrow()
    expect(() => OperationTypeSchema.parse('unknown')).toThrow()
    expect(() => OperationTypeSchema.parse('')).toThrow()
  })
})

describe('module identity', () => {
  it('re-exports operation-type module symbols through the barrel', () => {
    expect(opTypeModule.OperationTypeSchema).toBe(OperationTypeSchema)
    expect(opTypeModule.validateEvalContent).toBe(validateEvalContent)
  })
})
