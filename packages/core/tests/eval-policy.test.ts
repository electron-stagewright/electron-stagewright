/**
 * Per-target eval authorization (ADR-014). The eval escape hatch is gated per target —
 * main-process eval (full Node) versus renderer eval (the web page) — so an operator can
 * grant least privilege. These tests pin the policy normaliser, the CLI `--allow-eval[=…]`
 * parse (including fail-closed on a bad value), the dispatcher's per-target REGISTRATION
 * gate (a tool whose target the policy denies is absent from the manifest), the precise
 * gated-tool error that names the specific flag, the `ctx.allowEval` → main-target mapping
 * that gates main-process plugin instrumentation, and the main-eval startup warning.
 */

import { describe, expect, it } from 'vitest'

import { parseAllowEval } from '../src/cli.js'
import type { ErrorResponse } from '../src/errors/envelope.js'
import { anyEvalAllowed, type EvalPolicy, normalizeEvalPolicy } from '../src/server/eval-policy.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import type { LogFields, Logger } from '../src/server/logger.js'
import { SessionManager } from '../src/server/session-manager.js'
import { EVAL_TOOLS } from '../src/tools/eval/index.js'

/** A logger that records every `warn` message; the other levels are no-ops. */
function captureLogger(): { logger: Logger; warns: string[] } {
  const warns: string[] = []
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (message: string, _fields?: LogFields) => {
      warns.push(message)
    },
    error: () => {},
  }
  return { logger, warns }
}

/** Build a dispatcher under a given policy with the eval tools registered, returning visible names. */
function registeredEvalTools(allowEval: boolean | EvalPolicy, logger?: Logger): string[] {
  const sessions = new SessionManager()
  const dispatcher = new Dispatcher({ sessions, allowEval, ...(logger ? { logger } : {}) })
  dispatcher.registerAll(EVAL_TOOLS)
  return dispatcher
    .listManifest()
    .map((entry) => entry.name)
    .filter((name) => name.startsWith('electron_eval_'))
}

describe('normalizeEvalPolicy', () => {
  it('treats a back-compat boolean true as both targets and false/undefined as neither', () => {
    expect(normalizeEvalPolicy(true)).toEqual({ main: true, renderer: true })
    expect(normalizeEvalPolicy(false)).toEqual({ main: false, renderer: false })
    expect(normalizeEvalPolicy(undefined)).toEqual({ main: false, renderer: false })
    expect(normalizeEvalPolicy(false)).not.toBe(normalizeEvalPolicy(undefined))
  })

  it('passes an explicit per-target policy through as a fresh object', () => {
    const input: EvalPolicy = { main: false, renderer: true }
    const normalized = normalizeEvalPolicy(input)
    expect(normalized).toEqual({ main: false, renderer: true })
    expect(normalized).not.toBe(input) // copied, so the dispatcher cannot be mutated through the caller's ref
  })

  it('anyEvalAllowed is true when at least one target is permitted', () => {
    expect(anyEvalAllowed({ main: false, renderer: false })).toBe(false)
    expect(anyEvalAllowed({ main: true, renderer: false })).toBe(true)
    expect(anyEvalAllowed({ main: false, renderer: true })).toBe(true)
  })
})

describe('parseAllowEval (CLI)', () => {
  it('absent flag denies both targets', () => {
    expect(parseAllowEval(['--app-root', '/x'])).toEqual({ main: false, renderer: false })
  })

  it('bare --allow-eval enables both targets', () => {
    expect(parseAllowEval(['--allow-eval'])).toEqual({ main: true, renderer: true })
  })

  it('--allow-eval=main / =renderer enable only the named target', () => {
    expect(parseAllowEval(['--allow-eval=main'])).toEqual({ main: true, renderer: false })
    expect(parseAllowEval(['--allow-eval=renderer'])).toEqual({ main: false, renderer: true })
  })

  it('comma-separated and =all enable both', () => {
    expect(parseAllowEval(['--allow-eval=main,renderer'])).toEqual({ main: true, renderer: true })
    expect(parseAllowEval(['--allow-eval=all'])).toEqual({ main: true, renderer: true })
  })

  it('the last occurrence wins', () => {
    expect(parseAllowEval(['--allow-eval', '--allow-eval=renderer'])).toEqual({
      main: false,
      renderer: true,
    })
  })

  it('fails closed on an unrecognised target value (a typo never silently grants/denies)', () => {
    expect(() => parseAllowEval(['--allow-eval=both'])).toThrow(/main, renderer, or all/)
    expect(() => parseAllowEval(['--allow-eval=main,danger'])).toThrow(/got "danger"/)
    expect(() => parseAllowEval(['--allow-eval='])).toThrow(/expects main, renderer, or all/)
  })
})

