/**
 * Read tools — the agent's targeted view of the renderer: text, value,
 * attribute, full state envelope, bounding box, computed style, existence, the
 * focused element, and selector matches. All are `query` operations (no
 * mutation) that resolve a `ref`/`selector` through the shared `tools/target.ts`
 * machinery and run via the transport's renderer eval.
 *
 * @module
 */

import type { AnyToolDefinition } from '../types.js'
import { elementsListTool, focusedElementTool } from './query.js'
import { getStateTool } from './state.js'
import {
  existsTool,
  getAttributeTool,
  getBboxTool,
  getComputedStyleTool,
  getTextTool,
  getValueTool,
} from './value.js'

export {
  existsTool,
  getAttributeTool,
  getBboxTool,
  getComputedStyleTool,
  getTextTool,
  getValueTool,
} from './value.js'
export { getStateTool, makeGetStateTool, type ReadProbeDeps } from './state.js'
export {
  elementsListTool,
  focusedElementTool,
  makeElementsListTool,
  makeFocusedElementTool,
} from './query.js'

/** The read tools registered with the dispatcher by default. */
export const READ_TOOLS: readonly AnyToolDefinition[] = [
  getTextTool,
  getValueTool,
  getAttributeTool,
  getStateTool,
  getBboxTool,
  getComputedStyleTool,
  existsTool,
  focusedElementTool,
  elementsListTool,
]
