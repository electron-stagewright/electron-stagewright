/**
 * Unit tests for the transport abstraction. These focus on the shared contract
 * around the Playwright, CDP, and Injector implementations; protocol-specific
 * happy paths live in their dedicated fake-endpoint suites. These tests cover:
 *
 * - Capability matrix inspection (every transport declares its caps explicitly).
 * - Table-driven capability-vs-method drift detection (every method whose
 *   capability is `false` rejects with `TRANSPORT_UNSUPPORTED`).
 * - `assertCapability` helper.
 * - Refused-when-unsupported behaviour (Playwright transport's `attach` and
 *   `inject` reject because the matrix says false).
 * - Idempotent dispose contract on the abstract level (we cannot exercise the
 *   real Playwright session without launching Electron, but we can pin the
 *   contract via the type system and a lightweight runtime fake).
 */

import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

import { StagewrightError } from '../src/errors/registry.js'
import {
  CDPTransport,
  InjectorTransport,
  PlaywrightElectronTransport,
  assertCapability,
  type AttachOptions,
  type InjectOptions,
  type ITransport,
  type LaunchOptions,
  type StopOptions,
  type TransportCapabilities,
  type TransportSession,
} from '../src/transports/index.js'
import type {
  PWConsoleMessage,
  PWDialog,
  PWRequest,
  PWRoute,
} from '../src/transports/playwright-electron-api.js'
import { buildPlaywrightLaunchOptions } from '../src/transports/playwright-electron.js'
import {
  bodyContentTypeAllowed,
  captureBodyField,
  DEFAULT_BODY_CONTENT_TYPES,
  headerValue,
} from '../src/transports/network-filter.js'

const FAKE_SESSION: TransportSession = {
  id: 'fake-session',
  transport: 'playwright-electron',
  ipc: { transport: 'playwright-electron' },
  console: { transport: 'playwright-electron' },
  evaluate: async <T = unknown>() => undefined as T,
  screenshot: async () => Buffer.alloc(0),
  windowsList: async () => [],
  consoleLogs: async () => ({ entries: [], overflowed: 0 }),
  setDialogPolicy: async () => undefined,
  dialogEvents: async () => ({ entries: [], overflowed: 0, policy: { action: 'dismiss' } }),
  startNetworkCapture: async () => undefined,
  networkEvents: async () => ({ events: [], overflowed: 0 }),
  stopNetworkCapture: async () => undefined,
  stubNetwork: async () => undefined,
  clearNetworkStubs: async () => undefined,
  installClock: async () => undefined,
  setFixedTime: async () => undefined,
  setSystemTime: async () => undefined,
  advanceClock: async () => undefined,
  runClockFor: async () => undefined,
  pauseClockAt: async () => undefined,
  resumeClock: async () => undefined,
  getCookies: async () => [],
  setCookie: async () => undefined,
  clearCookies: async () => undefined,
  storageSnapshot: async () => ({ cookies: [], origins: [] }),
  getApplicationMenu: async () => null,
  invokeApplicationMenuItem: async () => ({ invoked: false, reason: 'not_found' }) as const,
  click: async () => undefined,
  fill: async () => undefined,
  hover: async () => undefined,
  press: async () => undefined,
  typeText: async () => undefined,
  selectOption: async (_selector, values) => values,
  setChecked: async () => undefined,
  setInputFiles: async () => undefined,
  dragTo: async () => undefined,
  scroll: async () => undefined,
  dispose: async () => undefined,
}

function createFakePage(
  title: string,
  opts: {
    evalResult?: unknown
    inertSelectors?: readonly string[]
    goneSelectors?: readonly string[]
  } = {},
) {
  let screenshotCalls = 0
  // Records every interaction method invocation, in order, so tests can assert
  // PlaywrightSession routed the call to the right page method with the mapped
  // actionability options ({ force, timeoutMs } -> { force, timeout }).
  const interactions: { readonly method: string; readonly args: readonly unknown[] }[] = []
  const consoleHandlers: ((message: unknown) => void)[] = []
  const dialogHandlers: ((dialog: unknown) => void)[] = []
  const requestFinishedHandlers: ((request: unknown) => void)[] = []
  const requestFailedHandlers: ((request: unknown) => void)[] = []
  const routeHandlers: { url: string; handler: (route: PWRoute) => void | Promise<void> }[] = []
  // Records page.clock calls so the PlaywrightSession clock-seam tests can assert the mapping
  // (installClock -> install, advanceClock -> fastForward, setFixedTime -> setSystemTime+pauseAt, etc.).
  const clockCalls: { method: string; arg?: unknown }[] = []
  // Backing store for the fake BrowserContext (the storage seam): cookies + a storageState snapshot.
  type FakeCookie = { name: string; value: string; domain?: string; path?: string; url?: string }
  let cookieStore: FakeCookie[] = []
  const storageStateData = {
    cookies: cookieStore,
    origins: [] as { origin: string; localStorage: { name: string; value: string }[] }[],
  }
  const clearCookiesCalls: { name?: string; domain?: string; path?: string }[] = []
  // Editable-content model backing the type-effect check: fill/type/keyboard-type update a
  // selector's content; the type-effect signature read (evaluate with arg.settleMs) reads it.
  // Selectors in `inertSelectors` swallow input (content never changes), simulating a modern
  // editor's hidden textarea that ignores keystrokes — so a force-type into them is a no-op.
  const inert = new Set(opts.inertSelectors ?? [])
  // Selectors whose editable signature reads back as null — the element is gone or not reachable
  // via document.querySelector (e.g. inside a shadow root Playwright pierced but our eval cannot).
  // The effect check must skip (not throw) for these, even if input was routed to them.
  const gone = new Set(opts.goneSelectors ?? [])
  const editable = new Map<string, string>()
  let focused: string | undefined
  const setContent = (selector: string, value: string): void => {
    if (!inert.has(selector)) editable.set(selector, value)
  }
  const appendContent = (selector: string, text: string): void => {
    if (!inert.has(selector)) editable.set(selector, (editable.get(selector) ?? '') + text)
  }
  return {
    get screenshotCalls() {
      return screenshotCalls
    },
    clockCalls,
    clock: {
      install: async (options?: { time?: number | string }) => {
        clockCalls.push(
          options?.time !== undefined
            ? { method: 'install', arg: options.time }
            : { method: 'install' },
        )
      },
      setFixedTime: async (time: number | string) => {
        clockCalls.push({ method: 'setFixedTime', arg: time })
      },
      setSystemTime: async (time: number | string) => {
        clockCalls.push({ method: 'setSystemTime', arg: time })
      },
      fastForward: async (ticks: number) => {
        clockCalls.push({ method: 'fastForward', arg: ticks })
      },
      runFor: async (ticks: number) => {
        clockCalls.push({ method: 'runFor', arg: ticks })
      },
      pauseAt: async (time: number | string) => {
        clockCalls.push({ method: 'pauseAt', arg: time })
      },
      resume: async () => {
        clockCalls.push({ method: 'resume' })
      },
    },
    // Inspectors for the storage seam tests.
    get cookieStore() {
      return cookieStore
    },
    clearCookiesCalls,
    setStorageOrigins(
      origins: { origin: string; localStorage: { name: string; value: string }[] }[],
    ) {
      storageStateData.origins = origins
    },
    context() {
      return {
        cookies: async (_urls?: string | readonly string[]) => [...cookieStore],
        addCookies: async (cookies: readonly FakeCookie[]) => {
          cookieStore.push(...cookies)
        },
        clearCookies: async (options?: { name?: string; domain?: string; path?: string }) => {
          clearCookiesCalls.push(options ?? {})
          cookieStore =
            options?.name !== undefined ? cookieStore.filter((c) => c.name !== options.name) : []
          storageStateData.cookies = cookieStore
        },
        storageState: async () => ({
          cookies: [...cookieStore],
          origins: storageStateData.origins,
        }),
      }
    },
    interactions,
    url: () => `app:///${title}`,
    title: async () => title,
    evaluate: async <T = unknown>(
      fn: (payload: { readonly body: string; readonly arg?: unknown }) => unknown,
      arg?: { readonly body: string; readonly arg?: unknown },
    ): Promise<T> => {
      // The type-effect check reads an editable signature: arg carries { selector, settleMs }.
      // Serve it from the editable-content model so fill/type effect verification can be tested
      // without a real DOM.
      const inner = arg?.arg as { selector?: unknown; settleMs?: unknown } | undefined
      if (inner && 'settleMs' in inner && typeof inner.selector === 'string') {
        if (gone.has(inner.selector)) return null as T
        return (editable.get(inner.selector) ?? '') as T
      }
      // The scroll-into-view body queries `document`, which does not exist in the
      // Node test environment. When a test supplies `evalResult`, short-circuit to
      // it so the transport's found/not-found handling can be exercised without a
      // DOM (the real renderer execution is covered by the gated Electron smoke).
      if (opts.evalResult !== undefined) return opts.evalResult as T
      if (arg === undefined) return undefined as T
      return fn(arg) as T
    },
    screenshot: async () => {
      screenshotCalls += 1
      return Buffer.from(title)
    },
    isVisible: async () => true,
    focus: async (selector: string, opts?: unknown) => {
      focused = selector
      interactions.push({ method: 'focus', args: [selector, opts] })
    },
    click: async (selector: string, opts?: unknown) => {
      focused = selector
      interactions.push({ method: 'click', args: [selector, opts] })
    },
    fill: async (selector: string, value: string, opts?: unknown) => {
      setContent(selector, value)
      interactions.push({ method: 'fill', args: [selector, value, opts] })
    },
    hover: async (selector: string, opts?: unknown) => {
      interactions.push({ method: 'hover', args: [selector, opts] })
    },
    press: async (selector: string, key: string, opts?: unknown) => {
      interactions.push({ method: 'press', args: [selector, key, opts] })
    },
    type: async (selector: string, text: string, opts?: unknown) => {
      appendContent(selector, text)
      interactions.push({ method: 'type', args: [selector, text, opts] })
    },
    selectOption: async (selector: string, values: readonly string[], opts?: unknown) => {
      interactions.push({ method: 'selectOption', args: [selector, values, opts] })
      return values
    },
    check: async (selector: string, opts?: unknown) => {
      interactions.push({ method: 'check', args: [selector, opts] })
    },
    uncheck: async (selector: string, opts?: unknown) => {
      interactions.push({ method: 'uncheck', args: [selector, opts] })
    },
    setInputFiles: async (selector: string, files: readonly string[], opts?: unknown) => {
      interactions.push({ method: 'setInputFiles', args: [selector, files, opts] })
    },
    dragAndDrop: async (source: string, target: string, opts?: unknown) => {
      interactions.push({ method: 'dragAndDrop', args: [source, target, opts] })
    },
    keyboard: {
      press: async (key: string) => {
        interactions.push({ method: 'keyboard.press', args: [key] })
      },
      type: async (text: string) => {
        // Global keystrokes land in the focused element (the force path focuses first).
        if (focused !== undefined) appendContent(focused, text)
        interactions.push({ method: 'keyboard.type', args: [text] })
      },
    },
    mouse: {
      wheel: async (deltaX: number, deltaY: number) => {
        interactions.push({ method: 'mouse.wheel', args: [deltaX, deltaY] })
      },
    },
    // Console- and dialog-event capture: store each listener and expose emitters so
    // tests can drive PlaywrightSession's buffers without a real renderer.
    consoleHandlers,
    dialogHandlers,
    on(
      event: 'console' | 'dialog' | 'requestfinished' | 'requestfailed',
      handler:
        | ((message: PWConsoleMessage) => void)
        | ((dialog: PWDialog) => void)
        | ((request: PWRequest) => void),
    ) {
      if (event === 'console') consoleHandlers.push(handler as (arg: unknown) => void)
      else if (event === 'dialog') dialogHandlers.push(handler as (arg: unknown) => void)
      else if (event === 'requestfinished')
        requestFinishedHandlers.push(handler as (arg: unknown) => void)
      else if (event === 'requestfailed')
        requestFailedHandlers.push(handler as (arg: unknown) => void)
    },
    emitConsole(message: { type: string; text: string; location?: unknown }) {
      const msg = {
        type: () => message.type,
        text: () => message.text,
        location: () => message.location ?? {},
      }
      for (const handler of consoleHandlers) handler(msg)
    },
    /**
     * Drive a native dialog through the attached listener. Returns a record of how
     * the session resolved it (accept/dismiss + any prompt text) for assertions.
     */
    emitDialog(spec: {
      type: string
      message?: string
      defaultValue?: string
      throwOnRead?: boolean
    }) {
      const record: { accepted: boolean; dismissed: boolean; promptText: string | undefined } = {
        accepted: false,
        dismissed: false,
        promptText: undefined,
      }
      const dialog = {
        type: () => {
          // Simulate a malformed dialog handle whose getter throws, to exercise the
          // listener's fire-and-forget rejection guard.
          if (spec.throwOnRead === true) throw new Error('broken dialog handle')
          return spec.type
        },
        message: () => spec.message ?? '',
        defaultValue: () => spec.defaultValue ?? '',
        accept: async (promptText?: string) => {
          record.accepted = true
          record.promptText = promptText
        },
        dismiss: async () => {
          record.dismissed = true
        },
      }
      for (const handler of dialogHandlers) handler(dialog)
      return record
    },
    /** Drive a completed request through the `requestfinished` listeners (with an optional response). */
    emitRequestFinished(spec: {
      url: string
      method?: string
      resourceType?: string
      requestHeaders?: Record<string, string>
      postData?: string
      status?: number
      responseHeaders?: Record<string, string>
      responseBody?: string
      /** When set, the fake `response.body()` rejects (simulates an already-consumed / absent body). */
      responseBodyThrows?: boolean
      /** Awaited inside `response.body()` — lets a test interleave a stop into the body await. */
      onBodyRead?: () => void | Promise<void>
      durationMs?: number
    }): void {
      const request: PWRequest = {
        url: () => spec.url,
        method: () => spec.method ?? 'GET',
        resourceType: () => spec.resourceType ?? 'fetch',
        headers: () => spec.requestHeaders ?? {},
        postData: () => spec.postData ?? null,
        timing: () => ({ startTime: 0, responseEnd: spec.durationMs ?? -1 }),
        failure: () => null,
        response: async () =>
          spec.status === undefined
            ? null
            : {
                status: () => spec.status as number,
                headers: () => spec.responseHeaders ?? {},
                body: async () => {
                  if (spec.onBodyRead !== undefined) await spec.onBodyRead()
                  if (spec.responseBodyThrows === true) throw new Error('body unavailable')
                  return Buffer.from(spec.responseBody ?? '', 'utf8')
                },
              },
      }
      for (const handler of requestFinishedHandlers) handler(request)
    },
    /** Drive a failed request through the `requestfailed` listeners. */
    emitRequestFailed(spec: {
      url: string
      method?: string
      requestHeaders?: Record<string, string>
      postData?: string
      errorText?: string
    }): void {
      const request: PWRequest = {
        url: () => spec.url,
        method: () => spec.method ?? 'GET',
        resourceType: () => 'fetch',
        headers: () => spec.requestHeaders ?? {},
        postData: () => spec.postData ?? null,
        timing: () => ({ startTime: 0, responseEnd: -1 }),
        failure: () => ({ errorText: spec.errorText ?? 'net::ERR_FAILED' }),
        response: async () => null,
      }
      for (const handler of requestFailedHandlers) handler(request)
    },
    // Request-interception stubbing: store each registered route handler (and drop it on unroute) so
    // tests can drive PlaywrightSession's stub seam without a real renderer.
    async route(url: string, handler: (route: PWRoute) => void | Promise<void>) {
      routeHandlers.push({ url, handler })
    },
    async unroute(url: string, handler: (route: PWRoute) => void | Promise<void>) {
      const index = routeHandlers.findIndex((r) => r.url === url && r.handler === handler)
      if (index !== -1) routeHandlers.splice(index, 1)
    },
    /**
     * Drive a request through the registered interceptor(s) and report how the route resolved
     * (`fulfilled` opts / `aborted` code / `continued`). `intercepted` is false when no route is
     * attached — i.e. the request would have gone live.
     */
    async emitRoute(spec: { url: string; method?: string }) {
      const record: {
        intercepted: boolean
        continued: boolean
        fulfilled: Parameters<PWRoute['fulfill']>[0] | undefined
        aborted: string | undefined
      } = {
        intercepted: routeHandlers.length > 0,
        continued: false,
        fulfilled: undefined,
        aborted: undefined,
      }
      const route: PWRoute = {
        request: () =>
          ({ url: () => spec.url, method: () => spec.method ?? 'GET' }) as unknown as PWRequest,
        continue: async () => {
          record.continued = true
        },
        fulfill: async (opts) => {
          record.fulfilled = opts
        },
        abort: async (code) => {
          record.aborted = code
        },
      }
      for (const { handler } of routeHandlers) await handler(route)
      return record
    },
  }
}

