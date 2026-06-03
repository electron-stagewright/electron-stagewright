/**
 * Plugin model tests (ADR-004). A fixture `StagewrightPlugin` exercises the loader and
 * the `createServer({ plugins })` integration in-process (no real Electron): tool
 * namespacing (`sample_greet`), error-code namespacing (`sample.GREETING_REFUSED`),
 * registration into the dispatcher, the namespaced error envelope, lifecycle
 * (setup/teardown + code unregistration), and fail-closed rejection of bad manifests,
 * version mismatches, duplicate namespaces/tools, and a throwing setup (which tears down
 * the already-loaded plugins).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { type ErrorResponse, makePluginError, makeSuccess } from '../src/errors/envelope.js'
import { clearPluginErrorCodes, lookupErrorCodeDefinition } from '../src/errors/registry.js'
import { loadPlugins } from '../src/plugins/loader.js'
import type { StagewrightPlugin } from '../src/plugins/types.js'
import { createServer } from '../src/server/server.js'
import { defineTool } from '../src/tools/types.js'

const CORE_VERSION = '0.0.0'
const GREETING_REFUSED_DEF = {
  http: 422,
  retryable: false,
  hint: 'The greeter refused this name.',
} as const

/** Build the fixture plugin, optionally wiring setup/teardown spies. */
function samplePlugin(
  hooks: Partial<Pick<StagewrightPlugin, 'setup' | 'teardown'>> = {},
): StagewrightPlugin {
  return {
    name: 'sample',
    version: '1.0.0',
    coreVersionRange: '*',
    errorCodes: {
      GREETING_REFUSED: GREETING_REFUSED_DEF,
    },
    tools: [
      defineTool({
        name: 'greet',
        description:
          'Greet someone. Errors: sample.GREETING_REFUSED (name is blocked; not retryable).',
        inputSchema: z.object({ name: z.string() }),
        operationType: 'query',
        handler: async (args, ctx) => {
          if (args.name === 'nobody') {
            return makePluginError('sample.GREETING_REFUSED', {
              startedAt: ctx.startedAt,
              now: ctx.now,
            })
          }
          return makeSuccess(
            { greeting: `Hello, ${args.name}!` },
            {
              startedAt: ctx.startedAt,
              now: ctx.now,
            },
          )
        },
      }),
    ],
    ...hooks,
  }
}

afterEach(() => {
  // The plugin error-code registry is process-global; reset it between tests.
  clearPluginErrorCodes()
})

