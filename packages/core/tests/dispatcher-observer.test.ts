/**
 * Unit tests for the dispatcher's dispatch-observer seam (ADR-009): every completed dispatch —
 * success, validation failure, or unknown tool — notifies registered observers exactly once
 * with the {@link DispatchRecord}; unsubscribe stops it; a throwing observer is swallowed and
 * never breaks the agent-facing result; and a tool handler can register an observer through
 * `ctx.addDispatchObserver` (the seam the trace plugin uses).
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { makeSuccess } from '../src/errors/envelope.js'
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