function createFakeElectronApp(
  initialPages: ReturnType<typeof createFakePage>[],
  electronModule: unknown = { value: 3 },
  appOpts: { readonly hangClose?: boolean } = {},
) {
  let pages = initialPages
  let closeCalls = 0
  let firstWindowCalls = 0
  const killSignals: string[] = []
  const windowHandlers: ((page: ReturnType<typeof createFakePage>) => void)[] = []
  return {
    get closeCalls() {
      return closeCalls
    },
    get firstWindowCalls() {
      return firstWindowCalls
    },
    killSignals,
    setPages: (nextPages: ReturnType<typeof createFakePage>[]) => {
      pages = nextPages
    },
    /** Register a late-opened window the way Playwright fires its `window` event. */
    emitWindow(page: ReturnType<typeof createFakePage>) {
      pages = [...pages, page]
      for (const handler of windowHandlers) handler(page)
    },
    on(event: 'window', handler: (page: ReturnType<typeof createFakePage>) => void) {
      if (event === 'window') windowHandlers.push(handler)
    },
    windows: () => pages,
    firstWindow: async () => {
      firstWindowCalls += 1
      const page = pages[0]
      if (page === undefined) throw new Error('no windows')
      return page
    },
    evaluate: async <T = unknown>(
      fn: (
        electronApp: unknown,
        payload: { readonly body: string; readonly arg?: unknown },
      ) => unknown,
      arg?: { readonly body: string; readonly arg?: unknown },
    ): Promise<T> => {
      // Mirror real Playwright: electronApp.evaluate(fn) runs the fn with the electron module as the
      // first arg whether or not a payload is given (the native-UI serializer takes no payload arg).
      return fn(electronModule, arg as { readonly body: string; readonly arg?: unknown }) as T
    },
    close: async () => {
      closeCalls += 1
      // A hung app never resolves its close — exercises the stop escalation.
      if (appOpts.hangClose === true) await new Promise(() => {})
    },
    process: () => ({
      pid: 123,
      kill: (signal: string) => {
        killSignals.push(signal)
        return true
      },
    }),
  }
}

