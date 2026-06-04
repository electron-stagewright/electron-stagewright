/**
 * Unit tests for the trace Recorder + reader/summary helpers (ADR-009): buffering, redaction,
 * the record cap (overflow), idempotent stop, the JSONL round-trip (stop -> readTrace), and
 * token aggregation (summarizeTrace).
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { DispatchRecord, ToolResult } from '@electron-stagewright/core'
import { afterEach, describe, expect, it } from 'vitest'

import { Recorder, readTrace, summarizeTrace, type TraceCallRecord } from '../src/recorder.js'

const created: string[] = []
afterEach(async () => {
  await Promise.all(created.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})

/** Build a DispatchRecord with a controllable token count + ok/args. */
function record(
  tool: string,
  estimatedTokens: number,
  opts: { ok?: boolean; args?: unknown } = {},
): DispatchRecord {
  const ok = opts.ok ?? true
  const result = (
    ok
      ? { ok: true, _meta: { estimated_tokens: estimatedTokens, elapsed_ms: 0 } }
      : {
          ok: false,
          error: 'bad',
          code: 'BAD_ARGUMENT',
          hint: 'h',
          retryable: false,
          http: 400,
          _meta: { estimated_tokens: estimatedTokens, elapsed_ms: 0 },
        }
  ) as ToolResult
  return { tool, args: opts.args ?? {}, result, startedAt: 0, finishedAt: 5 }
}

async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sw-trace-'))
  created.push(dir)
  return path.join(dir, 'trace.jsonl')
}

function newRecorder(
  file: string,
  overrides: { maxRecords?: number; redact?: string[] } = {},
): Recorder {
  return new Recorder({
    path: file,
    maxRecords: overrides.maxRecords ?? 10000,
    redact: overrides.redact ?? [],
    coreVersion: '0.0.0',
    startedAt: 1000,
  })
}

describe('Recorder', () => {
  it('buffers calls and writes a JSONL artifact with a meta header on stop', async () => {
    const file = await tmpFile()
    const rec = newRecorder(file)
    rec.record(record('demo_a', 10))
    rec.record(record('demo_b', 20, { ok: false }))
    const summary = await rec.stop()

    expect(summary).toMatchObject({
      path: file,
      records: 2,
      total_estimated_tokens: 30,
      overflowed: false,
    })

    const parsed = await readTrace(file)
    expect(parsed.meta).toMatchObject({
      v: 1,
      kind: 'meta',
      started_at: 1000,
      core_version: '0.0.0',
      overflowed: false,
    })
    expect(parsed.calls).toHaveLength(2)
    expect(parsed.calls[0]).toMatchObject({
      kind: 'call',
      tool: 'demo_a',
      ok: true,
      estimated_tokens: 10,
    })
    expect(parsed.calls[1]).toMatchObject({ tool: 'demo_b', ok: false, code: 'BAD_ARGUMENT' })
  })

  it('redacts configured argument fields, recursively', async () => {
    const file = await tmpFile()
    const rec = newRecorder(file, { redact: ['text', 'token'] })
    rec.record(
      record('demo', 1, {
        args: { text: 'secret', name: 'ok', nested: { token: 'abc', keep: 1 } },
      }),
    )
    await rec.stop()
    const { calls } = await readTrace(file)
    expect(calls[0]?.args).toEqual({
      text: '[redacted]',
      name: 'ok',
      nested: { token: '[redacted]', keep: 1 },
    })
  })

  it('caps the buffer and reports overflow', async () => {
    const file = await tmpFile()
    const rec = newRecorder(file, { maxRecords: 2 })
    rec.record(record('a', 1))
    rec.record(record('b', 1))
    rec.record(record('c', 1))
    expect(rec.count).toBe(2)
    expect(rec.overflowed).toBe(true)
    const summary = await rec.stop()
    expect(summary.overflowed).toBe(true)
    expect(summary.records).toBe(2)
    const parsed = await readTrace(file)
    expect(parsed.meta?.overflowed).toBe(true)
  })

  it('stop is idempotent', async () => {
    const file = await tmpFile()
    const rec = newRecorder(file)
    rec.record(record('a', 5))
    const first = await rec.stop()
    rec.record(record('b', 99)) // ignored after close
    const second = await rec.stop()
    expect(second).toEqual(first)
    const { calls } = await readTrace(file)
    expect(calls).toHaveLength(1)
  })
})

describe('summarizeTrace', () => {
  const calls: TraceCallRecord[] = [
    {
      kind: 'call',
      tool: 'snapshot',
      ok: true,
      started_at: 1,
      finished_at: 2,
      elapsed_ms: 1,
      estimated_tokens: 500,
      args: {},
      result: {},
    },
    {
      kind: 'call',
      tool: 'click',
      ok: true,
      started_at: 3,
      finished_at: 4,
      elapsed_ms: 1,
      estimated_tokens: 20,
      args: {},
      result: {},
    },
    {
      kind: 'call',
      tool: 'snapshot',
      ok: true,
      started_at: 5,
      finished_at: 6,
      elapsed_ms: 1,
      estimated_tokens: 300,
      args: {},
      result: {},
    },
  ]

  it('totals tokens, aggregates per tool, and ranks the largest responses', () => {
    const report = summarizeTrace(calls)
    expect(report.total_estimated_tokens).toBe(820)
    expect(report.calls).toBe(3)
    expect(report.overflowed).toBe(false)
    expect(report.by_tool[0]).toEqual({ tool: 'snapshot', calls: 2, estimated_tokens: 800 })
    expect(report.by_tool[1]).toEqual({ tool: 'click', calls: 1, estimated_tokens: 20 })
    expect(report.largest[0]).toMatchObject({ tool: 'snapshot', estimated_tokens: 500 })
    expect(report.largest.map((l) => l.estimated_tokens)).toEqual([500, 300, 20])
  })

  it('carries overflow through token reports', () => {
    expect(summarizeTrace(calls, 10, true).overflowed).toBe(true)
  })
})
