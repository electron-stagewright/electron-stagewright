/**
 * Wait tools — bounded, condition-based waits the agent uses to synchronise with
 * the app instead of re-snapshotting in a loop: a fixed delay, wait-for-selector
 * state, the composable wait-for-state, and wait-for-event. All are `query`
 * operations that run a self-bounded poll in the renderer and surface a timeout
 * as the retryable `WAIT_TIMEOUT` code.
 *
 * @module
 */

import type { AnyToolDefinition } from '../types.js'
import { waitTool } from './delay.js'
import { waitForEventTool } from './event.js'
import { waitForSelectorTool } from './selector.js'
import { waitForStateTool } from './state.js'

export { waitTool } from './delay.js'
export { waitForSelectorTool } from './selector.js'
export { waitForStateTool, makeWaitForStateTool, type WaitForStateDeps } from './state.js'
export { waitForEventTool } from './event.js'
export {
  DEFAULT_WAIT_TIMEOUT_MS,
  MAX_WAIT_TIMEOUT_MS,
  clampWaitTimeout,
  runWait,
  type RendererCall,
  type WaitRaw,
} from './poll.js'

/** The wait tools registered with the dispatcher by default. */
export const WAIT_TOOLS: readonly AnyToolDefinition[] = [
  waitTool,
  waitForSelectorTool,
  waitForStateTool,
  waitForEventTool,
]