describe('PlaywrightElectronTransport', () => {
  const t = new PlaywrightElectronTransport()

  it('declares its capabilities up front', () => {
    expect(t.id).toBe('playwright-electron')
    expect(t.capabilities).toMatchObject({
      canLaunch: true,
      canAttach: false,
      canInject: false,
      canIntercept: true,
      canControlClock: true,
      canAccessStorage: true,
      canAccessNativeUI: true,
      supportsMainEval: true,
      supportsRendererEval: true,
      supportsInteraction: true,
    })
  })

  it('attach() rejects with TRANSPORT_UNSUPPORTED (canAttach is false)', async () => {
    await expect(t.attach({} as AttachOptions)).rejects.toBeInstanceOf(StagewrightError)
    await expect(t.attach({} as AttachOptions)).rejects.toMatchObject({
      code: 'TRANSPORT_UNSUPPORTED',
    })
  })

  it('inject() rejects with TRANSPORT_UNSUPPORTED (canInject is false)', async () => {
    await expect(t.inject({ pid: 0 } as InjectOptions)).rejects.toBeInstanceOf(StagewrightError)
    await expect(t.inject({ pid: 0 } as InjectOptions)).rejects.toMatchObject({
      code: 'TRANSPORT_UNSUPPORTED',
    })
  })

  it('stop() and forceKill() delegate to session.dispose() and are safe on a fresh fake', async () => {
    await expect(t.stop(FAKE_SESSION)).resolves.toEqual({ escalated: false })
    await expect(t.forceKill(FAKE_SESSION)).resolves.toBeUndefined()
  })

  it('launch() surfaces TRANSPORT_UNSUPPORTED when the playwright peer cannot load', async () => {
    // The transport contract is that a peer-load failure reaches the caller as a
    // registered StagewrightError, never a raw dependency error. We inject a
    // failing loader so this is deterministic regardless of whether playwright
    // happens to be installed in the dev environment (it is a devDep for the
    // real-Electron smoke test, so we must not depend on its absence here).
    const missing = new PlaywrightElectronTransport({
      loadElectron: () =>
        Promise.reject(
          new StagewrightError(
            'TRANSPORT_UNSUPPORTED',
            'Playwright peer dependency is not installed.',
          ),
        ),
    })
    const result = await missing
      .launch({ appPath: '/nonexistent/app' } as LaunchOptions)
      .catch((e: unknown) => e)
    expect(result).toBeInstanceOf(StagewrightError)
    expect((result as StagewrightError).code).toBe('TRANSPORT_UNSUPPORTED')
  })

  it('maps a main-process appPath to Playwright args instead of executablePath', () => {
    const opts = buildPlaywrightLaunchOptions({
      appPath: '/abs/main.js',
      args: ['--dev'],
      cwd: '/tmp/app',
      timeoutMs: 123,
    })
    expect(opts).toMatchObject({
      args: ['/abs/main.js', '--dev'],
      cwd: '/tmp/app',
      timeout: 123,
    })
    expect(Object.prototype.hasOwnProperty.call(opts, 'executablePath')).toBe(false)
  })

  it('supports an explicit Electron executable plus a main entry', () => {
    const opts = buildPlaywrightLaunchOptions({
      executablePath: '/Applications/MyApp.app/Contents/MacOS/MyApp',
      appPath: '/abs/main.js',
      args: ['--flag'],
    })
    expect(opts.executablePath).toBe('/Applications/MyApp.app/Contents/MacOS/MyApp')
    expect(opts.args).toEqual(['/abs/main.js', '--flag'])
  })

  it('allows executable-only launches for packaged apps', () => {
    const opts = buildPlaywrightLaunchOptions({
      executablePath: '/Applications/MyApp.app/Contents/MacOS/MyApp',
      args: ['--flag'],
    })
    expect(opts.executablePath).toBe('/Applications/MyApp.app/Contents/MacOS/MyApp')
    expect(opts.args).toEqual(['--flag'])
  })

  it('merges caller env over process.env instead of replacing the environment', () => {
    const oldValue = process.env['STAGEWRIGHT_TEST_KEEP']
    process.env['STAGEWRIGHT_TEST_KEEP'] = 'from-process'
    try {
      const opts = buildPlaywrightLaunchOptions({
        appPath: '/abs/main.js',
        env: { STAGEWRIGHT_TEST_CUSTOM: 'from-call' },
      })
      expect(opts.env?.['STAGEWRIGHT_TEST_KEEP']).toBe('from-process')
      expect(opts.env?.['STAGEWRIGHT_TEST_CUSTOM']).toBe('from-call')
    } finally {
      if (oldValue === undefined) {
        delete process.env['STAGEWRIGHT_TEST_KEEP']
      } else {
        process.env['STAGEWRIGHT_TEST_KEEP'] = oldValue
      }
    }
  })

  it('rejects launches with no appPath or executablePath', () => {
    expect(() => buildPlaywrightLaunchOptions({})).toThrow(StagewrightError)
    try {
      buildPlaywrightLaunchOptions({})
    } catch (err) {
      expect(err).toBeInstanceOf(StagewrightError)
      if (err instanceof StagewrightError) {
        expect(err.code).toBe('BAD_ARGUMENT')
      }
    }
  })

  it('keeps window ids stable when Playwright window ordering changes', async () => {
    const pageA = createFakePage('A')
    const pageB = createFakePage('B')
    const app = createFakeElectronApp([pageA, pageB])
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
    })

    const session = await transport.launch({ appPath: '/abs/main.js' })
    const firstList = await session.windowsList()
    expect(firstList.map((w) => w.title)).toEqual(['A', 'B'])
    const firstId = firstList[0]?.id
    expect(firstId).toBeDefined()

    app.setPages([pageB, pageA])
    await session.screenshot({ kind: 'id', id: firstId ?? '' })

    expect(pageA.screenshotCalls).toBe(1)
    expect(pageB.screenshotCalls).toBe(0)
  })

  it('waits for the first window before returning a launched session', async () => {
    const app = createFakeElectronApp([createFakePage('A')])
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
    })

    await transport.launch({ appPath: '/abs/main.js' })

    expect(app.firstWindowCalls).toBe(1)
  })

  it('executes main and renderer evaluate bodies with the supplied arg', async () => {
    const app = createFakeElectronApp([createFakePage('A')], { value: 40 })
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
    })

    const session = await transport.launch({ appPath: '/abs/main.js' })
    await expect(
      session.evaluate('main', 'return electronApp.value + arg.delta;', { delta: 2 }),
    ).resolves.toBe(42)
    await expect(session.evaluate('renderer', 'return arg.label;', { label: 'ok' })).resolves.toBe(
      'ok',
    )
  })

  it('forceKill() sends SIGKILL for Playwright-owned sessions and marks them stopped', async () => {
    const app = createFakeElectronApp([createFakePage('A')])
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
    })

    const session = await transport.launch({ appPath: '/abs/main.js' })
    await transport.forceKill(session)
    await transport.forceKill(session)

    expect(app.killSignals).toEqual(['SIGKILL'])
    expect(app.closeCalls).toBe(1)
    await expect(session.windowsList()).rejects.toMatchObject({ code: 'NOT_RUNNING' })
  })

  it('routes interaction methods to the active page with mapped actionability options', async () => {
    const page = createFakePage('A')
    const app = createFakeElectronApp([page])
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
    })
    const session = await transport.launch({ appPath: '/abs/main.js' })

    // { force, timeoutMs } collapses to Playwright's { force, timeout }.
    await session.click('#go', { force: true, timeoutMs: 500 })
    await session.fill('#name', 'Ada', { timeoutMs: 250 })
    await session.hover('#menu')
    await session.setChecked('#agree', true)
    await session.setChecked('#agree', false)
    await session.setInputFiles('#file', ['/abs/a.txt', '/abs/b.txt'], {
      force: true,
      timeoutMs: 125,
    })
    await session.dragTo('#src', '#dst', { force: true })

    expect(page.interactions).toEqual([
      { method: 'click', args: ['#go', { force: true, timeout: 500 }] },
      { method: 'fill', args: ['#name', 'Ada', { timeout: 250 }] },
      { method: 'hover', args: ['#menu', {}] },
      { method: 'check', args: ['#agree', {}] },
      { method: 'uncheck', args: ['#agree', {}] },
      { method: 'setInputFiles', args: ['#file', ['/abs/a.txt', '/abs/b.txt'], { timeout: 125 }] },
      { method: 'dragAndDrop', args: ['#src', '#dst', { force: true }] },
    ])

    expect(session.transport).toBe('playwright-electron')
  })

  it('maps click button + clickCount onto Playwright click options', async () => {
    const page = createFakePage('A')
    const app = createFakeElectronApp([page])
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
    })
    const session = await transport.launch({ appPath: '/abs/main.js' })

    await session.click('#ctx', { button: 'right', clickCount: 2, timeoutMs: 300 })

    expect(page.interactions).toEqual([
      { method: 'click', args: ['#ctx', { timeout: 300, button: 'right', clickCount: 2 }] },
    ])
  })

  it('typeText emits real keystrokes via the selector or the active keyboard', async () => {
    const page = createFakePage('A')
    const app = createFakeElectronApp([page])
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
    })
    const session = await transport.launch({ appPath: '/abs/main.js' })

    await session.typeText('hello', { selector: '#editor', timeoutMs: 200 })
    await session.typeText('world')

    expect(page.interactions).toEqual([
      { method: 'type', args: ['#editor', 'hello', { timeout: 200 }] },
      { method: 'keyboard.type', args: ['world'] },
    ])
  })

  it('returns the resolved values from selectOption', async () => {
    const page = createFakePage('A')
    const app = createFakeElectronApp([page])
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
    })
    const session = await transport.launch({ appPath: '/abs/main.js' })

    await expect(session.selectOption('#sel', ['x', 'y'])).resolves.toEqual(['x', 'y'])
    expect(page.interactions).toEqual([{ method: 'selectOption', args: ['#sel', ['x', 'y'], {}] }])
  })

  it('press targets a selector when given one, else the active keyboard', async () => {
    const page = createFakePage('A')
    const app = createFakeElectronApp([page])
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
    })
    const session = await transport.launch({ appPath: '/abs/main.js' })

    await session.press('Enter', { selector: '#input', timeoutMs: 100 })
    await session.press('Escape')

    expect(page.interactions).toEqual([
      { method: 'press', args: ['#input', 'Enter', { timeout: 100 }] },
      { method: 'keyboard.press', args: ['Escape'] },
    ])
  })

  it('force routes typeText/press through focus + the active keyboard (offscreen editor inputs)', async () => {
    const page = createFakePage('A')
    const app = createFakeElectronApp([page])
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
    })
    const session = await transport.launch({ appPath: '/abs/main.js' })

    // force:true must NOT call page.type/page.press (which enforce visibility and would
    // reject Monaco's aria-hidden textarea); instead focus the selector (focus tolerates
    // non-visible elements) then drive the global keyboard.
    await session.typeText('hi', {
      selector: '.monaco-editor textarea',
      force: true,
      timeoutMs: 300,
    })
    await session.press('Control+A', { selector: '.monaco-editor textarea', force: true })

    expect(page.interactions).toEqual([
      { method: 'focus', args: ['.monaco-editor textarea', { timeout: 300 }] },
      { method: 'keyboard.type', args: ['hi'] },
      { method: 'focus', args: ['.monaco-editor textarea', {}] },
      { method: 'keyboard.press', args: ['Control+A'] },
    ])
  })

  it('force-typing into an input that ignores it returns TYPE_NO_EFFECT (no false ok)', async () => {
    // The selector is inert — it swallows keystrokes (a modern Monaco editor's hidden textarea
    // whose real input is an EditContext element). The content never changes, so the type-effect
    // check must reject instead of reporting success.
    const page = createFakePage('A', { inertSelectors: ['.monaco-editor textarea'] })
    const app = createFakeElectronApp([page])
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
    })
    const session = await transport.launch({ appPath: '/abs/main.js' })

    await expect(
      session.typeText('hello', { selector: '.monaco-editor textarea', force: true }),
    ).rejects.toMatchObject({ code: 'TYPE_NO_EFFECT' })
  })

  it('fill into an input that ignores it returns TYPE_NO_EFFECT', async () => {
    const page = createFakePage('A', { inertSelectors: ['#readonly'] })
    const app = createFakeElectronApp([page])
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
    })
    const session = await transport.launch({ appPath: '/abs/main.js' })

    await expect(session.fill('#readonly', 'value', { force: true })).rejects.toMatchObject({
      code: 'TYPE_NO_EFFECT',
    })
  })

  it('fill that lands (content changes) resolves without error', async () => {
    const page = createFakePage('A')
    const app = createFakeElectronApp([page])
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
    })
    const session = await transport.launch({ appPath: '/abs/main.js' })

    await expect(session.fill('#name', 'Ada')).resolves.toBeUndefined()
  })

  it('force-typing into an editable that accepts it resolves (content lands)', async () => {
    // Force-path success symmetry: when the focused target DOES accept keystrokes (a
    // contenteditable / EditContext content area, modelled here by a non-inert selector whose
    // content grows), the effect check sees the change and reports success — it only rejects a
    // genuine swallow. Without this case, only the failing force path was exercised.
    const page = createFakePage('A')
    const app = createFakeElectronApp([page])
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
    })
    const session = await transport.launch({ appPath: '/abs/main.js' })

    await expect(
      session.typeText('hello', { selector: '#editable', force: true }),
    ).resolves.toBeUndefined()
  })

  it('non-force typing into an input that ignores it returns TYPE_NO_EFFECT', async () => {
    // The non-force path (page.type, real per-character keystrokes) runs the same effect check
    // as the force path — a swallowed keystroke must reject, not report a false success.
    const page = createFakePage('A', { inertSelectors: ['#inert'] })
    const app = createFakeElectronApp([page])
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
    })
    const session = await transport.launch({ appPath: '/abs/main.js' })

    await expect(session.typeText('hello', { selector: '#inert' })).rejects.toMatchObject({
      code: 'TYPE_NO_EFFECT',
    })
  })

  it('typing a selector whose content cannot be read back does not block (null signature)', async () => {
    // A null signature read means the element is gone / unreachable via document.querySelector;
    // the effect check skips rather than risk a spurious TYPE_NO_EFFECT, even though input was
    // routed to it (here keyboard.type after focus). Errs toward not-throwing by design.
    const page = createFakePage('A', { goneSelectors: ['#gone'] })
    const app = createFakeElectronApp([page])
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
    })
    const session = await transport.launch({ appPath: '/abs/main.js' })

    await expect(
      session.typeText('hello', { selector: '#gone', force: true }),
    ).resolves.toBeUndefined()
  })

  it('scrolls via the mouse wheel when no selector is supplied', async () => {
    const page = createFakePage('A')
    const app = createFakeElectronApp([page])
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
    })
    const session = await transport.launch({ appPath: '/abs/main.js' })

    await session.scroll({ dx: 0, dy: 480 })
    await session.scroll({})

    expect(page.interactions).toEqual([
      { method: 'mouse.wheel', args: [0, 480] },
      { method: 'mouse.wheel', args: [0, 0] },
    ])
  })

  it('resolves when scroll-into-view finds the target element', async () => {
    const page = createFakePage('A', { evalResult: true })
    const app = createFakeElectronApp([page])
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
    })
    const session = await transport.launch({ appPath: '/abs/main.js' })

    await expect(session.scroll({ selector: '#present' })).resolves.toBeUndefined()
    // The selector path goes through the renderer, never the wheel.
    expect(page.interactions).toEqual([])
  })

  it('waits up to timeoutMs for scroll-into-view to find the target element', async () => {
    const page = createFakePage('A')
    const app = createFakeElectronApp([page])
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
    })
    const session = await transport.launch({ appPath: '/abs/main.js' })
    const dom = new JSDOM('<main></main>')
    const documentGlobal = globalThis as typeof globalThis & { document?: Document }
    const previousDocument = documentGlobal.document
    let scrolled = false

    documentGlobal.document = dom.window.document
    setTimeout(() => {
      const button = dom.window.document.createElement('button')
      button.id = 'late'
      button.scrollIntoView = () => {
        scrolled = true
      }
      dom.window.document.querySelector('main')?.append(button)
    }, 1)

    try {
      await expect(session.scroll({ selector: '#late', timeoutMs: 100 })).resolves.toBeUndefined()
    } finally {
      if (previousDocument === undefined) {
        delete documentGlobal.document
      } else {
        documentGlobal.document = previousDocument
      }
    }
    expect(scrolled).toBe(true)
  })

  it('rejects with SELECTOR_NO_MATCH when scroll-into-view finds no element', async () => {
    const page = createFakePage('A', { evalResult: false })
    const app = createFakeElectronApp([page])
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
    })
    const session = await transport.launch({ appPath: '/abs/main.js' })

    await expect(session.scroll({ selector: '#missing' })).rejects.toMatchObject({
      code: 'SELECTOR_NO_MATCH',
    })
  })

  it('refuses interaction after the session is disposed', async () => {
    const page = createFakePage('A')
    const app = createFakeElectronApp([page])
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
    })
    const session = await transport.launch({ appPath: '/abs/main.js' })
    await session.dispose()

    await expect(session.click('#go')).rejects.toMatchObject({ code: 'NOT_RUNNING' })
  })
})

