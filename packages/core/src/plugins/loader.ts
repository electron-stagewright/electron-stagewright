/**
 * In-process plugin loader (ADR-004). Validates each plugin manifest, checks the core
 * version, namespaces the plugin's tools (`<name>_<tool>`) and error codes
 * (`<name>.CODE`), runs `setup`, and returns the namespaced tools plus an idempotent
 * teardown. Fails CLOSED: a bad manifest, a version mismatch, a duplicate namespace or
 * tool name, or a throwing `setup` rejects the whole load AND tears down any plugins
 * already loaded in this call, so a half-initialised set never reaches the dispatcher.
 *
 * The loader does NOT import or discover packages — callers pass already-imported
 * {@link StagewrightPlugin} objects. The CLI's `--plugin` path does the dynamic import of
 * an explicitly-named package or file (see `resolve.ts`) and hands the result here.
 *
 * @module
 */

import {
  registerPluginErrorCodes,
  StagewrightError,
  unregisterPluginErrorCodes,
} from '../errors/index.js'
import { parsePluginConfig, PluginConfigValidationError } from '../plugin-sdk/config.js'
import type { AnyToolDefinition } from '../tools/types.js'
import { satisfies } from './semver.js'
import type {
  LoadedPlugin,
  LoadPluginsOptions,
  LoadPluginsResult,
  PluginIntrospection,
  StagewrightPlugin,
} from './types.js'

/** A plugin namespace: a lowercase identifier with no separators (so `<ns>_<tool>` parses). */
const PLUGIN_NAME = /^[a-z][a-z0-9]*$/
/** A plugin's short tool name: lowercase snake_case (the namespace prefix is added by the loader). */
const TOOL_SHORT_NAME = /^[a-z][a-z0-9_]*$/
/** Namespaces reserved for the core; a plugin may not claim them. */
const RESERVED_NAMESPACES = new Set(['electron'])
const EVAL_TARGETS = new Set(['main', 'renderer'])
const TRANSPORT_CAPABILITIES = new Set([
  'canLaunch',
  'canAttach',
  'canInject',
  'canIntercept',
  'canControlClock',
  'canAccessStorage',
  'canAccessNativeUI',
  'supportsMainEval',
  'supportsRendererEval',
  'supportsInteraction',
])
const UNSAFE_CONFIG_FIELDS = new Set(['__proto__', 'constructor', 'prototype'])

/** Internal construction handle: config is parsed only after the record is queued for rollback. */
interface PendingLoadedPlugin extends LoadedPlugin {
  setEffectiveConfig(config: Readonly<Record<string, unknown>> | undefined): void
}

/** Reject a manifest with a `PLUGIN_MANIFEST_INVALID` error carrying the reason. */
function invalid(reason: string): never {
  throw new StagewrightError('PLUGIN_MANIFEST_INVALID', reason, { reason })
}

/** Validate a plugin's identity + tool shapes before any side effect. */
function validateManifest(plugin: StagewrightPlugin): void {
  if (typeof plugin.name !== 'string' || !PLUGIN_NAME.test(plugin.name)) {
    invalid(`Plugin name "${String(plugin.name)}" must match ${PLUGIN_NAME.source}.`)
  }
  if (RESERVED_NAMESPACES.has(plugin.name)) {
    invalid(`Plugin name "${plugin.name}" is reserved for the core.`)
  }
  if (typeof plugin.version !== 'string' || plugin.version.length === 0) {
    invalid(`Plugin "${plugin.name}" must declare a non-empty version.`)
  }
  for (const tool of plugin.tools ?? []) {
    if (!TOOL_SHORT_NAME.test(tool.name)) {
      invalid(
        `Plugin "${plugin.name}" tool name "${tool.name}" must match ${TOOL_SHORT_NAME.source}.`,
      )
    }
  }
  validateIntrospection(plugin)
}

