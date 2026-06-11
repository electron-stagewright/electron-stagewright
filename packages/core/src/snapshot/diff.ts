/**
 * Snapshot diffing — compute the delta between two snapshots so an agent can
 * react to "what changed" instead of re-reading the full picture.
 *
 * Pure functions over already-produced `Snapshot` objects. The stateful
 * per-session store that holds the previous snapshot (so a tool can offer
 * `snapshot({ since: 'last' })`) lives in the tool layer; these functions are
 * the building blocks it calls.
 *
 * Fingerprint identity: entries are matched by fingerprint (`role + name +
 * last-3-ancestor-roles`). Two entries can legitimately share a fingerprint
 * (e.g. two "Save" buttons under the same ancestor chain), so matching is done
 * group-by-fingerprint in document order: the Nth entry of a fingerprint in the
 * previous snapshot pairs with the Nth entry of the same fingerprint in the
 * current snapshot. Extra current entries are `added`; extra previous entries
 * are `removed`.
 *
 * Edge cases to be aware of:
 *
 * - **A renamed element shows up as add + remove, not change.** The accessible
 *   name is part of the fingerprint, so renaming an element drifts its
 *   fingerprint: the old fingerprint disappears (removed) and the new one
 *   appears (added). The `name` comparison in `changedFields` is therefore
 *   effectively unreachable today; it is kept defensively in case a future
 *   fingerprint scheme excludes the name.
 * - **Landmarks (ref === null) participate in the diff.** A `<main>` or `<nav>`
 *   that moves or changes appears in `changed`; one that is added/removed shows
 *   in `added`/`removed`. Only interactive entries contribute to `ref_map`
 *   (landmarks have no ref to reuse).
 * - **`ref_map` records the first ref-bearing previous entry per fingerprint.**
 *   When duplicates share a fingerprint, reconciliation (see `reconcile.ts`)
 *   does the precise position-based pairing; `ref_map` is the coarse hint.
 * - **`markRecentlyChanged` matches by object identity.** It must be called with
 *   the exact `curr` object that was passed to `diffSnapshots` — a
 *   reconstructed/cloned `curr` will not match and the flags will not apply.
 * - **`detectRendererReload` returns `false` when either url is empty.** A
 *   missing url (some transports may not capture it) is treated as
 *   "cannot conclude a reload" rather than asserting one.
 * - **`detectRendererReload` also fires on SPA route changes.** A client-side
 *   `history.pushState` route change updates the url without recreating the
 *   document, so `navigation_started_at_ms` is unchanged but the url differs —
 *   this reports `true`. That is intentional and conservative-safe: a route
 *   change usually swaps enough of the DOM to invalidate the agent's refMap, so
 *   nudging the agent to re-snapshot is the safe default. A same-url hard reload
 *   (F5) is caught by the `navigation_started_at_ms` change even though the url
 *   is identical. The combination means: hard reload OR route change → true;
 *   in-place DOM mutation under the same url and navigation start → false.
 *
 * @module
 */

import { estimateTokens } from '../errors/index.js'
import type {
  ChangedField,
  Snapshot,
  SnapshotBbox,
  SnapshotDiff,
  SnapshotDiffCompact,
  SnapshotEntry,
  SnapshotEntryChange,
  SnapshotEntryChangeCompact,
  SnapshotEntryChangedValues,
  SnapshotEntryRemovedCompact,
  SnapshotState,
} from './schema.js'

/** Group a snapshot's entries by fingerprint, preserving document order within each group. */
function groupByFingerprint(snapshot: Snapshot): Map<string, SnapshotEntry[]> {
  const groups = new Map<string, SnapshotEntry[]>()
  for (const entry of snapshot.entries) {
    const group = groups.get(entry.fingerprint)
    if (group === undefined) {
      groups.set(entry.fingerprint, [entry])
    } else {
      group.push(entry)
    }
  }
  return groups
}

/** Shallow-compare two bounding boxes. */
function bboxEqual(a: SnapshotBbox, b: SnapshotBbox): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}

