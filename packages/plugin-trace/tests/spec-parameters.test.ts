/**
 * Unit tests for parameterized replay specs (ADR-026 amendment): declared typed parameters,
 * whole-value placeholders, validation before the first dispatch, sensitive-value redaction, and
 * the promotion helper that turns recorded values into parameters.
 */

import type { ToolResult } from '@electron-stagewright/core'
import { describe, expect, it, vi } from 'vitest'

import type { TraceCallRecord } from '../src/recorder.js'
import {
  ReplayParameterError,
  parseReplaySpec,
  prepareReplaySpec,
  promoteTraceWithParameters,
  replaySpec,
  sensitiveArgumentKeys,
} from '../src/spec.js'

const ABS = process.platform === 'win32' ? 'C:\\data\\dump.sql' : '/data/dump.sql'

function result(value: Record<string, unknown>): ToolResult {
  return { ok: true, _meta: { estimated_tokens: 1, elapsed_ms: 1 }, ...value } as ToolResult
}

function spec(parameters: Record<string, unknown>, steps: unknown[]) {
  return parseReplaySpec({
    format: 'stagewright-replay',
    version: 2,
    parameters,
    steps,
  })
}

const languageSpec = () =>
  spec(
    {
      language: { type: 'string', enum: ['en', 'es'], default: 'en' },
      width: { type: 'integer', minimum: 640, maximum: 3840 },
      dark: { type: 'boolean', default: false },
      dump: { type: 'path' },
    },
    [
      {
        tool: 'storage_local_set',
        args: { key: 'language', value: { $param: 'language' } },
        expect: { ok: true },
      },
      {
        tool: 'electron_set_window_size',
        args: { width: { $param: 'width' }, height: 720, dark: { $param: 'dark' } },
        expect: { ok: true },
      },
      {
        tool: 'native_file_dialog_arm',
        args: { responses: [{ kind: 'open', paths: [{ $param: 'dump' }] }] },
        expect: { ok: true },
      },
      {
        tool: 'electron_get_text',
        args: { selector: 'html' },
        expect: { result: { mode: 'subset', value: { lang: { $param: 'language' } } } },
      },
    ],
  )

