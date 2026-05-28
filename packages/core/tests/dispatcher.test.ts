/**
 * Unit tests for the {@link Dispatcher}: registration-time validation, input
 * validation, error mapping, eval-flag gating, slow-op logging, the manifest,
 * and session-id correlation through AsyncLocalStorage.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { type ErrorResponse, type SuccessResponse, makeSuccess } from '../src/errors/envelope.js'
import { StagewrightError } from '../src/errors/registry.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { StderrLogger } from '../src/server/logger.js'
import { type AnyToolDefinition, defineTool } from '../src/tools/types.js'

function newDispatcher(opts: { allowEval?: boolean } = {}): Dispatcher {
  return new Dispatcher({ sessions: new SessionManager(), allowEval: opts.allowEval ?? false })
}

const echoTool = defineTool({
  name: 'test_echo',
  description: 'Echo the value back.',
  inputSchema: z.object({ value: z.string() }),
  operationType: 'query',
  handler: async (args, ctx) =>
    makeSuccess({ echo: args.value }, { startedAt: ctx.startedAt, now: ctx.now }),
})

describe('Dispatcher registration', () => {
  it('rejects a tool with an invalid operationType at registration', () => {
    const d = newDispatcher()
    const bad = {
      name: 'test_bad',
      description: 'x',
      inputSchema: z.object({}),
      operationType: 'frobnicate',
      handler: async () => makeSuccess({}),
    } as unknown as AnyToolDefinition
    expect(() => d.register(bad)).toThrow(/invalid operationType/i)
  })

  it('rejects a duplicate tool name', () => {
    const d = newDispatcher()
    d.register(echoTool)
    expect(() => d.register(echoTool)).toThrow(/duplicate/i)
  })

  it('hides eval-gated tools unless the eval flag is set', () => {
    const evalTool = defineTool({
      name: 'test_eval',
      description: 'x',
      inputSchema: z.object({}),
      operationType: 'eval',
      requiresEvalFlag: true,
      handler: async (_args, ctx) => makeSuccess({}, { startedAt: ctx.startedAt, now: ctx.now }),
    })
    const off = newDispatcher({ allowEval: false })
    off.register(evalTool)
    expect(off.has('test_eval')).toBe(false)

    const on = newDispatcher({ allowEval: true })
    on.register(evalTool)
    expect(on.has('test_eval')).toBe(true)
  })

  it('rejects eval tools that do not declare the eval flag gate', () => {
    const d = newDispatcher({ allowEval: true })
    const evalTool = defineTool({
      name: 'test_eval_ungated',
      description: 'x',
      inputSchema: z.object({ body: z.string() }),
      operationType: 'eval',
      handler: async (_args, ctx) => makeSuccess({}, { startedAt: ctx.startedAt, now: ctx.now }),
    })

    expect(() => d.register(evalTool)).toThrow(/requiresEvalFlag/i)
  })
})

describe('Dispatcher dispatch', () => {
  it('runs a tool and returns its success envelope', async () => {
    const d = newDispatcher()
    d.register(echoTool)
    const res = await d.dispatch('test_echo', { value: 'hi' })
    expect(res).toMatchObject({ ok: true, echo: 'hi' })
    expect((res as SuccessResponse)._meta.estimated_tokens).toBeGreaterThan(0)
  })

  it('returns BAD_ARGUMENT for an unknown tool', async () => {
    const d = newDispatcher()
    const res = await d.dispatch('test_missing', {})
    expect(res.ok).toBe(false)
    expect((res as ErrorResponse).code).toBe('BAD_ARGUMENT')
  })

  it('returns BAD_ARGUMENT with issues for invalid arguments', async () => {
    const d = newDispatcher()
    d.register(echoTool)
    const res = await d.dispatch('test_echo', { value: 123 })
    expect(res.ok).toBe(false)
    expect((res as ErrorResponse).code).toBe('BAD_ARGUMENT')
    const issues = (res as ErrorResponse).details?.['issues']
    expect(Array.isArray(issues)).toBe(true)
  })

  it('maps a thrown StagewrightError to its code', async () => {
    const d = newDispatcher()
    d.register(
      defineTool({
        name: 'test_throw_sw',
        description: 'x',
        inputSchema: z.object({}),
        operationType: 'query',
        handler: async () => {
          throw new StagewrightError('NOT_RUNNING', 'no app here')
        },
      }),
    )
    const res = await d.dispatch('test_throw_sw', {})
    expect(res.ok).toBe(false)
    expect((res as ErrorResponse).code).toBe('NOT_RUNNING')
    expect((res as ErrorResponse).error).toBe('no app here')
  })

  it('maps an unexpected throw to INTERNAL_ERROR', async () => {
    const d = newDispatcher()
    d.register(
      defineTool({
        name: 'test_throw_raw',
        description: 'x',
        inputSchema: z.object({}),
        operationType: 'query',
        handler: async () => {
          throw new Error('boom')
        },
      }),
    )
    const res = await d.dispatch('test_throw_raw', {})
    expect(res.ok).toBe(false)
    expect((res as ErrorResponse).code).toBe('INTERNAL_ERROR')
    expect((res as ErrorResponse).error).toBe('boom')
  })

  it('routes object-shaped eval arguments through the keyword blocklist', async () => {
    const d = newDispatcher({ allowEval: true })
    let called = false
    d.register(
      defineTool({
        name: 'test_eval_body',
        description: 'x',
        inputSchema: z.object({ body: z.string() }),
        operationType: 'eval',
        requiresEvalFlag: true,
        handler: async (_args, ctx) => {
          called = true
          return makeSuccess({}, { startedAt: ctx.startedAt, now: ctx.now })
        },
      }),
    )

    const res = await d.dispatch('test_eval_body', { body: 'process.exit(0)' })
    expect(res.ok).toBe(false)
    expect((res as ErrorResponse).code).toBe('EVAL_BLOCKED_KEYWORD')
    expect(called).toBe(false)
  })

  it('logs a slow-op warning when a dispatch exceeds the threshold', async () => {
    let clock = 0
    const now = (): number => clock
    const lines: string[] = []
    const logger = new StderrLogger({ level: 'debug', sink: (l) => lines.push(l) })
    const d = new Dispatcher({
      sessions: new SessionManager(),
      logger,
      now,
      slowOpThresholdMs: 1000,
    })
    d.register(
      defineTool({
        name: 'test_slow',
        description: 'x',
        inputSchema: z.object({}),
        operationType: 'query',
        handler: async (_args, ctx) => {
          clock += 2000
          return makeSuccess({}, { startedAt: ctx.startedAt, now: ctx.now })
        },
      }),
    )
    await d.dispatch('test_slow', {})
    expect(lines.some((l) => l.includes('Slow tool execution'))).toBe(true)
  })

  it('never throws — a non-serialisable detail falls back to a clean envelope', async () => {
    const d = newDispatcher()
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    d.register(
      defineTool({
        name: 'test_bad_details',
        description: 'x',
        inputSchema: z.object({}),
        operationType: 'query',
        handler: async () => {
          throw new StagewrightError('INTERNAL_ERROR', 'with bad details', circular)
        },
      }),
    )
    const res = await d.dispatch('test_bad_details', {})
    expect(res.ok).toBe(false)
    expect((res as ErrorResponse).code).toBe('INTERNAL_ERROR')
    expect((res as ErrorResponse).details).toBeUndefined()
  })
})

describe('Dispatcher manifest', () => {
  it('lists registered tools with a JSON Schema for input', () => {
    const d = newDispatcher()
    d.register(echoTool)
    const manifest = d.listManifest()
    expect(manifest).toHaveLength(1)
    expect(manifest[0]).toMatchObject({ name: 'test_echo', operationType: 'query' })
    expect((manifest[0]?.inputJsonSchema as { type?: string }).type).toBe('object')
  })
})

describe('Dispatcher session correlation (AsyncLocalStorage)', () => {
  const sidTool = defineTool({
    name: 'test_sid',
    description: 'x',
    inputSchema: z.object({ sessionId: z.string().optional() }),
    operationType: 'query',
    // Intentionally does NOT pass session_id — it must be filled from the ambient context.
    handler: async (_args, ctx) =>
      makeSuccess({ seen: true }, { startedAt: ctx.startedAt, now: ctx.now }),
  })

  it('stamps _meta.session_id from the request args', async () => {
    const d = newDispatcher()
    d.register(sidTool)
    const res = await d.dispatch('test_sid', { sessionId: 'abc' })
    expect((res as SuccessResponse)._meta.session_id).toBe('abc')
  })

  it('omits _meta.session_id when no sessionId is supplied', async () => {
    const d = newDispatcher()
    d.register(sidTool)
    const res = await d.dispatch('test_sid', {})
    expect((res as SuccessResponse)._meta.session_id).toBeUndefined()
  })
})
