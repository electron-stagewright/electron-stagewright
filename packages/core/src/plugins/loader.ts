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
import type { AnyToolDefinition } from '../tools/types.js'
import { satisfies } from './semver.js'
import type {
  LoadedPlugin,
  LoadPluginsOptions,
  LoadPluginsResult,
  StagewrightPlugin,
} from './types.js'

/** A plugin namespace: a lowercase identifier with no separators (so `<ns>_<tool>` parses). */
const PLUGIN_NAME = /^[a-z][a-z0-9]*$/
/** A plugin's short tool name: lowercase snake_case (the namespace prefix is added by the loader). */
const TOOL_SHORT_NAME = /^[a-z][a-z0-9_]*$/
/** Namespaces reserved for the core; a plugin may not claim them. */
const RESERVED_NAMESPACES = new Set(['electron'])

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
  const result = plugin.configSchema.safeParse(raw)
  if (!result.success) {
    throw new StagewrightError(
      'PLUGIN_CONFIG_INVALID',
      `Plugin "${plugin.name}" config is invalid: ${result.error.message}`,
      { plugin: plugin.name },
    )
  }
  return result.data
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
): LoadedPlugin {
  let toreDown = false
  let setupRan = false
  return {
    name: plugin.name,
    version: plugin.version,
    tools,
    errorCodes,
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
    for (const plugin of plugins) {
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
      await plugin.setup?.(config)
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
