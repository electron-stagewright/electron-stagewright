/**
 * Unit tests for the dispatcher's dispatch-observer seam (ADR-009): every completed dispatch —
 * success, validation failure, or unknown tool — notifies registered observers exactly once
 * with the {@link DispatchRecord}; unsubscribe stops it; a throwing observer is swallowed and
 * never breaks the agent-facing result; and a tool handler can register an observer through
 * `ctx.addDispatchObserver` (the seam the trace plugin uses).
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { makeError, makeSuccess } from '../src/errors/envelope.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { type DispatchRecord, defineTool } from '../src/tools/types.js'

const echoTool = defineTool({
  name: 'test_echo',
  description: 'Echo the value back.',
  inputSchema: z.object({ value: z.string() }),
  operationType: 'query',
  handler: async (args, ctx) =>
    makeSuccess({ echo: args.value }, { startedAt: ctx.startedAt, now: ctx.now }),
})

function newDispatcher(): Dispatcher {
  const d = new Dispatcher({ sessions: new SessionManager() })
  d.register(echoTool)
  return d
}

describe('Dispatcher dispatch observers', () => {
  it('notifies for a successful call with the full record shape', async () => {
    const d = newDispatcher()
    const records: DispatchRecord[] = []
    d.addObserver((r) => records.push(r))
    await d.dispatch('test_echo', { value: 'hi' })
    expect(records).toHaveLength(1)
    const rec = records[0]
    expect(rec?.tool).toBe('test_echo')
    expect(rec?.args).toEqual({ value: 'hi' })
    expect(rec?.result.ok).toBe(true)
    expect(rec?.finishedAt).toBeGreaterThanOrEqual(rec?.startedAt ?? 0)
  })

  it('notifies for a validation failure (the bad call is still recorded)', async () => {
    const d = newDispatcher()
    const records: DispatchRecord[] = []
    d.addObserver((r) => records.push(r))
    await d.dispatch('test_echo', { value: 123 })
    expect(records).toHaveLength(1)
    expect(records[0]?.result.ok).toBe(false)
  })

  it('notifies for an unknown tool', async () => {
    const d = newDispatcher()
    const records: DispatchRecord[] = []
    d.addObserver((r) => records.push(r))
    await d.dispatch('nope', {})
    expect(records[0]?.tool).toBe('nope')
    expect(records[0]?.result.ok).toBe(false)
  })

  it('stops notifying after unsubscribe', async () => {
    const d = newDispatcher()
    const records: DispatchRecord[] = []
    const off = d.addObserver((r) => records.push(r))
    await d.dispatch('test_echo', { value: 'a' })
    off()
    await d.dispatch('test_echo', { value: 'b' })
    expect(records).toHaveLength(1)
  })

  it('swallows a throwing observer without breaking the dispatch', async () => {
    const d = newDispatcher()
    d.addObserver(() => {
      throw new Error('observer boom')
    })
    const res = await d.dispatch('test_echo', { value: 'ok' })
    expect(res.ok).toBe(true)
  })

  it('lets a tool handler register an observer via ctx.addDispatchObserver', async () => {
    const d = newDispatcher()
    const seen: string[] = []
    d.register(
      defineTool({
        name: 'test_subscribe',
        description: 'Registers a dispatch observer.',
        inputSchema: z.object({}),
        operationType: 'query',
        handler: async (_args, ctx) => {
          ctx.addDispatchObserver((r) => seen.push(r.tool))
          return makeSuccess({}, { startedAt: ctx.startedAt, now: ctx.now })
        },
      }),
    )
    await d.dispatch('test_subscribe', {})
    await d.dispatch('test_echo', { value: 'x' })
    // The observer fires for the registering call too (it is added before the dispatcher's
    // notify step), then for the subsequent call — both are seen. Plugins that must not record
    // their own tools filter them (the trace plugin skips trace_*).
    expect(seen).toEqual(['test_subscribe', 'test_echo'])
  })
})

describe('Dispatcher re-dispatch seam (ctx.dispatch + ctx.validate)', () => {
  it('lets a handler re-dispatch another tool and resolve to its envelope', async () => {
    const d = newDispatcher()
    let innerOk = false
    d.register(
      defineTool({
        name: 'test_driver',
        description: 'Re-dispatches test_echo (the trace_replay pattern).',
        inputSchema: z.object({}),
        operationType: 'query',
        handler: async (_args, ctx) => {
          const nested = await ctx.dispatch('test_echo', { value: 'via-redispatch' })
          innerOk = nested.ok
          return makeSuccess({ inner: nested.ok }, { startedAt: ctx.startedAt, now: ctx.now })
        },
      }),
    )
    const res = await d.dispatch('test_driver', {})
    expect(res.ok).toBe(true)
    expect(innerOk).toBe(true)
  })

  it('bounds re-dispatch depth so a self-dispatching tool cannot recurse unbounded', async () => {
    const d = newDispatcher()
    let runs = 0
    d.register(
      defineTool({
        name: 'test_chain',
        description: 'Re-dispatches itself.',
        inputSchema: z.object({}),
        operationType: 'query',
        handler: async (_args, ctx) => {
          runs += 1
          const nested = await ctx.dispatch('test_chain', {})
          return makeSuccess({ nestedOk: nested.ok }, { startedAt: ctx.startedAt, now: ctx.now })
        },
      }),
    )
    const res = await d.dispatch('test_chain', {})
    expect(res.ok).toBe(true)
    // Depth 0 runs, depth 1 runs, depth 2 is refused before the handler — exactly two runs.
    expect(runs).toBe(2)
  })

  it('validate accepts a good call, rejects a bad/unknown one, and never runs the handler', async () => {
    const d = new Dispatcher({ sessions: new SessionManager() })
    let ran = 0
    d.register(
      defineTool({
        name: 'test_effect',
        description: 'Counts handler runs.',
        inputSchema: z.object({ value: z.string() }),
        operationType: 'query',
        handler: async (args, ctx) => {
          ran += 1
          return makeSuccess({ echo: args.value }, { startedAt: ctx.startedAt, now: ctx.now })
        },
      }),
    )
    expect(d.validate('test_effect', { value: 'x' })).toBeNull()
    expect(d.validate('test_effect', { value: 123 })?.code).toBe('BAD_ARGUMENT')
    expect(d.validate('unknown_tool', {})?.code).toBe('BAD_ARGUMENT')
    expect(ran).toBe(0)
  })
})

describe('Dispatcher pre-dispatch guards (ctx.addDispatchGuard)', () => {
  function countingTool(name: string, counter: { runs: number }) {
    return defineTool({
      name,
      description: 'Counts handler runs.',
      inputSchema: z.object({}),
      operationType: 'query',
      handler: async (_args, ctx) => {
        counter.runs += 1
        return makeSuccess({}, { startedAt: ctx.startedAt, now: ctx.now })
      },
    })
  }

  it('vetoes a call before its handler runs', async () => {
    const d = newDispatcher()
    const counter = { runs: 0 }
    d.register(countingTool('test_guarded', counter))
    d.addGuard((call) =>
      call.tool === 'test_guarded'
        ? makeError('BAD_ARGUMENT', {
            message: 'blocked',
            startedAt: call.startedAt,
            now: call.now,
          })
        : null,
    )
    const res = await d.dispatch('test_guarded', {})
    expect(res.ok).toBe(false)
    expect(counter.runs).toBe(0)
  })

  it('allows the call when the guard returns null', async () => {
    const d = newDispatcher()
    d.addGuard(() => null)
    expect((await d.dispatch('test_echo', { value: 'x' })).ok).toBe(true)
  })

  it('fails open when a guard throws (the call still runs)', async () => {
    const d = newDispatcher()
    d.addGuard(() => {
      throw new Error('guard boom')
    })
    expect((await d.dispatch('test_echo', { value: 'x' })).ok).toBe(true)
  })

  it('first guard to veto wins, and the vetoed call still notifies observers', async () => {
    const d = newDispatcher()
    const seen: string[] = []
    d.addObserver((r) => seen.push(`${r.tool}:${r.result.ok}`))
    d.addGuard(() => null)
    d.addGuard((call) =>
      makeError('BAD_ARGUMENT', { message: 'no', startedAt: call.startedAt, now: call.now }),
    )
    const res = await d.dispatch('test_echo', { value: 'x' })
    expect(res.ok).toBe(false)
    expect(seen).toEqual(['test_echo:false'])
  })

  it('lets a handler register a guard via ctx.addDispatchGuard', async () => {
    const d = newDispatcher()
    d.register(
      defineTool({
        name: 'test_arm_guard',
        description: 'Arms a guard that vetoes test_echo.',
        inputSchema: z.object({}),
        operationType: 'query',
        handler: async (_args, ctx) => {
          ctx.addDispatchGuard((call) =>
            call.tool === 'test_echo'
              ? makeError('BAD_ARGUMENT', {
                  message: 'armed',
                  startedAt: call.startedAt,
                  now: call.now,
                })
              : null,
          )
          return makeSuccess({}, { startedAt: ctx.startedAt, now: ctx.now })
        },
      }),
    )
    await d.dispatch('test_arm_guard', {})
    expect((await d.dispatch('test_echo', { value: 'x' })).ok).toBe(false)
  })
})
