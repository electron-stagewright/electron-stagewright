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

// The generic ref / selector / sessionId fields live in the neutral
// `tools/schema.ts` so the read family shares them without importing from the
// interaction family. Re-exported here so existing interaction-tool imports
// (`./schema.js`) keep resolving.
export { sessionIdField, refField, selectorField } from '../schema.js'

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
