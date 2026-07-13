/**
 * Unit tests for the streaming trace recorder and dual-format readers (ADR-009). These pin v2's
 * partial-file lifecycle, bounded aggregation, ordering, redaction, and the independent v1 path.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { DispatchRecord, ToolResult } from '@electron-stagewright/core'
import { afterEach, describe, expect, it } from 'vitest'

import {
  LEGACY_TRACE_FORMAT_VERSION,
  Recorder,
  TRACE_FORMAT_VERSION,
  readTrace,
  readTraceV1,
  readTraceV2,
  summarizeTrace,
  type TraceCallRecord,
} from '../src/recorder.js'

const created: string[] = []
afterEach(async () => {
  await Promise.all(created.splice(0).map((entry) => rm(entry, { recursive: true, force: true })))
})

/** Build a DispatchRecord with a controllable token count and outcome. */
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
  overrides: {
    maxRecords?: number
    redact?: string[]
    budget?: number
    warnThreshold?: number
    fsync?: boolean
  } = {},
): Recorder {
  return new Recorder({
    path: file,
    maxRecords: overrides.maxRecords ?? 10000,
    redact: overrides.redact ?? [],
    coreVersion: '0.0.0',
    startedAt: 1000,
    ...(overrides.budget !== undefined ? { budget: overrides.budget } : {}),
    ...(overrides.warnThreshold !== undefined ? { warnThreshold: overrides.warnThreshold } : {}),
    ...(overrides.fsync !== undefined ? { fsync: overrides.fsync } : {}),
  })
}

async function startedRecorder(
  file: string,
  overrides: Parameters<typeof newRecorder>[1] = {},
): Promise<Recorder> {
  const recorder = newRecorder(file, overrides)
  await recorder.start()
  return recorder
}

