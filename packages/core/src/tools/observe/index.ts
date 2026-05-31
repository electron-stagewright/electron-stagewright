/**
 * Observe tools — the agent's out-of-band view of the app: a screenshot to a file
 * and the captured renderer console buffer. Both are `query` operations; they read
 * state the DOM snapshot does not expose (pixels, console output).
 *
 * @module
 */

import type { AnyToolDefinition } from '../types.js'
import { consoleLogsTool } from './console.js'
import { screenshotTool } from './screenshot.js'

export { consoleLogsTool } from './console.js'
export { screenshotTool, makeScreenshotTool, type ScreenshotToolDeps } from './screenshot.js'

/** The observe tools registered with the dispatcher by default. */
export const OBSERVE_TOOLS: readonly AnyToolDefinition[] = [screenshotTool, consoleLogsTool]
