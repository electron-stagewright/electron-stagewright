/**
 * Expect tools — agent-ergonomic assertion primitives (ADR-007 Principle 8). Each
 * folds a read + comparison + retry-on-mismatch into one declarative call so an
 * agent verifies state in a single turn instead of a get → compare → wait → re-get
 * chain. All are `query` operations; a never-met expectation surfaces as the
 * retryable `EXPECTATION_FAILED` code carrying expected vs actual.
 *
 * @module
 */

import type { AnyToolDefinition } from '../types.js'
import { assertPatternTool } from './assert-pattern.js'
import { expectCountTool } from './count.js'
import { expectStateTool } from './state.js'
import { expectTextTool, expectValueTool } from './text.js'
import { expectUrlTool } from './url.js'
import { expectVisibleTool } from './visible.js'

export { expectTextTool, expectValueTool } from './text.js'
export { expectVisibleTool } from './visible.js'
export { expectStateTool, makeExpectStateTool, type ExpectStateDeps } from './state.js'
export { expectCountTool, makeExpectCountTool, type ExpectCountDeps } from './count.js'
export { expectUrlTool } from './url.js'
export { assertPatternTool } from './assert-pattern.js'

/** The expect tools registered with the dispatcher by default. */
export const EXPECT_TOOLS: readonly AnyToolDefinition[] = [
  expectTextTool,
  expectValueTool,
  expectVisibleTool,
  expectStateTool,
  expectCountTool,
  expectUrlTool,
  assertPatternTool,
]
