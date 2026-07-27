/**
 * Tests for the CLI plugin-loading path (ADR-004): `importPlugin` (load by file path,
 * reject a missing module / a non-plugin export), `parseCliArgs` (repeatable + comma-split
 * `--plugin`, `--plugin-config <name>=<json>` parsing + bad-JSON rejection), plugin config
 * validation through `loadPlugins`, and the `electron_plugins` introspection tool registered
 * by `createServer` only when plugins are present.
 */

import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import storagePlugin from '../../plugin-storage/src/index.js'
import type { Logger } from '../src/server/logger.js'

import { type SuccessResponse } from '../src/errors/envelope.js'
import { clearPluginErrorCodes, lookupErrorCodeDefinition } from '../src/errors/registry.js'
import { isMainEntryPoint, parseCliArgs } from '../src/cli.js'
import { loadPlugins } from '../src/plugins/loader.js'
import { importPlugin, resolvePluginSpecifier } from '../src/plugins/resolve.js'
import type { StagewrightPlugin } from '../src/plugins/types.js'
import { createServer } from '../src/server/server.js'
import { defineTool } from '../src/tools/types.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE = path.join(HERE, 'fixtures', 'sample-plugin.mjs')
const NOT_A_PLUGIN = path.join(HERE, 'fixtures', 'not-a-plugin.mjs')

afterEach(() => {
  clearPluginErrorCodes()
})

describe('importPlugin', () => {
  it.each([
    ['a11y', '@electron-stagewright/plugin-a11y'],
    ['clock', '@electron-stagewright/plugin-clock'],
    ['ipc', '@electron-stagewright/plugin-ipc'],
    ['native', '@electron-stagewright/plugin-native-ui'],
    ['native-ui', '@electron-stagewright/plugin-native-ui'],
    ['network', '@electron-stagewright/plugin-network'],
    ['production', '@electron-stagewright/plugin-production'],
    ['storage', '@electron-stagewright/plugin-storage'],
    ['trace', '@electron-stagewright/plugin-trace'],
    ['visual', '@electron-stagewright/plugin-visual'],
  ])('expands the first-party short name %s', (shortName, packageName) => {
    expect(resolvePluginSpecifier(shortName)).toBe(packageName)
  })

  it('does not rewrite paths or third-party package names', () => {
    expect(resolvePluginSpecifier('@acme/stagewright-plugin')).toBe('@acme/stagewright-plugin')
    expect(resolvePluginSpecifier('./local-plugin.mjs')).toBe('./local-plugin.mjs')
  })

  it('imports a first-party plugin by short name', async () => {
    const plugin = await importPlugin('production')
    expect(plugin.name).toBe('production')
  })

  it('imports a plugin by file path', async () => {
    const plugin = await importPlugin(SAMPLE)
    expect(plugin.name).toBe('fixturep')
    expect(plugin.version).toBe('1.0.0')
  })

  it('rejects a missing module with PLUGIN_LOAD_FAILED', async () => {
    const spec = path.join(HERE, 'fixtures', 'nope.mjs')
    await expect(importPlugin(spec)).rejects.toMatchObject({
      code: 'PLUGIN_LOAD_FAILED',
      details: { spec, resolved_spec: spec },
    })
  })

  it('rejects a module with no plugin export (PLUGIN_MANIFEST_INVALID)', async () => {
    await expect(importPlugin(NOT_A_PLUGIN)).rejects.toMatchObject({
      code: 'PLUGIN_MANIFEST_INVALID',
    })
  })
})

