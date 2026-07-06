/**
 * Compact text rendering of snapshots and diffs (token-economy encoding). Verifies the
 * line format, the only-non-default-flags rule, and — the point of the feature — that the
 * text encoding is a large multiple cheaper than the JSON encoding on a realistic tree.
 */

import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

import { estimateTokens } from '../src/errors/envelope.js'
import {
  type Snapshot,
  compactDiff,
  diffSnapshots,
  renderDiffText,
  renderEntryLine,
  renderSnapshotText,
  walkAccessibilityTree,
} from '../src/snapshot/index.js'

function snap(html: string): Snapshot {
  return walkAccessibilityTree(new JSDOM(html).window.document, {})
}

describe('renderEntryLine', () => {
  it('renders ref, role, and quoted name with no flags for a default-state entry', () => {
    const s = snap('<button>Save</button>')
    const button = s.entries.find((e) => e.role === 'button')
    expect(button).toBeDefined()
    if (button === undefined) return
    expect(renderEntryLine(button)).toBe(`[${button.ref}] button "Save"`)
  })

  it('renders only non-default state flags', () => {
    const s = snap('<button disabled>Save</button><input type="checkbox" checked>')
    const button = s.entries.find((e) => e.role === 'button')
    const checkbox = s.entries.find((e) => e.role === 'checkbox')
    expect(button && renderEntryLine(button)).toContain('disabled')
    expect(button && renderEntryLine(button)).not.toContain('enabled')
    expect(checkbox && renderEntryLine(checkbox)).toContain('checked')
  })

  it('marks landmarks with [-] and recently-changed entries with ~', () => {
    const s = snap('<main><h1>Welcome</h1></main>')
    const heading = s.entries.find((e) => e.role === 'heading')
    expect(heading).toBeDefined()
    if (heading === undefined) return
    expect(renderEntryLine(heading)).toMatch(/^\[-\] heading "Welcome"/)
    expect(renderEntryLine({ ...heading, recently_changed: true })).toMatch(/^~\[-\]/)
  })

  it('always shows value= for textboxes (even empty) and placeholder when present', () => {
    const s = snap('<input type="text" placeholder="you@example.com">')
    const box = s.entries.find((e) => e.role === 'textbox')
    expect(box).toBeDefined()
    if (box === undefined) return
    const line = renderEntryLine(box)
    expect(line).toContain('value=""')
    expect(line).toContain('placeholder="you@example.com"')
  })

  it('truncates long values with a length marker and escapes newlines', () => {
    const s = snap(`<input type="text" value="${'x'.repeat(200)}">`)
    const box = s.entries.find((e) => e.role === 'textbox')
    expect(box).toBeDefined()
    if (box === undefined) return
    const line = renderEntryLine({ ...box, value: `${'x'.repeat(200)}\nline2` })
    expect(line).toContain('…(206 chars)')
    expect(line).not.toContain('\nline2')
  })
})

describe('renderSnapshotText', () => {
  it('renders a header line plus one line per entry', () => {
    const s = snap('<button>A</button><button>B</button>')
    const text = renderSnapshotText(s)
    const lines = text.split('\n')
    expect(lines[0]).toMatch(/^page ".*" url=".*" viewport=\d+x\d+ entries=\d+$/)
    expect(lines.length).toBe(1 + s.entries.length)
  })

  it('is a large multiple cheaper than the JSON encoding on a realistic tree', () => {
    // A form-heavy screen: 40 rows of label+input+button, nav, headings.
    const rows = Array.from(
      { length: 40 },
      (_, i) =>
        `<label>Field ${i}<input type="text" placeholder="Value ${i}"></label>` +
        `<button>Save row ${i}</button>`,
    ).join('')
    const s = snap(`<main><nav><a href="#">Home</a></nav><h1>Settings</h1>${rows}</main>`)
    const jsonTokens = estimateTokens(s)
    const textTokens = estimateTokens(renderSnapshotText(s))
    expect(s.entries.length).toBeGreaterThan(80)
    // The headline claim: at least 5x cheaper. (In practice ~8-10x on this fixture.)
    expect(textTokens * 5).toBeLessThan(jsonTokens)
  })
})

describe('renderDiffText', () => {
  it('renders +/-/~ lines with changed field values', () => {
    const before = snap(
      '<button>Save</button><button>Remove me</button><input type="text" value="a">',
    )
    const after = snap(
      '<button>Save</button><button disabled>Save</button><input type="text" value="b">',
    )
    // Force comparability by matching nav timestamps (walker fixes them per JSDOM).
    const diff = compactDiff(diffSnapshots(before, { ...after, meta: { ...after.meta } }))
    const text = renderDiffText(diff)
    const lines = text.split('\n')
    expect(lines[0]).toMatch(/^diff \+\d+ -\d+ ~\d+$/)
    expect(text).toContain('- ')
    expect(lines.length).toBe(1 + diff.added.length + diff.removed.length + diff.changed.length)
  })

  it('renders an empty delta as the summary line only', () => {
    const s = snap('<button>Same</button>')
    const diff = compactDiff(diffSnapshots(s, s))
    expect(renderDiffText(diff)).toBe('diff +0 -0 ~0')
  })
})
