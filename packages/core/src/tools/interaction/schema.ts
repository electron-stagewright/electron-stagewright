/**
 * Reusable Zod field fragments shared by the interaction tools, so every tool
 * exposes `ref` / `selector` / `force` / `timeoutMs` / `sessionId` with identical
 * shapes and agent-facing descriptions. Kept in one place (rather than copied per
 * tool) so the contract cannot drift between, say, `electron_click` and
 * `electron_type`.
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

/** CSS or text selector. Mutually exclusive with `ref`. */
export const selectorField = z
  .string()
  .optional()
  .describe('CSS or text selector. Provide ref OR selector, not both.')

/** Bypass actionability checks (for overlays / transient states). */
export const forceField = z
  .boolean()
  .optional()
  .describe('Bypass actionability checks (visibility/enabled/stable). Default false.')

/** Bounded actionability budget in milliseconds. */
export const timeoutField = z
  .number()
  .int()
  .nonnegative()
  .optional()
  .describe('Actionability budget in ms (default 5000, clamped to 30000).')
