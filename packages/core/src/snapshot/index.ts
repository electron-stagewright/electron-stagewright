/**
 * Public surface of the snapshot module: schema, framework-agnostic walker,
 * fingerprint, accname, role-resolution, and state-extraction helpers. The
 * dispatcher-side tool wrapping (the `snapshot` tool itself, dispatching
 * through `transport.evaluate`) is wired by the tool layer.
 *
 * @module
 */

export type {
  Snapshot,
  SnapshotEntry,
  SnapshotRole,
  SnapshotState,
  SnapshotBbox,
  SnapshotMeta,
  SnapshotJsonSchemaShape,
  SnapshotDiff,
  SnapshotEntryChange,
  ChangedField,
  FindQuery,
  RefReconciliation,
} from './schema.js'

export { SnapshotJsonSchema } from './schema.js'

export { walkAccessibilityTree, isEntryReachable, type WalkerOptions } from './walker.js'

export { computeAccessibleName } from './accname.js'

export { fnv1a32, computeFingerprint } from './fingerprint.js'

export { resolveRole, isRoleInteractive } from './roles.js'

export { extractState, isVisible, isDisabled } from './state.js'

export { diffSnapshots, markRecentlyChanged, detectRendererReload, withReloadFlag } from './diff.js'

export { reconcileRefs } from './reconcile.js'

export { findEntries } from './find.js'