describe('CDPTransport', () => {
  const t = new CDPTransport()

  it('declares its capabilities up front', () => {
    expect(t.id).toBe('cdp')
    expect(t.capabilities).toMatchObject({
      canLaunch: false,
      canAttach: true,
      canInject: false,
      canIntercept: true,
      canControlClock: false,
      canAccessStorage: true,
      canAccessNativeUI: false,
      supportsMainEval: true,
      supportsRendererEval: true,
      supportsInteraction: true,
    })
  })

  it('launch() rejects with TRANSPORT_UNSUPPORTED (capability matrix refuses)', async () => {
    await expect(t.launch({ appPath: '/' } as LaunchOptions)).rejects.toMatchObject({
      code: 'TRANSPORT_UNSUPPORTED',
    })
  })

  it('inject() rejects with TRANSPORT_UNSUPPORTED', async () => {
    await expect(t.inject({ pid: 0 } as InjectOptions)).rejects.toMatchObject({
      code: 'TRANSPORT_UNSUPPORTED',
    })
  })

  it('attach() without port or cdpUrl rejects with BAD_ARGUMENT (pid alone is not attachable)', async () => {
    await expect(t.attach({} as AttachOptions)).rejects.toMatchObject({
      code: 'BAD_ARGUMENT',
    })
    await expect(t.attach({ pid: 1234 } as AttachOptions)).rejects.toMatchObject({
      code: 'BAD_ARGUMENT',
    })
  })

  it('stop() and forceKill() on a non-CDP session fall back to dispose()', async () => {
    // The protocol-level behaviour (Browser.close, escalation, the pool) is
    // covered by cdp-transport.test.ts against a fake CDP endpoint.
    await expect(t.stop(FAKE_SESSION, {} as StopOptions)).resolves.toEqual({ escalated: false })
    await expect(t.forceKill(FAKE_SESSION)).resolves.toBeUndefined()
  })
})

describe('InjectorTransport', () => {
  const t = new InjectorTransport()

  it('declares its capabilities up front', () => {
    expect(t.id).toBe('injector')
    expect(t.capabilities).toMatchObject({
      canLaunch: false,
      canAttach: true,
      canInject: true,
      canIntercept: false,
      canControlClock: false,
      canAccessStorage: false,
      canAccessNativeUI: false,
      supportsMainEval: true,
      supportsRendererEval: false,
      supportsInteraction: false,
    })
  })

  it('launch() rejects with TRANSPORT_UNSUPPORTED', async () => {
    await expect(t.launch({ appPath: '/' } as LaunchOptions)).rejects.toMatchObject({
      code: 'TRANSPORT_UNSUPPORTED',
    })
  })

  it('attach() without an endpoint and inject() with an invalid pid reject with BAD_ARGUMENT', async () => {
    await expect(t.attach({} as AttachOptions)).rejects.toMatchObject({
      code: 'BAD_ARGUMENT',
    })
    await expect(t.inject({ pid: 0 } as InjectOptions)).rejects.toMatchObject({
      code: 'BAD_ARGUMENT',
    })
  })
})

describe('assertCapability helper', () => {
  const playwright = new PlaywrightElectronTransport()
  const cdp = new CDPTransport()

  it('returns silently when the transport supports the capability', () => {
    expect(() => assertCapability(playwright, 'canLaunch')).not.toThrow()
    expect(() => assertCapability(cdp, 'canAttach')).not.toThrow()
  })

  it('throws TRANSPORT_UNSUPPORTED with a structured details payload', () => {
    expect(() => assertCapability(playwright, 'canAttach')).toThrow(StagewrightError)
    try {
      assertCapability(playwright, 'canAttach')
    } catch (err) {
      expect(err).toBeInstanceOf(StagewrightError)
      if (err instanceof StagewrightError) {
        expect(err.code).toBe('TRANSPORT_UNSUPPORTED')
        expect(err.details).toEqual({
          transport: 'playwright-electron',
          capability: 'canAttach',
        })
      }
    }
  })
})

describe('capability-vs-method drift (table-driven)', () => {
  // For each transport, we walk its declared capabilities and assert that the
  // refused-method behaviour matches: capability false → method rejects with
  // TRANSPORT_UNSUPPORTED. Positive paths are covered by transport-specific
  // tests with fake Playwright/CDP/Injector endpoints, so this table only pins
  // the refused-when-unsupported path.

  type RefusedMethod = {
    name: string
    invoke: (t: ITransport) => Promise<unknown>
    expectedCap: keyof TransportCapabilities | null
  }

  const refusedMethods: readonly RefusedMethod[] = [
    {
      name: 'launch',
      invoke: (t) => t.launch({ appPath: '/x' }),
      expectedCap: 'canLaunch',
    },
    {
      name: 'attach',
      invoke: (t) => t.attach({}),
      expectedCap: 'canAttach',
    },
    {
      name: 'inject',
      invoke: (t) => t.inject({ pid: 0 }),
      expectedCap: 'canInject',
    },
  ]

  const transports: readonly ITransport[] = [
    new PlaywrightElectronTransport(),
    new CDPTransport(),
    new InjectorTransport(),
  ]

  for (const transport of transports) {
    for (const method of refusedMethods) {
      if (method.expectedCap === null) continue
      const hasCapability = transport.capabilities[method.expectedCap]
      if (hasCapability) {
        // Positive-path methods are exercised by transport-specific tests with
        // fake endpoints. We only pin the refused-when-unsupported path here.
        continue
      }
      it(`${transport.id}.${method.name}() rejects with TRANSPORT_UNSUPPORTED (capability ${method.expectedCap} is false)`, async () => {
        const result = await method.invoke(transport).catch((e) => e)
        expect(result).toBeInstanceOf(StagewrightError)
        if (result instanceof StagewrightError) {
          expect(result.code).toBe('TRANSPORT_UNSUPPORTED')
        }
      })
    }
  }
})

describe('TransportSession idempotent dispose contract (type-level)', () => {
  it('the contract documents dispose() as idempotent', () => {
    // A type-level sanity check that the interface signature is stable.
    // Runtime idempotency needs a real Electron app; the fake here confirms the
    // call signature compiles and a fake implementation treats the second call
    // as a no-op.
    let calls = 0
    const session: TransportSession = {
      ...FAKE_SESSION,
      dispose: async () => {
        if (calls === 0) calls++
      },
    }
    return Promise.all([session.dispose(), session.dispose(), session.dispose()]).then(() => {
      expect(calls).toBe(1)
    })
  })
})

describe('PlaywrightSession console buffer', () => {
  it('captures console messages from the first window for consoleLogs', async () => {
    const page = createFakePage('A')
    const app = createFakeElectronApp([page])
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
    })
    const session = await transport.launch({ appPath: '/abs/main.js' })

    page.emitConsole({ type: 'error', text: 'boom', location: { url: 'app://x', lineNumber: 4 } })
    page.emitConsole({ type: 'log', text: 'ok' })

    const { entries, overflowed } = await session.consoleLogs()
    expect(overflowed).toBe(0)
    expect(entries.map((e) => ({ type: e.type, text: e.text }))).toEqual([
      { type: 'error', text: 'boom' },
      { type: 'log', text: 'ok' },
    ])
    expect(entries[0]?.location).toEqual({ url: 'app://x', line: 4 })
    expect(typeof entries[0]?.timestamp).toBe('number')
  })

  it('drops the oldest entries past the cap and counts the overflow', async () => {
    const page = createFakePage('A')
    const app = createFakeElectronApp([page])
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
    })
    const session = await transport.launch({ appPath: '/abs/main.js' })

    for (let i = 0; i < 1005; i++) page.emitConsole({ type: 'log', text: `m${i}` })

    const { entries, overflowed } = await session.consoleLogs()
    expect(entries).toHaveLength(1000)
    expect(overflowed).toBe(5)
    expect(entries[0]?.text).toBe('m5')
    expect(entries.at(-1)?.text).toBe('m1004')
  })
})

