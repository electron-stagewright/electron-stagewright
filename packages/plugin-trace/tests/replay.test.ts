/**
 * Unit tests for the trace replay engine (ADR-009). The engine is driven with injected
 * `dispatch` / `validate` fakes and synthetic trace records, so session-id remapping, divergence
 * detection, the dry-run schema check, and the option flags (stopOnError, include/exclude,
 * maxCalls, self-tool skip, bounded diff) are all exercised without a real dispatcher or app.
 */

import type { ErrorResponse, ToolResult } from '@electron-stagewright/core'
import { describe, expect, it, vi } from 'vitest'

import { replayTrace } from '../src/replay.js'
import type { TraceCallRecord } from '../src/recorder.js'

/** Build a synthetic recorded call. `result` defaults to a success envelope carrying `sessionId`. */
function callRec(
  tool: string,
  args: unknown,
  opts: { ok?: boolean; code?: string; sessionId?: string } = {},
): TraceCallRecord {
  const ok = opts.ok ?? true
  const meta =
    opts.sessionId !== undefined
      ? { estimated_tokens: 0, elapsed_ms: 0, session_id: opts.sessionId }
      : { estimated_tokens: 0, elapsed_ms: 0 }
  const result = ok
    ? { ok: true, _meta: meta }
    : { ok: false, code: opts.code ?? 'INTERNAL_ERROR', error: 'x', _meta: meta }
  return {
    kind: 'call',
    tool,
    ok,
    ...(opts.code !== undefined ? { code: opts.code } : {}),
    started_at: 0,
    finished_at: 0,
    elapsed_ms: 0,
    estimated_tokens: 0,
    args,
    result,
  }
}

/** A success envelope from the replay run carrying the given (new) session id. */
function okResult(sessionId?: string): ToolResult {
  const meta =
    sessionId !== undefined
      ? { estimated_tokens: 0, elapsed_ms: 0, session_id: sessionId }
      : { estimated_tokens: 0, elapsed_ms: 0 }
  return { ok: true, _meta: meta } as unknown as ToolResult
}

/** An error envelope from the replay run with the given code. */
function errResult(code: string): ToolResult {
  return {
    ok: false,
    code,
    error: 'boom',
    hint: '',
    retryable: false,
    http: 500,
    _meta: { estimated_tokens: 0, elapsed_ms: 0 },
  } as unknown as ToolResult
}

const neverValidate = (): ErrorResponse | null => null

describe('replayTrace — session remapping', () => {
  it('rewrites later calls to the freshly created session id', async () => {
    const calls = [
      callRec('electron_launch', { main: '/abs/main.js' }, { sessionId: 'S1' }),
      callRec('electron_snapshot', { sessionId: 'S1' }, { sessionId: 'S1' }),
      callRec('electron_click', { sessionId: 'S1', selector: '#go' }, { sessionId: 'S1' }),
    ]
    const seen: Array<{ tool: string; args: unknown }> = []
    const dispatch = vi.fn(async (tool: string, args: unknown) => {
      seen.push({ tool, args })
      // The replayed launch mints a NEW session id; every call echoes the live one.
      return okResult('S2')
    })

    const report = await replayTrace(calls, { dispatch, validate: neverValidate })

    expect(report).toMatchObject({
      replayed: 3,
      matched: 3,
      diverged: 0,
      skipped: 0,
      dry_run: false,
    })
    // Launch ran with its recorded args; the two later calls were remapped S1 -> S2.
    expect(seen[0]?.args).toEqual({ main: '/abs/main.js' })
    expect((seen[1]?.args as { sessionId?: string }).sessionId).toBe('S2')
    expect((seen[2]?.args as { sessionId?: string }).sessionId).toBe('S2')
  })
})

describe('replayTrace — divergence', () => {
  it('flags a call whose ok/code differs and attaches a bounded diff', async () => {
    const calls = [
      callRec('electron_click', { sessionId: 'S1', selector: '#go' }, { sessionId: 'S1' }),
    ]
    const dispatch = vi.fn(async () => errResult('ELEMENT_NOT_VISIBLE'))

    const report = await replayTrace(calls, { dispatch, validate: neverValidate })

    expect(report).toMatchObject({ replayed: 1, matched: 0, diverged: 1 })
    const outcome = report.calls[0]
    expect(outcome?.diverged).toBe(true)
    expect(outcome?.recorded_ok).toBe(true)
    expect(outcome?.replayed_ok).toBe(false)
    expect(outcome?.replayed_code).toBe('ELEMENT_NOT_VISIBLE')
    expect(outcome?.diff?.length ?? 0).toBeGreaterThan(0)
  })

  it('caps the diff to diffLimit fields', async () => {
    const recorded = {
      ok: true,
      _meta: { estimated_tokens: 0, elapsed_ms: 0 },
      a: 1,
      b: 2,
      c: 3,
      d: 4,
    }
    const call: TraceCallRecord = {
      kind: 'call',
      tool: 'demo',
      ok: true,
      started_at: 0,
      finished_at: 0,
      elapsed_ms: 0,
      estimated_tokens: 0,
      args: {},
      result: recorded,
    }
    const dispatch = vi.fn(
      async () =>
        ({
          ok: false,
          code: 'X',
          a: 9,
          b: 9,
          c: 9,
          d: 9,
          _meta: { estimated_tokens: 0, elapsed_ms: 0 },
        }) as unknown as ToolResult,
    )

    const report = await replayTrace(
      [call],
      { dispatch, validate: neverValidate },
      { diffLimit: 2 },
    )
    expect(report.calls[0]?.diff?.length).toBe(2)
  })

  it('truncates an oversized diff value so the report cannot bloat', async () => {
    const big = 'x'.repeat(5000)
    const call: TraceCallRecord = {
      kind: 'call',
      tool: 'demo',
      ok: true,
      started_at: 0,
      finished_at: 0,
      elapsed_ms: 0,
      estimated_tokens: 0,
      args: {},
      result: { ok: true, blob: 'small', _meta: { estimated_tokens: 0, elapsed_ms: 0 } },
    }
    const dispatch = vi.fn(
      async () =>
        ({
          ok: false,
          code: 'X',
          blob: big,
          _meta: { estimated_tokens: 0, elapsed_ms: 0 },
        }) as unknown as ToolResult,
    )

    const report = await replayTrace([call], { dispatch, validate: neverValidate })
    const blobDiff = report.calls[0]?.diff?.find((d) => d.path === 'blob')
    expect(typeof blobDiff?.replayed).toBe('string')
    expect(String(blobDiff?.replayed)).toContain('[truncated')
    expect(String(blobDiff?.replayed).length).toBeLessThan(big.length)
  })
})