describe('replaySpec with parameters', () => {
  it('redacts sensitive numbers and short secrets by value, and by name in parameters', async () => {
    const pinSpec = spec(
      { pin: { type: 'integer', sensitive: true }, code: { type: 'string', sensitive: true } },
      [
        {
          tool: 'unlock',
          args: { pin: { $param: 'pin' }, code: { $param: 'code' } },
          expect: { result: { mode: 'exact', value: { never: true } } },
        },
      ],
    )
    const report = await replaySpec(
      pinSpec,
      {
        dispatch: async () =>
          result({
            pin: 4821,
            pinText: '4821',
            sentence: 'PIN 4821 accepted',
            code: 'ab',
            note: 'a cab',
          }),
      },
      { parameters: { pin: '4821', code: 'ab' } },
    )
    expect(report.parameters).toEqual({ pin: '[redacted]', code: '[redacted]' })
    expect(report.steps[0]?.actual).toMatchObject({
      pin: '[redacted]',
      pinText: '[redacted]',
      sentence: 'PIN [redacted] accepted',
      code: '[redacted]',
      // A two-character secret is not searched for inside other text.
      note: 'a cab',
    })
  })

  it('treats inherited object keys as undeclared and unknown', () => {
    const step = { tool: 't', args: { x: { $param: 'constructor' } }, expect: { ok: true } }
    expect(() =>
      prepareReplaySpec(
        spec({ a: { type: 'string' } }, [step, { ...step, args: { y: { $param: 'a' } } }]),
        {
          a: 'v',
        },
      ),
    ).toThrow(/Placeholder "constructor" has no declared parameter/)
    const ok = spec({ a: { type: 'string' } }, [{ ...step, args: { y: { $param: 'a' } } }])
    expect(() => prepareReplaySpec(ok, { a: 'v', toString: 'x' })).toThrow(
      /Unknown parameter "toString"/,
    )
  })

  it('accepts only decimal numbers from strings', () => {
    const numberSpec = spec({ n: { type: 'number' } }, [
      { tool: 't', args: { n: { $param: 'n' } }, expect: { ok: true } },
    ])
    expect(prepareReplaySpec(numberSpec, { n: '-1.5' }).parameters).toEqual({ n: -1.5 })
    for (const raw of ['0x10', '1e3', ' ', 'Infinity']) {
      expect(() => prepareReplaySpec(numberSpec, { n: raw })).toThrow(/must be a number/)
    }
  })

  it('substitutes whole values in args and matchers, coercing CLI strings', async () => {
    const calls: { tool: string; args: unknown }[] = []
    const report = await replaySpec(
      languageSpec(),
      {
        dispatch: async (tool, args) => {
          calls.push({ tool, args })
          return result({ lang: 'es' })
        },
      },
      { parameters: { language: 'es', width: '1280', dark: 'true', dump: ABS } },
    )
    expect(calls.map((call) => call.args)).toEqual([
      { key: 'language', value: 'es' },
      { width: 1280, height: 720, dark: true },
      { responses: [{ kind: 'open', paths: [ABS] }] },
      { selector: 'html' },
    ])
    expect(report).toMatchObject({
      passed: true,
      parameters: { language: 'es', width: 1280, dark: true, dump: ABS },
    })
  })

  it('uses defaults for parameters that were not supplied', () => {
    const prepared = prepareReplaySpec(languageSpec(), { width: 1024, dump: ABS })
    expect(prepared.parameters).toEqual({ language: 'en', width: 1024, dark: false, dump: ABS })
  })

  it('refuses every value problem before dispatching anything', async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ width: 1280, dump: ABS, colour: 'red' }, /Unknown parameter "colour"/],
      [{ dump: ABS }, /Missing a value for parameter "width"/],
      [{ width: 1280, dump: ABS, language: 'fr' }, /must be one of en, es/],
      [{ width: 100, dump: ABS }, /must be at least 640/],
      [{ width: 1280.5, dump: ABS }, /must be an integer/],
      [{ width: 'wide', dump: ABS }, /must be a number/],
      [{ width: 1280, dump: ABS, dark: 'yes' }, /must be true or false/],
      [{ width: 1280, dump: 'data/dump.sql' }, /must be an absolute path/],
    ]
    for (const [parameters, message] of cases) {
      const dispatch = vi.fn()
      const run = replaySpec(languageSpec(), { dispatch }, { parameters })
      await expect(run).rejects.toThrow(message)
      await expect(run).rejects.toMatchObject({ kind: 'value' })
      expect(dispatch).not.toHaveBeenCalled()
    }
  })

  it('refuses spec problems: undeclared, unused, malformed and v1 placeholders, bad defaults', () => {
    const step = (args: unknown) => ({ tool: 't', args, expect: { ok: true } })
    const cases: [() => unknown, RegExp][] = [
      [
        () =>
          spec({ a: { type: 'string' } }, [
            step({ x: { $param: 'b' } }),
            step({ y: { $param: 'a' } }),
          ]),
        /Placeholder "b" has no declared parameter/,
      ],
      [
        () =>
          spec({ a: { type: 'string' }, b: { type: 'string' } }, [step({ x: { $param: 'a' } })]),
        /Parameter "b" is declared but no step uses it/,
      ],
      [
        () => spec({ a: { type: 'string' } }, [step({ x: { $param: 'a', extra: 1 } })]),
        /a placeholder is exactly/,
      ],
      [
        () =>
          spec({ a: { type: 'integer', minimum: 10, default: 5 } }, [step({ x: { $param: 'a' } })]),
        /Parameter "a" default must be at least 10/,
      ],
      [
        () => spec({ a: { type: 'string', pattern: '(a+)+$' } }, [step({ x: { $param: 'a' } })]),
        /unsafe pattern/,
      ],
      [
        () =>
          parseReplaySpec({
            format: 'stagewright-replay',
            version: 1,
            steps: [step({ x: { $param: 'a' } })],
          }),
        /need a version 2 spec/,
      ],
    ]
    for (const [build, message] of cases) {
      expect(() => prepareReplaySpec(build() as never, {})).toThrow(message)
      try {
        prepareReplaySpec(build() as never, {})
      } catch (error) {
        expect(error).toBeInstanceOf(ReplayParameterError)
        expect((error as ReplayParameterError).kind).toBe('spec')
      }
    }
  })

  it('rejects a version 2 spec without parameters or with a bad parameter name', () => {
    const base = { format: 'stagewright-replay', version: 2, steps: [] }
    expect(() => parseReplaySpec({ ...base, parameters: {} })).toThrow(/at least one parameter/)
    expect(() =>
      parseReplaySpec({ ...base, parameters: { 'bad-name': { type: 'string' } } }),
    ).toThrow(/letters, digits and _/)
    expect(() => parseReplaySpec({ ...base })).toThrow(/Invalid replay spec/)
  })

  it('redacts sensitive values in the report and names the args that carry them', async () => {
    const secretSpec = spec(
      { token: { type: 'string', sensitive: true }, user: { type: 'string' } },
      [
        {
          tool: 'login',
          args: { user: { $param: 'user' }, token: { $param: 'token' } },
          expect: { result: { mode: 'subset', value: { echoed: { $param: 'token' } } } },
        },
        { tool: 'headers', args: { headers: [{ $param: 'token' }] }, expect: { ok: true } },
      ],
    )
    expect(sensitiveArgumentKeys(secretSpec)).toEqual(['token', 'headers'])
    const report = await replaySpec(
      secretSpec,
      { dispatch: async () => result({ echoed: 'other s3cret-value here' }) },
      { parameters: { token: 's3cret-value', user: 'ada' } },
    )
    const text = JSON.stringify(report)
    expect(text).not.toContain('s3cret-value')
    expect(report.parameters).toEqual({ token: '[redacted]', user: 'ada' })
    expect(report.steps[0]).toMatchObject({
      matched: false,
      expected: { echoed: '[redacted]' },
      actual: expect.objectContaining({ echoed: 'other [redacted] here' }),
    })
  })
})