async function readWhen(
  file: string,
  predicate: (trace: Awaited<ReturnType<typeof readTrace>>) => boolean,
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const parsed = await readTrace(file)
    if (predicate(parsed)) return parsed
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Trace at ${file} did not reach the expected state`)
}

describe('Recorder v2', () => {
  it('streams a header and calls to a partial file, then atomically publishes a footer-complete artifact', async () => {
    const file = await tmpFile()
    const recorder = await startedRecorder(file)
    expect(await readTrace(recorder.partialPath)).toMatchObject({
      formatVersion: TRACE_FORMAT_VERSION,
      complete: false,
      header: { kind: 'header', version: TRACE_FORMAT_VERSION, core_version: '0.0.0' },
    })

    recorder.record(record('demo_a', 10))
    recorder.record(record('demo_b', 20, { ok: false }))
    const partial = await readWhen(recorder.partialPath, (parsed) => parsed.calls.length === 2)
    expect(partial).toMatchObject({ complete: false })
    expect(partial.calls.map((call) => call.seq)).toEqual([1, 2])

    const summary = await recorder.stop()
    expect(summary).toMatchObject({
      path: file,
      records: 2,
      total_estimated_tokens: 30,
      overflowed: false,
    })
    await expect(readFile(recorder.partialPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    const parsed = await readTrace(file)
    expect(parsed).toMatchObject({
      formatVersion: TRACE_FORMAT_VERSION,
      complete: true,
      header: { started_at: 1000, core_version: '0.0.0' },
      footer: { complete: true, calls: 2, overflowed: false },
    })
    expect(parsed.calls[0]).toMatchObject({ kind: 'call', seq: 1, tool: 'demo_a', ok: true })
    expect(parsed.calls[1]).toMatchObject({
      seq: 2,
      tool: 'demo_b',
      ok: false,
      code: 'BAD_ARGUMENT',
    })
  })

  it('recovers a partial trace after a trailing interrupted JSON write', async () => {
    const file = await tmpFile()
    const partial = `${file}.partial`
    await writeFile(
      partial,
      `${JSON.stringify({
        kind: 'header',
        format: 'stagewright-trace',
        version: 2,
        started_at: 1,
        core_version: '0.0.0',
      })}\n${JSON.stringify({ kind: 'call', seq: 1, tool: 'demo', ok: true, args: {}, result: {} })}\n{"kind":"call","seq":2`,
      'utf8',
    )
    const parsed = await readTrace(partial)
    expect(parsed).toMatchObject({ formatVersion: 2, complete: false })
    expect(parsed.calls.map((call) => call.tool)).toEqual(['demo'])
  })

  it('redacts configured argument fields, recursively', async () => {
    const file = await tmpFile()
    const recorder = await startedRecorder(file, { redact: ['text', 'token'] })
    recorder.record(
      record('demo', 1, {
        args: { text: 'secret', name: 'ok', nested: { token: 'abc', keep: 1 } },
      }),
    )
    await recorder.stop()
    const { calls } = await readTrace(file)
    expect(calls[0]?.args).toEqual({
      text: '[redacted]',
      name: 'ok',
      nested: { token: '[redacted]', keep: 1 },
    })
  })

  it('preserves an own key literally named __proto__ instead of dropping it', async () => {
    const file = await tmpFile()
    const recorder = await startedRecorder(file, { redact: ['token'] })
    const args = JSON.parse('{"__proto__": {"token": "abc", "keep": 1}, "name": "ok"}') as unknown
    recorder.record(record('demo', 1, { args }))
    await recorder.stop()
    const { calls } = await readTrace(file)
    const recorded = calls[0]?.args as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(recorded, '__proto__')).toBe(true)
    expect(Object.getOwnPropertyDescriptor(recorded, '__proto__')?.value).toEqual({
      token: '[redacted]',
      keep: 1,
    })
    expect(recorded['name']).toBe('ok')
  })

  it('caps persisted records, retains exact budget spend, and writes overflow to the footer', async () => {
    const file = await tmpFile()
    const recorder = await startedRecorder(file, { maxRecords: 1, budget: 100 })
    recorder.record(record('a', 50))
    recorder.record(record('b', 50))
    recorder.record(record('c', 50))
    expect(recorder.count).toBe(1)
    expect(recorder.overflowed).toBe(true)
    expect(recorder.budgetStatus()).toMatchObject({ spent: 150, over_budget: true })
    expect(recorder.tokenReport()).toMatchObject({ calls: 1, total_estimated_tokens: 50 })

    const summary = await recorder.stop()
    expect(summary).toMatchObject({ records: 1, overflowed: true, budget: { spent: 150 } })
    const parsed = await readTrace(file)
    expect(parsed.footer).toMatchObject({ calls: 1, overflowed: true, spent: 150 })
  })

  it('uses bounded aggregate state across 50,000 calls while preserving sequence and ordering', async () => {
    const file = await tmpFile()
    const recorder = await startedRecorder(file, { maxRecords: 50000 })
    for (let index = 0; index < 50000; index += 1) {
      recorder.record(record(`tool_${index % 3}`, 1, { args: { index } }))
    }
    expect(recorder.tokenReport()).toMatchObject({ calls: 50000, total_estimated_tokens: 50000 })
    expect('calls' in recorder).toBe(false)
    await recorder.stop()
    const parsed = await readTrace(file)
    expect(parsed.calls).toHaveLength(50000)
    expect(parsed.calls[0]?.seq).toBe(1)
    expect(parsed.calls.at(-1)?.seq).toBe(50000)
    expect(parsed.calls[0]?.args).toEqual({ index: 0 })
    expect(parsed.calls.at(-1)?.args).toEqual({ index: 49999 })
  })

  it('stop is idempotent and ignores calls after finalization', async () => {
    const file = await tmpFile()
    const recorder = await startedRecorder(file, { fsync: true })
    recorder.record(record('a', 5))
    const first = await recorder.stop()
    recorder.record(record('b', 99))
    expect(await recorder.stop()).toEqual(first)
    expect((await readTrace(file)).calls).toHaveLength(1)
  })

  it('reports a publish failure without a fake final path and retries without appending a second footer', async () => {
    const file = await tmpFile()
    const recorder = await startedRecorder(file)
    recorder.record(record('a', 5))
    // The writer has a valid partial file, but turning the requested final target into a directory
    // forces the atomic rename to fail after the completion footer was appended.
    await mkdir(file)
    await expect(recorder.stop()).rejects.toBeDefined()
    expect(await readTrace(recorder.partialPath)).toMatchObject({
      complete: true,
      calls: [{ seq: 1 }],
    })
    recorder.record(record('must_not_follow_footer', 5))
    await rm(file, { recursive: true })
    await expect(recorder.stop()).resolves.toMatchObject({ path: file, records: 1 })
    const finalTrace = await readTrace(file)
    expect(finalTrace.calls).toHaveLength(1)
    expect(finalTrace.footer).toMatchObject({ calls: 1 })
  })
})

describe('trace readers', () => {
  it('reads legacy v1 independently from v2', async () => {
    const file = await tmpFile()
    const legacy = [
      {
        v: LEGACY_TRACE_FORMAT_VERSION,
        kind: 'meta',
        started_at: 1,
        core_version: '0.0.0',
        overflowed: false,
      },
      { kind: 'call', tool: 'legacy_tool', ok: true, args: {}, result: {} },
    ]
    await writeFile(file, `${legacy.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8')
    expect(readTraceV1(legacy)).toMatchObject({ formatVersion: 1, complete: true })
    const parsed = await readTrace(file)
    expect(parsed).toMatchObject({ formatVersion: 1, complete: true, meta: { v: 1 } })
    expect(parsed.calls[0]?.tool).toBe('legacy_tool')
  })

  it('rejects malformed v2 ordering and a footer whose call count lies', () => {
    const header = {
      kind: 'header',
      format: 'stagewright-trace',
      version: TRACE_FORMAT_VERSION,
      started_at: 1,
      core_version: '0.0.0',
    }
    expect(() =>
      readTraceV2([header, { kind: 'call', seq: 2, tool: 'bad', ok: true, args: {}, result: {} }]),
    ).toThrow('sequence')
    expect(() =>
      readTraceV2([
        header,
        { kind: 'call', seq: 1, tool: 'one', ok: true, args: {}, result: {} },
        { kind: 'footer', complete: true, calls: 2, overflowed: false },
      ]),
    ).toThrow('footer')
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

  it('totals tokens, aggregates per tool, and ranks largest responses', () => {
    const report = summarizeTrace(calls)
    expect(report.total_estimated_tokens).toBe(820)
    expect(report.by_tool[0]).toEqual({ tool: 'snapshot', calls: 2, estimated_tokens: 800 })
    expect(report.largest.map((entry) => entry.estimated_tokens)).toEqual([500, 300, 20])
  })
})
