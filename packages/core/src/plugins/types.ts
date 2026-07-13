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
import type { AnyToolDefinition, EvalTarget } from '../tools/types.js'
import type { TransportCapabilities } from '../transports/types.js'

/** Why a live session was released from its owning server. */
export type PluginSessionEndReason = 'stop' | 'force_kill' | 'detach' | 'server_close'

/**
 * A session release observed by a plugin. The event is emitted after the session is
 * removed from the server registry, so a listener can safely discard state keyed by
 * {@link sessionId}; {@link remainingSessionIds} describes the sessions still live on
 * that server after the release.
 */
export interface PluginSessionEndEvent {
  readonly sessionId: string
  readonly reason: PluginSessionEndReason
  readonly remainingSessionIds: readonly string[]
}

/**
 * Server-owned lifecycle hooks available to a plugin during setup. This deliberately
 * exposes only stable identities and cleanup notification, not mutable server internals.
 */
export interface PluginServerContext {
  /**
   * Register cleanup for a released session. Listener failures are isolated from the
   * lifecycle operation; return an idempotent unsubscribe for plugin teardown.
   */
  onSessionEnd(listener: (event: PluginSessionEndEvent) => void | Promise<void>): () => void
}

/**
 * The version of the PLUGIN CONTRACT surface (ADR-004) — the shape of {@link StagewrightPlugin},
 * the `ToolContext` passed to handlers, the error-envelope helpers, and the loader's namespacing
 * rules. It is versioned INDEPENDENTLY of the core package version (which churns on 0.x for
 * unrelated reasons) so a third-party plugin has a stable line to reason about: bump the MINOR
 * for additive contract changes, the MAJOR for breaking ones. A plugin can log or assert against
 * it at `setup` time, and `coreVersionRange` remains the enforced compatibility gate.
 */
export const PLUGIN_API_VERSION = '1.2.0' as const

/**
 * Declarative availability requirements for a plugin. These describe gates required by at
 * least one of its tools; they are explanatory metadata for `electron_plugins`, not a
 * replacement for the tool's runtime capability checks.
 */
export interface PluginRequirements {
  /** Eval targets required by at least one tool (including tools that stay visible to explain the gate). */
  readonly evalTargets?: readonly EvalTarget[]
  /** Transport capabilities required by at least one tool. */
  readonly transportCapabilities?: readonly (keyof TransportCapabilities)[]
}

/** Explicit allowlist for configuration values safe to disclose through MCP. */
export interface PluginConfigDisclosure {
  /**
   * Safe, top-level fields from the parsed effective config. Values outside this allowlist are
   * never exposed; plugins with no declaration expose no config at all.
   */
  readonly safeFields: readonly string[]
}

/**
 * Metadata surfaced for a successfully loaded plugin. Plugin authors must explicitly opt into
 * every disclosed config field so a newly-added secret cannot leak through introspection by default.
 */
export interface PluginIntrospection {
  /** Gates required by at least one plugin tool, when any. */
  readonly requirements?: PluginRequirements
  /** Explicit allowlist of effective configuration fields that are safe to return to an agent. */
  readonly config?: PluginConfigDisclosure
}

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
   * Optional safe, declarative metadata returned by `electron_plugins` after this plugin loads.
   * It must never contain configuration values itself; the loader selects only the declared
   * {@link PluginConfigDisclosure.safeFields} from parsed config.
   */
  readonly introspection?: PluginIntrospection
  /**
   * Optional per-server factory introduced in plugin API 1.1. When present, the
   * loader calls it once for every server before validation and setup, so closures,
   * maps, and parsed configuration cannot leak between co-resident servers. API 1.0
   * plugins omit this property and continue to load as their supplied object.
   */
  readonly createInstance?: () => StagewrightPlugin
  /**
   * Optional async setup, run once at load (after tools + codes are registered). Receives
   * the validated config when `configSchema` is set, otherwise `undefined`.
   */
  readonly setup?: (config: unknown, context?: PluginServerContext) => void | Promise<void>
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
  /** Static onboarding metadata supplied by the plugin manifest, if any. */
  readonly introspection?: PluginIntrospection
  /** Parsed config restricted to the manifest's explicit safe-field allowlist, if any. */
  readonly effectiveConfig?: Readonly<Record<string, unknown>> | undefined
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
  /** Server lifecycle context supplied to API 1.1 plugins during setup. */
  readonly context?: PluginServerContext
}

/** One plugin tool's availability as reported by `electron_plugins`. */
export interface LoadedPluginToolInfo {
  /** Namespaced tool name as it would appear in MCP `tools/list`. */
  readonly name: string
  /** `disabled` currently means the server's eval policy hid this tool at registration. */
  readonly state: 'enabled' | 'disabled'
  /** Present only when the tool was hidden by the eval policy. */
  readonly disabledReason?: {
    /** Availability classification, not an error-envelope code. */
    readonly kind: 'eval_policy_disabled'
    readonly target: EvalTarget | 'any'
  }
}

/** Public metadata for one loaded plugin, surfaced by the plugins-introspection tool. */
export interface LoadedPluginInfo {
  readonly name: string
  readonly version: string
  /** A successfully loaded plugin is always enabled; failed plugins never reach this response. */
  readonly state: 'enabled'
  /** Every contributed tool with its current server-policy availability. */
  readonly tools: readonly LoadedPluginToolInfo[]
  /** Full namespaced error-code names this loaded plugin can return. */
  readonly errorCodes: readonly string[]
  /** Declared availability gates required by at least one plugin tool. */
  readonly requirements?: PluginRequirements
  /** Parsed effective config restricted to explicitly declared safe fields. */
  readonly effectiveConfig?: Readonly<Record<string, unknown>>
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
