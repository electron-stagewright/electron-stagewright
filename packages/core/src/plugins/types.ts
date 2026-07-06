/**
 * Plugin contract (ADR-004). A plugin is plain data plus optional lifecycle hooks — the
 * same "tool is data, not a function" stance the dispatcher takes (ADR-008). A plugin
 * contributes namespaced tools and namespaced error codes to a core server; the loader
 * (see `loader.ts`) validates the manifest, namespaces the tools and codes, runs setup,
 * and returns a teardown handle. The core NEVER auto-scans for plugins — they are passed
 * to `createServer({ plugins })` (or named explicitly on the CLI), trusted and in-process.
 *
 * @module
 */

import type { z } from 'zod'

import type { ErrorCodeDefinition } from '../errors/index.js'
import type { AnyToolDefinition } from '../tools/types.js'

/**
 * The version of the PLUGIN CONTRACT surface (ADR-004) — the shape of {@link StagewrightPlugin},
 * the `ToolContext` passed to handlers, the error-envelope helpers, and the loader's namespacing
 * rules. It is versioned INDEPENDENTLY of the core package version (which churns on 0.x for
 * unrelated reasons) so a third-party plugin has a stable line to reason about: bump the MINOR
 * for additive contract changes, the MAJOR for breaking ones. A plugin can log or assert against
 * it at `setup` time, and `coreVersionRange` remains the enforced compatibility gate.
 */
export const PLUGIN_API_VERSION = '1.0.0' as const

/**
 * A first-party plugin. Authored with SHORT tool names and BARE error-code keys; the
 * loader namespaces them — tool `start` under plugin `trace` is registered as
 * `trace_start`, and error code key `BUFFER_FULL` becomes `trace.BUFFER_FULL`.
 */
export interface StagewrightPlugin {
  /**
   * Plugin namespace. Must be a lowercase identifier (`^[a-z][a-z0-9]*$`) and must not be
   * the reserved core namespace `electron`. Used as the prefix for every tool and code.
   */
  readonly name: string
  /** Plugin package version (informational; surfaced in introspection). */
  readonly version: string
  /**
   * Optional core-version requirement, matched against the running core version as a semver
   * range: `*` (any), an exact `1.2.3`, a caret `^0.1.0`, a tilde `~1.2`, comparators
   * `>=0.1.2 <0.3.0`, or an OR of ranges `^1.0.0 || ^2.0.0`. A version outside the range fails
   * the load with `PLUGIN_VERSION_MISMATCH`; an unparseable range fails with
   * `PLUGIN_MANIFEST_INVALID`. Third-party plugins should pin a caret on the {@link
   * PLUGIN_API_VERSION} they were built against.
   */
  readonly coreVersionRange?: string
  /**
   * Tools the plugin contributes, with SHORT names (e.g. `start`). The loader rewrites each
   * to `<name>_<short>` before registering, so authors never hard-code the namespace. Since
   * a plugin `name` cannot contain `_`, the FIRST underscore in a registered tool name is
   * always the namespace/tool boundary.
   */
  readonly tools?: readonly AnyToolDefinition[]
  /**
   * Error codes the plugin contributes, keyed by BARE SCREAMING_SNAKE_CASE keys (e.g.
   * `BUFFER_FULL`). The loader registers each as `<name>.<KEY>`; handlers RETURN them via
   * `makePluginError('<name>.<KEY>', …)` (return, do not throw — see `makePluginError`).
   */
  readonly errorCodes?: Readonly<Record<string, ErrorCodeDefinition>>
  /**
   * Optional Zod schema for the plugin's deployment config. When present, the loader
   * validates the config value supplied for this plugin (via `createServer`'s
   * `pluginConfigs` or the CLI's `--plugin-config`) against it and passes the parsed
   * result to `setup`; an invalid config fails the load with `PLUGIN_CONFIG_INVALID`.
   * Defaulting belongs in the schema (`z.object({…}).default({})`), so a plugin with a
   * schema always receives a fully-formed config even when none is supplied.
   */
  readonly configSchema?: z.ZodTypeAny
  /**
   * Optional async setup, run once at load (after tools + codes are registered). Receives
   * the validated config when `configSchema` is set, otherwise `undefined`.
   */
  readonly setup?: (config: unknown) => void | Promise<void>
  /** Optional async teardown, run once at server close. Made idempotent by the loader. */
  readonly teardown?: () => void | Promise<void>
}

/**
 * The result of loading one plugin: its namespaced tools (already prefixed), the full
 * namespaced error codes it registered, and an idempotent teardown that runs the plugin's
 * hook and unregisters its codes.
 */
export interface LoadedPlugin {
  readonly name: string
  readonly version: string
  /** Namespaced tools, ready to register with the dispatcher. */
  readonly tools: readonly AnyToolDefinition[]
  /** Full namespaced codes (e.g. `['trace.BUFFER_FULL']`) registered for this plugin. */
  readonly errorCodes: readonly string[]
  /**
   * Mark that the plugin's `setup` hook completed. Called by the loader after a successful
   * `setup`. Teardown only invokes the user `teardown` hook when setup ran, so a plugin whose
   * config validation (or setup) threw never has `teardown` called against state it never built.
   */
  markSetupRan(): void
  /** Run the plugin's teardown hook (only if setup ran) and unregister its codes. Safe to call more than once. */
  teardown(): Promise<void>
}

/** Options for {@link loadPlugins}. */
export interface LoadPluginsOptions {
  /** The running core version, checked against each plugin's `coreVersionRange`. */
  readonly coreVersion: string
  /**
   * Raw config values per plugin name. A plugin with a `configSchema` validates
   * `configs[plugin.name]` (defaulting to `{}`) against it and receives the parsed result
   * in `setup`. Plugins without a schema ignore config.
   */
  readonly configs?: Readonly<Record<string, unknown>>
}

/** Public metadata for one loaded plugin, surfaced by the plugins-introspection tool. */
export interface LoadedPluginInfo {
  readonly name: string
  readonly version: string
  /** The plugin's namespaced tool names (e.g. `['sample_greet']`). */
  readonly tools: readonly string[]
}

/**
 * The aggregate result of loading a set of plugins: every namespaced tool to register,
 * the per-plugin load records, and a teardown that tears every plugin down (in reverse
 * load order) and is safe to call more than once.
 */
export interface LoadPluginsResult {
  readonly tools: readonly AnyToolDefinition[]
  readonly loaded: readonly LoadedPlugin[]
  teardownAll(): Promise<void>
}
