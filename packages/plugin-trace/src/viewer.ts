/**
 * Offline trace viewer (ADR-009).
 *
 * Renders a parsed trace artifact to a **single self-contained HTML document** — no external
 * assets, no CDN, no runtime server, no build step. The file opens in any browser by
 * double-clicking it, which is the whole point: a trace is a portable record an operator (or an
 * agent handing off to one) can read anywhere, offline, with nothing installed. That format
 * choice is the v1 viewer decision recorded in ADR-009; richer interactive viewers can layer on
 * later without changing the artifact.
 *
 * SECURITY: a trace captures arbitrary tool inputs and outputs — typed text, eval payloads, app
 * content — so every dynamic value rendered into the document MUST be HTML-escaped, or a captured
 * string like `</script><img onerror=…>` would inject markup into the report. {@link escapeHtml}
 * is applied to every interpolated value (text content AND attribute values, hence quotes are
 * escaped too). The inline `<script>` is a fixed constant with no trace data interpolated into
 * it, so it carries no injection surface of its own.
 *
 * @module
 */

import {
  summarizeTrace,
  type BudgetStatus,
  type ParsedTrace,
  type TraceCallRecord,
} from './recorder.js'

/**
 * Escape the five HTML-significant characters. Safe for both element text and double-quoted
 * attribute values (both `"` and `'` are escaped). Captured trace data is never trusted markup,
 * so this is applied to every interpolated value in the document.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Pretty-print a JSON-serialisable trace value for display. Trace records round-trip through
 * `JSON.parse`, so they are acyclic; the try/catch and the `undefined` guard are defensive only. */
