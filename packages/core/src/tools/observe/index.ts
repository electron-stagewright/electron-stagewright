/**
 * Observe tools — the agent's out-of-band view of the app that the DOM snapshot
 * does not expose: a screenshot to a file, the captured renderer console buffer,
 * and the native-dialog auto-responder + capture. The first two are read-only
 * (`screenshot` / `logs`); `dialog_handler` also arms a forward-looking policy.
 *
 * @module
 */

import type { AnyToolDefinition } from '../types.js'
import { consoleLogsTool } from './console.js'
import { dialogHandlerTool } from './dialog.js'
import { screenshotTool } from './screenshot.js'

export { consoleLogsTool } from './console.js'
export { dialogHandlerTool } from './dialog.js'
export { screenshotTool, makeScreenshotTool, type ScreenshotToolDeps } from './screenshot.js'

/** The observe tools registered with the dispatcher by default. */
export const OBSERVE_TOOLS: readonly AnyToolDefinition[] = [
  screenshotTool,
  consoleLogsTool,
  dialogHandlerTool,
]