describe('PlaywrightSession network capture', () => {
  // recordRequestFinished awaits the response (fire-and-forget), so let its microtasks settle.
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  async function launchWithPage() {
    const page = createFakePage('A')
    const app = createFakeElectronApp([page])
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
    })
    const session = await transport.launch({ appPath: '/abs/main.js' })
    return { page, session }
  }

  it('records only allowlisted finished requests with response metadata', async () => {
    const { page, session } = await launchWithPage()
    await session.startNetworkCapture({ urls: ['/api/'] })

    page.emitRequestFinished({
      method: 'GET',
      url: 'https://app.test/api/items',
      status: 200,
      requestHeaders: { accept: 'application/json' },
      responseHeaders: { 'content-type': 'application/json' },
      durationMs: 17,
    })
    page.emitRequestFinished({ method: 'GET', url: 'https://cdn.test/logo.png', status: 200 })
    await flush()

    const { events, overflowed } = await session.networkEvents()
    expect(overflowed).toBe(0)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      method: 'GET',
      url: 'https://app.test/api/items',
      resourceType: 'fetch',
      status: 200,
      ok: true,
      requestHeaders: { accept: 'application/json' },
      responseHeaders: { 'content-type': 'application/json' },
      durationMs: 17,
    })
    expect(typeof events[0]?.timestamp).toBe('number')
  })

  it('records a failed request with its failure text and no status', async () => {
    const { page, session } = await launchWithPage()
    await session.startNetworkCapture({ urls: ['/api/'] })
    page.emitRequestFailed({
      method: 'POST',
      url: 'https://app.test/api/save',
      errorText: 'net::ERR_ABORTED',
    })
    await flush()

    const { events } = await session.networkEvents()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      method: 'POST',
      url: 'https://app.test/api/save',
      failure: 'net::ERR_ABORTED',
    })
    expect(events[0]?.status).toBeUndefined()
    expect(events[0]?.ok).toBeUndefined()
  })

  it('restricts capture to the named methods', async () => {
    const { page, session } = await launchWithPage()
    await session.startNetworkCapture({ urls: ['/api/'], methods: ['POST'] })
    page.emitRequestFinished({ method: 'GET', url: 'https://app.test/api/x', status: 200 })
    page.emitRequestFinished({ method: 'POST', url: 'https://app.test/api/x', status: 201 })
    await flush()

    expect((await session.networkEvents()).events.map((e) => e.method)).toEqual(['POST'])
  })

  it('records nothing until armed, and stop disarms and clears', async () => {
    const { page, session } = await launchWithPage()
    // Before arming: ignored (the listeners are attached but inert).
    page.emitRequestFinished({ method: 'GET', url: 'https://app.test/api/early', status: 200 })
    await flush()
    expect((await session.networkEvents()).events).toHaveLength(0)

    await session.startNetworkCapture({ urls: ['/api/'] })
    page.emitRequestFinished({ method: 'GET', url: 'https://app.test/api/live', status: 200 })
    await flush()
    expect((await session.networkEvents()).events).toHaveLength(1)

    // Stop disarms + clears; a later request is ignored and the buffer stays empty.
    await session.stopNetworkCapture()
    expect((await session.networkEvents()).events).toHaveLength(0)
    page.emitRequestFinished({ method: 'GET', url: 'https://app.test/api/after', status: 200 })
    await flush()
    expect((await session.networkEvents()).events).toHaveLength(0)
  })

  it('flushes the buffer when clear is passed and rejects after dispose', async () => {
    const { page, session } = await launchWithPage()
    await session.startNetworkCapture({ urls: ['/api/'] })
    page.emitRequestFinished({ method: 'GET', url: 'https://app.test/api/a', status: 200 })
    await flush()
    expect((await session.networkEvents({ clear: true })).events).toHaveLength(1)
    expect((await session.networkEvents()).events).toHaveLength(0)

    await session.dispose()
    await expect(session.networkEvents()).rejects.toMatchObject({ code: 'NOT_RUNNING' })
  })

  it('drops an in-flight request whose response resolves after stop (no ghost event)', async () => {
    const { page, session } = await launchWithPage()
    await session.startNetworkCapture({ urls: ['/api/'] })
    // recordRequestFinished suspends at `await request.response()`; stop() runs its synchronous body
    // (nulling the filter + clearing the buffer) before that await resolves. The fixed code re-checks
    // the filter after the await and drops the event, so it never lands in the cleared buffer.
    page.emitRequestFinished({ method: 'GET', url: 'https://app.test/api/inflight', status: 200 })
    await session.stopNetworkCapture()
    await flush()
    expect((await session.networkEvents()).events).toHaveLength(0)
  })

  it('captures request and response bodies when captureBodies is on (text content type)', async () => {
    const { page, session } = await launchWithPage()
    await session.startNetworkCapture({ urls: ['/api/'], captureBodies: true })
    page.emitRequestFinished({
      method: 'POST',
      url: 'https://app.test/api/save',
      status: 200,
      requestHeaders: { 'content-type': 'application/json' },
      postData: '{"name":"ada"}',
      responseHeaders: { 'content-type': 'application/json; charset=utf-8' },
      responseBody: '{"ok":true}',
    })
    await flush()
    const [event] = (await session.networkEvents()).events
    expect(event).toMatchObject({
      requestBody: '{"name":"ada"}',
      requestBodyBytes: 14,
      responseBody: '{"ok":true}',
      responseBodyBytes: 11,
    })
    expect(event?.requestBodyTruncated).toBeUndefined()
    expect(event?.responseBodyTruncated).toBeUndefined()
    // invariant A1: the body fields round-trip through JSON (string/number, no Buffer leak).
    expect(JSON.parse(JSON.stringify(event))).toEqual(event)
  })

  it('records only the byte length in size-only mode (no body content)', async () => {
    const { page, session } = await launchWithPage()
    await session.startNetworkCapture({ urls: ['/api/'], captureBodies: 'size' })
    page.emitRequestFinished({
      method: 'GET',
      url: 'https://app.test/api/items',
      status: 200,
      responseHeaders: { 'content-type': 'application/json' },
      responseBody: '[1,2,3]',
    })
    await flush()
    const [event] = (await session.networkEvents()).events
    expect(event?.responseBodyBytes).toBe(7)
    expect(event?.responseBody).toBeUndefined()
    expect(event?.responseBodyTruncated).toBeUndefined()
  })

  it('truncates an oversize body to maxBodyBytes and reports the true size', async () => {
    const { page, session } = await launchWithPage()
    await session.startNetworkCapture({ urls: ['/api/'], captureBodies: true, maxBodyBytes: 4 })
    page.emitRequestFinished({
      method: 'GET',
      url: 'https://app.test/api/big',
      status: 200,
      responseHeaders: { 'content-type': 'text/plain' },
      responseBody: 'abcdefgh',
    })
    await flush()
    const [event] = (await session.networkEvents()).events
    expect(event?.responseBodyBytes).toBe(8)
    expect(event?.responseBodyTruncated).toBe(true)
    expect(event?.responseBody).toBe('abcd…[+4 bytes truncated]')
  })

  it('skips the body for a non-text content type', async () => {
    const { page, session } = await launchWithPage()
    await session.startNetworkCapture({ urls: ['/api/'], captureBodies: true })
    page.emitRequestFinished({
      method: 'GET',
      url: 'https://app.test/api/logo',
      status: 200,
      responseHeaders: { 'content-type': 'image/png' },
      responseBody: 'PNGDATA',
    })
    await flush()
    const [event] = (await session.networkEvents()).events
    expect(event?.responseBody).toBeUndefined()
    expect(event?.responseBodyBytes).toBeUndefined()
  })

  it('captures no body when captureBodies is not set', async () => {
    const { page, session } = await launchWithPage()
    await session.startNetworkCapture({ urls: ['/api/'] })
    page.emitRequestFinished({
      method: 'GET',
      url: 'https://app.test/api/x',
      status: 200,
      responseHeaders: { 'content-type': 'application/json' },
      responseBody: '{"a":1}',
    })
    await flush()
    const [event] = (await session.networkEvents()).events
    expect(event?.responseBody).toBeUndefined()
    expect(event?.responseBodyBytes).toBeUndefined()
  })

  it('records the event without a body when the body read throws', async () => {
    const { page, session } = await launchWithPage()
    await session.startNetworkCapture({ urls: ['/api/'], captureBodies: true })
    page.emitRequestFinished({
      method: 'GET',
      url: 'https://app.test/api/x',
      status: 200,
      responseHeaders: { 'content-type': 'application/json' },
      responseBodyThrows: true,
    })
    await flush()
    const { events } = await session.networkEvents()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ url: 'https://app.test/api/x', status: 200 })
    expect(events[0]?.responseBody).toBeUndefined()
  })

  it('drops an event whose body read finishes after stop (no ghost event)', async () => {
    const { page, session } = await launchWithPage()
    await session.startNetworkCapture({ urls: ['/api/'], captureBodies: true })
    // The fake awaits onBodyRead INSIDE response.body(); stopping there exercises the post-body-await
    // filter re-check, so the resolved event never lands in the cleared buffer.
    page.emitRequestFinished({
      method: 'GET',
      url: 'https://app.test/api/inflight',
      status: 200,
      responseHeaders: { 'content-type': 'application/json' },
      responseBody: '{"a":1}',
      onBodyRead: () => session.stopNetworkCapture(),
    })
    await flush()
    expect((await session.networkEvents()).events).toHaveLength(0)
  })

  it('honours a bodyContentTypes override', async () => {
    const { page, session } = await launchWithPage()
    await session.startNetworkCapture({
      urls: ['/api/'],
      captureBodies: true,
      bodyContentTypes: ['application/custom'],
    })
    // The default text-ish types are now excluded; only the override matches.
    page.emitRequestFinished({
      method: 'GET',
      url: 'https://app.test/api/json',
      status: 200,
      responseHeaders: { 'content-type': 'application/json' },
      responseBody: '{"a":1}',
    })
    page.emitRequestFinished({
      method: 'GET',
      url: 'https://app.test/api/custom',
      status: 200,
      responseHeaders: { 'content-type': 'application/custom' },
      responseBody: 'CUSTOM',
    })
    await flush()
    const events = (await session.networkEvents()).events
    expect(events.find((e) => e.url.endsWith('/json'))?.responseBody).toBeUndefined()
    expect(events.find((e) => e.url.endsWith('/custom'))?.responseBody).toBe('CUSTOM')
  })

  it('captures the request body on a failed request', async () => {
    const { page, session } = await launchWithPage()
    await session.startNetworkCapture({ urls: ['/api/'], captureBodies: true })
    page.emitRequestFailed({
      method: 'POST',
      url: 'https://app.test/api/save',
      requestHeaders: { 'content-type': 'application/json' },
      postData: '{"x":1}',
      errorText: 'net::ERR_ABORTED',
    })
    await flush()
    const [event] = (await session.networkEvents()).events
    expect(event).toMatchObject({
      failure: 'net::ERR_ABORTED',
      requestBody: '{"x":1}',
      requestBodyBytes: 7,
    })
  })
})

