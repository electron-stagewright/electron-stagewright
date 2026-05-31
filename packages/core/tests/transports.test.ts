/**
 * Unit tests for the transport abstraction. The slice ships one functional
 * transport (PlaywrightElectronTransport) plus two stubs (CDPTransport,
 * InjectorTransport). These tests cover:
 *
 * - Capability matrix inspection (every transport declares its caps explicitly).
 * - Table-driven capability-vs-method drift detection (every method whose
 *   capability is `false` rejects with `TRANSPORT_UNSUPPORTED`; stubbed methods
 *   surface `NOT_IMPLEMENTED`).
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
import { buildPlaywrightLaunchOptions } from '../src/transports/playwright-electron.js'

const FAKE_SESSION: TransportSession = {
  id: 'fake-session',
  transport: 'playwright-electron',
  ipc: { transport: 'playwright-electron' },
  console: { transport: 'playwright-electron' },
  evaluate: async () => undefined as unknown,
  screenshot: async () => Buffer.alloc(0),
  windowsList: async () => [],
  consoleLogs: async () => ({ entries: [], overflowed: 0 }),
  click: async () => undefined,
  fill: async () => undefined,
  hover: async () => undefined,
  press: async () => undefined,
  selectOption: async (_selector, values) => values,
  setChecked: async () => undefined,
  setInputFiles: async () => undefined,
  dragTo: async () => undefined,
  scroll: async () => undefined,
  dispose: async () => undefined,
}

function createFakePage(title: string, opts: { evalResult?: unknown } = {}) {
  let screenshotCalls = 0
  // Records every interaction method invocation, in order, so tests can assert
  // PlaywrightSession routed the call to the right page method with the mapped
  // actionability options ({ force, timeoutMs } -> { force, timeout }).
  const interactions: { readonly method: string; readonly args: readonly unknown[] }[] = []
  const consoleHandlers: ((message: unknown) => void)[] = []
  return {
    get screenshotCalls() {
      return screenshotCalls
    },
    interactions,
    url: () => `app:///${title}`,
    title: async () => title,
    evaluate: async <T = unknown>(
      fn: (payload: { readonly body: string; readonly arg?: unknown }) => T | Promise<T>,
      arg?: { readonly body: string; readonly arg?: unknown },
    ) => {
      // The scroll-into-view body queries `document`, which does not exist in the
      // Node test environment. When a test supplies `evalResult`, short-circuit to
      // it so the transport's found/not-found handling can be exercised without a
      // DOM (the real renderer execution is covered by the gated Electron smoke).
      if (opts.evalResult !== undefined) return opts.evalResult as T
      if (arg === undefined) return undefined as T
      return fn(arg)
    },
    screenshot: async () => {
      screenshotCalls += 1
      return Buffer.from(title)
    },
    isVisible: async () => true,
    click: async (selector: string, opts?: unknown) => {
      interactions.push({ method: 'click', args: [selector, opts] })
    },
    fill: async (selector: string, value: string, opts?: unknown) => {
      interactions.push({ method: 'fill', args: [selector, value, opts] })
    },
    hover: async (selector: string, opts?: unknown) => {
      interactions.push({ method: 'hover', args: [selector, opts] })
    },
    press: async (selector: string, key: string, opts?: unknown) => {
      interactions.push({ method: 'press', args: [selector, key, opts] })
    },
    type: async (selector: string, text: string, opts?: unknown) => {
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
        interactions.push({ method: 'keyboard.type', args: [text] })
      },
    },
    mouse: {
      wheel: async (deltaX: number, deltaY: number) => {
        interactions.push({ method: 'mouse.wheel', args: [deltaX, deltaY] })
      },
    },
    // Console-event capture: store the listener and expose an emitter so tests
    // can drive PlaywrightSession's console buffer without a real renderer.
    consoleHandlers,
    on(event: 'console', handler: (message: unknown) => void) {
      if (event === 'console') consoleHandlers.push(handler)
    },
    emitConsole(message: { type: string; text: string; location?: unknown }) {
      const msg = {
        type: () => message.type,
        text: () => message.text,
        location: () => message.location ?? {},
      }
      for (const handler of consoleHandlers) handler(msg)
    },
  }
}

function createFakeElectronApp(
  initialPages: ReturnType<typeof createFakePage>[],
  electronModule: unknown = { value: 3 },
) {
  let pages = initialPages
  let closeCalls = 0
  let firstWindowCalls = 0
  const killSignals: string[] = []
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
      ) => T | Promise<T>,
      arg?: { readonly body: string; readonly arg?: unknown },
    ) => {
      if (arg === undefined) return undefined as T
      return fn(electronModule, arg)
    },
    close: async () => {
      closeCalls += 1
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
      canIntercept: false,
      canControlClock: false,
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
    await expect(t.stop(FAKE_SESSION)).resolves.toBeUndefined()
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

  it('scrolls via the mouse wheel when no selector is supplied', async () => {
    const page = createFakePage('A')
    const app = createFakeElectronApp([page])
    const transport = new PlaywrightElectronTransport({
      loadElectron: async () => ({ launch: async () => app }),
    })
    const session = await transport.launch({ appPath: '/abs/main.js' })

    await session.scroll({ dx: 0, dy: 480 })
    await session.scroll()

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
      canControlClock: true,
      supportsMainEval: true,
      supportsRendererEval: true,
      supportsInteraction: false,
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

  it('attach() rejects with NOT_IMPLEMENTED (capability claimed but body deferred)', async () => {
    await expect(t.attach({} as AttachOptions)).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
    })
  })

  it('stop() and forceKill() reject with NOT_IMPLEMENTED', async () => {
    await expect(t.stop(FAKE_SESSION, {} as StopOptions)).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
    })
    await expect(t.forceKill(FAKE_SESSION)).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
    })
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

  it('attach() and inject() reject with NOT_IMPLEMENTED', async () => {
    await expect(t.attach({} as AttachOptions)).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
    })
    await expect(t.inject({ pid: 0 } as InjectOptions)).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
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
  // TRANSPORT_UNSUPPORTED. The Playwright transport's positive paths (canLaunch
  // returning a real session) require a live Electron app, so we exercise only
  // the refused path on it; the stubs are exercised fully.

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
        // Positive-path methods are exercised by transport-specific tests above
        // (attach/inject for stubs surface NOT_IMPLEMENTED; launch for the real
        // Playwright transport is too heavyweight for unit tests). We only pin
        // the refused-when-unsupported path here.
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
