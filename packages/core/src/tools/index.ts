/**
 * Public surface of the tools module — the tool-definition contract plus the
 * concrete tool families.
 *
 * @module
 */

import { LIFECYCLE_TOOLS } from './lifecycle/index.js'
import { SNAPSHOT_TOOLS } from './snapshot/index.js'
import type { AnyToolDefinition } from './types.js'

export {
  type ToolDefinition,
  type AnyToolDefinition,
  type ToolContext,
  type ToolHandler,
  type ToolResult,
  defineTool,
} from './types.js'

export { LIFECYCLE_TOOLS } from './lifecycle/index.js'
export { SNAPSHOT_TOOLS } from './snapshot/index.js'

/**
 * The full set of tools registered with the dispatcher by default — lifecycle
 * (launch/stop/info/windows/discover/…) plus snapshot (snapshot/find).
 */
export const DEFAULT_TOOLS: readonly AnyToolDefinition[] = [...LIFECYCLE_TOOLS, ...SNAPSHOT_TOOLS]
