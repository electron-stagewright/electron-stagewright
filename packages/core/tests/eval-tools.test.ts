/**
 * Unit tests for the eval tools, with a focus on the security posture: the tools
 * are default-deny (hidden without `--allow-eval`), the keyword blocklist applies,
 * eval failures classify into the EVAL_* codes, large results are capped, and the
 * transport must declare the relevant eval capability.
 */

import { describe, expect, it } from 'vitest'

import { type ErrorResponse, type SuccessResponse } from '../src/errors/envelope.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import type { LogFields, Logger } from '../src/server/logger.js'
import { SessionManager } from '../src/server/session-manager.js'
import { EVAL_TOOLS } from '../src/tools/eval/index.js'
import type { TransportCapabilities } from '../src/transports/index.js'
import { FakeSession, FakeTransport, type FakeEvaluate } from './helpers/fake-transport.js'

function caps(partial: Partial<TransportCapabilities>): TransportCapabilities {
  return {
    canLaunch: true,
    canAttach: true,
    canInject: true,
    canIntercept: true,
    canControlClock: true,
    supportsMainEval: true,
    supportsRendererEval: true,
    supportsInteraction: true,
    ...partial,
  }
}

function setup(
  opts: {
    readonly allowEval?: boolean
    readonly evaluate?: FakeEvaluate
    readonly capabilities?: TransportCapabilities
    readonly logger?: Logger
  } = {},
) {
  const sessions = new SessionManager()
  const session = new FakeSession({
    id: 'sess',
    ...(opts.evaluate !== undefined ? { evaluate: opts.evaluate } : {}),
  })
  const transport =
    opts.capabilities !== undefined
      ? new FakeTransport({ capabilities: opts.capabilities })
      : new FakeTransport()
  sessions.register(transport, session)
  const dispatcher = new Dispatcher({
    sessions,
    allowEval: opts.allowEval ?? true,
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  })
  dispatcher.registerAll(EVAL_TOOLS)
  return { dispatcher, session }
}

describe('eval-tool gating (default-deny)', () => {
  it('hides eval tools when the server has no --allow-eval flag', () => {
    const { dispatcher } = setup({ allowEval: false })
    const names = dispatcher.listManifest().map((entry) => entry.name)
    expect(names).not.toContain('electron_eval_main')
    expect(names).not.toContain('electron_eval_renderer')
  })

  it('registers eval tools when --allow-eval is set', () => {
    const { dispatcher } = setup({ allowEval: true })
    const names = dispatcher.listManifest().map((entry) => entry.name)
    expect(names).toContain('electron_eval_main')
    expect(names).toContain('electron_eval_renderer')
  })

  it('dispatching a hidden eval tool is a BAD_ARGUMENT that names the gate (not a bare unknown-tool)', async () => {
    const { dispatcher } = setup({ allowEval: false })
    const res = (await dispatcher.dispatch('electron_eval_main', {
      code: '1 + 1',
    })) as ErrorResponse
    // The handler/validator is never reached; the dispatcher reports the missing tool. The message
    // distinguishes an intentionally-gated tool from a typo so the caller can recover deliberately.
    expect(res).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
    expect(res.error).toContain('--allow-eval')
    expect(res.next_actions?.length ?? 0).toBeGreaterThan(0)
  })

  it('reports a genuinely unknown tool as a plain unknown-tool error (no gate mention)', async () => {
    const { dispatcher } = setup({ allowEval: false })
    const res = (await dispatcher.dispatch('electron_not_a_real_tool', {})) as ErrorResponse
    expect(res).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
    expect(res.error).toContain('Unknown tool')
    expect(res.error).not.toContain('--allow-eval')
  })
})

