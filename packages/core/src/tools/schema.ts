/**
 * Zod field fragments shared by every tool family that addresses an element by
 * `ref` or `selector` (interaction + read). Kept in one neutral module so the
 * agent-facing shape of `ref` / `selector` / `sessionId` cannot drift between
 * `electron_click` and `electron_get_text`.
 *
 * @module
 */

import { z } from 'zod'

/** Optional target-session id; omit when exactly one session is live. */
export const sessionIdField = z
  .string()
  .optional()
  .describe('Target session id. Omit when a single session is running.')

/** Snapshot ref; resolves to `[data-sw-ref="N"]`. Mutually exclusive with `selector`. */
export const refField = z
  .number()
  .int()
  .positive()
  .optional()
  .describe('Element ref from a snapshot (resolves to [data-sw-ref="N"]). Provide ref OR selector.')

/** CSS selector. Mutually exclusive with `ref`. */
export const selectorField = z
  .string()
  .min(1)
  .optional()
  .describe('CSS selector. Provide ref OR selector, not both.')
