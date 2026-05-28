/**
 * Shared window-selection logic for the multi-window tools (`windows_list`,
 * `switch_window`, and any future tool that targets a specific window).
 *
 * The precedence is fixed and documented in the tool descriptions:
 * `targetId > windowTitle > index > default (the first/active window)`. Keeping
 * it in one place means every tool resolves a window identically — a divergence
 * here would make `switch_window` and a screenshot tool disagree about which
 * window the agent meant.
 *
 * @module
 */

import type { WindowDescriptor } from '../../transports/index.js'

/** A window selector as accepted from agent input. All fields optional; precedence applies. */
export interface WindowSelector {
  /** Transport-specific window id (highest precedence). */
  readonly targetId?: string
  /** Exact `document.title` match (second precedence). */
  readonly windowTitle?: string
  /** 0-based position in the window list (third precedence). */
  readonly index?: number
}

/**
 * Resolve the window a selector refers to, applying
 * `targetId > windowTitle > index > default` precedence. Returns the matched
 * {@link WindowDescriptor}, or `undefined` when the list is empty or no window
 * matches the chosen criterion (the caller maps `undefined` to `REF_NOT_FOUND`).
 *
 * Only the highest-precedence provided field is consulted: if `targetId` is
 * given it alone decides (a miss returns `undefined` rather than falling through
 * to `windowTitle`), so an agent passing a stale id gets a clear miss instead of
 * a surprising different window.
 */
export function resolveWindow(
  windows: readonly WindowDescriptor[],
  selector: WindowSelector,
): WindowDescriptor | undefined {
  if (windows.length === 0) return undefined
  if (selector.targetId !== undefined) {
    return windows.find((window) => window.id === selector.targetId)
  }
  if (selector.windowTitle !== undefined) {
    return windows.find((window) => window.title === selector.windowTitle)
  }
  if (selector.index !== undefined) {
    return windows[selector.index]
  }
  return windows[0]
}
