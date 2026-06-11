/**
 * Unit tests for the compact diff encoding and the token-budget truncation —
 * the two levers that keep a `snapshot({ since: 'last' })` payload inside an
 * MCP client's token cap (the dogfooded failure: a busy dialog's diff carried
 * full prev/curr entries per change and blew ~65k chars).
 */

import { describe, expect, it } from 'vitest'

import {
  compactDiff,
  diffSnapshots,
  truncateDiffToBudget,
  type Snapshot,
  type SnapshotEntry,
} from '../src/snapshot/index.js'

/** Build one synthetic entry; interactive entries get a ref, landmarks null. */
function entry(
  overrides: Partial<SnapshotEntry> & { readonly fingerprint: string },
): SnapshotEntry {
  const interactive = overrides.interactive ?? true
  return {
    ref: interactive ? 1 : null,
    tag: 'button',
    role: 'button',
    name: 'Save',
    description: '',
    interactive,
    state: {
      visible: true,
      enabled: true,
      disabled: false,
      checked: null,
      selected: null,
      expanded: null,
      pressed: null,
      focused: false,
      readonly: null,
      required: null,
      invalid: null,
      busy: false,
      shadow_closed: false,
    },
    bbox: { x: 0, y: 0, w: 100, h: 30 },
    recently_changed: false,
    value: '',
    placeholder: '',
    ...overrides,
  }
}

function snapshotOf(entries: readonly SnapshotEntry[]): Snapshot {
  return {
    schemaVersion: 1,
    entries,
    meta: {
      viewport: { width: 800, height: 600 },
      url: 'app://index.html',
      title: 'App',
      navigation_started_at_ms: 1000,
      diff_baseline: 'full',
      renderer_reloaded_since_last_snapshot: false,
    },
  }
}

describe('compactDiff', () => {
  it('shrinks changed entries to identity plus ONLY the changed fields', () => {
    const prev = snapshotOf([entry({ fingerprint: 'f1', ref: 3, value: 'old' })])
    const curr = snapshotOf([entry({ fingerprint: 'f1', ref: 3, value: 'new' })])
    const compact = compactDiff(diffSnapshots(prev, curr))

    expect(compact.changed).toHaveLength(1)
    const change = compact.changed[0]
    expect(change).toMatchObject({
      fingerprint: 'f1',
      ref: 3,
      role: 'button',
      name: 'Save',
      changed_fields: ['value'],
      prev: { value: 'old' },
      curr: { value: 'new' },
    })
    // The unchanged fields are NOT carried — that is the whole point.
    expect(change?.prev).not.toHaveProperty('state')
    expect(change?.prev).not.toHaveProperty('bbox')
  })

  it('shrinks removed entries to identity only and keeps added entries complete', () => {
    const prev = snapshotOf([
      entry({ fingerprint: 'gone', ref: 1, name: 'Old button' }),
      entry({ fingerprint: 'stays', ref: 2, name: 'Stays' }),
    ])
    const curr = snapshotOf([
      entry({ fingerprint: 'stays', ref: 2, name: 'Stays' }),
      entry({ fingerprint: 'fresh', ref: 3, name: 'New button' }),
    ])
    const compact = compactDiff(diffSnapshots(prev, curr))

    expect(compact.removed).toEqual([
      { fingerprint: 'gone', ref: 1, role: 'button', name: 'Old button' },
    ])
    // Added entries are new UI the agent has never seen — they stay complete.
    expect(compact.added[0]).toMatchObject({ fingerprint: 'fresh', tag: 'button', value: '' })
    expect(compact._meta).toMatchObject({ entries_added: 1, entries_removed: 1 })
  })

  it('is strictly smaller than the full encoding and recomputes estimated_tokens', () => {
    const prev = snapshotOf([entry({ fingerprint: 'f1', value: 'a'.repeat(50) })])
    const curr = snapshotOf([entry({ fingerprint: 'f1', value: 'b'.repeat(50) })])
    const full = diffSnapshots(prev, curr)
    const compact = compactDiff(full)
    expect(compact._meta.estimated_tokens).toBeLessThan(full._meta.estimated_tokens)
  })

  it('survives the JSON round-trip intact (wire-type contract)', () => {
    const prev = snapshotOf([entry({ fingerprint: 'f1', value: 'old' })])
    const curr = snapshotOf([entry({ fingerprint: 'f1', value: 'new' })])
    const compact = compactDiff(diffSnapshots(prev, curr))
    expect(JSON.parse(JSON.stringify(compact))).toEqual(compact)
  })
})

describe('truncateDiffToBudget', () => {
  function bigDiff() {
    // 3 non-interactive landmarks + 3 interactive buttons removed; budget
    // pressure must drop the landmarks first.
    const landmarks = [1, 2, 3].map((i) =>
      entry({
        fingerprint: `land-${i}`,
        interactive: false,
        role: 'main',
        tag: 'main',
        name: `Landmark ${i} ${'x'.repeat(40)}`,
      }),
    )
    const buttons = [1, 2, 3].map((i) =>
      entry({ fingerprint: `btn-${i}`, ref: i, name: `Button ${i} ${'y'.repeat(40)}` }),
    )
    const prev = snapshotOf([...landmarks, ...buttons])
    const curr = snapshotOf([])
    return diffSnapshots(prev, curr)
  }

  it('returns the diff untouched when it fits the budget', () => {
    const diff = bigDiff()
    const { diff: kept, dropped } = truncateDiffToBudget(diff, 1_000_000)
    expect(dropped).toBe(0)
    expect(kept).toBe(diff)
    expect(kept._meta.truncated_entries).toBeUndefined()
  })

  it('drops non-interactive entries first and reports the omission', () => {
    const diff = bigDiff()
    const full = diff._meta.estimated_tokens
    // A budget that forces SOME dropping but can keep the three buttons.
    const { diff: kept, dropped } = truncateDiffToBudget(diff, Math.ceil(full * 0.55))

    expect(dropped).toBeGreaterThan(0)
    expect(kept._meta.truncated_entries).toBe(dropped)
    // Every surviving removed entry is interactive — landmarks went first.
    expect(kept.removed.every((e) => e.interactive)).toBe(true)
    // The REAL delta counts are untouched; only the payload shrank.
    expect(kept._meta.entries_removed).toBe(6)
    expect(kept._meta.estimated_tokens).toBeLessThan(full)
  })

  it('works identically on the compact encoding (ref null = landmark)', () => {
    const compact = compactDiff(bigDiff())
    const { diff: kept, dropped } = truncateDiffToBudget(
      compact,
      Math.ceil(compact._meta.estimated_tokens * 0.55),
    )
    expect(dropped).toBeGreaterThan(0)
    expect(kept.removed.every((e) => e.ref !== null)).toBe(true)
  })

  it('preserves the original relative order among the kept entries', () => {
    const diff = bigDiff()
    const original = diff.removed.map((e) => e.fingerprint)
    const { diff: kept, dropped } = truncateDiffToBudget(
      diff,
      Math.ceil(diff._meta.estimated_tokens * 0.7),
    )
    expect(dropped).toBeGreaterThan(0)
    const keptOrder = kept.removed.map((e) => e.fingerprint)
    // The kept list must be the original list with items removed — never reordered.
    expect(keptOrder).toEqual(original.filter((f) => keptOrder.includes(f)))
  })
})
