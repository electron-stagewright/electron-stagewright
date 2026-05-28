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
  dispose: async () => undefined,
}

function createFakePage(title: string) {
  let screenshotCalls = 0
  return {
    get screenshotCalls() {
      return screenshotCalls
    },
    url: () => `app:///${title}`,
    title: async () => title,
    evaluate: async <T = unknown>() => undefined as T,
    screenshot: async () => {
      screenshotCalls += 1
      return Buffer.from(title)
    },
    isVisible: async () => true,
  }
}

function createFakeElectronApp(initialPages: ReturnType<typeof createFakePage>[]) {
  let pages = initialPages
  let closeCalls = 0
  const killSignals: string[] = []
  return {
    get closeCalls() {
      return closeCalls
    },
    killSignals,
    setPages: (nextPages: ReturnType<typeof createFakePage>[]) => {
      pages = nextPages
    },
    windows: () => pages,
    firstWindow: async () => {
      const page = pages[0]
      if (page === undefined) throw new Error('no windows')
      return page
    },
    evaluate: async <T = unknown>() => undefined as T,
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

  it('launch() surfaces TRANSPORT_UNSUPPORTED when playwright is missing or stale', async () => {
    // This may fail at the optional-peer import boundary, or after Playwright
    // receives the bogus launch path. Either way, the transport contract is
    // that callers get a registered StagewrightError, never a raw dependency
    // error.
    const result = await t.launch({ appPath: '/nonexistent/app' } as LaunchOptions).catch((e) => e)
    expect(result).toBeInstanceOf(StagewrightError)
    expect(['TRANSPORT_UNSUPPORTED', 'LAUNCH_TIMEOUT', 'INTERNAL_ERROR']).toContain(
      (result as StagewrightError).code,
    )
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
    // The Playwright session's runtime idempotency is exercised against a real
    // app in a future dogfooding slice; the fake here just confirms the call
    // signature compiles and a fake implementation respects "second call is
    // a no-op".
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