describe('loadPlugins', () => {
  it('namespaces tools and error codes, and runs setup', async () => {
    const setup = vi.fn()
    const result = await loadPlugins([samplePlugin({ setup })], { coreVersion: CORE_VERSION })

    expect(result.tools).toHaveLength(1)
    expect(result.tools[0]?.name).toBe('sample_greet')
    expect(result.loaded[0]?.errorCodes).toEqual(['sample.GREETING_REFUSED'])
    expect(setup).toHaveBeenCalledTimes(1)
    expect(lookupErrorCodeDefinition('sample.GREETING_REFUSED')).toEqual(GREETING_REFUSED_DEF)
  })

  it('teardown runs the hook and unregisters the codes (idempotent)', async () => {
    const teardown = vi.fn()
    const result = await loadPlugins([samplePlugin({ teardown })], { coreVersion: CORE_VERSION })
    expect(lookupErrorCodeDefinition('sample.GREETING_REFUSED')).toBeDefined()

    await result.teardownAll()
    await result.teardownAll() // idempotent — second call is a no-op

    expect(teardown).toHaveBeenCalledTimes(1)
    expect(lookupErrorCodeDefinition('sample.GREETING_REFUSED')).toBeUndefined()
  })

  it('keeps shared codes registered until every independent load tears down', async () => {
    const first = await loadPlugins([samplePlugin()], { coreVersion: CORE_VERSION })
    const second = await loadPlugins([samplePlugin()], { coreVersion: CORE_VERSION })

    expect(lookupErrorCodeDefinition('sample.GREETING_REFUSED')).toEqual(GREETING_REFUSED_DEF)

    await first.teardownAll()
    expect(lookupErrorCodeDefinition('sample.GREETING_REFUSED')).toEqual(GREETING_REFUSED_DEF)

    await second.teardownAll()
    expect(lookupErrorCodeDefinition('sample.GREETING_REFUSED')).toBeUndefined()
  })

  it('rejects a conflicting shared code without mutating the existing registration', async () => {
    const first = await loadPlugins([samplePlugin()], { coreVersion: CORE_VERSION })
    const conflicting = samplePlugin()
    const changed: StagewrightPlugin = {
      ...conflicting,
      errorCodes: {
        GREETING_REFUSED: { http: 409, retryable: true, hint: 'Different semantics.' },
      },
    }

    await expect(loadPlugins([changed], { coreVersion: CORE_VERSION })).rejects.toThrow(
      'Duplicate error code registration for "sample.GREETING_REFUSED".',
    )
    expect(lookupErrorCodeDefinition('sample.GREETING_REFUSED')).toEqual(GREETING_REFUSED_DEF)

    await first.teardownAll()
    expect(lookupErrorCodeDefinition('sample.GREETING_REFUSED')).toBeUndefined()
  })

  it('does not leak partial codes when a later code key is malformed', async () => {
    const malformed: StagewrightPlugin = {
      ...samplePlugin(),
      tools: [],
      errorCodes: {
        FIRST_OK: { http: 500, retryable: false, hint: 'Registered first.' },
        bad_code: { http: 500, retryable: false, hint: 'Invalid key.' },
      },
    }

    await expect(loadPlugins([malformed], { coreVersion: CORE_VERSION })).rejects.toThrow(
      'must be SCREAMING_SNAKE_CASE',
    )
    expect(lookupErrorCodeDefinition('sample.FIRST_OK')).toBeUndefined()
  })

  it('does not leak codes when tool namespacing fails', async () => {
    const duplicateTool = defineTool({
      name: 'dupe',
      description: 'Duplicate-name fixture.',
      inputSchema: z.object({}),
      operationType: 'query',
      handler: async () => makeSuccess({}),
    })
    const malformed: StagewrightPlugin = {
      ...samplePlugin(),
      tools: [duplicateTool, duplicateTool],
    }

    await expect(loadPlugins([malformed], { coreVersion: CORE_VERSION })).rejects.toMatchObject({
      code: 'PLUGIN_MANIFEST_INVALID',
    })
    expect(lookupErrorCodeDefinition('sample.GREETING_REFUSED')).toBeUndefined()
  })

  it('rejects a malformed plugin name (PLUGIN_MANIFEST_INVALID)', async () => {
    await expect(
      loadPlugins([{ ...samplePlugin(), name: 'Bad Name' }], { coreVersion: CORE_VERSION }),
    ).rejects.toMatchObject({ code: 'PLUGIN_MANIFEST_INVALID' })
  })

  it('rejects the reserved core namespace "electron"', async () => {
    await expect(
      loadPlugins([{ ...samplePlugin(), name: 'electron' }], { coreVersion: CORE_VERSION }),
    ).rejects.toMatchObject({ code: 'PLUGIN_MANIFEST_INVALID' })
  })

  it('rejects a core-version mismatch (PLUGIN_VERSION_MISMATCH)', async () => {
    await expect(
      loadPlugins([{ ...samplePlugin(), coreVersionRange: '9.9.9' }], {
        coreVersion: CORE_VERSION,
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_VERSION_MISMATCH' })
  })

  it('rejects a duplicate plugin namespace', async () => {
    await expect(
      loadPlugins([samplePlugin(), samplePlugin()], { coreVersion: CORE_VERSION }),
    ).rejects.toMatchObject({ code: 'PLUGIN_MANIFEST_INVALID' })
    // The first plugin's codes were torn down on the failed load.
    expect(lookupErrorCodeDefinition('sample.GREETING_REFUSED')).toBeUndefined()
  })

  it('tears down already-loaded plugins when a later setup throws', async () => {
    const firstTeardown = vi.fn()
    const first = samplePlugin({ teardown: firstTeardown })
    const second: StagewrightPlugin = {
      name: 'broken',
      version: '1.0.0',
      coreVersionRange: '*',
      setup: () => {
        throw new Error('setup boom')
      },
    }

    await expect(loadPlugins([first, second], { coreVersion: CORE_VERSION })).rejects.toThrow(
      'setup boom',
    )
    expect(firstTeardown).toHaveBeenCalledTimes(1)
    expect(lookupErrorCodeDefinition('sample.GREETING_REFUSED')).toBeUndefined()
  })
})

describe('createServer({ plugins })', () => {
  it('registers the namespaced tool and dispatches success + namespaced error', async () => {
    // tools: [] keeps the core surface out so the test is fast and transport-free.
    const teardown = vi.fn()
    const server = await createServer({ plugins: [samplePlugin({ teardown })], tools: [] })

    expect(server.dispatcher.has('sample_greet')).toBe(true)
    expect(server.dispatcher.list().map((t) => t.name)).toEqual(['sample_greet'])

    const ok = await server.dispatcher.dispatch('sample_greet', { name: 'Ada' })
    expect(ok).toMatchObject({ ok: true, greeting: 'Hello, Ada!' })

    const err = (await server.dispatcher.dispatch('sample_greet', {
      name: 'nobody',
    })) as ErrorResponse
    expect(err.ok).toBe(false)
    expect(err.code).toBe('sample.GREETING_REFUSED')
    expect(err.http).toBe(422)
    expect(err.retryable).toBe(false)

    // close() tears the plugin down even if the (unconnected) MCP close rejects.
    await server.close().catch(() => undefined)
    expect(teardown).toHaveBeenCalledTimes(1)
    expect(lookupErrorCodeDefinition('sample.GREETING_REFUSED')).toBeUndefined()
  })
})
