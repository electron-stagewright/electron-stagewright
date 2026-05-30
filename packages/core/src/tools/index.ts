/**
 * Public surface of the tools module — the tool-definition contract plus the
 * concrete tool families.
 *
 * @module
 */

import { INTERACTION_TOOLS } from './interaction/index.js'
import { LIFECYCLE_TOOLS } from './lifecycle/index.js'
import { READ_TOOLS } from './read/index.js'
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
export { INTERACTION_TOOLS } from './interaction/index.js'
export { READ_TOOLS } from './read/index.js'

/**
 * The full set of tools registered with the dispatcher by default — lifecycle
 * (launch/stop/info/windows/discover/…), snapshot (snapshot/find), interaction
 * (click/type/key/hover/drag/scroll/select/check/set-files), and read
 * (get_text/value/attribute/state/bbox/computed_style/exists/focused/elements).
 */
export const DEFAULT_TOOLS: readonly AnyToolDefinition[] = [
  ...LIFECYCLE_TOOLS,
  ...SNAPSHOT_TOOLS,
  ...INTERACTION_TOOLS,
  ...READ_TOOLS,
]
