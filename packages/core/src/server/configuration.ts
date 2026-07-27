/**
 * Shared CLI server-configuration resolution.
 *
 * Both `serve` and standalone `doctor` use this path so package resolution, demo
 * selection, plugin manifest/config validation, tool-profile assembly, and operation
 * timeout validation cannot drift. Doctor creates the server object graph without
 * connecting stdio, then closes it immediately.
 *
 * @module
 */

import { resolveDemoMain } from '../demo.js'
import { lookupErrorCodeDefinition, StagewrightError } from '../errors/index.js'
import { importPlugin, type StagewrightPlugin } from '../plugins/index.js'
import type { ToolProfile } from '../tools/index.js'
import type { EvalPolicy } from './eval-policy.js'
import { type Logger, NOOP_LOGGER } from './logger.js'
import { createServer, type CreateServerOptions, type StagewrightServer } from './server.js'

/** CLI-controlled values that determine the server object graph. */
export interface ServerConfigurationInput {
  readonly demo: boolean
  readonly allowEval: EvalPolicy
  readonly toolProfile: ToolProfile
  readonly screenshotDir?: string
  readonly appRoot?: string
  readonly pluginSpecs: readonly string[]
  readonly pluginConfigs: Readonly<Record<string, unknown>>
  readonly operationTimeoutMs?: number
}

/** Resolved server plus non-sensitive facts safe to print in diagnostics. */
export interface ConfiguredServer {
  readonly server: StagewrightServer
  readonly pluginNames: readonly string[]
  readonly demo: boolean
}

/** Result of validating the complete server configuration for standalone doctor. */
export type ServerConfigurationInspection =
  | {
      readonly ok: true
      readonly status: 'pass' | 'warn'
      readonly message: string
      readonly details: {
        readonly demo: boolean
        readonly tool_profile: ToolProfile
        readonly plugins: readonly string[]
        readonly operation_timeout_ms: number | 'default'
        readonly orphaned_plugin_configs?: readonly string[]
      }
    }
  | {
      readonly ok: false
      readonly message: string
      readonly code?: string
      readonly hint?: string
      readonly details?: Readonly<Record<string, unknown>>
    }

/** Injectable seams for deterministic configuration tests. */
export interface ServerConfigurationDeps {
  readonly resolveDemoMain?: () => Promise<string>
  readonly importPlugin?: (spec: string) => Promise<StagewrightPlugin>
  readonly createServer?: (opts: CreateServerOptions) => Promise<StagewrightServer>
}

/** Keep a malformed plugin-supplied StagewrightError detail from breaking doctor JSON output. */
function serializableDetails(
  details: Record<string, unknown> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (details === undefined) return undefined
  try {
    const parsed = JSON.parse(JSON.stringify(details)) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve operator-selected modules and construct the same unconnected server used by `serve`.
 * The caller owns the returned server and must close it.
 */
export async function createConfiguredServer(
  input: ServerConfigurationInput,
  logger: Logger,
  deps: ServerConfigurationDeps = {},
): Promise<ConfiguredServer> {
  if (input.demo && input.appRoot !== undefined) {
    throw new Error(
      '--demo cannot be combined with --app-root; the packaged demo is outside that root',
    )
  }

  const resolveDemo = deps.resolveDemoMain ?? resolveDemoMain
  const loadPlugin = deps.importPlugin ?? importPlugin
  const assembleServer = deps.createServer ?? createServer
  const launchDefaultMain = input.demo ? await resolveDemo() : undefined
  const plugins: StagewrightPlugin[] = []
  for (const spec of input.pluginSpecs) plugins.push(await loadPlugin(spec))

  const server = await assembleServer({
    allowEval: input.allowEval,
    toolProfile: input.toolProfile,
    logger,
    ...(input.screenshotDir !== undefined ? { screenshotDir: input.screenshotDir } : {}),
    ...(input.appRoot !== undefined ? { appRoot: input.appRoot } : {}),
    ...(launchDefaultMain !== undefined ? { launchDefaultMain } : {}),
    ...(input.operationTimeoutMs !== undefined
      ? { operationTimeoutMs: input.operationTimeoutMs }
      : {}),
    ...(plugins.length > 0 ? { plugins } : {}),
    ...(Object.keys(input.pluginConfigs).length > 0 ? { pluginConfigs: input.pluginConfigs } : {}),
  })

  return {
    server,
    pluginNames: plugins.map((plugin) => plugin.name),
    demo: input.demo,
  }
}

/**
 * Build and tear down the complete server object graph, returning a bounded diagnostic instead
 * of throwing. Explicit plugin modules are trusted operator code and therefore run their normal
 * setup/teardown hooks, exactly as they would in serve mode.
 */
export async function inspectServerConfiguration(
  input: ServerConfigurationInput,
  deps: ServerConfigurationDeps = {},
): Promise<ServerConfigurationInspection> {
  try {
    const configured = await createConfiguredServer(input, NOOP_LOGGER, deps)
    await configured.server.close()
    const loadedNames = new Set(configured.pluginNames)
    const orphanedPluginConfigs = Object.keys(input.pluginConfigs).filter(
      (name) => !loadedNames.has(name),
    )
    const details = {
      demo: configured.demo,
      tool_profile: input.toolProfile,
      plugins: configured.pluginNames,
      operation_timeout_ms: input.operationTimeoutMs ?? ('default' as const),
      ...(orphanedPluginConfigs.length > 0
        ? { orphaned_plugin_configs: orphanedPluginConfigs }
        : {}),
    }
    return {
      ok: true,
      status: orphanedPluginConfigs.length > 0 ? 'warn' : 'pass',
      message:
        orphanedPluginConfigs.length > 0
          ? `Server configuration is valid, but config for unloaded plugin(s) will be ignored: ${orphanedPluginConfigs.join(', ')}.`
          : `Server configuration is valid (${configured.pluginNames.length} plugin(s), ${input.toolProfile} tool profile).`,
      details,
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    if (cause instanceof StagewrightError) {
      const definition = lookupErrorCodeDefinition(cause.code)
      const details = serializableDetails(cause.details)
      return {
        ok: false,
        message: `Server configuration is invalid: ${message}`,
        code: cause.code,
        ...(definition !== undefined ? { hint: definition.hint } : {}),
        ...(details !== undefined ? { details } : {}),
      }
    }
    return {
      ok: false,
      message: `Server configuration is invalid: ${message}`,
      hint: 'Correct the server flags or selected packages, then rerun doctor.',
    }
  }
}
