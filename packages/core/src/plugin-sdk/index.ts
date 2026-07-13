/**
 * Stable authoring helpers for `@electron-stagewright/core` plugins.
 *
 * Import from `@electron-stagewright/core/plugin-sdk`; this subpath intentionally exposes only
 * helpers proven by first-party plugins, while the plugin contract itself remains at the package root.
 *
 * @module
 */

export {
  createPluginConfigState,
  parsePluginConfig,
  PluginConfigValidationError,
  type DeepReadonly,
  type PluginConfigState,
} from './config.js'
export { createSessionCleanup, type PluginSessionCleanup } from './lifecycle.js'
export { requireTransportCapability, type TransportCapabilityCheck } from './capability.js'
export { sessionIdField } from './schemas.js'