describe('parseCliArgs (plugin flags)', () => {
  it('collects repeatable and comma-separated --plugin specs', () => {
    const opts = parseCliArgs(['--plugin', 'a,b', '--plugin', './c.js', '--allow-eval'])
    expect(opts.pluginSpecs).toEqual(['a', 'b', './c.js'])
    // Bare `--allow-eval` enables both eval targets (ADR-014).
    expect(opts.allowEval).toEqual({ main: true, renderer: true })
  })

  it('parses --plugin-config <name>=<json> into a config record', () => {
    const opts = parseCliArgs(['--plugin-config', 'sample={"greeting":"Hola"}'])
    expect(opts.pluginConfigs).toEqual({ sample: { greeting: 'Hola' } })
  })

  it('throws on malformed --plugin-config JSON', () => {
    expect(() => parseCliArgs(['--plugin-config', 'sample={bad'])).toThrow(/not valid JSON/)
  })

  it('defaults to no plugins when the flags are absent', () => {
    const opts = parseCliArgs([])
    expect(opts.pluginSpecs).toEqual([])
    expect(opts.pluginConfigs).toEqual({})
  })

  it('parses --operation-timeout-ms into a number (0 disables the backstop)', () => {
    expect(parseCliArgs(['--operation-timeout-ms', '5000']).operationTimeoutMs).toBe(5000)
    expect(parseCliArgs(['--operation-timeout-ms', '0']).operationTimeoutMs).toBe(0)
    expect(parseCliArgs([]).operationTimeoutMs).toBeUndefined()
  })

  it('throws on a non-numeric, fractional, or negative --operation-timeout-ms', () => {
    expect(() => parseCliArgs(['--operation-timeout-ms', 'soon'])).toThrow(/non-negative integer/)
    expect(() => parseCliArgs(['--operation-timeout-ms', '1.5'])).toThrow(/non-negative integer/)
    expect(() => parseCliArgs(['--operation-timeout-ms', '-1'])).toThrow(/non-negative integer/)
  })
})