describe('replayTrace — dry run (schema drift)', () => {
  it('re-validates without dispatching and flags a call that no longer validates', async () => {
    const calls = [
      callRec('electron_snapshot', { sessionId: 'S1' }, { sessionId: 'S1' }),
      callRec('electron_old', { gone: true }, { sessionId: 'S1' }),
    ]
    const dispatch = vi.fn(async () => okResult())
    const validate = vi.fn((tool: string): ErrorResponse | null =>
      tool === 'electron_old'
        ? ({
            ok: false,
            code: 'BAD_ARGUMENT',
            error: 'no such tool',
            hint: '',
            retryable: false,
            http: 400,
            _meta: { estimated_tokens: 0, elapsed_ms: 0 },
          } as unknown as ErrorResponse)
        : null,
    )

    const report = await replayTrace(calls, { dispatch, validate }, { dryRun: true })

    expect(dispatch).not.toHaveBeenCalled()
    expect(report).toMatchObject({ replayed: 2, matched: 1, diverged: 1, dry_run: true })
    expect(report.calls[1]).toMatchObject({
      tool: 'electron_old',
      recorded_ok: true,
      replayed_ok: false,
      replayed_code: 'BAD_ARGUMENT',
      diverged: true,
    })
  })
})

describe('replayTrace — option flags', () => {
  it('stopOnError halts after the first divergence', async () => {
    const calls = [callRec('a', {}), callRec('b', {}), callRec('c', {})]
    const dispatch = vi.fn(async (tool: string) => (tool === 'b' ? errResult('NOPE') : okResult()))

    const report = await replayTrace(
      calls,
      { dispatch, validate: neverValidate },
      { stopOnError: true },
    )

    expect(report).toMatchObject({ replayed: 2, matched: 1, diverged: 1, skipped: 1 })
    expect(report.calls[2]).toMatchObject({ skipped: true, skip_reason: 'stopped_on_error' })
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('maxCalls replays a prefix and reports the rest skipped', async () => {
    const calls = [callRec('a', {}), callRec('b', {}), callRec('c', {})]
    const dispatch = vi.fn(async () => okResult())

    const report = await replayTrace(calls, { dispatch, validate: neverValidate }, { maxCalls: 2 })

    expect(report).toMatchObject({ replayed: 2, skipped: 1 })
    expect(report.calls[2]).toMatchObject({ skipped: true, skip_reason: 'max_calls' })
  })

  it('include / exclude filter by tool name', async () => {
    const calls = [callRec('keep', {}), callRec('drop', {})]
    const dispatch = vi.fn(async () => okResult())

    const excluded = await replayTrace(
      calls,
      { dispatch, validate: neverValidate },
      { exclude: ['drop'] },
    )
    expect(excluded.calls[1]).toMatchObject({ skipped: true, skip_reason: 'excluded' })

    const included = await replayTrace(
      calls,
      { dispatch, validate: neverValidate },
      { include: ['keep'] },
    )
    expect(included.calls[1]).toMatchObject({ skipped: true, skip_reason: 'not_included' })
  })

  it('skips the replaying plugin own tools (anti-recursion backstop)', async () => {
    const calls = [
      callRec('trace_status', {}),
      callRec('electron_snapshot', { sessionId: 'S1' }, { sessionId: 'S1' }),
    ]
    const dispatch = vi.fn(async () => okResult('S2'))

    const report = await replayTrace(
      calls,
      { dispatch, validate: neverValidate },
      {
        skipTool: (tool) => tool.startsWith('trace_'),
      },
    )

    expect(report.calls[0]).toMatchObject({
      tool: 'trace_status',
      skipped: true,
      skip_reason: 'self_tool',
    })
    expect(report.replayed).toBe(1)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith('electron_snapshot', expect.anything())
  })

  it('handles an empty trace', async () => {
    const report = await replayTrace([], { dispatch: vi.fn(), validate: neverValidate })
    expect(report).toMatchObject({ replayed: 0, matched: 0, diverged: 0, skipped: 0 })
    expect(report.calls).toEqual([])
  })
})
