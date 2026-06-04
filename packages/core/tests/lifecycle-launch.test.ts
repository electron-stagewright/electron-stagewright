/**
 * Unit tests for `electron_launch` (driven through the dispatcher against a fake
 * transport) and the `diagnoseLaunchError` helper. Covers preflight, the
 * single-instance guard, error diagnosis, the returned window list, session
 * registration, and wire-serialisability.
 */

import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

import { type ErrorResponse, type SuccessResponse } from '../src/errors/envelope.js'
import { StagewrightError } from '../src/errors/registry.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { TransportRegistry } from '../src/server/transport-registry.js'
import { diagnoseLaunchError } from '../src/tools/lifecycle/diagnose.js'
import { makeLaunchTool } from '../src/tools/lifecycle/launch.js'
import type { WindowDescriptor } from '../src/transports/index.js'
import { FakeSession, FakeTransport } from './helpers/fake-transport.js'

const WIN: WindowDescriptor = {
  id: 'w0',
  index: 0,
  title: 'Main',
  url: 'app://index',
  visible: true,
  focused: true,
}

function setup(opts: { fileExists?: boolean; transport?: FakeTransport } = {}) {
  const sessions = new SessionManager()
  const transport =
    opts.transport ??
    new FakeTransport({ session: new FakeSession({ id: 'launched', windows: [WIN] }) })
  const dispatcher = new Dispatcher({
    sessions,
    transports: new TransportRegistry({ transports: [transport] }),
  })
  dispatcher.register(makeLaunchTool({ fileExists: () => opts.fileExists ?? true }))
  return { sessions, transport, dispatcher }
}

/** Execute the renderer-ready body in a browser-like document after JSDOM completes parse. */
async function runRendererReadyProbe(body: string, html: string, arg: unknown): Promise<unknown> {
  const dom = new JSDOM(`<!doctype html>${html}`, { runScripts: 'outside-only' })
  await new Promise<void>((resolve) => dom.window.setTimeout(resolve, 0))
  const probe = dom.window.eval(`(async function(arg) { ${body} })`) as (
    payload: unknown,
  ) => Promise<unknown>
  return probe(arg)
}