/** Validate declarative onboarding metadata before any plugin side effect. */
function validateIntrospection(plugin: StagewrightPlugin): void {
  const introspection = plugin.introspection
  if (introspection === undefined) return
  if (!isPlainRecord(introspection)) {
    invalid(`Plugin "${plugin.name}" introspection must be an object.`)
  }

  const requirements = introspection.requirements
  if (requirements !== undefined && !isPlainRecord(requirements)) {
    invalid(`Plugin "${plugin.name}" introspection requirements must be an object.`)
  }
  if (requirements?.evalTargets !== undefined) {
    if (!Array.isArray(requirements.evalTargets)) {
      invalid(`Plugin "${plugin.name}" introspection evalTargets must be an array.`)
    }
    for (const target of requirements.evalTargets) {
      if (!EVAL_TARGETS.has(target)) {
        invalid(
          `Plugin "${plugin.name}" introspection eval target "${String(target)}" must be "main" or "renderer".`,
        )
      }
    }
  }
  if (requirements?.transportCapabilities !== undefined) {
    if (!Array.isArray(requirements.transportCapabilities)) {
      invalid(`Plugin "${plugin.name}" introspection transportCapabilities must be an array.`)
    }
    for (const capability of requirements.transportCapabilities) {
      if (!TRANSPORT_CAPABILITIES.has(capability)) {
        invalid(
          `Plugin "${plugin.name}" introspection transport capability "${String(capability)}" is unknown.`,
        )
      }
    }
  }

  const configDisclosure = introspection.config
  if (configDisclosure !== undefined && !isPlainRecord(configDisclosure)) {
    invalid(`Plugin "${plugin.name}" introspection config must be an object.`)
  }
  const safeFields = configDisclosure?.safeFields
  if (safeFields === undefined) return
  if (!Array.isArray(safeFields)) {
    invalid(`Plugin "${plugin.name}" introspection safeFields must be an array.`)
  }
  if (plugin.configSchema === undefined) {
    invalid(`Plugin "${plugin.name}" declares introspection config fields but has no configSchema.`)
  }
  const seen = new Set<string>()
  for (const field of safeFields) {
    if (typeof field !== 'string' || field.length === 0 || UNSAFE_CONFIG_FIELDS.has(field)) {
      invalid(
        `Plugin "${plugin.name}" introspection safe config fields must be non-empty ordinary top-level keys.`,
      )
    }
    if (seen.has(field)) {
      invalid(`Plugin "${plugin.name}" introspection repeats safe config field "${field}".`)
    }
    seen.add(field)
  }
}

/** Plain JSON-style object guard for runtime plugin-manifest validation. */
function isPlainRecord<T>(value: T): value is T & Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Materialize a fresh per-server plugin instance when an API 1.1 factory is available. */
function instantiatePlugin(plugin: StagewrightPlugin): StagewrightPlugin {
  const instance = plugin.createInstance?.() ?? plugin
  if (instance === plugin && plugin.createInstance !== undefined) {
    invalid(`Plugin "${plugin.name}" createInstance must return a fresh plugin instance.`)
  }
  if (instance.createInstance !== undefined) {
    invalid(`Plugin "${plugin.name}" createInstance must return a concrete plugin instance.`)
  }
  if (instance.name !== plugin.name) {
    invalid(
      `Plugin "${plugin.name}" createInstance must preserve the plugin namespace (received "${instance.name}").`,
    )
  }
  return instance
}

/**
 * Resolve and validate a plugin's config. Returns the parsed config when the plugin
 * declares a `configSchema` (defaulting the raw value to `{}` so schema defaults apply),
 * or `undefined` when it has no schema. Throws `PLUGIN_CONFIG_INVALID` when the supplied
 * config does not match the schema.
 */
