import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { makeError, makeSuccess } from '../src/errors/envelope.js'
import { ArtifactStore } from '../src/resources/artifacts.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { NOOP_LOGGER } from '../src/server/logger.js'
import { SessionManager } from '../src/server/session-manager.js'
import { ServerStatus } from '../src/server/status.js'
import { createProgressReporter } from '../src/server/progress.js'
import { artifactOutputFields } from '../src/tools/output-schema.js'
import { defineTool, type DispatchRecord, type ToolContext } from '../src/tools/types.js'

const stores: ArtifactStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

function setup() {
  const artifacts = new ArtifactStore()
  stores.push(artifacts)
  const status = new ServerStatus()
  const warn = vi.fn()
  const dispatcher = new Dispatcher({
    sessions: new SessionManager(),
    artifacts,
    status,
    logger: { ...NOOP_LOGGER, warn },
  })
  const records: DispatchRecord[] = []
  dispatcher.addObserver((record) => records.push(record))
  return { artifacts, dispatcher, records, status, warn }
}

function publish(ctx: ToolContext): string {
  const publication = ctx.artifacts?.publish(Buffer.from('{}'), 'application/json', 'item.json')
  if (publication === undefined || !('artifact' in publication)) {
    throw new Error('Expected a publication')
  }
  return publication.artifact.uri
}

