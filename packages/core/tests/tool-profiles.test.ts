/** Explicit core tool-profile contract and profile/eval composition tests. */

import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { makeSuccess } from '../src/errors/envelope.js'
import type { StagewrightPlugin } from '../src/plugins/types.js'
import { createServer } from '../src/server/server.js'
import {
  DEBUG_CORE_TOOL_NAMES,
  DEFAULT_TOOLS,
  ESSENTIAL_CORE_TOOL_NAMES,
  resolveCoreToolProfile,
  TESTING_CORE_TOOL_NAMES,
} from '../src/tools/index.js'
import { defineTool } from '../src/tools/types.js'

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  while (closers.length > 0)
    await closers
      .pop()?.()
      .catch(() => undefined)
})

function safeNames(profile: 'essential' | 'testing' | 'debug' | 'full'): string[] {
  return resolveCoreToolProfile(DEFAULT_TOOLS, profile)
    .filter((tool) => tool.requiresEvalFlag !== true)
    .map((tool) => tool.name)
}

function plugin(name: string): StagewrightPlugin {
  return {
    name,
    version: '1.0.0',
    coreVersionRange: '*',
    tools: [
      defineTool({
        name: 'inspect',
        description: 'Inspect plugin state. Errors: none.',
        inputSchema: z.object({}),
        operationType: 'query',
        handler: async (_args, ctx) => makeSuccess({}, { startedAt: ctx.startedAt, now: ctx.now }),
      }),
    ],
  }
}

describe('core tool profiles', () => {
  it('keeps each named safe profile explicit and its resolved manifest canonical', () => {
    expect(safeNames('essential')).toEqual([...ESSENTIAL_CORE_TOOL_NAMES].sort())
    expect(safeNames('testing')).toEqual([...TESTING_CORE_TOOL_NAMES].sort())
    expect(safeNames('debug')).toEqual([...DEBUG_CORE_TOOL_NAMES].sort())
    expect(safeNames('full')).toEqual(
      DEFAULT_TOOLS.filter((tool) => tool.requiresEvalFlag !== true)
        .map((tool) => tool.name)
        .sort(),
    )
  })

  it('keeps eval definitions orthogonal to every profile', () => {
    const names = resolveCoreToolProfile(DEFAULT_TOOLS, 'essential').map((tool) => tool.name)
    expect(names).toContain('electron_eval_main')
    expect(names).toContain('electron_eval_renderer')
  })

  it('makes the omitted-tool error actionable without shadowing eval gating', async () => {
    const server = await createServer({ toolProfile: 'essential' })
    closers.push(() => server.close())

    expect(server.dispatcher.has('electron_screenshot')).toBe(false)
    await expect(server.dispatcher.dispatch('electron_screenshot', {})).resolves.toMatchObject({
      ok: false,
      code: 'BAD_ARGUMENT',
      next_actions: [expect.stringContaining('--tool-profile debug')],
    })
    await expect(server.dispatcher.dispatch('electron_eval_renderer', {})).resolves.toMatchObject({
      ok: false,
      code: 'BAD_ARGUMENT',
      error: expect.stringContaining('--allow-eval=renderer'),
    })
  })

  it('combines an essential profile with eval authorization by target', async () => {
    const server = await createServer({
      toolProfile: 'essential',
      allowEval: { main: true, renderer: false },
    })
    closers.push(() => server.close())

    expect(server.dispatcher.has('electron_eval_main')).toBe(true)
    expect(server.dispatcher.has('electron_eval_renderer')).toBe(false)
    expect(server.dispatcher.list().map((tool) => tool.name)).toEqual(
      [...server.dispatcher.list().map((tool) => tool.name)].sort(),
    )
  })

  it('preserves full as the default and rejects a silent custom-tools collision', async () => {
    const defaultServer = await createServer()
    const fullServer = await createServer({ toolProfile: 'full' })
    closers.push(
      () => defaultServer.close(),
      () => fullServer.close(),
    )

    expect(defaultServer.dispatcher.list().map((tool) => tool.name)).toEqual(
      fullServer.dispatcher.list().map((tool) => tool.name),
    )
    await expect(createServer({ tools: [], toolProfile: 'essential' })).rejects.toThrow(
      /mutually exclusive/,
    )
  })

  it('keeps MCP ordering stable when explicitly loaded plugins arrive in another order', async () => {
    const alpha = plugin('alpha')
    const zeta = plugin('zeta')
    const first = await createServer({ toolProfile: 'essential', plugins: [alpha, zeta] })
    const second = await createServer({ toolProfile: 'essential', plugins: [zeta, alpha] })
    closers.push(
      () => first.close(),
      () => second.close(),
    )

    expect(first.dispatcher.listMcpTools().map((tool) => tool.name)).toEqual(
      second.dispatcher.listMcpTools().map((tool) => tool.name),
    )
  })
})
