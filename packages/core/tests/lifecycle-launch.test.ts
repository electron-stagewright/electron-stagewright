/**
 * Unit tests for `electron_launch` (driven through the dispatcher against a fake
 * transport) and the `diagnoseLaunchError` helper. Covers preflight, the
 * single-instance guard, error diagnosis, the returned window list, session
 * registration, and wire-serialisability.
 */

import path from 'node:path'

import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

import { type ErrorResponse, type SuccessResponse } from '../src/errors/envelope.js'
import { StagewrightError } from '../src/errors/registry.js'
import type { ProjectElectronResolution } from '../src/runtime/project-electron.js'
import type { ElectronLaunchFuseInspection } from '../src/runtime/electron-fuses.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { TransportRegistry } from '../src/server/transport-registry.js'
import { diagnoseLaunchError } from '../src/tools/lifecycle/diagnose.js'
import { makeLaunchTool } from '../src/tools/lifecycle/launch.js'
import type { LaunchOptions, WindowDescriptor } from '../src/transports/index.js'
import { FakeSession, FakeTransport } from './helpers/fake-transport.js'

const WIN: WindowDescriptor = {
  id: 'w0',
  index: 0,
  title: 'Main',
  url: 'app://index',
  visible: true,
  focused: true,
}

function setup(
  opts: {
    fileExists?: boolean
    transport?: FakeTransport
    packagedTransport?: FakeTransport
    appRoot?: string
    launchDefaultMain?: string
    resolveProjectElectron?: (appRoot: string) => Promise<ProjectElectronResolution>
    inspectElectronFuses?: (
      executablePath: string,
    ) => Promise<ElectronLaunchFuseInspection | undefined>
  } = {},
) {
  const sessions = new SessionManager()
  const transport =
    opts.transport ??
    new FakeTransport({ session: new FakeSession({ id: 'launched', windows: [WIN] }) })
  const packagedTransport =
    opts.packagedTransport ??
    new FakeTransport({
      id: 'cdp',
      session: new FakeSession({ id: 'packaged', transport: 'cdp', windows: [WIN] }),
    })
  const dispatcher = new Dispatcher({
    sessions,
    transports: new TransportRegistry({ transports: [transport, packagedTransport] }),
    ...(opts.appRoot !== undefined ? { appRoot: opts.appRoot } : {}),
    ...(opts.launchDefaultMain !== undefined ? { launchDefaultMain: opts.launchDefaultMain } : {}),
  })
  dispatcher.register(
    makeLaunchTool({
      fileExists: () => opts.fileExists ?? true,
      ...(opts.resolveProjectElectron !== undefined
        ? { resolveProjectElectron: opts.resolveProjectElectron }
        : {}),
      ...(opts.inspectElectronFuses !== undefined
        ? { inspectElectronFuses: opts.inspectElectronFuses }
        : {}),
    }),
  )
  return { sessions, transport, packagedTransport, dispatcher }
}

class CapturingTransport extends FakeTransport {
  lastLaunchOptions: LaunchOptions | undefined

  override async launch(opts?: LaunchOptions) {
    this.lastLaunchOptions = opts
    return super.launch(opts)
  }
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

  it('uses a server-configured default entry when the call omits main and executablePath', async () => {
    const { dispatcher, transport } = setup({ launchDefaultMain: '/demo/main.js' })
    await expect(dispatcher.dispatch('electron_launch', {})).resolves.toMatchObject({ ok: true })
    expect(transport.launchCount).toBe(1)
  })