describe('dispatch completion owns its evidence and wire result', () => {
  it.each(['throw', 'error', 'invalid-schema'] as const)(
    'releases every request-owned publication after %s, even when none is in the result',
    async (outcome) => {
      const { artifacts, dispatcher, records } = setup()
      const uris: string[] = []
      dispatcher.register(
        defineTool({
          name: 'test_failure',
          description: 'Exercise completion after publication.',
          inputSchema: z.object({}),
          outputSchema: z.object({ path: z.string(), ...artifactOutputFields }),
          operationType: 'command',
          handler: async (_args, ctx) => {
            uris.push(publish(ctx), publish(ctx))
            if (outcome === 'throw') throw new Error('Handler failed')
            if (outcome === 'error') return makeError('BAD_ARGUMENT')
            return makeSuccess({ path: 42 })
          },
        }),
      )
      const result = await dispatcher.dispatch('test_failure', {})
      expect(result.ok).toBe(false)
      expect(uris).toHaveLength(2)
      expect(uris.map((uri) => artifacts.describe(uri))).toEqual([undefined, undefined])
      expect(records).toHaveLength(1)
      expect(records[0]?.result).toEqual(result)
    },
  )

  it.each(['bigint', 'circular'] as const)(
    'maps a %s result to INTERNAL_ERROR before status and observers, and releases evidence',
    async (kind) => {
      const { artifacts, dispatcher, records, status } = setup()
      let uri = ''
      dispatcher.register(
        defineTool({
          name: 'test_unencodable',
          description: 'Exercise JSON completion failure.',
          inputSchema: z.object({ sessionId: z.string() }),
          outputSchema: z.object({ value: z.string(), ...artifactOutputFields }),
          operationType: 'query',
          handler: async (_args, ctx) => {
            uri = publish(ctx)
            const extra: Record<string, unknown> = {}
            extra['value'] = kind === 'bigint' ? 1n : extra
            return makeSuccess({ value: 'valid typed field', extra })
          },
        }),
      )
      const result = await dispatcher.dispatch('test_unencodable', { sessionId: 'session-1' })
      expect(result).toMatchObject({
        ok: false,
        code: 'INTERNAL_ERROR',
        _meta: { session_id: 'session-1' },
      })
      expect(() => JSON.stringify(result)).not.toThrow()
      expect(artifacts.describe(uri)).toBeUndefined()
      expect(status.lastServerError()).toMatchObject({ code: 'INTERNAL_ERROR' })
      expect(records).toHaveLength(1)
      expect(records[0]?.result).toEqual(result)
    },
  )

  it('keeps concurrent and already-completed evidence when another request fails', async () => {
    const { artifacts, dispatcher } = setup()
    let release!: () => void
    let enter!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    let failedUri = ''
    dispatcher.register(
      defineTool({
        name: 'test_concurrent',
        description: 'Exercise independent publication lifetimes.',
        inputSchema: z.object({ fail: z.boolean() }),
        outputSchema: z.object({ path: z.string(), ...artifactOutputFields }),
        operationType: 'query',
        handler: async (args, ctx) => {
          const publication = ctx.artifacts?.publish(Buffer.from('{}'), 'application/json', 'item')
          if (publication === undefined || !('artifact' in publication))
            throw new Error('No artifact')
          if (!args.fail) return makeSuccess({ path: '/local/item', ...publication })
          failedUri = publication.artifact.uri
          enter()
          await gate
          // Returning someone else's descriptor must never transfer deletion ownership.
          return makeSuccess({
            path: 42,
            artifact: committed.ok ? committed['artifact'] : undefined,
          })
        },
      }),
    )
    const committed = await dispatcher.dispatch('test_concurrent', { fail: false })
    const pending = dispatcher.dispatch('test_concurrent', { fail: true })
    await entered
    const concurrent = await dispatcher.dispatch('test_concurrent', { fail: false })
    release()
    expect(await pending).toMatchObject({ ok: false, code: 'INTERNAL_ERROR' })
    expect(artifacts.describe(failedUri)).toBeUndefined()
    for (const result of [committed, concurrent]) {
      const artifact = result.ok ? (result['artifact'] as { uri: string }) : undefined
      expect(artifact).toBeDefined()
      expect(artifacts.describe(artifact?.uri ?? '')).toBeDefined()
    }
  })

  it('preserves a completed nested call when its parent fails', async () => {
    const { artifacts, dispatcher } = setup()
    let childUri = ''
    let parentUri = ''
    dispatcher.registerAll([
      defineTool({
        name: 'test_child',
        description: 'Publish in a nested call.',
        inputSchema: z.object({}),
        operationType: 'query',
        handler: async (_args, ctx) => {
          childUri = publish(ctx)
          return makeSuccess({ childUri })
        },
      }),
      defineTool({
        name: 'test_parent',
        description: 'Fail after a completed nested call.',
        inputSchema: z.object({}),
        operationType: 'query',
        handler: async (_args, ctx) => {
          parentUri = publish(ctx)
          await ctx.dispatch('test_child', {})
          return makeError('BAD_ARGUMENT')
        },
      }),
    ])
    expect(await dispatcher.dispatch('test_parent', {})).toMatchObject({ ok: false })
    expect(artifacts.describe(parentUri)).toBeUndefined()
    expect(artifacts.describe(childUri)).toBeDefined()
  })

  it('commits success before observers and closes its publication capability', async () => {
    const { artifacts, dispatcher } = setup()
    const controller = new AbortController()
    let context: ToolContext | undefined
    let uri = ''
    dispatcher.register(
      defineTool({
        name: 'test_complete',
        description: 'Capture its context.',
        inputSchema: z.object({}),
        operationType: 'query',
        handler: async (_args, ctx) => {
          context = ctx
          uri = publish(ctx)
          return makeSuccess({ uri })
        },
      }),
    )
    dispatcher.addObserver(() => controller.abort())
    expect(
      await dispatcher.dispatch('test_complete', {}, { signal: controller.signal }),
    ).toMatchObject({ ok: true })
    expect(artifacts.describe(uri)).toBeDefined()
    expect(context?.artifacts?.maxArtifactBytes).toBe(artifacts.maxArtifactBytes)
    expect(context?.artifacts?.publish(Buffer.from('{}'), 'application/json', 'late')).toEqual({
      artifact_unavailable: 'closed',
    })
  })

  it('cleans a publication when cancellation happens inside the store call', async () => {
    const { artifacts, dispatcher } = setup()
    const controller = new AbortController()
    let uri = ''
    const original = artifacts.publish.bind(artifacts)
    vi.spyOn(artifacts, 'publish').mockImplementation((...args) => {
      const publication = original(...args)
      if ('artifact' in publication) uri = publication.artifact.uri
      controller.abort()
      return publication
    })
    dispatcher.register(
      defineTool({
        name: 'test_cancel',
        description: 'Publish while cancelled.',
        inputSchema: z.object({}),
        operationType: 'query',
        handler: async (_args, ctx) => makeSuccess({ uri: publish(ctx) }),
      }),
    )
    expect(
      await dispatcher.dispatch('test_cancel', {}, { signal: controller.signal }),
    ).toMatchObject({ code: 'OPERATION_CANCELLED' })
    expect(uri).not.toBe('')
    expect(artifacts.describe(uri)).toBeUndefined()
  })

  it('rejects cancellation triggered while serializing the completion snapshot', async () => {
    const { artifacts, dispatcher, records, status } = setup()
    const controller = new AbortController()
    let uri = ''
    dispatcher.register(
      defineTool({
        name: 'test_serialization_cancel',
        description: 'Cancel while producing the wire snapshot.',
        inputSchema: z.object({}),
        outputSchema: z.object({ value: z.string() }),
        operationType: 'query',
        handler: async (_args, ctx) => {
          uri = publish(ctx)
          const result = makeSuccess({ value: 'ready' })
          return Object.assign(result, {
            toJSON: () => {
              controller.abort()
              return { ...result, toJSON: undefined }
            },
          })
        },
      }),
    )
    const result = await dispatcher.dispatch(
      'test_serialization_cancel',
      {},
      {
        signal: controller.signal,
      },
    )
    expect(result).toMatchObject({ ok: false, code: 'OPERATION_CANCELLED' })
    expect(artifacts.describe(uri)).toBeUndefined()
    expect(records).toHaveLength(1)
    expect(records[0]?.result).toEqual(result)
    expect(status.lastServerError()).toMatchObject({ code: 'OPERATION_CANCELLED' })
  })

  it('closes progress and commits the failure to status before notifying observers', async () => {
    const { dispatcher, status } = setup()
    const controller = new AbortController()
    const cleanup = vi.fn()
    let context: ToolContext | undefined
    const sent = vi.fn(async () => undefined)
    const progress = createProgressReporter({
      progressToken: 'complete',
      sendNotification: sent,
      logger: NOOP_LOGGER,
    })
    dispatcher.register(
      defineTool({
        name: 'test_complete',
        description: 'Return an error.',
        inputSchema: z.object({}),
        operationType: 'query',
        handler: async (_args, ctx) => {
          context = ctx
          ctx.onCancel?.(cleanup)
          return makeError('BAD_ARGUMENT')
        },
      }),
    )
    dispatcher.addObserver(() => {
      expect(status.lastServerError()).toMatchObject({ code: 'BAD_ARGUMENT' })
      expect(context?.progress.report({ progress: 1 })).toBe(false)
      controller.abort()
    })
    expect(
      await dispatcher.dispatch('test_complete', {}, { signal: controller.signal, progress }),
    ).toMatchObject({ code: 'BAD_ARGUMENT' })
    progress.close()
    expect(sent).not.toHaveBeenCalled()
    expect(cleanup).not.toHaveBeenCalled()
  })

  it('never enters a pre-cancelled artifact-producing handler', async () => {
    const { dispatcher } = setup()
    const controller = new AbortController()
    controller.abort()
    const handler = vi.fn(async (_args: object, ctx: ToolContext) =>
      makeSuccess({ uri: publish(ctx) }),
    )
    dispatcher.register(
      defineTool({
        name: 'test_pre_cancel',
        description: 'Would publish evidence.',
        inputSchema: z.object({}),
        operationType: 'query',
        handler,
      }),
    )
    expect(
      await dispatcher.dispatch('test_pre_cancel', {}, { signal: controller.signal }),
    ).toMatchObject({ code: 'OPERATION_CANCELLED' })
    expect(handler).not.toHaveBeenCalled()
  })

  it.each(['coercion', 'default', 'stripping'] as const)(
    'rejects a wire result that is valid only after output-schema %s',
    async (kind) => {
      const { artifacts, dispatcher, records } = setup()
      let uri = ''
      const outputSchema =
        kind === 'coercion'
          ? z.object({ value: z.coerce.number() })
          : kind === 'default'
            ? z.object({ value: z.string().default('missing') })
            : z.object({ value: z.object({ label: z.string() }) })
      dispatcher.register(
        defineTool({
          name: 'test_repaired',
          description: 'Returns a result that requires schema repair.',
          inputSchema: z.object({}),
          outputSchema,
          operationType: 'query',
          handler: async (_args, ctx) => {
            uri = publish(ctx)
            return makeSuccess(
              kind === 'coercion'
                ? { value: '42' }
                : kind === 'default'
                  ? {}
                  : { value: { label: 'allowed', extra: 'stripped' } },
            )
          },
        }),
      )
      const result = await dispatcher.dispatch('test_repaired', {})
      expect(result).toMatchObject({ ok: false, code: 'INTERNAL_ERROR' })
      expect(artifacts.describe(uri)).toBeUndefined()
      expect(records).toHaveLength(1)
      expect(records[0]?.result).toEqual(result)
    },
  )

  it.each(['optional', 'optional-default', 'loose', 'tuple'] as const)(
    'preserves a valid %s JSON result without applying a parsed projection',
    async (kind) => {
      const { dispatcher } = setup()
      const outputSchema =
        kind === 'optional'
          ? z.object({ value: z.string().optional() })
          : kind === 'optional-default'
            ? z.object({ value: z.string().default('annotation').optional() })
            : kind === 'loose'
              ? z.object({ value: z.looseObject({ label: z.string() }) })
              : z.object({ value: z.tuple([z.string(), z.number()]) })
      const payload =
        kind === 'loose'
          ? { value: { label: 'declared', extra: 'allowed' }, additive: 'preserved' }
          : kind === 'tuple'
            ? { value: ['first', 2] }
            : { additive: 'preserved' }
      dispatcher.register(
        defineTool({
          name: 'test_valid',
          description: 'Return a valid JSON-schema result.',
          inputSchema: z.object({}),
          outputSchema,
          operationType: 'query',
          handler: async () => makeSuccess(payload),
        }),
      )
      const result = await dispatcher.dispatch('test_valid', {})
      expect(result).toMatchObject({ ok: true, ...payload })
      if (kind.startsWith('optional')) expect(result).not.toHaveProperty('value')
    },
  )

  it('maps an unrepresentable output contract to one error and releases its publications', async () => {
    const { artifacts, dispatcher, records } = setup()
    let uri = ''
    dispatcher.register(
      defineTool({
        name: 'test_contract_failure',
        description: 'Declare an unsupported schema conversion.',
        inputSchema: z.object({}),
        outputSchema: z.object({ value: z.string().transform((value) => value.toUpperCase()) }),
        operationType: 'query',
        handler: async (_args, ctx) => {
          uri = publish(ctx)
          return makeSuccess({ value: 'original' })
        },
      }),
    )
    const result = await dispatcher.dispatch('test_contract_failure', {})
    expect(result).toMatchObject({ ok: false, code: 'INTERNAL_ERROR' })
    expect(artifacts.describe(uri)).toBeUndefined()
    expect(records).toHaveLength(1)
    expect(records[0]?.result).toEqual(result)
  })
  it.each([
    ['a non-Unicode escape', /^[a-z\_]+$/, 'snake_case'],
    ['a regex flag', /^[a-z]+$/i, 'MixedCase'],
  ] as const)(
    'accepts a result Zod validates against a pattern with %s',
    async (_kind, regex, value) => {
      const { dispatcher } = setup()
      dispatcher.register(
        defineTool({
          name: 'test_pattern',
          description: 'Return a value constrained by a regex.',
          inputSchema: z.object({}),
          outputSchema: z.object({ value: z.string().regex(regex) }),
          operationType: 'query',
          handler: async () => makeSuccess({ value }),
        }),
      )
      expect(await dispatcher.dispatch('test_pattern', {})).toMatchObject({ ok: true, value })
    },
  )

  it('returns a genuine tool error unchanged when its output contract cannot be compiled', async () => {
    const { dispatcher } = setup()
    dispatcher.register(
      defineTool({
        name: 'test_contract_error',
        description: 'Return an error from a tool with an unsupported schema conversion.',
        inputSchema: z.object({}),
        outputSchema: z.object({ value: z.string().transform((value) => value.toUpperCase()) }),
        operationType: 'query',
        handler: async () => makeError('BAD_ARGUMENT', { message: 'Bad input.' }),
      }),
    )
    expect(await dispatcher.dispatch('test_contract_error', {})).toMatchObject({
      ok: false,
      code: 'BAD_ARGUMENT',
      error: 'Bad input.',
    })
  })
})
