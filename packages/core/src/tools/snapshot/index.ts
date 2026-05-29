/**
 * Snapshot tools — the agent's structured view of the renderer and semantic
 * element queries. Both inject the bundled accessibility walker via the
 * transport's renderer eval.
 *
 * @module
 */

import type { AnyToolDefinition } from '../types.js'
import { findTool } from './find.js'
import { snapshotTool } from './snapshot.js'

export { snapshotTool, makeSnapshotTool, type SnapshotToolDeps } from './snapshot.js'
export { findTool, makeFindTool, type FindToolDeps } from './find.js'
export { loadInjectedWalker, buildWalkBody } from './inject.js'

/** The snapshot tools registered with the dispatcher by default. */
export const SNAPSHOT_TOOLS: readonly AnyToolDefinition[] = [snapshotTool, findTool]
