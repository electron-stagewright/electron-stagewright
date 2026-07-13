/**
 * `electron_plugins` — list the plugins loaded into this server and explain their availability.
 * Session-independent: it reports a per-server metadata snapshot captured after registration,
 * so an agent can discover plugin-provided capabilities and an eval-policy-hidden tool without
 * launching an app or inspecting local files.
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
      state: plugin.state,
      tools: plugin.tools
        .map((tool) => ({
          name: tool.name,
          state: tool.state,
          ...(tool.disabledReason !== undefined
            ? { disabledReason: { ...tool.disabledReason } }
            : {}),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      errorCodes: [...plugin.errorCodes].sort((a, b) => a.localeCompare(b)),
      ...(plugin.requirements !== undefined
        ? {
            requirements: {
              ...(plugin.requirements.evalTargets !== undefined
                ? { evalTargets: [...plugin.requirements.evalTargets].sort() }
                : {}),
              ...(plugin.requirements.transportCapabilities !== undefined
                ? {
                    transportCapabilities: [...plugin.requirements.transportCapabilities].sort(),
                  }
                : {}),
            },
          }
        : {}),
      ...(plugin.effectiveConfig !== undefined
        ? { effectiveConfig: { ...plugin.effectiveConfig } }
        : {}),
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
      "List the plugins loaded into this server: each plugin's name, version, enabled state, namespaced",
      'tools and their availability, error codes, declared eval/transport gates, and explicitly safe',
      'effective config. A disabled tool is hidden by the server eval policy; its reason says which',
      'target to enable. Use this to discover plugin capabilities beyond the core tool surface. Takes',
      'no arguments and needs no running app. Returns: { ok, plugins: [{ name, version, state, tools,',
      'errorCodes, requirements?, effectiveConfig? }] }. Errors: none.',
    ].join(' '),
    inputSchema: z.object({}),
    // State-reading, non-eval, no session required — classified as a query.
    operationType: 'query',
    handler: async (_args, ctx) =>
      makeSuccess({ plugins: loadedPlugins }, { startedAt: ctx.startedAt, now: ctx.now }),
  })
}
