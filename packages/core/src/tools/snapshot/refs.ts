/**
 * Shared ref reconciliation for tools that run the renderer snapshot walker.
 *
 * The renderer walk initially tags elements with document-order refs. When a
 * previous snapshot exists, the server reconciles current refs against stable
 * fingerprints; any changed refs must then be retagged in the renderer so the
 * DOM agrees with the refs returned to the agent.
 *
 * @module
 */

import type { SnapshotStore } from '../../server/snapshot-store.js'
import {
  type Snapshot,
  detectRendererReload,
  reconcileRefs,
  withReloadFlag,
} from '../../snapshot/index.js'
import type { TransportSession } from '../../transports/index.js'
import { buildRetagBody } from './inject.js'

/** One DOM retag operation: element currently tagged `from` should become `to`. */
export interface RefRetagAssignment {
  readonly from: number
  readonly to: number
}

/** Reconcile current refs against the previous snapshot and report DOM retags needed. */
export function reconcileWalkedSnapshot(
  prev: Snapshot,
  walked: Snapshot,
): { readonly snapshot: Snapshot; readonly retags: readonly RefRetagAssignment[] } {
  const reconciliation = reconcileRefs(prev, walked)
  const retags: RefRetagAssignment[] = []
  for (let i = 0; i < walked.entries.length; i++) {
    const before = walked.entries[i]
    const after = reconciliation.snapshot.entries[i]
    if (
      before?.ref !== undefined &&
      before.ref !== null &&
      after?.ref !== undefined &&
      after.ref !== null &&
      before.ref !== after.ref
    ) {
      retags.push({ from: before.ref, to: after.ref })
    }
  }
  return { snapshot: reconciliation.snapshot, retags }
}

/**
 * The shared "stabilise a fresh walk" step used by both `electron_snapshot` and
 * `electron_find`: detect a reload, reconcile refs against the stored baseline
 * (when comparable), retag the renderer DOM to the reconciled refs, stamp the
 * reload flag, and store the result as the new baseline. Returns the stored
 * snapshot plus the flags both callers need. Keeping this in one place stops the
 * two tools from drifting on how a walk becomes the canonical session view.
 */
export async function reconcileRetagAndStore(args: {
  readonly session: TransportSession
  readonly store: SnapshotStore
  readonly sessionId: string
  readonly prev: Snapshot | undefined
  readonly walked: Snapshot
}): Promise<{ readonly curr: Snapshot; readonly comparable: boolean; readonly reloaded: boolean }> {
  const { session, store, sessionId, prev, walked } = args
  const reloaded = prev !== undefined && detectRendererReload(prev, walked)
  const comparable = prev !== undefined && !reloaded

  let reconciledSnapshot = walked
  let retags: readonly RefRetagAssignment[] = []
  if (prev !== undefined && !reloaded) {
    const reconciliation = reconcileWalkedSnapshot(prev, walked)
    reconciledSnapshot = reconciliation.snapshot
    retags = reconciliation.retags
  }
  if (retags.length > 0) {
    await session.evaluate<number>('renderer', buildRetagBody(), retags)
  }
  const curr = withReloadFlag(reconciledSnapshot, reloaded)
  store.set(sessionId, curr)
  return { curr, comparable, reloaded }
}
