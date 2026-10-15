/**
 * Restrict a full snapshot or diff to one element's subtree, using the entry
 * positions a scoped walk reported. The stored baseline stays the full walk, so
 * scoping is a view over it: refs and diff pairing are computed globally first.
 *
 * @module
 */

import { estimateTokens } from '../errors/index.js'
import type { Snapshot, SnapshotDiff, SnapshotEntry } from './schema.js'
import type { WalkScope } from './walker.js'

/** The entries of `snapshot` inside `scope`, in document order. */
export function scopeSnapshot(snapshot: Snapshot, scope: WalkScope): Snapshot {
  const keep = new Set(scope.indices)
  return { ...snapshot, entries: snapshot.entries.filter((_, index) => keep.has(index)) }
}

/**
 * Restrict `diff` (computed from `prev` to `curr`) to the scoped subtree of `curr`.
 * Added and changed entries are kept when their current entry is in scope. A
 * removed entry has no current position, so it is kept when it sat between the
 * nearest surviving out-of-scope neighbours of an in-scope run; a removal right
 * at the subtree's edge may therefore be reported even if it was a sibling.
 */
export function scopeDiff(
  diff: SnapshotDiff,
  prev: Snapshot,
  curr: Snapshot,
  scope: WalkScope,
): SnapshotDiff {
  const inScope = new Set(scope.indices)
  const inScopeEntries = new Set(scope.indices.flatMap((index) => curr.entries[index] ?? []))
  const added = diff.added.filter((entry) => inScopeEntries.has(entry))
  const changed = diff.changed.filter((change) => inScopeEntries.has(change.curr))

  const prevIndexOf = pairedPrevIndices(prev, curr)
  const ranges = removalRanges(scope, inScope, prevIndexOf, prev.entries.length)
  const prevPosition = new Map(prev.entries.map((entry, index) => [entry, index]))
  const removed = diff.removed.filter((entry) => {
    const position = prevPosition.get(entry)
    return position !== undefined && ranges.some(([lo, hi]) => position > lo && position < hi)
  })

  const fingerprints = new Set([...inScopeEntries].map((entry) => entry.fingerprint))
  const refMap = Object.fromEntries(
    Object.entries(diff.ref_map).filter(([fingerprint]) => fingerprints.has(fingerprint)),
  )
  return {
    added,
    removed,
    changed,
    ref_map: refMap,
    _meta: {
      entries_added: added.length,
      entries_removed: removed.length,
      entries_changed: changed.length,
      estimated_tokens: estimateTokens({ added, removed, changed }),
    },
  }
}

/** For each `curr` position, the `prev` position it pairs with (same Nth-per-fingerprint rule as the diff). */
function pairedPrevIndices(prev: Snapshot, curr: Snapshot): (number | undefined)[] {
  const queues = new Map<string, number[]>()
  prev.entries.forEach((entry, index) => {
    const queue = queues.get(entry.fingerprint)
    if (queue === undefined) queues.set(entry.fingerprint, [index])
    else queue.push(index)
  })
  return curr.entries.map((entry: SnapshotEntry) => queues.get(entry.fingerprint)?.shift())
}

/**
 * Open `prev` position intervals that bound each in-scope run: from the previous
 * surviving out-of-scope entry to the next one. An empty scope still yields the
 * interval around the root's walk position.
 */
function removalRanges(
  scope: WalkScope,
  inScope: ReadonlySet<number>,
  prevIndexOf: readonly (number | undefined)[],
  prevLength: number,
): [number, number][] {
  const runs: [number, number][] = []
  for (const index of scope.indices) {
    const last = runs.at(-1)
    if (last !== undefined && last[1] === index) last[1] = index + 1
    else runs.push([index, index + 1])
  }
  if (runs.length === 0) runs.push([scope.start, scope.start])

  const anchor = (from: number, step: 1 | -1): number | undefined => {
    for (let index = from; index >= 0 && index < prevIndexOf.length; index += step) {
      if (inScope.has(index)) continue
      const paired = prevIndexOf[index]
      if (paired !== undefined) return paired
    }
    return undefined
  }
  return runs.map(([start, end]) => [anchor(start - 1, -1) ?? -1, anchor(end, 1) ?? prevLength])
}