describe('PlaywrightSession network stubbing', () => {
  async function launchWithPage() {
    const page = createFakePage('A')
    const app = createFakeElectronApp([page])
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
    })
    const session = await transport.launch({ appPath: '/abs/main.js' })
    return { page, session }
  }

  it('fulfills a matching request with the canned response and continues a non-match', async () => {
    const { page, session } = await launchWithPage()
    await session.stubNetwork({
      urls: ['/api/'],
      fulfill: { status: 503, contentType: 'application/json', body: '{"down":true}' },
    })

    const hit = await page.emitRoute({ url: 'https://app.test/api/items', method: 'GET' })
    expect(hit.fulfilled).toMatchObject({
      status: 503,
      contentType: 'application/json',
      body: '{"down":true}',
    })
    expect(hit.aborted).toBeUndefined()

    const miss = await page.emitRoute({ url: 'https://cdn.test/logo.png' })
    expect(miss.continued).toBe(true)
    expect(miss.fulfilled).toBeUndefined()
  })

  it('aborts a matching request when the stub specifies abort', async () => {
    const { page, session } = await launchWithPage()
    await session.stubNetwork({ urls: ['/api/'], abort: 'failed' })
    const hit = await page.emitRoute({ url: 'https://app.test/api/x' })
    expect(hit.aborted).toBe('failed')
    expect(hit.fulfilled).toBeUndefined()
  })

  it('restricts a stub to the named methods', async () => {
    const { page, session } = await launchWithPage()
    await session.stubNetwork({ urls: ['/api/'], methods: ['POST'], fulfill: { status: 201 } })
    expect((await page.emitRoute({ url: 'https://app.test/api/x', method: 'GET' })).continued).toBe(
      true,
    )
    expect(
      (await page.emitRoute({ url: 'https://app.test/api/x', method: 'POST' })).fulfilled,
    ).toBeDefined()
  })

  it('expires a stub after `times` uses, then detaches the catch-all route', async () => {
    const { page, session } = await launchWithPage()
    await session.stubNetwork({ urls: ['/api/'], fulfill: { status: 200 }, times: 1 })
    expect((await page.emitRoute({ url: 'https://app.test/api/x' })).fulfilled).toBeDefined()
    // Second hit: the one-shot stub is spent and no other stubs remain, so the route is removed and
    // the request goes live without even paying Playwright's interception/cache-disabling cost.
    expect((await page.emitRoute({ url: 'https://app.test/api/x' })).intercepted).toBe(false)
  })

  it('keeps the route attached while another stub remains active', async () => {
    const { page, session } = await launchWithPage()
    await session.stubNetwork({ urls: ['/api/a'], fulfill: { status: 201 }, times: 1 })
    await session.stubNetwork({ urls: ['/api/b'], fulfill: { status: 202 } })

    expect((await page.emitRoute({ url: 'https://app.test/api/a' })).fulfilled).toMatchObject({
      status: 201,
    })
    expect((await page.emitRoute({ url: 'https://app.test/api/a' })).continued).toBe(true)
    expect((await page.emitRoute({ url: 'https://app.test/api/b' })).fulfilled).toMatchObject({
      status: 202,
    })
  })

  it('clears all stubs and unroutes, so later requests are not intercepted', async () => {
    const { page, session } = await launchWithPage()
    await session.stubNetwork({ urls: ['/api/'], fulfill: { status: 200 } })
    await session.clearNetworkStubs()
    // The catch-all route was removed; the request would go live (no interceptor attached).
    expect((await page.emitRoute({ url: 'https://app.test/api/x' })).intercepted).toBe(false)
  })

  it('clears only the named stub when a url is passed (granular unstub)', async () => {
    const { page, session } = await launchWithPage()
    await session.stubNetwork({ urls: ['/api/a'], fulfill: { status: 201 } })
    await session.stubNetwork({ urls: ['/api/b'], fulfill: { status: 202 } })
    await session.clearNetworkStubs('/api/a')

    // /api/a now goes live; /api/b is still stubbed (the interceptor stays attached).
    expect((await page.emitRoute({ url: 'https://app.test/api/a' })).continued).toBe(true)
    expect((await page.emitRoute({ url: 'https://app.test/api/b' })).fulfilled).toMatchObject({
      status: 202,
    })
  })

  it('applies delayMs and still fulfills', async () => {
    const { page, session } = await launchWithPage()
    await session.stubNetwork({ urls: ['/api/'], fulfill: { status: 200 }, delayMs: 1 })
    expect((await page.emitRoute({ url: 'https://app.test/api/x' })).fulfilled).toBeDefined()
  })
})

describe('PlaywrightSession clock control', () => {
  async function launchWithPage() {
    const page = createFakePage('A')
    const app = createFakeElectronApp([page])
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
    })
    const session = await transport.launch({ appPath: '/abs/main.js' })
    return { page, session }
  }

  it('maps each clock seam method onto the page.clock call', async () => {
    const { page, session } = await launchWithPage()
    await session.installClock({ time: '2026-01-01T00:00:00Z' })
    await session.setFixedTime(1000)
    await session.setSystemTime(2000)
    await session.advanceClock(5000)
    await session.runClockFor(250)
    await session.pauseClockAt(9000)
    await session.resumeClock()
    expect(page.clockCalls).toEqual([
      { method: 'install', arg: '2026-01-01T00:00:00Z' },
      { method: 'setSystemTime', arg: 1000 },
      { method: 'pauseAt', arg: 1000 },
      { method: 'setSystemTime', arg: 2000 },
      { method: 'resume' },
      { method: 'fastForward', arg: 5000 },
      { method: 'runFor', arg: 250 },
      { method: 'pauseAt', arg: 9000 },
      { method: 'resume' },
    ])
  })

  it('installs with no initial time when none is given', async () => {
    const { page, session } = await launchWithPage()
    await session.installClock()
    expect(page.clockCalls).toEqual([{ method: 'install' }])
  })

  it('rejects clock ops after dispose', async () => {
    const { session } = await launchWithPage()
    await session.dispose()
    await expect(session.installClock()).rejects.toMatchObject({ code: 'NOT_RUNNING' })
    await expect(session.advanceClock(1)).rejects.toMatchObject({ code: 'NOT_RUNNING' })
  })
})

describe('PlaywrightSession storage access', () => {
  async function launchWithPage() {
    const page = createFakePage('A')
    const app = createFakeElectronApp([page])
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
    })
    const session = await transport.launch({ appPath: '/abs/main.js' })
    return { page, session }
  }

  it('sets a cookie through the context (addCookies) verbatim', async () => {
    const { page, session } = await launchWithPage()
    await session.setCookie({ name: 'auth', value: 'tok', url: 'https://app.example.com' })
    expect(page.cookieStore).toEqual([
      { name: 'auth', value: 'tok', url: 'https://app.example.com' },
    ])
  })

  it('reads cookies and applies the name filter', async () => {
    const { page, session } = await launchWithPage()
    await page.context().addCookies([
      { name: 'auth', value: 'a', domain: 'app.example.com', path: '/' },
      { name: 'theme', value: 'dark', domain: 'app.example.com', path: '/' },
    ])
    expect(await session.getCookies()).toHaveLength(2)
    expect(await session.getCookies({ name: 'auth' })).toEqual([
      { name: 'auth', value: 'a', domain: 'app.example.com', path: '/' },
    ])
  })

  it('clears all cookies when no filter is given', async () => {
    const { page, session } = await launchWithPage()
    await page.context().addCookies([{ name: 'auth', value: 'a' }])
    await session.clearCookies()
    expect(page.cookieStore).toEqual([])
    expect(page.clearCookiesCalls).toEqual([{}])
  })

  it('clears one cookie by name', async () => {
    const { page, session } = await launchWithPage()
    await page.context().addCookies([
      { name: 'auth', value: 'a' },
      { name: 'theme', value: 'dark' },
    ])
    await session.clearCookies({ name: 'auth' })
    expect(page.cookieStore.map((c) => c.name)).toEqual(['theme'])
    expect(page.clearCookiesCalls).toEqual([{ name: 'auth' }])
  })

  it('clears a url-scoped cookie precisely by name/domain/path (no URL option on clearCookies)', async () => {
    const { page, session } = await launchWithPage()
    await page
      .context()
      .addCookies([{ name: 'auth', value: 'a', domain: 'app.example.com', path: '/' }])
    await session.clearCookies({ urls: ['https://app.example.com'] })
    // The url-scoped branch reads the matching cookies and clears each by its precise key.
    expect(page.clearCookiesCalls).toEqual([{ name: 'auth', domain: 'app.example.com', path: '/' }])
  })

  it('maps the storage state into the snapshot (cookies + origins)', async () => {
    const { page, session } = await launchWithPage()
    await page.context().addCookies([{ name: 'auth', value: 'a', domain: 'app.example.com' }])
    page.setStorageOrigins([
      { origin: 'https://app.example.com', localStorage: [{ name: 'cart', value: '3-items' }] },
    ])
    expect(await session.storageSnapshot()).toEqual({
      cookies: [{ name: 'auth', value: 'a', domain: 'app.example.com' }],
      origins: [
        { origin: 'https://app.example.com', localStorage: [{ name: 'cart', value: '3-items' }] },
      ],
    })
  })

  it('rejects storage ops after dispose', async () => {
    const { session } = await launchWithPage()
    await session.dispose()
    await expect(session.getCookies()).rejects.toMatchObject({ code: 'NOT_RUNNING' })
    await expect(
      session.setCookie({ name: 'a', value: 'b', url: 'https://x.example' }),
    ).rejects.toMatchObject({ code: 'NOT_RUNNING' })
    await expect(session.clearCookies()).rejects.toMatchObject({ code: 'NOT_RUNNING' })
    await expect(session.storageSnapshot()).rejects.toMatchObject({ code: 'NOT_RUNNING' })
  })
})