describe('per-target registration gate', () => {
  it('boolean true registers both eval tools, false neither (back-compat)', () => {
    expect(registeredEvalTools(true).sort()).toEqual([
      'electron_eval_main',
      'electron_eval_renderer',
    ])
    expect(registeredEvalTools(false)).toEqual([])
  })

  it('a main-only policy registers only electron_eval_main', () => {
    expect(registeredEvalTools({ main: true, renderer: false })).toEqual(['electron_eval_main'])
  })

  it('a renderer-only policy registers only electron_eval_renderer', () => {
    expect(registeredEvalTools({ main: false, renderer: true })).toEqual(['electron_eval_renderer'])
  })
})

describe('gated-tool error names the specific flag', () => {
  async function gatedError(allowEval: EvalPolicy, tool: string): Promise<ErrorResponse> {
    const sessions = new SessionManager()
    const dispatcher = new Dispatcher({ sessions, allowEval })
    dispatcher.registerAll(EVAL_TOOLS)
    return (await dispatcher.dispatch(tool, { code: '1 + 1' })) as ErrorResponse
  }

  it('calling a renderer-eval tool under a main-only policy names --allow-eval=renderer', async () => {
    const res = await gatedError({ main: true, renderer: false }, 'electron_eval_renderer')
    expect(res).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
    expect(res.error).toContain('--allow-eval=renderer')
    expect(res.next_actions?.some((action) => action.includes('--allow-eval=renderer'))).toBe(true)
  })

  it('calling a main-eval tool under a renderer-only policy names --allow-eval=main', async () => {
    // The least-privilege direction the ADR promotes (--allow-eval=renderer): the main tool must
    // still report the precise flag, not degrade to a generic unknown-tool error.
    const res = await gatedError({ main: false, renderer: true }, 'electron_eval_main')
    expect(res).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
    expect(res.error).toContain('--allow-eval=main')
    expect(res.next_actions?.some((action) => action.includes('--allow-eval=main'))).toBe(true)
  })
})

describe('ctx.allowEval maps to the main target (the main-process instrumentation gate)', () => {
  it('is true only when main eval is permitted, regardless of renderer', () => {
    const sessions = new SessionManager()
    const mainOnly = new Dispatcher({ sessions, allowEval: { main: true, renderer: false } })
    const rendererOnly = new Dispatcher({ sessions, allowEval: { main: false, renderer: true } })
    const neither = new Dispatcher({ sessions, allowEval: false })
    // The IPC plugin reads ctx.allowEval to gate MAIN-process instrumentation, so a renderer-only
    // policy must read as false here even though renderer eval is on.
    expect(mainOnly.allowEval).toBe(true)
    expect(rendererOnly.allowEval).toBe(false)
    expect(neither.allowEval).toBe(false)
  })
})

describe('ctx.allowEvalRenderer maps to the renderer target (the renderer-instrumentation gate)', () => {
  it('is true only when renderer eval is permitted, regardless of main', () => {
    const sessions = new SessionManager()
    const mainOnly = new Dispatcher({ sessions, allowEval: { main: true, renderer: false } })
    const rendererOnly = new Dispatcher({ sessions, allowEval: { main: false, renderer: true } })
    const both = new Dispatcher({ sessions, allowEval: true })
    const neither = new Dispatcher({ sessions, allowEval: false })
    // The storage plugin reads ctx.allowEvalRenderer to gate per-key localStorage/sessionStorage, so a
    // main-only policy must read as false here even though main eval is on — the mirror of allowEval.
    expect(mainOnly.allowEvalRenderer).toBe(false)
    expect(rendererOnly.allowEvalRenderer).toBe(true)
    expect(both.allowEvalRenderer).toBe(true)
    expect(neither.allowEvalRenderer).toBe(false)
    // And the two targets are independent: a renderer-only policy denies main, permits renderer.
    expect(rendererOnly.allowEval).toBe(false)
  })
})

describe('main-eval startup warning', () => {
  it('warns when main eval is granted', () => {
    const { logger, warns } = captureLogger()
    new Dispatcher({
      sessions: new SessionManager(),
      allowEval: { main: true, renderer: false },
      logger,
    })
    expect(warns.some((message) => message.includes('Main-process eval is enabled'))).toBe(true)
  })

  it('does not warn for a renderer-only policy', () => {
    const { logger, warns } = captureLogger()
    new Dispatcher({
      sessions: new SessionManager(),
      allowEval: { main: false, renderer: true },
      logger,
    })
    expect(warns.some((message) => message.includes('Main-process eval is enabled'))).toBe(false)
  })
})