/** Compare two state envelopes flag-by-flag. */
function stateEqual(a: SnapshotState, b: SnapshotState): boolean {
  return (
    a.visible === b.visible &&
    a.enabled === b.enabled &&
    a.disabled === b.disabled &&
    a.checked === b.checked &&
    a.selected === b.selected &&
    a.expanded === b.expanded &&
    a.pressed === b.pressed &&
    a.focused === b.focused &&
    a.readonly === b.readonly &&
    a.required === b.required &&
    a.invalid === b.invalid &&
    a.busy === b.busy &&
    a.shadow_closed === b.shadow_closed
  )
}

/** Determine which observable fields differ between two entries with the same fingerprint. */
function changedFields(prev: SnapshotEntry, curr: SnapshotEntry): ChangedField[] {
  const fields: ChangedField[] = []
  if (!stateEqual(prev.state, curr.state)) fields.push('state')
  if (prev.value !== curr.value) fields.push('value')
  if (!bboxEqual(prev.bbox, curr.bbox)) fields.push('bbox')
  // `name` is part of the fingerprint, so a name change normally drifts the
  // fingerprint and shows up as add+remove rather than change. We still compare
  // it for completeness in case a future fingerprint scheme excludes the name.
  if (prev.name !== curr.name) fields.push('name')
  return fields
}

/**
 * Compute the delta between two snapshots. Returns `added`, `removed`,
 * `changed`, a `ref_map` (current fingerprint → previous ref), and
 * token-economy metadata.
 */
export function diffSnapshots(prev: Snapshot, curr: Snapshot): SnapshotDiff {
  const prevGroups = groupByFingerprint(prev)
  const currGroups = groupByFingerprint(curr)

  const added: SnapshotEntry[] = []
  const removed: SnapshotEntry[] = []
  const changed: SnapshotEntryChange[] = []
  const refMap: Record<string, number> = {}

  // Walk current groups: pair with previous group entries by position.
  for (const [fingerprint, currEntries] of currGroups) {
    const prevEntries = prevGroups.get(fingerprint) ?? []
    const pairCount = Math.min(prevEntries.length, currEntries.length)

    // Record the ref_map from the FIRST previous entry with this fingerprint
    // that carried a ref (reconciliation reuses it).
    const prevWithRef = prevEntries.find((e) => e.ref !== null)
    if (prevWithRef !== undefined && prevWithRef.ref !== null) {
      refMap[fingerprint] = prevWithRef.ref
    }

    for (let i = 0; i < pairCount; i++) {
      const prevEntry = prevEntries[i]
      const currEntry = currEntries[i]
      if (prevEntry === undefined || currEntry === undefined) continue
      const fields = changedFields(prevEntry, currEntry)
      if (fields.length > 0) {
        changed.push({ fingerprint, prev: prevEntry, curr: currEntry, changed_fields: fields })
      }
    }

    // Extra current entries beyond the paired count are newly added.
    for (let i = pairCount; i < currEntries.length; i++) {
      const entry = currEntries[i]
      if (entry !== undefined) added.push(entry)
    }
  }

  // Walk previous groups for entries with no current counterpart → removed.
  for (const [fingerprint, prevEntries] of prevGroups) {
    const currEntries = currGroups.get(fingerprint) ?? []
    for (let i = currEntries.length; i < prevEntries.length; i++) {
      const entry = prevEntries[i]
      if (entry !== undefined) removed.push(entry)
    }
  }

  // Restore document order. Grouping by fingerprint scrambled the lists; agents
  // expect "what changed" in the order it appears on screen, so sort added /
  // changed by position in `curr` and removed by position in `prev`.
  const currIndex = new Map(curr.entries.map((entry, index) => [entry, index]))
  const prevIndex = new Map(prev.entries.map((entry, index) => [entry, index]))
  added.sort((a, b) => (currIndex.get(a) ?? 0) - (currIndex.get(b) ?? 0))
  removed.sort((a, b) => (prevIndex.get(a) ?? 0) - (prevIndex.get(b) ?? 0))
  changed.sort((a, b) => (currIndex.get(a.curr) ?? 0) - (currIndex.get(b.curr) ?? 0))

  const estimated = estimateTokens({ added, removed, changed })
  return {
    added,
    removed,
    changed,
    ref_map: refMap,
    _meta: {
      entries_added: added.length,
      entries_removed: removed.length,
      entries_changed: changed.length,
      estimated_tokens: estimated,
    },
  }
}