describe('PlaywrightSession native UI', () => {
  // A fake Electron application menu shaped like Menu.getApplicationMenu()'s return: items carry data
  // fields plus a `click` handler and a `commandId` internal ref that the serializer MUST drop.
  function fakeAppMenu() {
    return {
      items: [
        {
          label: 'Edit',
          type: 'submenu',
          enabled: true,
          visible: true,
          commandId: 42,
          submenu: {
            items: [
              {
                label: 'Undo',
                role: 'undo',
                type: 'normal',
                enabled: true,
                visible: true,
                accelerator: 'CmdOrCtrl+Z',
                click: () => undefined,
              },
              { label: '', type: 'separator', enabled: true, visible: true },
              {
                label: 'Spellcheck',
                type: 'checkbox',
                enabled: true,
                visible: true,
                checked: true,
              },
              { label: 'Writing Tools', type: 'header', enabled: true, visible: true },
              { label: 'Palette', type: 'palette', enabled: true, visible: true },
              { label: 'Paste', role: 'paste', type: 'normal', enabled: false, visible: true },
            ],
          },
        },
      ],
    }
  }

  async function launchWithMenu(electronModule: unknown) {
    const app = createFakeElectronApp([createFakePage('A')], electronModule)
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
    })
    const session = await transport.launch({ appPath: '/abs/main.js' })
    return { session }
  }

  it('serializes the application menu, dropping handlers and internal refs', async () => {
    const { session } = await launchWithMenu({ Menu: { getApplicationMenu: () => fakeAppMenu() } })
    const menu = await session.getApplicationMenu()
    expect(menu).toEqual({
      items: [
        {
          label: 'Edit',
          type: 'submenu',
          enabled: true,
          visible: true,
          submenu: [
            {
              label: 'Undo',
              role: 'undo',
              type: 'normal',
              enabled: true,
              visible: true,
              accelerator: 'CmdOrCtrl+Z',
            },
            { label: '', type: 'separator', enabled: true, visible: true },
            { label: 'Spellcheck', type: 'checkbox', enabled: true, visible: true, checked: true },
            { label: 'Writing Tools', type: 'header', enabled: true, visible: true },
            { label: 'Palette', type: 'palette', enabled: true, visible: true },
            { label: 'Paste', role: 'paste', type: 'normal', enabled: false, visible: true },
          ],
        },
      ],
    })
    // The click handler and the commandId internal ref are gone — the payload is pure JSON.
    expect(JSON.parse(JSON.stringify(menu))).toEqual(menu)
    expect(menu?.items[0]).not.toHaveProperty('commandId')
    expect(menu?.items[0]?.submenu?.[0]).not.toHaveProperty('click')
  })

  it('returns null when the app has no application menu', async () => {
    const { session } = await launchWithMenu({ Menu: { getApplicationMenu: () => null } })
    expect(await session.getApplicationMenu()).toBeNull()
  })

  it('returns null when the electron module exposes no Menu', async () => {
    const { session } = await launchWithMenu({})
    expect(await session.getApplicationMenu()).toBeNull()
  })

  it('rejects getApplicationMenu after dispose', async () => {
    const { session } = await launchWithMenu({ Menu: { getApplicationMenu: () => fakeAppMenu() } })
    await session.dispose()
    await expect(session.getApplicationMenu()).rejects.toMatchObject({ code: 'NOT_RUNNING' })
  })

  // A live menu whose click handlers push to `record`, plus a disabled item, a role item, a separator,
  // a no-handler item, and a throwing item — one instance reused across invokes so `record` accumulates.
  function fakeInvokeMenu(
    record: string[],
    clickArgs: { event: unknown; window: unknown; webContents: unknown }[],
  ) {
    // Electron MenuItem instances always expose a click wrapper. When an app supplied a click option,
    // the click property keeps the option slot before Electron's default fields; default-only wrappers
    // appear at the end. These fakes mirror that observable shape so `no_handler` stays covered.
    const save = {
      label: 'Save',
      click: (event: unknown, window: unknown, webContents: unknown) => {
        record.push('Save')
        clickArgs.push({ event, window, webContents })
      },
      submenu: null,
      type: 'normal',
      role: null,
      enabled: true,
      visible: true,
      checked: false,
      commandId: 1,
      userAccelerator: null,
    }
    const inertDefaultClick = {
      label: 'DefaultClick',
      submenu: null,
      type: 'normal',
      role: null,
      enabled: true,
      visible: true,
      checked: false,
      commandId: 2,
      userAccelerator: null,
      click: () => record.push('DefaultClick'),
    }
    return {
      items: [
        {
          label: 'File',
          type: 'submenu',
          enabled: true,
          submenu: {
            items: [
              save,
              {
                label: 'Locked',
                type: 'normal',
                enabled: false,
                click: () => record.push('Locked'),
              },
              {
                label: '',
                type: 'separator',
                enabled: true,
                click: () => record.push('Separator'),
              },
              { label: 'Inert', type: 'normal', enabled: true },
              inertDefaultClick,
              {
                label: 'Boom',
                type: 'normal',
                enabled: true,
                click: () => {
                  throw new Error('boom')
                },
              },
            ],
          },
        },
        {
          label: 'Help',
          type: 'submenu',
          enabled: true,
          submenu: {
            items: [
              {
                label: 'Quit',
                role: 'quit',
                type: 'normal',
                enabled: true,
                click: () => record.push('Quit'),
              },
            ],
          },
        },
      ],
    }
  }

  async function launchWithInvokeMenu() {
    const record: string[] = []
    const clickArgs: { event: unknown; window: unknown; webContents: unknown }[] = []
    const focusedWebContents = { id: 'focused-web-contents' }
    const focusedWindow = { webContents: focusedWebContents }
    const menu = fakeInvokeMenu(record, clickArgs)
    const { session } = await launchWithMenu({
      Menu: { getApplicationMenu: () => menu },
      BrowserWindow: {
        getFocusedWindow: () => focusedWindow,
        getAllWindows: () => [focusedWindow],
      },
    })
    return { session, record, clickArgs, focusedWindow, focusedWebContents }
  }

  it('invokes an app-defined click handler and echoes the resolved item', async () => {
    const { session, record, clickArgs, focusedWindow, focusedWebContents } =
      await launchWithInvokeMenu()
    expect(await session.invokeApplicationMenuItem(['File', 'Save'])).toEqual({
      invoked: true,
      label: 'Save',
    })
    expect(record).toEqual(['Save'])
    expect(clickArgs).toHaveLength(1)
    expect(clickArgs[0]?.event).toEqual({})
    expect(clickArgs[0]?.window).toBe(focusedWindow)
    expect(clickArgs[0]?.webContents).toBe(focusedWebContents)
  })

  it('falls back to the first app window when no window is focused', async () => {
    const record: string[] = []
    const clickArgs: { event: unknown; window: unknown; webContents: unknown }[] = []
    const firstWebContents = { id: 'first-web-contents' }
    const firstWindow = { webContents: firstWebContents }
    const menu = fakeInvokeMenu(record, clickArgs)
    const { session } = await launchWithMenu({
      Menu: { getApplicationMenu: () => menu },
      BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [firstWindow] },
    })

    expect(await session.invokeApplicationMenuItem(['File', 'Save'])).toEqual({
      invoked: true,
      label: 'Save',
    })
    expect(record).toEqual(['Save'])
    expect(clickArgs[0]?.window).toBe(firstWindow)
    expect(clickArgs[0]?.webContents).toBe(firstWebContents)
  })

  it('refuses a disabled item without firing its handler', async () => {
    const { session, record } = await launchWithInvokeMenu()
    expect(await session.invokeApplicationMenuItem(['File', 'Locked'])).toEqual({
      invoked: false,
      reason: 'disabled',
    })
    expect(record).toEqual([])
  })

  it('classifies the no-handler refusals (role / submenu / separator / no_handler / not_found)', async () => {
    const { session, record } = await launchWithInvokeMenu()
    expect(await session.invokeApplicationMenuItem(['Help', 'quit'])).toEqual({
      invoked: false,
      reason: 'role',
    })
    expect(await session.invokeApplicationMenuItem(['File'])).toEqual({
      invoked: false,
      reason: 'submenu',
    })
    expect(await session.invokeApplicationMenuItem(['File', ''])).toEqual({
      invoked: false,
      reason: 'separator',
    })
    expect(await session.invokeApplicationMenuItem(['File', 'Inert'])).toEqual({
      invoked: false,
      reason: 'no_handler',
    })
    expect(await session.invokeApplicationMenuItem(['File', 'DefaultClick'])).toEqual({
      invoked: false,
      reason: 'no_handler',
    })
    expect(await session.invokeApplicationMenuItem(['File', 'Nope'])).toEqual({
      invoked: false,
      reason: 'not_found',
    })
    expect(record).toEqual([])
  })

  it('surfaces a throwing handler as a clean error', async () => {
    const { session } = await launchWithInvokeMenu()
    await expect(session.invokeApplicationMenuItem(['File', 'Boom'])).rejects.toThrow(
      /menu item handler threw/,
    )
  })

  it('returns not_found when the app has no application menu', async () => {
    const { session } = await launchWithMenu({ Menu: { getApplicationMenu: () => null } })
    expect(await session.invokeApplicationMenuItem(['File'])).toEqual({
      invoked: false,
      reason: 'not_found',
    })
  })

  it('rejects invokeApplicationMenuItem after dispose', async () => {
    const { session } = await launchWithInvokeMenu()
    await session.dispose()
    await expect(session.invokeApplicationMenuItem(['File', 'Save'])).rejects.toMatchObject({
      code: 'NOT_RUNNING',
    })
  })
})

