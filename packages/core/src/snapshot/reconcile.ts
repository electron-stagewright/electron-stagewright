/**
 * Ref reconciliation — reassign the current snapshot's interactive ref numbers
 * so that an element with a stable fingerprint keeps the ref number it held in
 * the previous snapshot. This is what lets an agent run several interactions in
 * a row (`click({ ref: 5 })` after typing) without re-snapshotting: as long as
 * the element's fingerprint is unchanged, ref 5 still points at it even though
 * the DOM re-rendered and shifted document order.
 *
 * Pure function over two snapshots. Fingerprint matching is group-by-fingerprint
 * in document order, mirroring the diff: the Nth interactive entry of a
 * fingerprint in the current snapshot reuses the ref of the Nth interactive
 * entry of the same fingerprint in the previous snapshot. Current interactive
 * entries with no previous counterpart get fresh refs allocated ABOVE the
 * maximum reused ref, so reused and fresh refs never collide.
 *
 * Edge cases to be aware of:
 *
 * - **More current duplicates than previous.** If `curr` has three "Save"
 *   buttons sharing a fingerprint but `prev` had only one, the first reuses the
 *   previous ref and the other two get fresh refs. The per-fingerprint queue
 *   cursor handles this — once the queue is exhausted, subsequent entries fall
 *   through to fresh allocation.
 * - **No collision guarantee.** Fresh refs start at `maxPrevRef + 1` and skip
 *   any number already reused (the `while (reusedRefs.has(nextFresh))` guard).
 *   Reused refs are always `<= maxPrevRef`, so in practice the skip is
 *   defensive, but it makes the no-collision property hold even if the ref
 *   space ever became non-contiguous.
 * - **A list reorder drifts fingerprints and drops reuse.** Because the
 *   fingerprint encodes ancestor roles, reordering items in a list changes
 *   their composed context; those refs will be reported as `dropped` (old) +
 *   `fresh` (new) rather than `reused`. Apps that need ref stability under
 *   reorder must give items a stable identity the fingerprint can latch onto
 *   (a future enhancement — see the snapshot backlog).
 * - **Non-interactive entries (ref === null) are untouched.** Landmarks keep
 *   `ref: null`; they do not participate in reuse, fresh allocation, or the
 *   dropped count.
 *
 * @module
 */

import type { RefReconciliation, Snapshot, SnapshotEntry } from './schema.js'

/**
 * Build a map of fingerprint → queue of previous refs (in document order) for
 * interactive entries only. Non-interactive entries (ref === null) do not
 * participate in ref reuse.
 */
function buildPrevRefQueues(prev: Snapshot): Map<string, number[]> {
  const queues = new Map<string, number[]>()
  for (const entry of prev.entries) {
    if (entry.ref === null) continue
    const queue = queues.get(entry.fingerprint)
    if (queue === undefined) {
      queues.set(entry.fingerprint, [entry.ref])
    } else {
      queue.push(entry.ref)
    }
  }
  return queues
}

/**
 * Reconcile `curr`'s interactive refs against `prev`. Returns the reconciled
 * snapshot plus counts of reused / fresh / dropped refs.
 *
 * - `reused`: current interactive entries that took a previous ref.
 * - `fresh`: current interactive entries that received a brand-new ref.
 * - `dropped`: previous interactive refs with no current counterpart.
 */
export function reconcileRefs(prev: Snapshot, curr: Snapshot): RefReconciliation {
  const prevQueues = buildPrevRefQueues(prev)

  // Track which previous refs get reused so we can (a) avoid handing them out
  // as fresh refs and (b) count the dropped ones.
  const reusedRefs = new Set<number>()
  let maxPrevRef = 0
  for (const entry of prev.entries) {
    if (entry.ref !== null && entry.ref > maxPrevRef) maxPrevRef = entry.ref
  }

  // First pass: assign reused refs where a previous queue entry exists.
  // Consume from the per-fingerprint queues in document order.
  const queueCursors = new Map<string, number>()
  const assignments = new Map<SnapshotEntry, number | 'fresh'>()
  let reused = 0

  for (const entry of curr.entries) {
    if (entry.ref === null) continue // non-interactive: keep null
    const queue = prevQueues.get(entry.fingerprint)
    const cursor = queueCursors.get(entry.fingerprint) ?? 0
    if (queue !== undefined && cursor < queue.length) {
      const reusedRef = queue[cursor]
      if (reusedRef !== undefined) {
        assignments.set(entry, reusedRef)
        reusedRefs.add(reusedRef)
        queueCursors.set(entry.fingerprint, cursor + 1)
        reused++
        continue
      }
    }
    assignments.set(entry, 'fresh')
  }

  // Second pass: hand out fresh refs above max(prev ref, any reused ref),
  // skipping any number already reused to guarantee no collision.
  let nextFresh = maxPrevRef + 1
  let fresh = 0
  const freshAssignments = new Map<SnapshotEntry, number>()
  for (const [entry, assignment] of assignments) {
    if (assignment !== 'fresh') continue
    while (reusedRefs.has(nextFresh)) nextFresh++
    freshAssignments.set(entry, nextFresh)
    reusedRefs.add(nextFresh)
    nextFresh++
    fresh++
  }

  // Build the reconciled entries.
  const entries: SnapshotEntry[] = curr.entries.map((entry) => {
    if (entry.ref === null) return entry
    const assignment = assignments.get(entry)
    if (assignment === undefined) return entry
    const newRef = assignment === 'fresh' ? freshAssignments.get(entry) : assignment
    if (newRef === undefined || newRef === entry.ref) return entry
    return { ...entry, ref: newRef }
  })

  // Dropped: previous interactive refs whose fingerprint queue was not fully
  // consumed by current entries.
  let dropped = 0
  for (const [fingerprint, queue] of prevQueues) {
    const consumed = queueCursors.get(fingerprint) ?? 0
    dropped += Math.max(0, queue.length - consumed)
  }

  return {
    snapshot: { ...curr, entries },
    reused,
    fresh,
    dropped,
  }
}
