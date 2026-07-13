/**
 * Plugin model public surface (ADR-004) — re-exported from the package root.
 *
 * @module
 */

export {
  type StagewrightPlugin,
  type PluginServerContext,
  type PluginSessionEndEvent,
  type PluginSessionEndReason,
  type PluginRequirements,
  type PluginConfigDisclosure,
  type PluginIntrospection,
  type LoadedPlugin,
  type LoadedPluginToolInfo,
  type LoadedPluginInfo,
  type LoadPluginsOptions,
  type LoadPluginsResult,
  PLUGIN_API_VERSION,
} from './types.js'

export { loadPlugins } from './loader.js'
export { satisfies as satisfiesCoreVersion } from './semver.js'
export { importPlugin } from './resolve.js'
export { definePluginsInfoTool } from './info-tool.js'