describe('isMainEntryPoint', () => {
  it('matches the module URL through a bin symlink (npm/pnpm install shape)', () => {
    // npm installs a `bin` as a symlink in node_modules/.bin while ESM reports the realpath
    // in import.meta.url — a raw path comparison would make a globally-installed CLI a
    // silent no-op. The realpath resolution must bridge the symlink.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sw-cli-entry-'))
    try {
      const real = path.join(dir, 'cli.js')
      writeFileSync(real, '// entry point\n')
      const linked = path.join(dir, 'bin-shim')
      symlinkSync(real, linked)
      const moduleUrl = pathToFileURL(realpathSync(real)).href

      expect(isMainEntryPoint(moduleUrl, linked)).toBe(true)
      expect(isMainEntryPoint(moduleUrl, real)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is false with no entry path or an unresolvable one (REPL / node --eval)', () => {
    expect(isMainEntryPoint('file:///some/module.js', undefined)).toBe(false)
    expect(
      isMainEntryPoint('file:///some/module.js', path.join(os.tmpdir(), 'sw-missing-xyz')),
    ).toBe(false)
  })

  it('is false when the entry resolves to a different module', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sw-cli-entry-'))
    try {
      const real = path.join(dir, 'cli.js')
      writeFileSync(real, '// entry point\n')
      expect(isMainEntryPoint('file:///elsewhere/other.js', real)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** Build a plugin with a configSchema whose setup records the greeting it received. */
function configurablePlugin(seen: { greeting?: string }): StagewrightPlugin {
  return {
    name: 'cfg',
    version: '1.0.0',
    coreVersionRange: '*',
    configSchema: z.object({ greeting: z.string().default('Hello') }),
    setup: (config) => {
      seen.greeting = (config as { greeting: string }).greeting
    },
  }
}

describe('plugin config', () => {
  it('validates config and passes the parsed value to setup', async () => {
    const seen: { greeting?: string } = {}
    const result = await loadPlugins([configurablePlugin(seen)], {
      coreVersion: '0.0.0',
      configs: { cfg: { greeting: 'Hej' } },
    })
    expect(seen.greeting).toBe('Hej')
    await result.teardownAll()
  })

  it('applies schema defaults when no config is supplied', async () => {
    const seen: { greeting?: string } = {}
    const result = await loadPlugins([configurablePlugin(seen)], { coreVersion: '0.0.0' })
    expect(seen.greeting).toBe('Hello')
    await result.teardownAll()
  })

  it('passes setup an immutable config isolated from the caller input', async () => {
    let received: { readonly nested: { readonly enabled: boolean } } | undefined
    const plugin: StagewrightPlugin = {
      name: 'immutable',
      version: '1.0.0',
      coreVersionRange: '*',
      configSchema: z.object({ nested: z.object({ enabled: z.boolean() }) }),
      setup: (config) => {
        received = config as { readonly nested: { readonly enabled: boolean } }
      },
    }
    const raw = { nested: { enabled: true } }
    const result = await loadPlugins([plugin], {
      coreVersion: '0.0.0',
      configs: { immutable: raw },
    })
    raw.nested.enabled = false

    expect(received).toEqual({ nested: { enabled: true } })
    expect(Object.isFrozen(received)).toBe(true)
    expect(Object.isFrozen(received?.nested)).toBe(true)
    await result.teardownAll()
  })

  it('rejects config that fails the schema (PLUGIN_CONFIG_INVALID)', async () => {
    await expect(
      loadPlugins([configurablePlugin({})], {
        coreVersion: '0.0.0',
        configs: { cfg: { greeting: 42 } },
      }),
    ).rejects.toMatchObject({
      code: 'PLUGIN_CONFIG_INVALID',
      details: {
        plugin: 'cfg',
        issues: [{ path: '$.greeting' }],
        remediation: expect.stringContaining('--plugin-config cfg=<json>'),
      },
    })
  })

  it('tears down codes when config validation fails', async () => {
    // resolveConfig runs AFTER the plugin's codes are registered, so a config-invalid
    // rejection must unwind them — otherwise the failed load leaks process-global state
    // into the next load.
    const leaky: StagewrightPlugin = {
      name: 'leaky',
      version: '1.0.0',
      coreVersionRange: '*',
      configSchema: z.object({ greeting: z.string() }),
      errorCodes: {
        BOOM: { http: 500, retryable: false, hint: 'Should be torn down on config failure.' },
      },
    }

    await expect(
      loadPlugins([leaky], { coreVersion: '0.0.0', configs: { leaky: { greeting: 42 } } }),
    ).rejects.toMatchObject({ code: 'PLUGIN_CONFIG_INVALID' })

    expect(lookupErrorCodeDefinition('leaky.BOOM')).toBeUndefined()
  })

  it('rejects an unsafe config disclosure declaration before plugin setup', async () => {
    const invalidDisclosure: StagewrightPlugin = {
      name: 'unsafe',
      version: '1.0.0',
      coreVersionRange: '*',
      introspection: { config: { safeFields: ['secret'] } },
    }

    await expect(loadPlugins([invalidDisclosure], { coreVersion: '0.0.0' })).rejects.toMatchObject({
      code: 'PLUGIN_MANIFEST_INVALID',
    })
  })

  it('fails closed when runtime plugin metadata has the wrong shape', async () => {
    const malformed = {
      ...toolPlugin('malformed'),
      introspection: { requirements: { evalTargets: 'main' } },
    } as unknown as StagewrightPlugin

    await expect(loadPlugins([malformed], { coreVersion: '0.0.0' })).rejects.toMatchObject({
      code: 'PLUGIN_MANIFEST_INVALID',
    })
  })
})

/** A plugin with one tool, for the introspection test. */
function toolPlugin(name = 'demo', version = '2.1.0'): StagewrightPlugin {
  return {
    name,
    version,
    coreVersionRange: '*',
    tools: [
      defineTool({
        name: 'ping',
        description: 'A no-op demo tool. Errors: none.',
        inputSchema: z.object({}),
        operationType: 'query',
        handler: async () => ({ ok: true as const, _meta: { estimated_tokens: 1, elapsed_ms: 0 } }),
      }),
    ],
  }
}

/** A plugin that explicitly discloses one safe config field, for privacy regression coverage. */
function introspectedPlugin(): StagewrightPlugin {
  return {
    name: 'safe',
    version: '1.0.0',
    coreVersionRange: '*',
    configSchema: z.object({ publicLabel: z.string().default('default'), secret: z.string() }),
    introspection: {
      requirements: {
        evalTargets: ['main'],
        transportCapabilities: ['supportsMainEval', 'supportsSurfaceTargeting'],
      },
      config: { safeFields: ['publicLabel'] },
    },
    errorCodes: {
      BLOCKED: { http: 403, retryable: false, hint: 'The operation is blocked.' },
    },
  }
}

interface IntrospectedPluginResponse {
  readonly name: string
  readonly version: string
  readonly state: 'enabled'
  readonly tools: readonly {
    readonly name: string
    readonly state: 'enabled' | 'disabled'
    readonly disabledReason?: { readonly kind: string; readonly target: string }
  }[]
  readonly errorCodes: readonly string[]
  readonly requirements?: {
    readonly evalTargets?: readonly string[]
    readonly transportCapabilities?: readonly string[]
  }
  readonly effectiveConfig?: Readonly<Record<string, unknown>>
}

describe('electron_plugins introspection tool', () => {
  it('is registered and lists loaded plugins when plugins are present', async () => {
    const server = await createServer({ plugins: [toolPlugin()], tools: [] })
    expect(server.dispatcher.has('electron_plugins')).toBe(true)

    const res = (await server.dispatcher.dispatch('electron_plugins', {})) as SuccessResponse<{
      plugins: ReadonlyArray<IntrospectedPluginResponse>
    }>
    expect(res.ok).toBe(true)
    expect(res.plugins).toEqual([
      {
        name: 'demo',
        version: '2.1.0',
        state: 'enabled',
        tools: [{ name: 'demo_ping', state: 'enabled' }],
        errorCodes: [],
      },
    ])

    await server.close().catch(() => undefined)
  })

  it('is NOT registered on a plugin-free server (lean core)', async () => {
    const server = await createServer({ tools: [] })
    expect(server.dispatcher.has('electron_plugins')).toBe(false)
    await server.close().catch(() => undefined)
  })

  it('discloses only allowlisted config and declared requirements', async () => {
    const server = await createServer({
      plugins: [introspectedPlugin()],
      pluginConfigs: { safe: { publicLabel: 'visible', secret: 'must-not-leak' } },
      tools: [],
    })
    const res = (await server.dispatcher.dispatch('electron_plugins', {})) as SuccessResponse<{
      plugins: ReadonlyArray<IntrospectedPluginResponse>
    }>

    expect(res.plugins).toEqual([
      {
        name: 'safe',
        version: '1.0.0',
        state: 'enabled',
        tools: [],
        errorCodes: ['safe.BLOCKED'],
        requirements: {
          evalTargets: ['main'],
          transportCapabilities: ['supportsMainEval', 'supportsSurfaceTargeting'],
        },
        effectiveConfig: { publicLabel: 'visible' },
      },
    ])
    expect(JSON.stringify(res.plugins)).not.toContain('must-not-leak')

    await server.close().catch(() => undefined)
  })

  it('reports eval-policy-hidden first-party tools as disabled with their remediation target', async () => {
    const safe = await createServer({ plugins: [storagePlugin], tools: [] })
    const enabled = await createServer({
      plugins: [storagePlugin],
      tools: [],
      allowEval: { main: false, renderer: true },
    })
    try {
      const safeRes = (await safe.dispatcher.dispatch('electron_plugins', {})) as SuccessResponse<{
        plugins: ReadonlyArray<IntrospectedPluginResponse>
      }>
      const enabledRes = (await enabled.dispatcher.dispatch(
        'electron_plugins',
        {},
      )) as SuccessResponse<{
        plugins: ReadonlyArray<IntrospectedPluginResponse>
      }>
      const safeStorage = safeRes.plugins[0]
      const enabledStorage = enabledRes.plugins[0]

      expect(safeStorage).toMatchObject({
        name: 'storage',
        state: 'enabled',
        errorCodes: expect.arrayContaining(['storage.EVAL_REQUIRED', 'storage.UNSUPPORTED']),
        requirements: {
          evalTargets: ['renderer'],
          transportCapabilities: expect.arrayContaining([
            'canAccessStorage',
            'supportsRendererEval',
          ]),
        },
        effectiveConfig: { redactValues: false, revealValues: false },
      })
      expect(safeStorage?.tools).toContainEqual({
        name: 'storage_local_get',
        state: 'disabled',
        disabledReason: { kind: 'eval_policy_disabled', target: 'renderer' },
      })
      expect(safeStorage?.tools).toContainEqual({ name: 'storage_cookies', state: 'enabled' })
      expect(enabledStorage?.tools).toContainEqual({ name: 'storage_local_get', state: 'enabled' })
    } finally {
      await safe.close().catch(() => undefined)
      await enabled.close().catch(() => undefined)
    }
  })

  it('reports each server instance independently', async () => {
    const first = await createServer({ plugins: [toolPlugin('alpha', '1.0.0')], tools: [] })
    const second = await createServer({ plugins: [toolPlugin('beta', '2.0.0')], tools: [] })

    const firstRes = (await first.dispatcher.dispatch('electron_plugins', {})) as SuccessResponse<{
      plugins: ReadonlyArray<IntrospectedPluginResponse>
    }>
    const secondRes = (await second.dispatcher.dispatch(
      'electron_plugins',
      {},
    )) as SuccessResponse<{
      plugins: ReadonlyArray<IntrospectedPluginResponse>
    }>

    expect(firstRes.plugins).toEqual([
      {
        name: 'alpha',
        version: '1.0.0',
        state: 'enabled',
        tools: [{ name: 'alpha_ping', state: 'enabled' }],
        errorCodes: [],
      },
    ])
    expect(secondRes.plugins).toEqual([
      {
        name: 'beta',
        version: '2.0.0',
        state: 'enabled',
        tools: [{ name: 'beta_ping', state: 'enabled' }],
        errorCodes: [],
      },
    ])

    await first.close().catch(() => undefined)
    await second.close().catch(() => undefined)
  })
})

/** A no-op Logger that records `warn` calls so we can assert the orphaned-config warning. */
function capturingLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
  // vi.fn()'s Mock type does not structurally satisfy Logger's optional-fields
  // signatures under exactOptionalPropertyTypes; the runtime shape is correct.
  return logger as unknown as Logger & { warn: ReturnType<typeof vi.fn> }
}

describe('createServer orphaned pluginConfigs', () => {
  it('warns when config is supplied but no plugins are loaded', async () => {
    const logger = capturingLogger()
    const server = await createServer({ tools: [], logger, pluginConfigs: { ghost: { x: 1 } } })

    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0]?.[1]).toEqual({ configKeys: ['ghost'] })

    await server.close().catch(() => undefined)
  })

  it('warns for config keys that match no loaded plugin', async () => {
    const logger = capturingLogger()
    const server = await createServer({
      plugins: [toolPlugin()],
      tools: [],
      logger,
      pluginConfigs: { demo: { ok: true }, ghost: { x: 1 } },
    })

    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0]?.[1]).toEqual({ configKeys: ['ghost'] })

    await server.close().catch(() => undefined)
  })

  it('does not warn for an empty pluginConfigs record', async () => {
    const logger = capturingLogger()
    const server = await createServer({ tools: [], logger, pluginConfigs: {} })

    expect(logger.warn).not.toHaveBeenCalled()

    await server.close().catch(() => undefined)
  })
})