  it('does not add the configured default entry to an explicit executable-only launch', async () => {
    const { dispatcher, transport } = setup({ launchDefaultMain: '/demo/main.js' })
    const res = (await dispatcher.dispatch('electron_launch', {
      executablePath: '/abs/App.app/Contents/MacOS/App',
      instrumentNative: true,
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
    expect(res.error).toContain('instrumentNative requires main')
    expect(transport.launchCount).toBe(0)
  })

  it('requires an operator-configured app root before selecting the project runtime', async () => {
    const { dispatcher, transport } = setup()
    const res = (await dispatcher.dispatch('electron_launch', {
      main: '/abs/main.js',
      runtime: 'project',
    })) as ErrorResponse

    expect(res.code).toBe('BAD_ARGUMENT')
    expect(res.error).toContain('--app-root')
    expect(transport.launchCount).toBe(0)
  })

  it('resolves and forwards the app-root Electron runtime', async () => {
    const root = path.resolve('sw-project-runtime-fixture')
    const transport = new CapturingTransport({
      session: new FakeSession({ id: 'project-runtime', windows: [WIN] }),
    })
    const resolveProjectElectron = async (appRoot: string): Promise<ProjectElectronResolution> => {
      expect(appRoot).toBe(root)
      return {
        ok: true,
        electron: {
          executablePath: path.join(root, 'node_modules', 'electron', 'dist', 'electron'),
          packageJsonPath: path.join(root, 'node_modules', 'electron', 'package.json'),
          version: '42.3.0',
        },
      }
    }
    const { dispatcher } = setup({ appRoot: root, transport, resolveProjectElectron })

    const res = await dispatcher.dispatch('electron_launch', {
      main: path.join(root, 'app', 'main.js'),
      runtime: 'project',
    })

    expect(res).toMatchObject({ ok: true, runtime_source: 'project' })
    expect(transport.lastLaunchOptions).toMatchObject({
      appPath: path.join(root, 'app', 'main.js'),
      executablePath: path.join(root, 'node_modules', 'electron', 'dist', 'electron'),
    })
  })

  it('accepts the canonical project binary when the configured root uses a filesystem alias', async () => {
    const configuredRoot = path.resolve('sw-project-runtime-alias')
    const canonicalRoot = path.resolve('sw-project-runtime-canonical')
    const transport = new CapturingTransport({
      session: new FakeSession({ id: 'project-alias', windows: [WIN] }),
    })
    const { dispatcher } = setup({
      appRoot: configuredRoot,
      transport,
      resolveProjectElectron: async () => ({
        ok: true,
        rootPath: canonicalRoot,
        electron: {
          executablePath: path.join(canonicalRoot, 'node_modules', 'electron', 'dist', 'electron'),
          packageJsonPath: path.join(canonicalRoot, 'node_modules', 'electron', 'package.json'),
        },
      }),
    })

    const res = await dispatcher.dispatch('electron_launch', {
      main: path.join(configuredRoot, 'main.js'),
      runtime: 'project',
    })

    expect(res).toMatchObject({ ok: true, runtime_source: 'project' })
    expect(transport.lastLaunchOptions?.executablePath).toBe(
      path.join(canonicalRoot, 'node_modules', 'electron', 'dist', 'electron'),
    )
  })

  it('keeps an explicit executable authoritative over the requested project runtime', async () => {
    let resolverCalled = false
    const { dispatcher, transport, packagedTransport } = setup({
      resolveProjectElectron: async () => {
        resolverCalled = true
        return { ok: false, message: 'must not run' }
      },
    })
    const res = await dispatcher.dispatch('electron_launch', {
      executablePath: '/abs/explicit-electron',
      runtime: 'project',
    })

    expect(res).toMatchObject({ ok: true, runtime_source: 'explicit' })
    expect(resolverCalled).toBe(false)
    expect(transport.launchCount).toBe(0)
    expect(packagedTransport.launchCount).toBe(1)
  })

  it('routes an executable-only packaged app through CDP without inspecting Playwright fuses', async () => {
    const executablePath = '/abs/App.app/Contents/MacOS/App'
    let inspected = false
    const { dispatcher, transport, packagedTransport } = setup({
      inspectElectronFuses: async () => {
        inspected = true
        return undefined
      },
    })

    const res = await dispatcher.dispatch('electron_launch', {
      executablePath,
    })

    expect(res).toMatchObject({
      ok: true,
      transport: 'cdp',
      runtime_source: 'explicit',
      launch_mode: 'packaged',
      capabilities: packagedTransport.capabilities,
    })
    expect(inspected).toBe(false)
    expect(transport.launchCount).toBe(0)
    expect(packagedTransport.launchCount).toBe(1)
  })

  it('forwards the packaged credential-store policy to CDP and rejects it for development launch', async () => {
    const packagedTransport = new CapturingTransport({
      id: 'cdp',
      session: new FakeSession({ id: 'packaged-policy', transport: 'cdp', windows: [WIN] }),
    })
    const { dispatcher, transport } = setup({ packagedTransport })

    await expect(
      dispatcher.dispatch('electron_launch', {
        executablePath: '/abs/App.app/Contents/MacOS/App',
        credentialStore: 'system',
      }),
    ).resolves.toMatchObject({ ok: true, launch_mode: 'packaged' })
    expect(packagedTransport.lastLaunchOptions).toMatchObject({
      executablePath: '/abs/App.app/Contents/MacOS/App',
      credentialStore: 'system',
    })
    expect(transport.launchCount).toBe(0)

    const development = (await setup().dispatcher.dispatch('electron_launch', {
      main: '/abs/main.js',
      credentialStore: 'testing',
    })) as ErrorResponse
    expect(development).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
    expect(development.error).toContain('executable-only packaged launches')
  })

  it('reports TRANSPORT_UNSUPPORTED when the packaged CDP launcher is unavailable', async () => {
    const transport = new FakeTransport({
      session: new FakeSession({ id: 'development-only', windows: [WIN] }),
    })
    const sessions = new SessionManager()
    const dispatcher = new Dispatcher({
      sessions,
      transports: new TransportRegistry({ transports: [transport] }),
    })
    dispatcher.register(makeLaunchTool({ fileExists: () => true }))

    const res = (await dispatcher.dispatch('electron_launch', {
      executablePath: '/abs/App.app/Contents/MacOS/App',
    })) as ErrorResponse
    expect(res).toMatchObject({
      ok: false,
      code: 'TRANSPORT_UNSUPPORTED',
      details: { transport: 'cdp', capability: 'canLaunch' },
    })
    expect(transport.launchCount).toBe(0)
  })

  it('refuses a main-based launch whose selected runtime blocks Playwright inspect', async () => {
    const executablePath = '/abs/custom-electron'
    const { dispatcher, transport } = setup({
      inspectElectronFuses: async (pathToElectron) => {
        expect(pathToElectron).toBe(executablePath)
        return {
          version: '1',
          run_as_node: 'disabled',
          node_cli_inspect_arguments: 'disabled',
          blocks_playwright_launch: true,
        }
      },
    })

    const res = (await dispatcher.dispatch('electron_launch', {
      main: '/abs/main.js',
      executablePath,
    })) as ErrorResponse

    expect(res).toMatchObject({
      ok: false,
      code: 'FUSES_BLOCK_LAUNCH',
      retryable: false,
      next_actions: expect.arrayContaining([
        expect.stringContaining('electron_launch'),
        expect.stringContaining('electron_attach'),
        expect.stringContaining('development Electron build'),
      ]),
    })
    expect(transport.launchCount).toBe(0)
  })

  it('does not block a main-based launch when fuse compatibility cannot be established', async () => {
    const { dispatcher, transport } = setup({
      inspectElectronFuses: async () => undefined,
    })

    const res = await dispatcher.dispatch('electron_launch', {
      main: '/abs/main.js',
      executablePath: '/abs/custom-electron',
    })

    expect(res).toMatchObject({
      ok: true,
      runtime_source: 'explicit',
      launch_mode: 'development',
    })
    expect(transport.launchCount).toBe(1)
  })

  it('requires main before resolving a project runtime', async () => {
    let resolverCalled = false
    const { dispatcher, transport } = setup({
      appRoot: path.resolve('sw-project-runtime-fixture'),
      resolveProjectElectron: async () => {
        resolverCalled = true
        return { ok: false, message: 'must not run' }
      },
    })
    const res = (await dispatcher.dispatch('electron_launch', {
      runtime: 'project',
    })) as ErrorResponse

    expect(res.code).toBe('BAD_ARGUMENT')
    expect(res.error).toContain('requires main')
    expect(resolverCalled).toBe(false)
    expect(transport.launchCount).toBe(0)
  })

  it('rejects a readyTimeoutMs above the dispatch backstop cap (BAD_ARGUMENT)', async () => {
    const { dispatcher, transport } = setup()
    // Above 60s the renderer-ready wait could outlast the 120s dispatch backstop and turn a
    // successful launch into a retryable OPERATION_TIMEOUT; the schema caps it instead.
    const res = (await dispatcher.dispatch('electron_launch', {
      main: '/abs/main.js',
      readyTimeoutMs: 120_000,
    })) as ErrorResponse
    expect(res.ok).toBe(false)
    expect(res.code).toBe('BAD_ARGUMENT')
    expect(transport.launchCount).toBe(0)
  })

  it('refuses a runtime-altering env key before spawning (ELECTRON_RUN_AS_NODE)', async () => {
    const { dispatcher, transport } = setup()
    const res = (await dispatcher.dispatch('electron_launch', {
      main: '/abs/main.js',
      env: { ELECTRON_RUN_AS_NODE: '1' },
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
    expect(res.error).toContain('ELECTRON_RUN_AS_NODE')
    expect(transport.launchCount).toBe(0) // refused before any process is spawned
  })

  it('refuses loader-injection env keys (NODE_OPTIONS, LD_PRELOAD, DYLD_INSERT_LIBRARIES)', async () => {
    for (const key of ['NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES']) {
      const { dispatcher, transport } = setup()
      const res = (await dispatcher.dispatch('electron_launch', {
        main: '/abs/main.js',
        env: { [key]: 'x' },
      })) as ErrorResponse
      expect(res.code, key).toBe('BAD_ARGUMENT')
      expect(transport.launchCount, key).toBe(0)
    }
  })

  it('allows a benign application env var', async () => {
    const { dispatcher, transport } = setup()
    const res = await dispatcher.dispatch('electron_launch', {
      main: '/abs/main.js',
      env: { MY_APP_CONFIG: 'staging' },
    })
    expect((res as SuccessResponse).ok).toBe(true)
    expect(transport.launchCount).toBe(1)
  })

  it('refuses a launch past the concurrent-session cap even with allowMultiple', async () => {
    const { sessions, dispatcher, transport } = setup()
    // Pre-fill to the cap (16) with distinct live sessions, then attempt one more.
    for (let i = 0; i < 16; i += 1) {
      sessions.register(new FakeTransport(), new FakeSession({ id: `pre-${i}`, windows: [WIN] }))
    }
    const res = (await dispatcher.dispatch('electron_launch', {
      main: '/abs/main.js',
      allowMultiple: true,
    })) as ErrorResponse
    expect(res.code).toBe('ALREADY_RUNNING')
    expect(res.error).toContain('Maximum concurrent sessions')
    expect(transport.launchCount).toBe(0) // refused before spawning
  })

  it('allows a launch whose main is inside --app-root', async () => {
    const root = path.resolve('sw-approot-fixture')
    const { dispatcher, transport } = setup({ appRoot: root })
    const res = (await dispatcher.dispatch('electron_launch', {
      main: path.join(root, 'app', 'main.js'),
    })) as SuccessResponse
    expect(res.ok).toBe(true)
    expect(transport.launchCount).toBe(1)
  })

  it('refuses an executablePath outside --app-root (arbitrary-binary launch)', async () => {
    const root = path.resolve('sw-approot-fixture')
    const { dispatcher, transport } = setup({ appRoot: root })
    const res = (await dispatcher.dispatch('electron_launch', {
      executablePath: '/usr/bin/python3',
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
    expect(res.error).toContain('app-root')
    expect(transport.launchCount).toBe(0) // refused before spawning
  })

  it('refuses a main that traverses outside --app-root', async () => {
    const root = path.resolve('sw-approot-fixture')
    const { dispatcher, transport } = setup({ appRoot: root })
    const res = (await dispatcher.dispatch('electron_launch', {
      main: path.join(root, '..', 'evil', 'main.js'),
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
    expect(res.error).toContain('app-root')
    expect(transport.launchCount).toBe(0)
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

  it('retries transient packaged-target churn within the renderer-ready budget', async () => {
    let evaluateCount = 0
    const session = new FakeSession({
      id: 'packaged',
      transport: 'cdp',
      windows: [WIN],
      evaluate: async () => {
        evaluateCount += 1
        if (evaluateCount === 1) {
          throw new StagewrightError('REF_NOT_FOUND', 'The initial page target was replaced.')
        }
        return { ready: true }
      },
    })
    const packagedTransport = new FakeTransport({ id: 'cdp', session })
    const { dispatcher } = setup({ packagedTransport })

    const res = await dispatcher.dispatch('electron_launch', {
      executablePath: '/abs/App.app/Contents/MacOS/App',
      readyTimeoutMs: 1000,
    })

    expect(res).toMatchObject({ ok: true, renderer_ready: true })
    expect(evaluateCount).toBe(2)
  })

  it('does not retry permanent renderer evaluation errors', async () => {
    let evaluateCount = 0
    const session = new FakeSession({
      id: 'launched',
      windows: [WIN],
      evaluate: async () => {
        evaluateCount += 1
        throw new StagewrightError('EVAL_RUNTIME_ERROR', 'The readiness probe threw.')
      },
    })
    const transport = new FakeTransport({ session })
    const { dispatcher } = setup({ transport })

    const res = await dispatcher.dispatch('electron_launch', {
      main: '/abs/main.js',
      readyTimeoutMs: 1000,
    })

    expect(res).toMatchObject({ ok: true, renderer_ready: false })
    expect(evaluateCount).toBe(1)
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

  it('rejects instrumentNative without a main entry', async () => {
    const { dispatcher, transport } = setup()
    const res = await dispatcher.dispatch('electron_launch', {
      executablePath: '/abs/App.app/Contents/MacOS/App',
      instrumentNative: true,
    })
    expect((res as ErrorResponse).code).toBe('BAD_ARGUMENT')
    expect((res as ErrorResponse).error).toContain('instrumentNative requires main')
    expect(transport.launchCount).toBe(0)
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