function call(tool: string, args: unknown, sessionId = 's1'): TraceCallRecord {
  return {
    kind: 'call',
    tool,
    ok: true,
    started_at: 0,
    finished_at: 1,
    elapsed_ms: 1,
    estimated_tokens: 1,
    args,
    result: { ok: true, _meta: { session_id: sessionId } },
  }
}

describe('promoteTraceWithParameters', () => {
  const calls = [
    call('electron_launch', { main: '/app/main.js' }),
    call('storage_local_set', { sessionId: 's1', key: 'language', value: 'es' }),
    call('electron_expect_text', { sessionId: 's1', selector: 'h1', contains: 'es' }),
    call('login', { sessionId: 's1', token: 'tok-123' }),
  ]

  it('turns recorded values into placeholders and declares them with their defaults', () => {
    const promoted = promoteTraceWithParameters(calls, {
      parameters: {
        language: { definition: { type: 'string', enum: ['en', 'es'] }, value: 'es' },
        token: { definition: { type: 'string', sensitive: true }, value: 'tok-123' },
      },
      redactions: ['args.token'],
    })
    expect(promoted.replaced).toEqual({ language: 2, token: 1 })
    expect(promoted.spec).toMatchObject({
      version: 2,
      parameters: {
        language: { type: 'string', enum: ['en', 'es'], default: 'es' },
        token: { type: 'string', sensitive: true },
      },
    })
    expect(promoted.spec.version === 2 && promoted.spec.parameters['token']).not.toHaveProperty(
      'default',
    )
    expect(promoted.spec.steps[1]?.args).toMatchObject({ value: { $param: 'language' } })
    // Redaction keeps the placeholder instead of writing "[redacted]" over it.
    expect(promoted.spec.steps[3]?.args).toMatchObject({ token: { $param: 'token' } })
    // The promoted spec runs: every placeholder is declared and used.
    expect(() => prepareReplaySpec(promoted.spec, { token: 'x' })).not.toThrow()
  })

  it('never writes a sensitive default, refuses a redacted value without sensitive, and skips session ids', () => {
    const sensitive = promoteTraceWithParameters(calls, {
      parameters: {
        token: {
          definition: { type: 'string', sensitive: true, default: 'tok-123' },
          value: 'tok-123',
        },
      },
    })
    expect(sensitive.spec.version === 2 && sensitive.spec.parameters['token']).toEqual({
      type: 'string',
      sensitive: true,
    })
    expect(() =>
      promoteTraceWithParameters(calls, {
        parameters: { token: { definition: { type: 'string' }, value: 'tok-123' } },
        redactions: ['args.token'],
      }),
    ).toThrow(/replaces a redacted argument; declare it sensitive/)
    // "s1" is the recorded session id: it stays a session placeholder, so the parameter matches nothing.
    expect(() =>
      promoteTraceWithParameters(calls, {
        parameters: { session: { definition: { type: 'string' }, value: 's1' } },
      }),
    ).toThrow(/matched no recorded argument value/)
  })

  it('refuses a parameter that matches nothing or breaks its own constraints', () => {
    expect(() =>
      promoteTraceWithParameters(calls, {
        parameters: { theme: { definition: { type: 'string' }, value: 'dark' } },
      }),
    ).toThrow(/matched no recorded argument value/)
    expect(() =>
      promoteTraceWithParameters(calls, {
        parameters: { language: { definition: { type: 'string', enum: ['en'] }, value: 'es' } },
      }),
    ).toThrow(/must be one of en/)
  })
})
