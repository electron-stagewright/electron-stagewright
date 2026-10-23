/**
 * `electron_reload` — reload a window's page without eval and return once the new page has
 * rendered, using the same readiness check as `electron_launch`.
 *
 * @module
 */

import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import { makeError, makeSuccess } from '../../errors/envelope.js'
import { assertCapability } from '../../transports/index.js'
import { isRendererNavigation } from '../../transports/navigation.js'
import { sessionIdField } from '../schema.js'
import { type AnyToolDefinition, defineTool } from '../types.js'
import { buildWaitForSelectorBody } from '../wait/body.js'
import { type WaitRaw } from '../wait/poll.js'
import { sleep } from '../wait/sleep.js'
import { awaitRendererReady, DEFAULT_READY_TIMEOUT_MS, MAX_READY_TIMEOUT_MS } from './ready.js'

/** Tags the current document, so the wait can tell the reloaded one apart. */
const MARK_BODY = 'globalThis.__stagewrightReloadMark = arg.mark; return true'
const SAME_DOCUMENT_BODY = 'return globalThis.__stagewrightReloadMark === arg.mark'
const URL_BODY = 'return location.href'
/** Interval between checks for the new document. */
const NEW_DOCUMENT_POLL_MS = 25

/** `electron_reload` — reload the active (or given) window and wait for the new page. */
export const reloadTool: AnyToolDefinition = defineTool({
  name: 'electron_reload',
  title: 'Reload a window',
  description: [
    'Reload the active window (or windowId, which also selects it) and wait, within readyTimeoutMs',
    '(default 5000), for the new page to render, like electron_launch; then optionally for',
    'waitForSelector to be visible. Use it instead of location.reload() in eval. ignoreCache does a',
    'hard reload. Refs from before the reload are gone. Returns: { ok, session_id, renderer_ready,',
    'url }. Errors: WAIT_TIMEOUT (waitForSelector not visible in time; retryable), REF_NOT_FOUND (no',
    'such window), TRANSPORT_UNSUPPORTED, NOT_RUNNING, BAD_ARGUMENT (invalid selector).',
  ].join(' '),
  inputSchema: z.object({
    ignoreCache: z.boolean().optional().describe('Bypass the HTTP cache (hard reload).'),
    waitForSelector: z
      .string()
      .min(1)
      .optional()
      .describe('Once the page is ready, wait for this selector to be visible.'),
    readyTimeoutMs: z
      .number()
      .int()
      .min(0)
      .max(MAX_READY_TIMEOUT_MS)
      .optional()
      .describe('Budget in ms for the new page and waitForSelector. Default 5000.'),
    windowId: z.string().optional().describe('Window to reload and select. Default: active.'),
    sessionId: sessionIdField,
  }),
  operationType: 'command',
  handler: async (args, ctx) => {
    const managed = ctx.sessions.resolve(args.sessionId)
    const meta = { startedAt: ctx.startedAt, now: ctx.now, session_id: managed.id }
    assertCapability(managed.transport, 'supportsRendererEval')
    const session = managed.session
    const windows = await session.windowsList()
    const windowId = args.windowId ?? (windows.find((window) => window.focused) ?? windows[0])?.id
    if (windowId === undefined) {
      return makeError('REF_NOT_FOUND', { ...meta, message: 'No Electron window to reload.' })
    }
    // Selecting the window also resets the surface to its root: a selected iframe is replaced too.
    await session.activateWindow({ kind: 'id', id: windowId })

    const deadline = ctx.now() + (args.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS)
    const remaining = (): number => Math.max(0, deadline - ctx.now())
    const mark = randomUUID()
    // A page that is already navigating cannot be tagged yet; try again on its next document.
    for (;;) {
      ctx.signal?.throwIfAborted()
      try {
        await session.evaluate('renderer', MARK_BODY, { mark })
        break
      } catch (err) {
        if (!isRendererNavigation(err) || remaining() === 0) throw err
      }
      await sleep(Math.min(NEW_DOCUMENT_POLL_MS, remaining()), ctx.signal)
    }
    ctx.signal?.throwIfAborted()
    await session.reload({ kind: 'id', id: windowId }, { ignoreCache: args.ignoreCache === true })
    // Refs from the stored snapshot point into the page being replaced.
    ctx.snapshots.clear(managed.id)

    // The old document keeps the mark until it unloads; checks during the swap may fail outright.
    let reloaded = false
    for (;;) {
      ctx.signal?.throwIfAborted()
      try {
        reloaded =
          (await session.evaluate<unknown>('renderer', SAME_DOCUMENT_BODY, { mark })) !== true
      } catch (err) {
        if (!isRendererNavigation(err)) throw err
      }
      if (reloaded || remaining() === 0) break
      await sleep(Math.min(NEW_DOCUMENT_POLL_MS, remaining()), ctx.signal)
    }
    const rendererReady = reloaded && (await awaitRendererReady(session, remaining(), ctx.signal))

    if (args.waitForSelector !== undefined) {
      const raw = await session.evaluate<WaitRaw>('renderer', buildWaitForSelectorBody(), {
        selector: args.waitForSelector,
        state: 'visible',
        timeoutMs: remaining(),
      })
      if (raw?.invalid_selector === true) {
        return makeError('BAD_ARGUMENT', {
          ...meta,
          message: `Invalid CSS selector${typeof raw.error === 'string' ? `: ${raw.error}` : '.'}`,
        })
      }
      if (raw?.satisfied !== true) {
        return makeError('WAIT_TIMEOUT', {
          ...meta,
          message: `The page reloaded but "${args.waitForSelector}" was not visible in time.`,
          next_actions: ['electron_snapshot()'],
          details: { renderer_ready: rendererReady },
        })
      }
    }

    const url = await session.evaluate<unknown>('renderer', URL_BODY).catch(async () => {
      const after = await session.windowsList().catch(() => [])
      return after.find((window) => window.id === windowId)?.url ?? ''
    })
    return makeSuccess(
      {
        session_id: managed.id,
        renderer_ready: rendererReady,
        url: typeof url === 'string' ? url : '',
      },
      meta,
    )
  },
})
