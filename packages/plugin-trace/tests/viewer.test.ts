/**
 * Unit tests for the offline trace viewer (ADR-009): the pure `renderTraceHtml` / `escapeHtml`
 * functions. The `trace_view` tool that writes the rendered HTML to disk is exercised by the
 * plugin integration tests; here we assert the render contract directly — including the
 * load-bearing security property that captured trace data is HTML-escaped and cannot inject
 * markup into the report.
 */

import { describe, expect, it } from 'vitest'

import { escapeHtml, renderTraceHtml } from '../src/viewer.js'
import type { ParsedTrace, TraceCallRecord } from '../src/recorder.js'

function call(overrides: Partial<TraceCallRecord> = {}): TraceCallRecord {
  return {
    kind: 'call',
    tool: 'demo_echo',
    ok: true,
    started_at: 1_000,
    finished_at: 1_010,
    elapsed_ms: 10,
    estimated_tokens: 4,
    args: { value: 'a' },
    result: { ok: true, echo: 'a' },
    ...overrides,
  }
}

const META: ParsedTrace['meta'] = {
  v: 1,
  kind: 'meta',
  started_at: 1_700_000_000_000,
  core_version: '9.9.9',
  overflowed: false,
}

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x" id='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; id=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    )
  })

  it('leaves plain text unchanged', () => {
    expect(escapeHtml('plain text 123')).toBe('plain text 123')
  })
})

describe('renderTraceHtml', () => {
  it('produces a complete self-contained HTML document', () => {
    const html = renderTraceHtml({ meta: META, calls: [call()] })
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<title>Stagewright trace</title>')
    // Self-contained: inline style + script, no external asset references.
    expect(html).toContain('<style>')
    expect(html).toContain('<script>')
    expect(html).not.toMatch(/<link[^>]+href=/i)
    expect(html).not.toMatch(/<script[^>]+src=/i)
  })

  it('summarises calls and lists tool names', () => {
    const html = renderTraceHtml({
      meta: META,
      calls: [call({ estimated_tokens: 4 }), call({ tool: 'electron_click', estimated_tokens: 6 })],
    })
    expect(html).toContain('electron_click')
    expect(html).toContain('demo_echo')
    // Total estimated tokens (4 + 6) is surfaced.
    expect(html).toContain('10')
  })

  it('stamps the injected generation time deterministically', () => {
    const html = renderTraceHtml(
      { meta: META, calls: [call()] },
      { generatedAt: 1_700_000_000_000 },
    )
    expect(html).toContain(new Date(1_700_000_000_000).toISOString())
  })

  it('HTML-escapes captured args and results so trace data cannot inject markup', () => {
    const xss = '<img src=x onerror=alert(1)>'
    const html = renderTraceHtml({
      meta: META,
      calls: [call({ args: { payload: xss }, result: { note: '</script><b>boom</b>' } })],
    })
    // The dangerous raw opening tags from trace data never appear unescaped...
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<b>boom')
    // ...they are escaped instead.
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('&lt;/script&gt;&lt;b&gt;boom')
  })

  it('HTML-escapes a malicious tool name in both attribute and text contexts', () => {
    // The tool name lands in a double-quoted attribute (data-tool="…") and in element text; a
    // crafted name must not break out of either. This guards the attribute-context escaping
    // specifically (quote + angle bracket).
    const html = renderTraceHtml({
      meta: META,
      calls: [call({ tool: '"><img onerror=alert(1) x="' })],
    })
    expect(html).not.toContain('<img')
    expect(html).toContain('&quot;&gt;&lt;img onerror=alert(1) x=&quot;')
  })

  it('renders a budget bar with the over-budget state when the trace is over budget', () => {
    const html = renderTraceHtml({
      meta: { ...META, budget: 1, warn_threshold: 0.8, spent: 50 },
      calls: [call()],
    })
    expect(html).toContain('Token budget')
    expect(html).toContain('bar-over')
    expect(html).toContain('over budget')
  })

  it('omits the budget bar when the trace carries no budget', () => {
    const html = renderTraceHtml({ meta: META, calls: [call()] })
    expect(html).not.toContain('Token budget')
  })

  it('flags an overflowed trace', () => {
    const html = renderTraceHtml({ meta: { ...META, overflowed: true }, calls: [call()] })
    expect(html).toContain('record cap')
  })

  it('renders an empty trace without throwing', () => {
    const html = renderTraceHtml({ calls: [] })
    expect(html).toContain('No calls recorded.')
    expect(html.startsWith('<!doctype html>')).toBe(true)
  })

  it('marks error calls distinctly from ok calls', () => {
    const html = renderTraceHtml({
      meta: META,
      calls: [call({ ok: false, code: 'electron.SELECTOR_NO_MATCH' })],
    })
    expect(html).toContain('call-err')
    expect(html).toContain('electron.SELECTOR_NO_MATCH')
  })
})