describe('PlaywrightSession dialog handling', () => {
  // The dialog listener is fire-and-forget (`void handleDialog`), so a macrotask
  // tick lets its microtasks settle before we assert. The fake dialog's
  // accept/dismiss resolve synchronously and real dialogs are modal (a new one
  // cannot arrive until the current resolves), so a single tick is sufficient;
  // multi-dialog tests still flush between emits to keep ordering deterministic.
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  async function launchWithPage() {
    const page = createFakePage('A')
    const app = createFakeElectronApp([page])
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
    })
    const session = await transport.launch({ appPath: '/abs/main.js' })
    return { page, session }
  }

  it('dismisses by default and records the event so dialogs never hang', async () => {
    const { page, session } = await launchWithPage()
    const record = page.emitDialog({ type: 'confirm', message: 'proceed?' })
    await flush()
    expect(record.dismissed).toBe(true)
    expect(record.accepted).toBe(false)

    const { entries, policy } = await session.dialogEvents()
    expect(policy).toEqual({ action: 'dismiss' })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ type: 'confirm', message: 'proceed?', action: 'dismiss' })
    expect(typeof entries[0]?.timestamp).toBe('number')
  })

  it('accepts when armed and submits promptText to prompt() dialogs', async () => {
    const { page, session } = await launchWithPage()
    await session.setDialogPolicy({ action: 'accept', promptText: 'LIC-123' })

    const promptRec = page.emitDialog({ type: 'prompt', message: 'key?', defaultValue: 'x' })
    const confirmRec = page.emitDialog({ type: 'confirm', message: 'ok?' })
    await flush()

    expect(promptRec.accepted).toBe(true)
    expect(promptRec.promptText).toBe('LIC-123')
    // promptText is only meaningful for prompt(); confirm accepts without it.
    expect(confirmRec.accepted).toBe(true)
    expect(confirmRec.promptText).toBeUndefined()

    const { entries } = await session.dialogEvents()
    expect(entries[0]).toMatchObject({
      type: 'prompt',
      action: 'accept',
      defaultValue: 'x',
      promptText: 'LIC-123',
    })
    expect(entries[1]).toMatchObject({ type: 'confirm', action: 'accept' })
    expect(entries[1]?.promptText).toBeUndefined()
  })

  it('honours per-type overrides, falling back to the default action', async () => {
    const { page, session } = await launchWithPage()
    await session.setDialogPolicy({
      action: 'accept',
      perType: { beforeunload: 'dismiss' },
    })

    const confirmRec = page.emitDialog({ type: 'confirm', message: 'ok?' })
    const beforeRec = page.emitDialog({ type: 'beforeunload', message: 'leave?' })
    await flush()

    expect(confirmRec.accepted).toBe(true)
    expect(beforeRec.dismissed).toBe(true)
  })

  it('reverts to dismiss after one dialog when oneShot is set', async () => {
    const { page, session } = await launchWithPage()
    await session.setDialogPolicy({ action: 'accept', oneShot: true })

    const first = page.emitDialog({ type: 'confirm', message: 'first?' })
    await flush()
    const second = page.emitDialog({ type: 'confirm', message: 'second?' })
    await flush()

    expect(first.accepted).toBe(true)
    expect(second.dismissed).toBe(true)
    const { policy } = await session.dialogEvents()
    expect(policy).toEqual({ action: 'dismiss' })
  })

  it('returns a defensive copy of the active dialog policy', async () => {
    const { page, session } = await launchWithPage()
    await session.setDialogPolicy({ action: 'accept', perType: { confirm: 'dismiss' } })

    const observed = await session.dialogEvents()
    const observedPolicy = observed.policy as { perType: Record<string, string> }
    observedPolicy.perType['confirm'] = 'accept'

    const record = page.emitDialog({ type: 'confirm', message: 'should stay dismissed' })
    await flush()

    expect(record.dismissed).toBe(true)
    expect(record.accepted).toBe(false)
  })

  it('drops the oldest events past the cap and counts the overflow', async () => {
    const { page, session } = await launchWithPage()
    for (let i = 0; i < 205; i++) page.emitDialog({ type: 'alert', message: `d${i}` })
    await flush()

    const { entries, overflowed } = await session.dialogEvents()
    expect(entries).toHaveLength(200)
    expect(overflowed).toBe(5)
    expect(entries[0]?.message).toBe('d5')
    expect(entries.at(-1)?.message).toBe('d204')
  })

  it('clears the buffer after reading when asked', async () => {
    const { page, session } = await launchWithPage()
    page.emitDialog({ type: 'alert', message: 'hi' })
    await flush()

    const first = await session.dialogEvents({ clear: true })
    expect(first.entries).toHaveLength(1)
    const second = await session.dialogEvents()
    expect(second.entries).toHaveLength(0)
    expect(second.overflowed).toBe(0)
  })

  it('rejects dialog methods after dispose with NOT_RUNNING', async () => {
    const { session } = await launchWithPage()
    await session.dispose()
    await expect(session.dialogEvents()).rejects.toMatchObject({ code: 'NOT_RUNNING' })
    await expect(session.setDialogPolicy({ action: 'accept' })).rejects.toMatchObject({
      code: 'NOT_RUNNING',
    })
  })

  it('survives a malformed dialog handle and keeps capturing later dialogs', async () => {
    const { page, session } = await launchWithPage()
    // A throwing getter would otherwise become an unhandled rejection (the listener
    // is fire-and-forget) and crash the process under Node's default policy. vitest
    // surfaces unhandled rejections as failures, so this also guards the `.catch()`.
    page.emitDialog({ type: 'confirm', message: 'boom', throwOnRead: true })
    await flush()
    page.emitDialog({ type: 'alert', message: 'ok' })
    await flush()

    const { entries } = await session.dialogEvents()
    // The broken dialog was not recorded (it threw before push); the next one was.
    expect(entries.map((e) => e.type)).toEqual(['alert'])
  })
})

describe('PlaywrightSession multi-window capture', () => {
  function launchWith(pages: ReturnType<typeof createFakePage>[]) {
    const app = createFakeElectronApp(pages)
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
    })
    return { app, launch: () => transport.launch({ appPath: '/abs/main.js' }) }
  }

  it('captures console and dialogs from later windows, attributed by windowId', async () => {
    const pageA = createFakePage('A')
    const { app, launch } = launchWith([pageA])
    const session = await launch()

    const pageB = createFakePage('B')
    app.emitWindow(pageB)

    pageA.emitConsole({ type: 'log', text: 'from A' })
    pageB.emitConsole({ type: 'warning', text: 'from B' })
    const recordB = pageB.emitDialog({ type: 'confirm', message: 'close B?' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const windows = await session.windowsList()
    const { entries } = await session.consoleLogs()
    expect(entries.map((e) => ({ text: e.text, windowId: e.windowId }))).toEqual([
      { text: 'from A', windowId: windows[0]?.id },
      { text: 'from B', windowId: windows[1]?.id },
    ])
    // The dialog from the SECOND window was auto-resolved and recorded too.
    expect(recordB.dismissed).toBe(true)
    const dialogs = await session.dialogEvents()
    expect(dialogs.entries[0]).toMatchObject({ message: 'close B?', windowId: windows[1]?.id })
  })

  it('attaches capture to a window exactly once even when re-announced', async () => {
    const pageA = createFakePage('A')
    const { app, launch } = launchWith([pageA])
    const session = await launch()

    // Playwright can hand the same page through windows() AND the window event;
    // the capture set must dedupe or every message doubles.
    app.emitWindow(pageA)
    pageA.emitConsole({ type: 'log', text: 'once' })

    const { entries } = await session.consoleLogs()
    expect(entries).toHaveLength(1)
  })
})

describe('PlaywrightSession stop escalation', () => {
  it('escalates to SIGKILL when the graceful close exceeds its budget', async () => {
    const app = createFakeElectronApp([createFakePage('A')], { value: 1 }, { hangClose: true })
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
    })
    const session = await transport.launch({ appPath: '/abs/main.js' })

    const result = await transport.stop(session, { timeoutMs: 40 })

    expect(result).toEqual({ escalated: true })
    expect(app.killSignals).toEqual(['SIGKILL'])
    // The session is released regardless of the hung close.
    await expect(session.windowsList()).rejects.toMatchObject({ code: 'NOT_RUNNING' })
  })

  it('does not escalate when the close resolves within the budget', async () => {
    const app = createFakeElectronApp([createFakePage('A')])
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
    })
    const session = await transport.launch({ appPath: '/abs/main.js' })

    await expect(transport.stop(session, { timeoutMs: 1000 })).resolves.toEqual({
      escalated: false,
    })
    expect(app.killSignals).toEqual([])
    expect(app.closeCalls).toBe(1)
  })

  it('a second stop after an escalation is a no-op that reports no escalation', async () => {
    const app = createFakeElectronApp([createFakePage('A')], { value: 1 }, { hangClose: true })
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
    })
    const session = await transport.launch({ appPath: '/abs/main.js' })

    await expect(transport.stop(session, { timeoutMs: 40 })).resolves.toEqual({ escalated: true })
    await expect(transport.stop(session, { timeoutMs: 40 })).resolves.toEqual({ escalated: false })
    expect(app.killSignals).toEqual(['SIGKILL'])
  })
})

describe('PlaywrightSession window recovery (activePage)', () => {
  it('recovers when the known window list empties and later repopulates', async () => {
    const pageA = createFakePage('A')
    const app = createFakeElectronApp([pageA])
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
      windowRecoveryBudgetMs: 2000,
    })
    const session = await transport.launch({ appPath: '/abs/main.js' })

    // Seen after an in-page modal confirm: Playwright momentarily drops the page
    // from windows() and firstWindow() would block on a window event that never
    // fires. The page then re-registers WITHOUT an event.
    app.setPages([])
    setTimeout(() => app.setPages([pageA]), 150)

    await expect(session.click('#go')).resolves.toBeUndefined()
    expect(pageA.interactions.at(-1)).toMatchObject({ method: 'click' })
  })

  it('fails with REF_NOT_FOUND when no window reappears within the budget', async () => {
    const app = createFakeElectronApp([createFakePage('A')])
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
      windowRecoveryBudgetMs: 150,
    })
    const session = await transport.launch({ appPath: '/abs/main.js' })

    app.setPages([])

    await expect(session.click('#go')).rejects.toMatchObject({ code: 'REF_NOT_FOUND' })
  })
})

describe('network body helpers', () => {
  it('captureBodyField: returns the full body under the cap, no truncation', () => {
    const result = captureBodyField(Buffer.from('hello', 'utf8'), true, 64)
    expect(result).toEqual({ body: 'hello', bytes: 5, truncated: false })
  })

  it('captureBodyField: an exact-cap body is not truncated', () => {
    const result = captureBodyField(Buffer.from('abcd', 'utf8'), true, 4)
    expect(result).toEqual({ body: 'abcd', bytes: 4, truncated: false })
  })

  it('captureBodyField: truncates by BYTES and appends the dropped-byte marker', () => {
    const result = captureBodyField(Buffer.from('abcdefgh', 'utf8'), true, 4)
    expect(result).toEqual({ body: 'abcd…[+4 bytes truncated]', bytes: 8, truncated: true })
  })

  it('captureBodyField: size mode reports byte length only (no text)', () => {
    // "café" is 5 bytes (é is 2) — the byte count is honest even for multibyte content.
    const result = captureBodyField(Buffer.from('café', 'utf8'), 'size', 4)
    expect(result).toEqual({ bytes: 5, truncated: false })
    expect(result.body).toBeUndefined()
  })

  it('bodyContentTypeAllowed: matches text-ish types and rejects binary / absent', () => {
    const allow = ['application/json', 'text/', 'xml']
    expect(bodyContentTypeAllowed('application/json; charset=utf-8', allow)).toBe(true)
    expect(bodyContentTypeAllowed('TEXT/HTML', allow)).toBe(true)
    expect(bodyContentTypeAllowed('image/png', allow)).toBe(false)
    expect(bodyContentTypeAllowed(undefined, allow)).toBe(false)
    expect(bodyContentTypeAllowed('application/json', [])).toBe(false)
  })

  it('headerValue: case-insensitive lookup', () => {
    expect(headerValue({ 'Content-Type': 'text/plain' }, 'content-type')).toBe('text/plain')
    expect(headerValue({ 'content-type': 'application/json' }, 'Content-Type')).toBe(
      'application/json',
    )
    expect(headerValue({ accept: '*/*' }, 'content-type')).toBeUndefined()
  })

  it('DEFAULT_BODY_CONTENT_TYPES: captures vendor/problem JSON media types', () => {
    expect(bodyContentTypeAllowed('application/problem+json', DEFAULT_BODY_CONTENT_TYPES)).toBe(
      true,
    )
    expect(bodyContentTypeAllowed('application/vnd.api+json', DEFAULT_BODY_CONTENT_TYPES)).toBe(
      true,
    )
  })
})