/** Project exactly the changed fields' values out of one entry. */
function pickChangedValues(
  entry: SnapshotEntry,
  fields: readonly ChangedField[],
): SnapshotEntryChangedValues {
  const out: { state?: SnapshotState; value?: string; bbox?: SnapshotBbox; name?: string } = {}
  for (const field of fields) {
    if (field === 'state') out.state = entry.state
    else if (field === 'value') out.value = entry.value
    else if (field === 'bbox') out.bbox = entry.bbox
    else out.name = entry.name
  }
  return out
}

/**
 * Project a full {@link SnapshotDiff} into the compact encoding: added entries
 * stay complete (new UI), removed entries shrink to identity, changed entries
 * carry only the changed fields' previous/current values. Pure transform;
 * `estimated_tokens` is recomputed on the compact payload so the agent's
 * apply-or-rescan decision uses the real cost.
 */
export function compactDiff(diff: SnapshotDiff): SnapshotDiffCompact {
  const removed: SnapshotEntryRemovedCompact[] = diff.removed.map((entry) => ({
    fingerprint: entry.fingerprint,
    ref: entry.ref,
    role: entry.role,
    name: entry.name,
  }))
  const changed: SnapshotEntryChangeCompact[] = diff.changed.map((change) => ({
    fingerprint: change.fingerprint,
    ref: change.curr.ref,
    role: change.curr.role,
    name: change.curr.name,
    changed_fields: change.changed_fields,
    prev: pickChangedValues(change.prev, change.changed_fields),
    curr: pickChangedValues(change.curr, change.changed_fields),
  }))
  return {
    added: diff.added,
    removed,
    changed,
    ref_map: diff.ref_map,
    _meta: {
      ...diff._meta,
      estimated_tokens: estimateTokens({ added: diff.added, removed, changed }),
    },
  }
}

/** One droppable payload item during budget truncation. */
interface DroppableItem {
  readonly kind: 'added' | 'removed' | 'changed'
  readonly index: number
  readonly tokens: number
  readonly interactive: boolean
}

/** Whether a diff payload item refers to an interactive entry (any encoding). */
function isInteractiveDiffItem(
  item:
    | SnapshotEntry
    | SnapshotEntryChange
    | SnapshotEntryChangeCompact
    | SnapshotEntryRemovedCompact,
): boolean {
  if ('interactive' in item) return item.interactive
  if ('curr' in item && typeof item.curr === 'object' && 'interactive' in item.curr) {
    return (item.curr as SnapshotEntry).interactive
  }
  return (item as { ref: number | null }).ref !== null
}

/**
 * Drop the lowest-value diff entries until the payload's estimated tokens fit
 * `budgetTokens`. Interactive entries are protected: non-interactive removed →
 * non-interactive changed → non-interactive added go first, then (only if
 * still over budget) interactive removed → changed → added; within a bucket,
 * later document-order items drop first. The `entries_*` counts keep
 * describing the REAL delta; `truncated_entries` reports how many items the
 * payload omitted. Works on either encoding.
 */
