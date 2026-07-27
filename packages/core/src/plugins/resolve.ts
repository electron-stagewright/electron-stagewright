/**
 * Resolve a plugin from a name or path (ADR-004). `importPlugin` dynamic-imports an
 * explicitly-named package specifier or a file path and extracts the `StagewrightPlugin`
 * it exports (default export, or a named `plugin` export). This is how the CLI's
 * `--plugin <name|path>` flag loads a plugin before handing it to `createServer`.
 *
 * Dynamic import only (never a static `import`): the plugin is an optional, caller-chosen
 * dependency, so a failed import surfaces as a registered error, never a crash at module
 * load. The loader (`loader.ts`) then validates and namespaces whatever this returns.
 *
 * @module
 */

import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { StagewrightError } from '../errors/index.js'
import type { StagewrightPlugin } from './types.js'

/** Dynamic-module loader seam used to keep package-resolution tests hermetic. */
type PluginModuleLoader = (target: string) => Promise<Record<string, unknown>>

const dynamicImport: PluginModuleLoader = async (target) =>
  (await import(target)) as Record<string, unknown>

/**
 * Stable short names for the first-party packages shipped from this monorepo. The CLI still
 * requires an explicit `--plugin`; this is an ergonomic package-name expansion, never discovery.
 */
const FIRST_PARTY_PLUGIN_PACKAGES = {
  a11y: '@electron-stagewright/plugin-a11y',
  clock: '@electron-stagewright/plugin-clock',
  ipc: '@electron-stagewright/plugin-ipc',
  native: '@electron-stagewright/plugin-native-ui',
  'native-ui': '@electron-stagewright/plugin-native-ui',
  network: '@electron-stagewright/plugin-network',
  production: '@electron-stagewright/plugin-production',
  storage: '@electron-stagewright/plugin-storage',
  trace: '@electron-stagewright/plugin-trace',
  visual: '@electron-stagewright/plugin-visual',
} as const satisfies Readonly<Record<string, string>>

/** True when `value` is shaped like a {@link StagewrightPlugin} (name + version present). */
function isStagewrightPlugin(value: unknown): value is StagewrightPlugin {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string' &&
    typeof (value as { version?: unknown }).version === 'string'
  )
}

/**
 * A spec is a FILE PATH (vs a bare package specifier) when it is absolute or starts with a
 * relative-path marker. Bare specifiers (`@scope/pkg`, `pkg`) are imported as-is so Node
 * resolves them from node_modules; paths are converted to a `file://` URL first.
 */
function isPathSpec(spec: string): boolean {
  return spec.startsWith('.') || spec.startsWith('/') || path.isAbsolute(spec)
}

/**
 * Expand a shipped first-party short name to its package specifier. Paths, scoped packages,
 * and third-party bare package names pass through unchanged.
 */
export function resolvePluginSpecifier(spec: string): string {
  return FIRST_PARTY_PLUGIN_PACKAGES[spec as keyof typeof FIRST_PARTY_PLUGIN_PACKAGES] ?? spec
}

/**
 * Dynamic-import a plugin by package name or file path and return its
 * {@link StagewrightPlugin}. Throws `PLUGIN_LOAD_FAILED` when the module cannot be
 * imported, `PLUGIN_MANIFEST_INVALID` when it exports no valid plugin.
 *
 * SECURITY: a dynamic import executes the target module's top-level code, so calling
 * this with a caller-supplied string is equivalent to executing arbitrary code in the
 * server process. The trust model is explicit-operator-supplied — the CLI operator names
 * the plugin on the command line; community-plugin sandboxing is out of scope (see
 * ADR-004). Never call `importPlugin` with an untrusted or remotely-sourced path.
 */
export async function importPlugin(
  spec: string,
  loadModule: PluginModuleLoader = dynamicImport,
): Promise<StagewrightPlugin> {
  const resolvedSpec = resolvePluginSpecifier(spec)
  const target = isPathSpec(resolvedSpec)
    ? pathToFileURL(path.resolve(resolvedSpec)).href
    : resolvedSpec
  let mod: Record<string, unknown>
  try {
    mod = await loadModule(target)
  } catch (cause) {
    throw new StagewrightError(
      'PLUGIN_LOAD_FAILED',
      `Could not import plugin "${spec}" (resolved as "${resolvedSpec}"): ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { spec, resolved_spec: resolvedSpec },
    )
  }
  const candidate = mod['default'] ?? mod['plugin']
  if (!isStagewrightPlugin(candidate)) {
    throw new StagewrightError(
      'PLUGIN_MANIFEST_INVALID',
      `Module "${spec}" (resolved as "${resolvedSpec}") does not export a StagewrightPlugin (as default or a named "plugin" export).`,
      { spec, resolved_spec: resolvedSpec },
    )
  }
  return candidate
}