function resolveConfig(plugin: StagewrightPlugin, configs: LoadPluginsOptions['configs']): unknown {
  if (plugin.configSchema === undefined) return undefined
  const raw = configs?.[plugin.name] ?? {}
  try {
    return parsePluginConfig(plugin.configSchema, raw)
  } catch (cause) {
    const message =
      cause instanceof PluginConfigValidationError
        ? cause.message
        : cause instanceof Error
          ? cause.message
          : String(cause)
    throw new StagewrightError(
      'PLUGIN_CONFIG_INVALID',
      `Plugin "${plugin.name}" config is invalid: ${message}. Correct --plugin-config ${plugin.name}=<json> (or pluginConfigs.${plugin.name}) and restart.`,
      {
        plugin: plugin.name,
        ...(cause instanceof PluginConfigValidationError ? { issues: cause.issues } : {}),
        remediation: `Correct --plugin-config ${plugin.name}=<json> (or pluginConfigs.${plugin.name}) and restart.`,
      },
    )
  }
}

/** Return only explicitly allowlisted top-level parsed config values for agent-facing introspection. */
function selectEffectiveConfig(
  plugin: StagewrightPlugin,
  config: unknown,
): Readonly<Record<string, unknown>> | undefined {
  const safeFields = plugin.introspection?.config?.safeFields
  if (safeFields === undefined || safeFields.length === 0) return undefined
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    invalid(
      `Plugin "${plugin.name}" introspection config fields require an object-shaped parsed config.`,
    )
  }

  const record = config as Record<string, unknown>
  const selected: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const field of [...safeFields].sort((a, b) => a.localeCompare(b))) {
    if (Object.hasOwn(record, field)) selected[field] = record[field]
  }
  return Object.freeze(selected)
}

/**
 * Core-version check (ADR-004): `*` (or absent) accepts any core; otherwise the plugin's
 * `coreVersionRange` is matched against the running core version as a semver range (`^0.1.0`,
 * `>=0.1.2 <0.3.0`, `~1.2`, exact `1.2.3`, or `a || b`). A mismatch throws `PLUGIN_VERSION_MISMATCH`;
 * an unparseable range throws `PLUGIN_MANIFEST_INVALID` (a manifest typo, not a compat failure).
 */
