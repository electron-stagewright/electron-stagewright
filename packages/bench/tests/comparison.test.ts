/**
 * Unit tests for the cross-server comparison. The contrast computation is PURE (synthetic rows in,
 * deltas out) so it runs as a fast gate in `pnpm test` — no Electron, no spawned server. The runner
 * orchestration (`runAdapter` / `runComparison`) is covered by injecting a FAKE MCP client, so the
 * launch → run → stop → memory sequencing and metric threading are exercised without spawning anything;
 * the real spawn path is exercised by `pnpm bench --compare`.
 */

import { describe, expect, it } from 'vitest'

import { stagewrightAdapters } from '../src/adapters.js'
import { computeContrast, runComparison } from '../src/comparison.js'
import { runAdapter, type ComparisonResult, type Envelope } from '../src/harness.js'

/** A synthetic comparison row (latency/memory are irrelevant to the pure contrast). */
function row(
  target: string,
  task: string,
  toolCalls: number,
  measuredTokens: number,
  ok = true,
): ComparisonResult {
  return {
    target,
    task,
    toolCalls,
    estimatedTokens: measuredTokens,
    measuredTokens,
    latencyMs: 0,
    memoryRssBytes: null,
    ok,
  }
}

describe('computeContrast (pure)', () => {
  it('computes target − baseline deltas per task', () => {
    const results = [
      row('stagewright', 'verify-greeting', 4, 100),
      row('rival', 'verify-greeting', 6, 150),
    ]
    const contrasts = computeContrast(results, 'stagewright')
    expect(contrasts).toHaveLength(1)
    expect(contrasts[0]?.baseline).toBe('stagewright')
    expect(contrasts[0]?.deltas).toEqual([
      {
        target: 'rival',
        toolCallsVsBaseline: 2,
        estimatedTokensVsBaseline: 50,
        measuredTokensVsBaseline: 50,
      },
    ])
  })

  it('yields no deltas for a single (baseline-only) target but still reports the row', () => {
    const contrasts = computeContrast(
      [row('stagewright', 'verify-greeting', 4, 100)],
      'stagewright',
    )
    expect(contrasts[0]?.deltas).toEqual([])
    expect(contrasts[0]?.rows).toHaveLength(1)
  })

  it('excludes a failed competitor row from deltas but keeps it in rows', () => {
    const results = [
      row('stagewright', 'verify-greeting', 4, 100),
      row('rival', 'verify-greeting', 0, 0, false),
    ]
    const contrasts = computeContrast(results, 'stagewright')
    expect(contrasts[0]?.deltas).toEqual([])
    expect(contrasts[0]?.rows.map((r) => r.target)).toEqual(['stagewright', 'rival'])
  })

  it('yields no deltas when the baseline target is absent', () => {
    const contrasts = computeContrast([row('rival', 'verify-greeting', 6, 150)], 'stagewright')
    expect(contrasts[0]?.deltas).toEqual([])
  })

  it('groups by task', () => {
    const results = [
      row('stagewright', 'verify-greeting', 4, 100),
      row('rival', 'verify-greeting', 5, 120),
      row('stagewright', 'load-details', 3, 80),
      row('rival', 'load-details', 4, 90),
    ]
    const contrasts = computeContrast(results, 'stagewright')
    expect(contrasts.map((c) => c.task)).toEqual(['verify-greeting', 'load-details'])
    expect(contrasts[1]?.deltas[0]).toMatchObject({ target: 'rival', toolCallsVsBaseline: 1 })
  })

  it('produces a JSON-serialisable contrast (invariant A1)', () => {
    const contrasts = computeContrast(
      [row('stagewright', 'verify-greeting', 4, 100), row('rival', 'verify-greeting', 6, 150)],
      'stagewright',
    )
    expect(JSON.parse(JSON.stringify(contrasts))).toEqual(contrasts)
  })
})

/**
 * A fake MCP client returning canned envelopes per tool name — no process, no I/O. An UNEXPECTED tool
 * name returns ok:false so the test actually checks the adapter's tool vocabulary: a renamed/misspelled
 * tool in an adapter trips `expectOk` and fails the run, rather than passing on a permissive default.
 */
function fakeClient(responses: Record<string, Envelope>): unknown {
  return {
    callTool: async ({ name }: { name: string }) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            responses[name] ?? {
              ok: false,
              code: 'UNEXPECTED_TOOL',
              error: `unexpected tool: ${name}`,
            },
          ),
        },
      ],
    }),
    close: async () => undefined,
  }
}

/** Exhaustive over the tools our adapters call, so an unlisted tool name surfaces as a failure. */
const CANNED: Record<string, Envelope> = {
  electron_launch: { ok: true, session_id: 's1' },
  electron_type: { ok: true },
  electron_find: { ok: true, matches: [{ ref: 1 }] },
  electron_click: { ok: true },
  electron_expect_text: { ok: true },
  electron_eval_main: { ok: true, result: 4096 },
  electron_stop: { ok: true },
}

describe('runAdapter / runComparison (fake client)', () => {
  it('runs an adapter end to end and records its task-step metrics', async () => {
    const greeting = stagewrightAdapters()[0]
    if (greeting === undefined) throw new Error('no stagewright adapters')
    const result = await runAdapter(greeting, async () => fakeClient(CANNED) as never)
    // type + find + click + expect_text = 4 counted task calls (launch/stop/eval are not counted).
    expect(result).toMatchObject({
      target: 'stagewright',
      task: 'verify-greeting',
      toolCalls: 4,
      ok: true,
      memoryRssBytes: 4096,
    })
  })

  it('runs the whole adapter set into one row per task', async () => {
    const results = await runComparison(
      stagewrightAdapters(),
      async () => fakeClient(CANNED) as never,
    )
    expect(results.map((r) => r.task)).toEqual(['verify-greeting', 'load-details'])
    expect(results.every((r) => r.ok)).toBe(true)
  })

  it('records a connect (spawn) failure as an ok:false row instead of throwing', async () => {
    const greeting = stagewrightAdapters()[0]
    if (greeting === undefined) throw new Error('no stagewright adapters')
    const result = await runAdapter(greeting, async () => {
      throw new Error('spawn failed')
    })
    expect(result).toMatchObject({ target: 'stagewright', ok: false })
    expect(result.error).toContain('spawn failed')
  })
})