describe('electron_launch', () => {
  it('launches, registers the session, and returns the window list', async () => {
    const { sessions, transport, dispatcher } = setup()
    const res = await dispatcher.dispatch('electron_launch', { main: '/abs/main.js' })
    expect(res).toMatchObject({
      ok: true,
      session_id: 'launched',
      transport: 'playwright-electron',
      windows: [WIN],
    })
    expect(transport.launchCount).toBe(1)
    expect(sessions.size).toBe(1)
    expect((res as SuccessResponse)._meta.session_id).toBe('launched')
  })

  it('reports renderer_ready true once the renderer DOM has rendered', async () => {
    const sessions = new SessionManager()
    const session = new FakeSession({
      id: 'launched',
      windows: [WIN],
      // The launch tool probes the renderer for readiness via evaluate('renderer', …).
      evaluate: async () => ({ ready: true }),
    })
    const transport = new FakeTransport({ session })
    const dispatcher = new Dispatcher({
      sessions,
      transports: new TransportRegistry({ transports: [transport] }),
    })
    dispatcher.register(makeLaunchTool({ fileExists: () => true }))
    const res = await dispatcher.dispatch('electron_launch', { main: '/abs/main.js' })
    expect(res).toMatchObject({ ok: true, renderer_ready: true })
  })

  it('does not treat an empty app root as renderer-ready', async () => {
    const sessions = new SessionManager()
    const session = new FakeSession({
      id: 'launched',
      windows: [WIN],
      evaluate: async (_target, body, arg) =>
        runRendererReadyProbe(
          body,
          '<body><div id="root"></div><script>window.booted = true</script></body>',
          arg,
        ),
    })
    const transport = new FakeTransport({ session })
    const dispatcher = new Dispatcher({
      sessions,
      transports: new TransportRegistry({ transports: [transport] }),
    })
    dispatcher.register(makeLaunchTool({ fileExists: () => true }))
    const res = await dispatcher.dispatch('electron_launch', {
      main: '/abs/main.js',
      readyTimeoutMs: 0,
    })
    expect(res).toMatchObject({ ok: true, renderer_ready: false })
  })

  it('treats accessible controls inside the app root as renderer-ready', async () => {
    const sessions = new SessionManager()
    const session = new FakeSession({
      id: 'launched',
      windows: [WIN],
      evaluate: async (_target, body, arg) =>
        runRendererReadyProbe(
          body,
          '<body><div id="root"><button aria-label="Save"></button></div></body>',
          arg,
        ),
    })
    const transport = new FakeTransport({ session })
    const dispatcher = new Dispatcher({
      sessions,
      transports: new TransportRegistry({ transports: [transport] }),
    })
    dispatcher.register(makeLaunchTool({ fileExists: () => true }))
    const res = await dispatcher.dispatch('electron_launch', {
      main: '/abs/main.js',
      readyTimeoutMs: 0,
    })
    expect(res).toMatchObject({ ok: true, renderer_ready: true })
  })

  it('still succeeds with renderer_ready false when readiness is not confirmed', async () => {
    // The default fake session does not resolve the readiness probe (evaluate → undefined),
    // so launch reports renderer_ready:false but the session is registered and usable.
    const { sessions, dispatcher } = setup()
    const res = await dispatcher.dispatch('electron_launch', {
      main: '/abs/main.js',
      readyTimeoutMs: 0,
    })
    expect(res).toMatchObject({ ok: true, renderer_ready: false })
    expect(sessions.size).toBe(1)
  })

  it('rejects a relative main path with ABSOLUTE_PATH_REQUIRED', async () => {
    const { dispatcher } = setup()
    const res = await dispatcher.dispatch('electron_launch', { main: 'relative/main.js' })
    expect((res as ErrorResponse).code).toBe('ABSOLUTE_PATH_REQUIRED')
  })

  it('rejects a missing main path with FILE_NOT_FOUND', async () => {
    const { dispatcher } = setup({ fileExists: false })
    const res = await dispatcher.dispatch('electron_launch', { main: '/abs/missing.js' })
    expect((res as ErrorResponse).code).toBe('FILE_NOT_FOUND')
  })

  it('rejects when neither main nor executablePath is given', async () => {
    const { dispatcher } = setup()
    const res = await dispatcher.dispatch('electron_launch', {})
    expect((res as ErrorResponse).code).toBe('BAD_ARGUMENT')
  })

  it('refuses a second launch while a session is live (single-instance guard)', async () => {
    const { sessions, transport, dispatcher } = setup()
    sessions.register(transport, new FakeSession({ id: 'existing' }))
    const res = await dispatcher.dispatch('electron_launch', { main: '/abs/main.js' })
    expect((res as ErrorResponse).code).toBe('ALREADY_RUNNING')
    expect(transport.launchCount).toBe(0)
  })

  it('allows a second launch when allowMultiple is set', async () => {
    const sessions = new SessionManager()
    sessions.register(new FakeTransport(), new FakeSession({ id: 'existing' }))
    const launchTransport = new FakeTransport({
      session: new FakeSession({ id: 'second', windows: [WIN] }),
    })
    const dispatcher = new Dispatcher({
      sessions,
      transports: new TransportRegistry({ transports: [launchTransport] }),
    })
    dispatcher.register(makeLaunchTool({ fileExists: () => true }))
    const res = await dispatcher.dispatch('electron_launch', {
      main: '/abs/main.js',
      allowMultiple: true,
    })
    expect(res.ok).toBe(true)
    expect(sessions.size).toBe(2)
  })

  it('diagnoses a transport launch failure into a registered code', async () => {
    const transport = new FakeTransport({ launchError: new Error('Timed out waiting for window') })
    const { dispatcher } = setup({ transport })
    const res = await dispatcher.dispatch('electron_launch', { main: '/abs/main.js' })
    expect((res as ErrorResponse).code).toBe('LAUNCH_TIMEOUT')
  })

  it('produces a wire-serialisable response', async () => {
    const { dispatcher } = setup()
    const res = await dispatcher.dispatch('electron_launch', { main: '/abs/main.js' })
    expect(JSON.parse(JSON.stringify(res))).toEqual(res)
  })

  it('does not leave an orphaned session when the window list fails post-launch', async () => {
    const transport = new FakeTransport({
      session: new FakeSession({ id: 'launched', windowsError: new Error('connection dropped') }),
    })
    const { sessions, dispatcher } = setup({ transport })
    const res = await dispatcher.dispatch('electron_launch', { main: '/abs/main.js' })
    expect(res.ok).toBe(false)
    // The session must have been deregistered so the agent is not left with an
    // unreachable, never-stoppable session.
    expect(sessions.size).toBe(0)
  })
})

describe('diagnoseLaunchError', () => {
  it('passes a StagewrightError through unchanged', () => {
    const original = new StagewrightError('SINGLE_INSTANCE_LOCK', 'locked')
    expect(diagnoseLaunchError(original)).toBe(original)
  })

  it('reclassifies generic internal launch wrappers when their message is recognizable', () => {
    const err = new StagewrightError(
      'INTERNAL_ERROR',
      'Playwright launch failed: app.requestSingleInstanceLock failed',
      { transport: 'playwright-electron' },
    )
    const diagnosed = diagnoseLaunchError(err)
    expect(diagnosed.code).toBe('SINGLE_INSTANCE_LOCK')
    expect(diagnosed.details).toEqual({ transport: 'playwright-electron' })
  })

  it('maps a single-instance message', () => {
    expect(diagnoseLaunchError(new Error('app.requestSingleInstanceLock failed')).code).toBe(
      'SINGLE_INSTANCE_LOCK',
    )
  })

  it('maps a timeout message', () => {
    expect(diagnoseLaunchError(new Error('operation timed out')).code).toBe('LAUNCH_TIMEOUT')
  })

  it('maps a missing-file message', () => {
    expect(diagnoseLaunchError(new Error('ENOENT: no such file')).code).toBe('FILE_NOT_FOUND')
  })

  it('defaults to INTERNAL_ERROR', () => {
    expect(diagnoseLaunchError(new Error('something weird')).code).toBe('INTERNAL_ERROR')
  })
})
