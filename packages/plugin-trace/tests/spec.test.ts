/** Unit tests for promoted replay specs: privacy-preserving promotion and explicit checkpoints. */

import type { ToolResult } from '@electron-stagewright/core'
import { describe, expect, it, vi } from 'vitest'

import { promoteTrace, replaySpec, type ReplaySpec } from '../src/spec.js'
import type { TraceCallRecord } from '../src/recorder.js'

function call(tool: string, args: unknown, result: unknown, ok = true): TraceCallRecord {
  return {
    kind: 'call',
    tool,
    ok,
    started_at: 0,
    finished_at: 1,
    elapsed_ms: 1,
    estimated_tokens: 1,
    args,
    result,
  }
}

function result(value: Record<string, unknown>): ToolResult {
  return { ok: true, _meta: { estimated_tokens: 1, elapsed_ms: 1 }, ...value } as ToolResult
}

describe('promoteTrace', () => {
  it('redacts args before writing and replaces recorded session ids with stable placeholders', () => {
    const spec = promoteTrace([
      call(
        'electron_launch',
        { main: '/app/main.js' },
        { ok: true, _meta: { session_id: 'old-1' } },
      ),
      call(
        'electron_type',
        { sessionId: 'old-1', password: 'do-not-write' },
        { ok: true, _meta: { session_id: 'old-1' } },
      ),
    ])
    expect(spec.app).toEqual({ main: '/app/main.js' })
    expect(spec.steps[0]?.captureSession).toBe('$stagewright.session.1')
    expect(spec.steps[1]?.args).toEqual({
      sessionId: '$stagewright.session.1',
      password: '[redacted]',
    })
    expect(JSON.stringify(spec)).not.toContain('do-not-write')
  })

  it('retains session creators required by a filtered dependent call', () => {
    const spec = promoteTrace(
      [
        call(
          'electron_launch',
          { main: '/app/main.js' },
          { ok: true, _meta: { session_id: 'old-1' } },
        ),
        call('electron_snapshot', { sessionId: 'old-1' }, { ok: true }),
      ],
      { include: ['electron_snapshot'], exclude: ['electron_launch'] },
    )
    expect(spec.steps).toMatchObject([
      { tool: 'electron_launch', captureSession: '$stagewright.session.1' },
      { tool: 'electron_snapshot', args: { sessionId: '$stagewright.session.1' } },
    ])
    expect(spec.app).toEqual({ main: '/app/main.js' })
  })
})

describe('replaySpec', () => {
  it('only fails a changed text when an explicit checkpoint observes it', async () => {
    const dispatch = vi.fn(async () => result({ status: 'Changed' }))
    const withoutCheckpoint: ReplaySpec = {
      format: 'stagewright-replay',
      version: 1,
      normalizers: [],
      redactions: [],
      steps: [{ tool: 'demo', args: {}, expect: { ok: true } }],
    }
    await expect(replaySpec(withoutCheckpoint, { dispatch })).resolves.toMatchObject({
      passed: true,
    })

    const withCheckpoint: ReplaySpec = {
      ...withoutCheckpoint,
      steps: [
        {
          tool: 'demo',
          args: {},
          expect: { result: { mode: 'subset', value: { status: 'Ready' } } },
        },
      ],
    }
    await expect(replaySpec(withCheckpoint, { dispatch })).resolves.toMatchObject({
      passed: false,
      mismatched: 1,
      steps: [
        { tool: 'demo', matcher: 'subset', message: expect.stringContaining('did not match') },
      ],
    })
  })

  it('supports exact, subset, regex, ignore, numeric tolerance, and declared normalizers', async () => {
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce(result({ value: 10.04 }))
      .mockResolvedValueOnce(result({ status: 'Ready now' }))
      .mockResolvedValueOnce(
        result({ password: 'secret', _meta: { session_id: 'new', elapsed_ms: 99 } }),
      )
      .mockResolvedValueOnce(
        result({ path: '/private/file', timestamp: 1, _meta: { session_id: 'new' } }),
      )
    const spec: ReplaySpec = {
      format: 'stagewright-replay',
      version: 1,
      normalizers: ['session_id', 'timestamps', 'absolute_paths'],
      redactions: ['result.password'],
      steps: [
        {
          tool: 'numeric',
          args: {},
          expect: { result: { mode: 'subset', value: { value: 10 }, numericTolerance: 0.1 } },
        },
        { tool: 'regex', args: {}, expect: { result: { mode: 'regex', value: 'Ready\\s+now' } } },
        { tool: 'ignore', args: {}, expect: { result: { mode: 'ignore' } } },
        {
          tool: 'normalizers',
          args: {},
          expect: { result: { mode: 'subset', value: { path: '<absolute-path>' } } },
        },
      ],
    }
    const report = await replaySpec(spec, { dispatch })
    expect(report).toMatchObject({ passed: true, matched: 4, mismatched: 0 })
  })

  it('redacts mismatched actual results before putting them in a report', async () => {
    const spec: ReplaySpec = {
      format: 'stagewright-replay',
      version: 1,
      normalizers: [],
      redactions: ['result.password'],
      steps: [
        {
          tool: 'secret',
          args: {},
          expect: { result: { mode: 'subset', value: { status: 'Ready' } } },
        },
      ],
    }
    const report = await replaySpec(spec, {
      dispatch: async () => result({ password: 'never-report', status: 'Changed' }),
    })
    expect(report.passed).toBe(false)
    expect(JSON.stringify(report)).not.toContain('never-report')
    expect(JSON.stringify(report)).toContain('[redacted]')
  })

  it('refuses a catastrophic regex matcher instead of running it on the event loop', async () => {
    const spec: ReplaySpec = {
      format: 'stagewright-replay',
      version: 1,
      normalizers: [],
      redactions: [],
      steps: [{ tool: 'regex', args: {}, expect: { result: { mode: 'regex', value: '(a+)+$' } } }],
    }
    const report = await replaySpec(spec, {
      dispatch: async () => result({ text: `${'a'.repeat(500)}!` }),
    })
    expect(report).toMatchObject({ passed: false, mismatched: 1 })
  })

  it('resolves promoted session placeholders from a launch result', async () => {
    const spec = promoteTrace([
      call(
        'electron_launch',
        { main: '/app/main.js' },
        { ok: true, _meta: { session_id: 'old-1' } },
      ),
      call(
        'electron_snapshot',
        { sessionId: 'old-1' },
        { ok: true, _meta: { session_id: 'old-1' } },
      ),
    ])
    const seen: unknown[] = []
    const report = await replaySpec(spec, {
      dispatch: async (tool, args) => {
        seen.push({ tool, args })
        return result({ _meta: { session_id: 'new-1' } })
      },
    })
    expect(report.passed).toBe(true)
    expect(seen[1]).toEqual({ tool: 'electron_snapshot', args: { sessionId: 'new-1' } })
  })
})
