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

import type { Logger } from '../src/server/logger.js'

import { type SuccessResponse } from '../src/errors/envelope.js'
import { clearPluginErrorCodes, lookupErrorCodeDefinition } from '../src/errors/registry.js'
import { isMainEntryPoint, parseCliArgs } from '../src/cli.js'
import { loadPlugins } from '../src/plugins/loader.js'
import { importPlugin } from '../src/plugins/resolve.js'
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
  it('imports a plugin by file path', async () => {
    const plugin = await importPlugin(SAMPLE)
    expect(plugin.name).toBe('fixturep')
    expect(plugin.version).toBe('1.0.0')
  })

  it('rejects a missing module with PLUGIN_LOAD_FAILED', async () => {
    await expect(importPlugin(path.join(HERE, 'fixtures', 'nope.mjs'))).rejects.toMatchObject({
      code: 'PLUGIN_LOAD_FAILED',
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
    expect(opts.allowEval).toBe(true)
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

  it('rejects config that fails the schema (PLUGIN_CONFIG_INVALID)', async () => {
    await expect(
      loadPlugins([configurablePlugin({})], {
        coreVersion: '0.0.0',
        configs: { cfg: { greeting: 42 } },
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_CONFIG_INVALID' })
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

describe('electron_plugins introspection tool', () => {
  it('is registered and lists loaded plugins when plugins are present', async () => {
    const server = await createServer({ plugins: [toolPlugin()], tools: [] })
    expect(server.dispatcher.has('electron_plugins')).toBe(true)

    const res = (await server.dispatcher.dispatch('electron_plugins', {})) as SuccessResponse<{
      plugins: ReadonlyArray<{ name: string; version: string; tools: readonly string[] }>
    }>
    expect(res.ok).toBe(true)
    expect(res.plugins).toEqual([{ name: 'demo', version: '2.1.0', tools: ['demo_ping'] }])

    await server.close().catch(() => undefined)
  })

  it('is NOT registered on a plugin-free server (lean core)', async () => {
    const server = await createServer({ tools: [] })
    expect(server.dispatcher.has('electron_plugins')).toBe(false)
    await server.close().catch(() => undefined)
  })

  it('reports each server instance independently', async () => {
    const first = await createServer({ plugins: [toolPlugin('alpha', '1.0.0')], tools: [] })
    const second = await createServer({ plugins: [toolPlugin('beta', '2.0.0')], tools: [] })

    const firstRes = (await first.dispatcher.dispatch('electron_plugins', {})) as SuccessResponse<{
      plugins: ReadonlyArray<{ name: string; version: string; tools: readonly string[] }>
    }>
    const secondRes = (await second.dispatcher.dispatch(
      'electron_plugins',
      {},
    )) as SuccessResponse<{
      plugins: ReadonlyArray<{ name: string; version: string; tools: readonly string[] }>
    }>

    expect(firstRes.plugins).toEqual([{ name: 'alpha', version: '1.0.0', tools: ['alpha_ping'] }])
    expect(secondRes.plugins).toEqual([{ name: 'beta', version: '2.0.0', tools: ['beta_ping'] }])

    await first.close().catch(() => undefined)
    await second.close().catch(() => undefined)
  })
})

/** A no-op Logger that records `warn` calls so we can assert the orphaned-config warning. */
function capturingLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
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
