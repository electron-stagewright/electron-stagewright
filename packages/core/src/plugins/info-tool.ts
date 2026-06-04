/**
 * `electron_plugins` — list the plugins loaded into this server (name, version, and their
 * namespaced tool names). Session-independent: it reports a per-server metadata snapshot
 * captured during server assembly, so an agent can discover plugin-provided capabilities
 * without launching an app.
 *
 * The server registers this tool ONLY when at least one plugin is loaded, so a plugin-free
 * server keeps its `tools/list` minimal (the lean-core principle this plugin model exists
 * to protect — ADR-004, ADR-007).
 *
 * @module
 */

import { z } from 'zod'

import { makeSuccess } from '../errors/envelope.js'
import { type AnyToolDefinition, defineTool } from '../tools/types.js'
import type { LoadedPluginInfo } from './types.js'

function snapshotPluginInfo(plugins: readonly LoadedPluginInfo[]): readonly LoadedPluginInfo[] {
  return plugins
    .map((plugin) => ({
      name: plugin.name,
      version: plugin.version,
      tools: [...plugin.tools],
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Define `electron_plugins` for ONE server's loaded-plugin set. Registered only when
 * plugins are present.
 */
export function definePluginsInfoTool(plugins: readonly LoadedPluginInfo[]): AnyToolDefinition {
  const loadedPlugins = snapshotPluginInfo(plugins)
  return defineTool({
    name: 'electron_plugins',
    title: 'List loaded plugins',
    description: [
      "List the plugins loaded into this server: each plugin's name, version, and its",
      'namespaced tool names (e.g. trace_start). Use it to discover plugin-provided capabilities',
      'beyond the core tool surface. Takes no arguments and needs no running app. Returns:',
      '{ ok, plugins: [{ name, version, tools }] }. Errors: none (empty list when none loaded).',
    ].join(' '),
    inputSchema: z.object({}),
    // State-reading, non-eval, no session required — classified as a query.
    operationType: 'query',
    handler: async (_args, ctx) =>
      makeSuccess({ plugins: loadedPlugins }, { startedAt: ctx.startedAt, now: ctx.now }),
  })
}
