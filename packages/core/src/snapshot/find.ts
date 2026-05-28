/**
 * Semantic query over a snapshot. `findEntries` lets an agent ask for elements
 * by role / name / visibility / interactivity without re-reading the full
 * snapshot or guessing CSS selectors.
 *
 * Pure filter over an already-produced `Snapshot`. All provided query fields
 * must match (logical AND). `name_contains` is a case-insensitive substring
 * match; `name_exact` is a case-insensitive equality match. Supplying both is a
 * caller error — `name_exact` wins when both are present, but callers should
 * pick one.
 *
 * @module
 */

import type { FindQuery, Snapshot, SnapshotEntry } from './schema.js'

/**
 * Return the entries of `snapshot` that satisfy every provided field of
 * `query`. An empty query returns all entries. No matches returns an empty
 * array.
 */
export function findEntries(snapshot: Snapshot, query: FindQuery): readonly SnapshotEntry[] {
  return snapshot.entries.filter((entry) => matchesQuery(entry, query))
}

function matchesQuery(entry: SnapshotEntry, query: FindQuery): boolean {
  if (query.role !== undefined && entry.role !== query.role) {
    return false
  }
  if (query.interactive !== undefined && entry.interactive !== query.interactive) {
    return false
  }
  if (query.visible !== undefined && entry.state.visible !== query.visible) {
    return false
  }
  if (query.name_exact !== undefined) {
    if (entry.name.toLowerCase() !== query.name_exact.toLowerCase()) {
      return false
    }
  } else if (query.name_contains !== undefined) {
    if (!entry.name.toLowerCase().includes(query.name_contains.toLowerCase())) {
      return false
    }
  }
  return true
}
