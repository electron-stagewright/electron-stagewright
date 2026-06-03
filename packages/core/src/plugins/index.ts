/**
 * Plugin model public surface (ADR-004) — re-exported from the package root.
 *
 * @module
 */

export {
  type StagewrightPlugin,
  type LoadedPlugin,
  type LoadPluginsOptions,
  type LoadPluginsResult,
} from './types.js'

export { loadPlugins } from './loader.js'
