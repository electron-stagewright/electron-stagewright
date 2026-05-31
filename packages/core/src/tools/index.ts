/**
 * Public surface of the tools module — the tool-definition contract plus the
 * concrete tool families.
 *
 * @module
 */

import { EVAL_TOOLS } from './eval/index.js'
import { INTERACTION_TOOLS } from './interaction/index.js'
import { LIFECYCLE_TOOLS } from './lifecycle/index.js'
import { OBSERVE_TOOLS } from './observe/index.js'
import { READ_TOOLS } from './read/index.js'
import { SNAPSHOT_TOOLS } from './snapshot/index.js'
import { WAIT_TOOLS } from './wait/index.js'
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
export { WAIT_TOOLS } from './wait/index.js'
export { EVAL_TOOLS } from './eval/index.js'
export { OBSERVE_TOOLS } from './observe/index.js'

/**
 * The full set of tools registered with the dispatcher by default — lifecycle
 * (launch/stop/info/windows/discover/…), snapshot (snapshot/find), interaction
 * (click/type/key/hover/drag/scroll/select/check/set-files), read
 * (get_text/value/attribute/state/bbox/computed_style/exists/focused/elements),
 * wait (wait/wait_for_selector/wait_for_state/wait_for_event), eval
 * (eval_main/eval_renderer — registered only when the server has --allow-eval),
 * and observe (screenshot/console_logs/dialog_handler).
 */
export const DEFAULT_TOOLS: readonly AnyToolDefinition[] = [
  ...LIFECYCLE_TOOLS,
  ...SNAPSHOT_TOOLS,
  ...INTERACTION_TOOLS,
  ...READ_TOOLS,
  ...WAIT_TOOLS,
  ...EVAL_TOOLS,
  ...OBSERVE_TOOLS,
]