function checkCoreVersion(plugin: StagewrightPlugin, coreVersion: string): void {
  const range = plugin.coreVersionRange
  if (range === undefined || range === '*') return
  let ok: boolean
  try {
    ok = satisfies(coreVersion, range)
  } catch (cause) {
    invalid(
      `Plugin "${plugin.name}" declares an invalid coreVersionRange "${range}": ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    )
  }
  if (!ok) {
    throw new StagewrightError(
      'PLUGIN_VERSION_MISMATCH',
      `Plugin "${plugin.name}" requires core ${range} but the running core is ${coreVersion}.`,
      { plugin: plugin.name, required: range, actual: coreVersion },
    )
  }
}

/** Produce a namespaced copy of a tool (`<ns>_<short>`), guarding against name collisions. */
function namespaceTool(
  namespace: string,
  tool: AnyToolDefinition,
  seenToolNames: Set<string>,
): AnyToolDefinition {
  const name = `${namespace}_${tool.name}`
  if (seenToolNames.has(name)) {
    invalid(`Duplicate plugin tool name "${name}".`)
  }
  seenToolNames.add(name)
  return { ...tool, name }
}

/** Build the idempotent teardown handle for one loaded plugin. */
function makeLoadedPlugin(
  plugin: StagewrightPlugin,
  tools: readonly AnyToolDefinition[],
  errorCodes: readonly string[],
): PendingLoadedPlugin {
  let toreDown = false
  let setupRan = false
  let effectiveConfig: Readonly<Record<string, unknown>> | undefined
  return {
    name: plugin.name,
    version: plugin.version,
    tools,
    errorCodes,
    ...(plugin.introspection !== undefined
      ? { introspection: snapshotIntrospection(plugin.introspection) }
      : {}),
    get effectiveConfig(): Readonly<Record<string, unknown>> | undefined {
      return effectiveConfig
    },
    setEffectiveConfig(config): void {
      effectiveConfig = config
    },
    markSetupRan(): void {
      setupRan = true
    },
    async teardown(): Promise<void> {
      if (toreDown) return
      toreDown = true
      // Unregister codes first so a throwing teardown hook can't leave codes registered.
      unregisterPluginErrorCodes(errorCodes)
      // Only invoke the user hook when setup actually ran: a plugin whose config validation
      // (or setup) threw must not have teardown called against resources it never acquired.
      if (setupRan) await plugin.teardown?.()
    },
  }
}

/** Freeze a copied metadata snapshot so a plugin cannot mutate its published contract after load. */
function snapshotIntrospection(introspection: PluginIntrospection): PluginIntrospection {
  return Object.freeze({
    ...(introspection.requirements !== undefined
      ? {
          requirements: Object.freeze({
            ...(introspection.requirements.evalTargets !== undefined
              ? { evalTargets: Object.freeze([...introspection.requirements.evalTargets]) }
              : {}),
            ...(introspection.requirements.transportCapabilities !== undefined
              ? {
                  transportCapabilities: Object.freeze([
                    ...introspection.requirements.transportCapabilities,
                  ]),
                }
              : {}),
          }),
        }
      : {}),
    ...(introspection.config !== undefined
      ? {
          config: Object.freeze({
            safeFields: Object.freeze([...introspection.config.safeFields]),
          }),
        }
      : {}),
  })
}

/**
 * Load a set of plugins in order. Returns the aggregate namespaced tools, the per-plugin
 * load records, and a `teardownAll` that tears every plugin down in reverse order.
 * Never leaves a partial load registered: if any plugin fails, the already-loaded ones
 * are torn down before the error propagates.
 */
export async function loadPlugins(
  plugins: Iterable<StagewrightPlugin>,
  opts: LoadPluginsOptions,
): Promise<LoadPluginsResult> {
  const allTools: AnyToolDefinition[] = []
  const loaded: LoadedPlugin[] = []
  const seenNamespaces = new Set<string>()
  const seenToolNames = new Set<string>()

  let toreDownAll = false
  const teardownLoaded = async (): Promise<void> => {
    if (toreDownAll) return
    toreDownAll = true
    for (const p of [...loaded].reverse()) {
      await p.teardown().catch(() => undefined)
    }
  }

  try {
    for (const suppliedPlugin of plugins) {
      const plugin = instantiatePlugin(suppliedPlugin)
      validateManifest(plugin)
      if (seenNamespaces.has(plugin.name)) {
        invalid(`Duplicate plugin namespace "${plugin.name}".`)
      }
      seenNamespaces.add(plugin.name)
      checkCoreVersion(plugin, opts.coreVersion)

      const tools = (plugin.tools ?? []).map((t) => namespaceTool(plugin.name, t, seenToolNames))
      const codes = plugin.errorCodes
        ? registerPluginErrorCodes(plugin.name, plugin.errorCodes)
        : []
      const record = makeLoadedPlugin(plugin, tools, codes)
      // Record BEFORE setup so a throwing setup (or invalid config) still gets its codes
      // unregistered by teardown. allTools accumulates only AFTER setup succeeds, so a
      // plugin whose setup throws never contributes its tools to the aggregate — and on
      // the success path the aggregate always equals the concatenation of every loaded
      // plugin's tools.
      loaded.push(record)
      const config = resolveConfig(plugin, opts.configs)
      record.setEffectiveConfig(selectEffectiveConfig(plugin, config))
      await plugin.setup?.(config, opts.context)
      record.markSetupRan()
      allTools.push(...tools)
    }
  } catch (err) {
    await teardownLoaded()
    throw err
  }

  return {
    tools: allTools,
    loaded,
    teardownAll: teardownLoaded,
  }
}
