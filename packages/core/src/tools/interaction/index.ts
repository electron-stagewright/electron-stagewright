/**
 * Interaction tools — the agent's real-input surface over a renderer: click,
 * type, key, hover, drag, scroll, select, check, set-files. Each resolves a
 * `ref`/`selector` target through the shared `target.ts` machinery and drives
 * the transport's interaction methods.
 *
 * @module
 */

import type { AnyToolDefinition } from '../types.js'
import { clickTool, dragTool, hoverTool } from './pointer.js'
import {
  clearInputTool,
  keyTool,
  keyboardTypeTool,
  pressSequenceTool,
  typeTool,
} from './keyboard.js'
import { checkTool, selectOptionTool, setFilesTool, uncheckTool } from './form.js'
import { scrollIntoViewTool, scrollTool } from './scroll.js'

export { clickTool, dragTool, hoverTool } from './pointer.js'
export {
  clearInputTool,
  keyTool,
  keyboardTypeTool,
  pressSequenceTool,
  typeTool,
} from './keyboard.js'
export { checkTool, selectOptionTool, setFilesTool, uncheckTool } from './form.js'
export { scrollIntoViewTool, scrollTool } from './scroll.js'

/** The interaction tools registered with the dispatcher by default. */
export const INTERACTION_TOOLS: readonly AnyToolDefinition[] = [
  clickTool,
  hoverTool,
  dragTool,
  typeTool,
  keyboardTypeTool,
  keyTool,
  pressSequenceTool,
  clearInputTool,
  selectOptionTool,
  checkTool,
  uncheckTool,
  setFilesTool,
  scrollTool,
  scrollIntoViewTool,
]