function formatValue(value: unknown): string {
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Format an epoch-ms timestamp as an ISO string, tolerating a missing/invalid value. */
function formatTime(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
  return new Date(ms).toISOString()
}

/** Options for {@link renderTraceHtml}. */
export interface RenderOptions {
  /**
   * Epoch-ms stamped into the report as its generation time. Injected (rather than read from the
   * clock) so the output is deterministic under test. Defaults to the trace's `started_at`.
   */
  readonly generatedAt?: number
  /** How many entries to show in the "largest responses" table. Defaults to 10. */
  readonly topN?: number
}

/** A single summary card (label + value) shown in the report header strip. */
function card(label: string, value: string): string {
  return `<div class="card"><div class="card-label">${escapeHtml(label)}</div><div class="card-value">${escapeHtml(value)}</div></div>`
}

/** Render the token-budget bar, or empty string when the trace carries no budget. */
function budgetBar(budget: BudgetStatus | undefined): string {
  if (budget === undefined) return ''
  const pct =
    budget.budget_tokens > 0 ? Math.min(100, (budget.spent / budget.budget_tokens) * 100) : 0
  const state = budget.over_budget ? 'over' : budget.near_budget ? 'near' : 'ok'
  return `<section class="budget">
    <h2>Token budget</h2>
    <div class="bar bar-${state}"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
    <p class="budget-detail">${escapeHtml(String(budget.spent))} / ${escapeHtml(String(budget.budget_tokens))} estimated tokens spent (${escapeHtml(String(budget.remaining))} remaining)${budget.over_budget ? ' — <strong>over budget</strong>' : budget.near_budget ? ' — near budget' : ''}</p>
  </section>`
}

/** Render the "largest responses" + "by tool" tables from a token summary. */
function tables(parsed: ParsedTrace, topN: number): string {
  const summary = summarizeTrace(parsed.calls, topN, parsed.meta?.overflowed ?? false)
  const largestRows = summary.largest
    .map(
      (l) =>
        `<tr><td>${escapeHtml(l.tool)}</td><td class="num">${escapeHtml(String(l.estimated_tokens))}</td><td><span class="badge badge-${l.ok ? 'ok' : 'err'}">${l.ok ? 'ok' : 'error'}</span></td><td class="time">${escapeHtml(formatTime(l.started_at))}</td></tr>`,
    )
    .join('')
  const byToolRows = summary.by_tool
    .map(
      (t) =>
        `<tr><td>${escapeHtml(t.tool)}</td><td class="num">${escapeHtml(String(t.calls))}</td><td class="num">${escapeHtml(String(t.estimated_tokens))}</td></tr>`,
    )
    .join('')
  return `<section class="tables">
    <div>
      <h2>Largest responses</h2>
      <table><thead><tr><th>Tool</th><th class="num">Est. tokens</th><th>Outcome</th><th>Started</th></tr></thead><tbody>${largestRows || '<tr><td colspan="4" class="empty">No calls recorded.</td></tr>'}</tbody></table>
    </div>
    <div>
      <h2>By tool</h2>
      <table><thead><tr><th>Tool</th><th class="num">Calls</th><th class="num">Est. tokens</th></tr></thead><tbody>${byToolRows || '<tr><td colspan="3" class="empty">No calls recorded.</td></tr>'}</tbody></table>
    </div>
  </section>`
}

/** Render one timeline entry as a native `<details>` (no JS needed to expand). */
function timelineEntry(call: TraceCallRecord, index: number): string {
  const outcome = call.ok ? 'ok' : 'err'
  const codeLabel = call.ok ? 'ok' : escapeHtml(call.code ?? 'error')
  return `<details class="call call-${outcome}" data-tool="${escapeHtml(call.tool)}" data-outcome="${outcome}">
    <summary>
      <span class="idx">#${index + 1}</span>
      <span class="tool">${escapeHtml(call.tool)}</span>
      <span class="badge badge-${outcome}">${codeLabel}</span>
      <span class="meta">${escapeHtml(String(call.elapsed_ms))} ms · ${escapeHtml(String(call.estimated_tokens))} tok</span>
    </summary>
    <div class="call-body">
      <h3>args</h3><pre>${escapeHtml(formatValue(call.args))}</pre>
      <h3>result</h3><pre>${escapeHtml(formatValue(call.result))}</pre>
    </div>
  </details>`
}

/**
 * Render a parsed trace to a self-contained HTML document string. The returned string is a
 * complete, standalone `.html` file (doctype + inline CSS + inline JS); the caller writes it to
 * disk. Every dynamic value is HTML-escaped (see module security note).
 */
export function renderTraceHtml(parsed: ParsedTrace, options: RenderOptions = {}): string {
  const topN = options.topN ?? 10
  const calls = parsed.calls
  const okCount = calls.filter((c) => c.ok).length
  const errCount = calls.length - okCount
  const totalTokens = calls.reduce((sum, c) => sum + c.estimated_tokens, 0)
  const budget = budgetStatusFromMeta(parsed)
  const generatedAt = options.generatedAt ?? parsed.meta?.started_at
  const overflow = parsed.meta?.overflowed
    ? `<div class="warn">This trace hit its record cap and dropped later calls — the timeline below is truncated.</div>`
    : ''
  const timeline = calls.map((c, i) => timelineEntry(c, i)).join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Stagewright trace</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>Stagewright trace</h1>
  <p class="sub">Generated ${escapeHtml(formatTime(generatedAt))} · core ${escapeHtml(parsed.meta?.core_version ?? 'unknown')} · started ${escapeHtml(formatTime(parsed.meta?.started_at))}</p>
</header>
${overflow}
<section class="cards">
  ${card('Calls', String(calls.length))}
  ${card('OK', String(okCount))}
  ${card('Errors', String(errCount))}
  ${card('Est. tokens', String(totalTokens))}
</section>
${budgetBar(budget)}
${tables(parsed, topN)}
<section class="timeline">
  <div class="timeline-head">
    <h2>Timeline</h2>
    <div class="controls">
      <input id="filter" type="search" placeholder="Filter by tool…" aria-label="Filter timeline by tool name" />
      <button type="button" data-action="expand">Expand all</button>
      <button type="button" data-action="collapse">Collapse all</button>
    </div>
  </div>
  <div id="calls">
${timeline || '<p class="empty">No calls recorded.</p>'}
  </div>
</section>
<script>${SCRIPT}</script>
</body>
</html>`
}

/** Derive budget status from the artifact meta header (exact `spent`), or undefined when none. */
function budgetStatusFromMeta(parsed: ParsedTrace): BudgetStatus | undefined {
  const m = parsed.meta
  if (m?.budget === undefined) return undefined
  const spent = m.spent ?? parsed.calls.reduce((sum, c) => sum + c.estimated_tokens, 0)
  const warn = m.warn_threshold ?? 0.8
  const overBudget = spent > m.budget
  return {
    budget_tokens: m.budget,
    spent,
    remaining: Math.max(0, m.budget - spent),
    over_budget: overBudget,
    near_budget: !overBudget && spent >= m.budget * warn,
    warn_threshold: warn,
  }
}

/** Inline stylesheet. A fixed constant — no trace data is interpolated into it. */
const STYLE = `
:root { color-scheme: light dark; --fg: #1a1a1a; --bg: #fff; --muted: #666; --line: #e2e2e2; --ok: #1a7f37; --err: #cf222e; --near: #bf8700; --accent: #0969da; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6e6e6; --bg: #0d1117; --muted: #8b949e; --line: #30363d; --ok: #3fb950; --err: #f85149; --near: #d29922; --accent: #58a6ff; } }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: var(--fg); background: var(--bg); padding: 1.5rem; max-width: 1100px; margin: 0 auto; }
h1 { font-size: 1.5rem; margin: 0; }
h2 { font-size: 1.05rem; margin: 1.5rem 0 .5rem; }
h3 { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: .75rem 0 .25rem; }
.sub { color: var(--muted); margin: .25rem 0 0; }
.warn { background: color-mix(in srgb, var(--near) 18%, transparent); border: 1px solid var(--near); border-radius: 6px; padding: .5rem .75rem; margin: 1rem 0; }
.cards { display: flex; flex-wrap: wrap; gap: .75rem; margin-top: 1rem; }
.card { flex: 1 1 120px; border: 1px solid var(--line); border-radius: 8px; padding: .6rem .8rem; }
.card-label { color: var(--muted); font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; }
.card-value { font-size: 1.4rem; font-weight: 600; }
.budget .bar { height: 12px; border-radius: 6px; background: var(--line); overflow: hidden; }
.budget .bar-fill { height: 100%; background: var(--ok); }
.bar-near .bar-fill { background: var(--near); }
.bar-over .bar-fill { background: var(--err); }
.budget-detail { color: var(--muted); margin: .35rem 0 0; }
.tables { display: flex; flex-wrap: wrap; gap: 1.5rem; }
.tables > div { flex: 1 1 320px; }
table { width: 100%; border-collapse: collapse; font-size: .85rem; }
th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid var(--line); }
th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
td.time, .time { color: var(--muted); font-size: .8rem; }
td.empty, .empty { color: var(--muted); font-style: italic; }
.badge { display: inline-block; padding: 0 .4rem; border-radius: 4px; font-size: .75rem; font-weight: 600; }
.badge-ok { color: var(--ok); background: color-mix(in srgb, var(--ok) 15%, transparent); }
.badge-err { color: var(--err); background: color-mix(in srgb, var(--err) 15%, transparent); }
.timeline-head { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: .5rem; }
.controls { display: flex; gap: .5rem; align-items: center; }
.controls input, .controls button { font: inherit; padding: .25rem .5rem; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); cursor: pointer; }
.controls input { cursor: text; }
.call { border: 1px solid var(--line); border-radius: 8px; margin: .4rem 0; }
.call[hidden] { display: none; }
.call summary { display: flex; gap: .6rem; align-items: center; padding: .5rem .75rem; cursor: pointer; }
.call summary::-webkit-details-marker { display: none; }
.call .idx { color: var(--muted); font-variant-numeric: tabular-nums; }
.call .tool { font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.call .meta { margin-left: auto; color: var(--muted); font-size: .8rem; }
.call-err { border-color: color-mix(in srgb, var(--err) 50%, var(--line)); }
.call-body { padding: 0 .75rem .75rem; }
pre { margin: 0; padding: .6rem .75rem; background: color-mix(in srgb, var(--fg) 5%, transparent); border-radius: 6px; overflow-x: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8rem; white-space: pre-wrap; word-break: break-word; }
`

/**
 * Inline behaviour: filter timeline entries by tool name and expand/collapse all. A fixed constant
 * with NO trace data interpolated, so it adds no injection surface (it only reads the `data-tool`
 * attributes the renderer already escaped). The viewer is fully usable without it (native
 * `<details>` still expand) — it is progressive enhancement.
 */
const SCRIPT = `
(function () {
  var filter = document.getElementById('filter');
  var calls = Array.prototype.slice.call(document.querySelectorAll('#calls .call'));
  if (filter) {
    filter.addEventListener('input', function () {
      var q = filter.value.trim().toLowerCase();
      calls.forEach(function (el) {
        var tool = (el.getAttribute('data-tool') || '').toLowerCase();
        el.hidden = q.length > 0 && tool.indexOf(q) === -1;
      });
    });
  }
  document.querySelectorAll('[data-action]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var open = btn.getAttribute('data-action') === 'expand';
      calls.forEach(function (el) { if (!el.hidden) el.open = open; });
    });
  });
})();
`