describe('eval-tool execution', () => {
  it('evaluates in the main process and returns the result', async () => {
    const calls: { target: string; body: string }[] = []
    const evaluate: FakeEvaluate = async (target, body) => {
      calls.push({ target, body })
      return '32.1.0'
    }
    const { dispatcher } = setup({ evaluate })
    const res = (await dispatcher.dispatch('electron_eval_main', {
      code: 'return electronApp.app.getVersion()',
    })) as SuccessResponse & { result: unknown }
    expect(res).toMatchObject({ ok: true, result: '32.1.0' })
    expect(calls[0]?.target).toBe('main')
    expect(calls[0]?.body).toBe('return electronApp.app.getVersion()')
  })

  it('evaluates in the renderer', async () => {
    const calls: { target: string }[] = []
    const evaluate: FakeEvaluate = async (target) => {
      calls.push({ target })
      return 'Title'
    }
    const { dispatcher } = setup({ evaluate })
    const res = (await dispatcher.dispatch('electron_eval_renderer', {
      code: 'return document.title',
    })) as SuccessResponse & { result: unknown }
    expect(res.result).toBe('Title')
    expect(calls[0]?.target).toBe('renderer')
  })

  it('caps a large result and flags truncation', async () => {
    const big = 'x'.repeat(20_000)
    const { dispatcher } = setup({ evaluate: async () => big })
    const res = (await dispatcher.dispatch('electron_eval_main', {
      code: 'return big',
    })) as SuccessResponse & {
      result: string
      truncated?: boolean
      result_chars?: number
      result_serialized?: boolean
    }
    expect(res.truncated).toBe(true)
    expect(res.result_serialized).toBe(true)
    expect(typeof res.result).toBe('string')
    expect(res.result.length).toBeLessThan(big.length)
    expect(res.result_chars).toBeGreaterThan(20_000)
  })

  it('returns JSON-unsafe values as explicit serialised strings', async () => {
    const { dispatcher } = setup({ evaluate: async () => 1n })
    const res = (await dispatcher.dispatch('electron_eval_main', {
      code: 'return 1n',
    })) as SuccessResponse & { result: string; result_serialized?: boolean; result_chars?: number }
    expect(res.result).toBe('1')
    expect(res.result_serialized).toBe(true)
    expect(res.result_chars).toBe(1)
    expect(() => JSON.stringify(res)).not.toThrow()
  })

  it('keeps undefined results visible in the response envelope', async () => {
    const { dispatcher } = setup({ evaluate: async () => undefined })
    const res = (await dispatcher.dispatch('electron_eval_renderer', {
      code: 'return undefined',
    })) as SuccessResponse & { result: string; result_serialized?: boolean }
    expect(res.result).toBe('undefined')
    expect(res.result_serialized).toBe(true)
  })

  it('logs an audit breadcrumb without logging eval source', async () => {
    const logs: { message: string; fields?: LogFields }[] = []
    const logger: Logger = {
      debug() {},
      info(message, fields) {
        logs.push({ message, ...(fields !== undefined ? { fields } : {}) })
      },
      warn() {},
      error() {},
    }
    const { dispatcher } = setup({ evaluate: async () => 2, logger })
    await dispatcher.dispatch('electron_eval_main', { code: 'return secretToken' })
    expect(logs).toHaveLength(1)
    expect(logs[0]?.message).toBe('eval invoked')
    expect(logs[0]?.fields).toMatchObject({
      tool: 'electron_eval_main',
      target: 'main',
      session_id: 'sess',
      code_length: 'return secretToken'.length,
    })
    expect(JSON.stringify(logs)).not.toContain('secretToken')
  })
})

describe('eval-tool safety + error classification', () => {
  it('blocks a payload containing a blocklisted keyword', async () => {
    const { dispatcher } = setup()
    const res = (await dispatcher.dispatch('electron_eval_main', {
      code: "return require('fs')",
    })) as ErrorResponse
    expect(res.code).toBe('EVAL_BLOCKED_KEYWORD')
  })

  it('maps a SyntaxError to EVAL_SYNTAX_ERROR', async () => {
    const { dispatcher } = setup({
      evaluate: async () => {
        throw new SyntaxError('Unexpected token }')
      },
    })
    const res = (await dispatcher.dispatch('electron_eval_main', {
      code: 'return }',
    })) as ErrorResponse
    expect(res.code).toBe('EVAL_SYNTAX_ERROR')
  })

  it('maps a timeout to EVAL_TIMEOUT', async () => {
    const { dispatcher } = setup({
      evaluate: async () => {
        throw new Error('Timeout 30000ms exceeded')
      },
    })
    const res = (await dispatcher.dispatch('electron_eval_main', {
      code: 'return slow()',
    })) as ErrorResponse
    expect(res.code).toBe('EVAL_TIMEOUT')
  })

  it('maps any other throw to EVAL_RUNTIME_ERROR', async () => {
    const { dispatcher } = setup({
      evaluate: async () => {
        throw new Error('boom at runtime')
      },
    })
    const res = (await dispatcher.dispatch('electron_eval_main', {
      code: 'return boom()',
    })) as ErrorResponse
    expect(res.code).toBe('EVAL_RUNTIME_ERROR')
  })

  it('refuses a transport that cannot eval in the requested context', async () => {
    const { dispatcher } = setup({ capabilities: caps({ supportsMainEval: false }) })
    const res = (await dispatcher.dispatch('electron_eval_main', {
      code: 'return 1',
    })) as ErrorResponse
    expect(res.code).toBe('TRANSPORT_UNSUPPORTED')
  })
})
