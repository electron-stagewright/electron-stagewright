/**
 * Lifecycle tools manage Electron app state. This module exposes the default
 * built-in lifecycle registry; `electron_info` is currently the built-in tool.
 *
 * @module
 */

import type { AnyToolDefinition } from '../types.js'
import { infoTool } from './info.js'

export { infoTool, makeInfoTool, type InfoToolDeps } from './info.js'
export {
  inspectSignature,
  type SignatureInfo,
  type SignatureStatus,
  type SignatureVerifier,
  type InspectSignatureOptions,
} from './signature.js'

/** The lifecycle tools registered with the dispatcher by default. */
export const LIFECYCLE_TOOLS: readonly AnyToolDefinition[] = [infoTool]
