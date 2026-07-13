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
import { SessionManager } from '../src/server/session-manager.js'
import { createServer } from '../src/server/server.js'
import { defineTool } from '../src/tools/types.js'
import { FakeSession, FakeTransport } from './helpers/fake-transport.js'

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

/** A plugin descriptor whose loader-created instances expose their own closure state. */
function factoryPlugin(): StagewrightPlugin {
  return {
    name: 'factory',
    version: '1.1.0',
    coreVersionRange: '*',
    createInstance: () => {
      let label = 'unset'
      let calls = 0
      const ended: Array<{ session_id: string; reason: string }> = []
      return {
        name: 'factory',
        version: '1.1.0',
        coreVersionRange: '*',
        configSchema: z.object({ label: z.string() }),
        tools: [
          defineTool({
            name: 'state',
            description: 'Return instance-local plugin state.',
            inputSchema: z.object({}),
            operationType: 'query',
            handler: async (_args, ctx) =>
              makeSuccess(
                { label, calls: ++calls, ended },
                { startedAt: ctx.startedAt, now: ctx.now },
              ),
          }),
        ],
        setup: (raw, context) => {
          label = (raw as { label: string }).label
          context?.onSessionEnd(({ sessionId, reason }) => {
            ended.push({ session_id: sessionId, reason })
          })
        },
      }
    },
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

  it('accepts a semver RANGE that admits the running core (^, comparators, OR)', async () => {
    // Running core 1.2.3 against a variety of satisfied ranges.
    for (const range of ['^1.2.0', '>=1.0.0 <2.0.0', '~1.2', '1.x', '0.9.0 || ^1.0.0']) {
      const result = await loadPlugins([{ ...samplePlugin(), coreVersionRange: range }], {
        coreVersion: '1.2.3',
      })
      expect(result.tools.map((t) => t.name)).toContain('sample_greet')
      await result.teardownAll()
    }
  })

  it('rejects a semver range that excludes the running core', async () => {
    await expect(
      loadPlugins([{ ...samplePlugin(), coreVersionRange: '^2.0.0' }], { coreVersion: '1.2.3' }),
    ).rejects.toMatchObject({ code: 'PLUGIN_VERSION_MISMATCH' })
  })

  it('rejects an unparseable coreVersionRange as a manifest error, not a compat failure', async () => {
    await expect(
      loadPlugins([{ ...samplePlugin(), coreVersionRange: '>=garbage' }], {
        coreVersion: '1.2.3',
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_MANIFEST_INVALID' })
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

  it('does NOT call a plugin teardown hook when its own config validation failed', async () => {
    // The plugin is recorded before config validation (so its codes get unregistered), but its
    // setup never ran — so teardown must not run against state it never built.
    const teardown = vi.fn()
    const setup = vi.fn()
    const bad: StagewrightPlugin = {
      name: 'needsconfig',
      version: '1.0.0',
      coreVersionRange: '*',
      configSchema: z.object({ required: z.string() }),
      setup,
      teardown,
    }
    await expect(
      loadPlugins([bad], { coreVersion: CORE_VERSION, configs: { needsconfig: {} } }),
    ).rejects.toMatchObject({ code: 'PLUGIN_CONFIG_INVALID' })
    expect(setup).not.toHaveBeenCalled()
    expect(teardown).not.toHaveBeenCalled()
  })

  it('materializes factory plugins per server while preserving API 1.0 object plugins', async () => {
    const descriptor = factoryPlugin()
    const first = await createServer({
      plugins: [descriptor],
      pluginConfigs: { factory: { label: 'first' } },
      tools: [],
    })
    const second = await createServer({
      plugins: [descriptor],
      pluginConfigs: { factory: { label: 'second' } },
      tools: [],
    })
    try {
      expect(await first.dispatcher.dispatch('factory_state', {})).toMatchObject({
        ok: true,
        label: 'first',
        calls: 1,
        ended: [],
      })
      expect(await second.dispatcher.dispatch('factory_state', {})).toMatchObject({
        ok: true,
        label: 'second',
        calls: 1,
        ended: [],
      })

      const session = new FakeSession({ id: 'factory-session' })
      const transport = new FakeTransport({ session })
      first.sessions.register(transport, session)
      await first.sessions.remove(session.id)

      expect(await first.dispatcher.dispatch('factory_state', {})).toMatchObject({
        ok: true,
        label: 'first',
        calls: 2,
        ended: [{ session_id: 'factory-session', reason: 'stop' }],
      })
      expect(await second.dispatcher.dispatch('factory_state', {})).toMatchObject({
        ok: true,
        label: 'second',
        calls: 2,
        ended: [],
      })
    } finally {
      await first.close().catch(() => undefined)
      await second.close().catch(() => undefined)
    }
  })

  it('rejects a factory that changes its declared namespace', async () => {
    const malformed: StagewrightPlugin = {
      name: 'declared',
      version: '1.1.0',
      coreVersionRange: '*',
      createInstance: () => ({
        name: 'different',
        version: '1.1.0',
        coreVersionRange: '*',
      }),
    }

    await expect(loadPlugins([malformed], { coreVersion: CORE_VERSION })).rejects.toThrow(
      'createInstance must preserve the plugin namespace',
    )
  })
})

describe('createServer({ plugins })', () => {
  it('registers the namespaced tool and dispatches success + namespaced error', async () => {
    // tools: [] keeps the core surface out so the test is fast and transport-free.
    const teardown = vi.fn()
    const server = await createServer({ plugins: [samplePlugin({ teardown })], tools: [] })

    expect(server.dispatcher.has('sample_greet')).toBe(true)
    // With plugins present, createServer also registers the electron_plugins
    // introspection tool (ADR-004). Both — and only both — make up the surface.
    expect(
      server.dispatcher
        .list()
        .map((t) => t.name)
        .sort(),
    ).toEqual(['electron_plugins', 'sample_greet'])

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

describe('SessionManager plugin lifecycle', () => {
  it('notifies release hooks for stop, force-kill, detach, and server close', async () => {
    const sessions = new SessionManager()
    const events: Array<{ sessionId: string; reason: string; remaining: readonly string[] }> = []
    sessions.onSessionEnd(({ sessionId, reason, remainingSessionIds }) => {
      events.push({ sessionId, reason, remaining: remainingSessionIds })
    })

    const add = (id: string) => {
      const session = new FakeSession({ id })
      sessions.register(new FakeTransport({ session }), session)
    }

    add('stop')
    await sessions.remove('stop')
    add('kill')
    await sessions.remove('kill', { force: true })
    add('detach')
    await sessions.detach('detach')
    add('close-a')
    add('close-b')
    await sessions.disposeAll()

    expect(events).toEqual([
      { sessionId: 'stop', reason: 'stop', remaining: [] },
      { sessionId: 'kill', reason: 'force_kill', remaining: [] },
      { sessionId: 'detach', reason: 'detach', remaining: [] },
      { sessionId: 'close-a', reason: 'server_close', remaining: [] },
      { sessionId: 'close-b', reason: 'server_close', remaining: [] },
    ])
  })

  it('isolates a cleanup-listener failure from session release', async () => {
    const sessions = new SessionManager()
    sessions.onSessionEnd(() => {
      throw new Error('cleanup failed')
    })
    const session = new FakeSession({ id: 'still-released' })
    sessions.register(new FakeTransport({ session }), session)

    await expect(sessions.remove(session.id)).resolves.toEqual({ escalated: false })
    expect(sessions.has(session.id)).toBe(false)
  })
})