export function truncateDiffToBudget<T extends SnapshotDiff | SnapshotDiffCompact>(
  diff: T,
  budgetTokens: number,
): { readonly diff: T; readonly dropped: number } {
  let total = estimateTokens({ added: diff.added, removed: diff.removed, changed: diff.changed })
  if (total <= budgetTokens) return { diff, dropped: 0 }

  const items: DroppableItem[] = []
  const collect = (kind: DroppableItem['kind'], list: readonly unknown[]): void => {
    for (let index = 0; index < list.length; index++) {
      const value = list[index] as Parameters<typeof isInteractiveDiffItem>[0]
      items.push({
        kind,
        index,
        tokens: estimateTokens(value),
        interactive: isInteractiveDiffItem(value),
      })
    }
  }
  collect('removed', diff.removed)
  collect('changed', diff.changed)
  collect('added', diff.added)

  // Drop order: non-interactive before interactive; removed → changed → added
  // within each tier; later document-order items first within a bucket.
  const kindRank = { removed: 0, changed: 1, added: 2 } as const
  const dropOrder = [...items].sort((a, b) => {
    if (a.interactive !== b.interactive) return a.interactive ? 1 : -1
    if (a.kind !== b.kind) return kindRank[a.kind] - kindRank[b.kind]
    return b.index - a.index
  })

  const droppedByKind = {
    added: new Set<number>(),
    removed: new Set<number>(),
    changed: new Set<number>(),
  }
  let dropped = 0
  for (const item of dropOrder) {
    if (total <= budgetTokens) break
    droppedByKind[item.kind].add(item.index)
    total -= item.tokens
    dropped += 1
  }
  if (dropped === 0) return { diff, dropped: 0 }

  // The two encodings share the same array positions, so filtering by kept
  // index is encoding-agnostic; the cast back to T restores the precise shape.
  const keep = (list: readonly unknown[], kind: DroppableItem['kind']): unknown[] =>
    list.filter((_, index) => !droppedByKind[kind].has(index))

  const added = keep(diff.added, 'added')
  const removed = keep(diff.removed, 'removed')
  const changed = keep(diff.changed, 'changed')
  return {
    diff: {
      ...diff,
      added,
      removed,
      changed,
      _meta: {
        ...diff._meta,
        estimated_tokens: estimateTokens({ added, removed, changed }),
        truncated_entries: dropped,
      },
    } as T,
    dropped,
  }
}

/**
 * Produce a new snapshot identical to `curr` except that entries which the diff
 * marked as changed carry `recently_changed: true`. Entries are matched by the
 * change records' `curr` reference identity, so this must be called with the
 * same `curr` object that was passed to {@link diffSnapshots}.
 */
export function markRecentlyChanged(curr: Snapshot, diff: SnapshotDiff): Snapshot {
  if (diff.changed.length === 0) return curr
  const changedSet = new Set<SnapshotEntry>(diff.changed.map((c) => c.curr))
  const entries = curr.entries.map((entry) =>
    changedSet.has(entry) ? { ...entry, recently_changed: true } : entry,
  )
  return { ...curr, entries }
}

/**
 * Detect whether the renderer reloaded between two snapshots. A navigation
 * start change catches same-URL reloads; URL change is the fallback signal. A
 * title change alone is NOT a reload (apps update the title constantly).
 * Returns true when the snapshots come from different documents.
 */
export function detectRendererReload(prev: Snapshot, curr: Snapshot): boolean {
  if (
    prev.meta.navigation_started_at_ms > 0 &&
    curr.meta.navigation_started_at_ms > 0 &&
    prev.meta.navigation_started_at_ms !== curr.meta.navigation_started_at_ms
  ) {
    return true
  }
  if (prev.meta.url === '' || curr.meta.url === '') {
    // No URL captured on one side — cannot conclude a reload happened.
    return false
  }
  return prev.meta.url !== curr.meta.url
}

/**
 * Stamp `meta.renderer_reloaded_since_last_snapshot` on a snapshot. Returns a
 * new snapshot with the flag set; does not mutate the input.
 */
export function withReloadFlag(snapshot: Snapshot, reloaded: boolean): Snapshot {
  if (snapshot.meta.renderer_reloaded_since_last_snapshot === reloaded) return snapshot
  return {
    ...snapshot,
    meta: { ...snapshot.meta, renderer_reloaded_since_last_snapshot: reloaded },
  }
}
