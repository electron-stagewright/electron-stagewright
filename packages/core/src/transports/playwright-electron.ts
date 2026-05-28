/**
 * PlaywrightElectronTransport — the default, uses Playwright's experimental
 * `_electron.launch()` API. Playwright is declared as an OPTIONAL peer
 * dependency, so this module never imports it statically; the SDK is loaded
 * lazily inside `launch()`. Consumers that install `@electron-stagewright/core`
 * without `playwright` can still import the package and inspect the capability
 * matrix; only invoking `launch()` will surface a `TRANSPORT_UNSUPPORTED` error
 * with a clear remediation hint.
 *
 * ## Capability decisions (deviation from PLAN.md noted)
 *
 * - `canLaunch: true` — Playwright `_electron.launch()` is the primary purpose.
 * - `canAttach: false` — Playwright's `_electron` does NOT expose an attach API
 *   in the published surface; attach is provided by CDPTransport instead. This
 *   deviates from PLAN.md's blanket "all capabilities except canIntercept and
 *   canControlClock return true" because attach has no upstream implementation
 *   to call into. The deviation is documented in the ADR.
 * - `canInject: false` — Injector is its own transport.
 * - `canIntercept: false` — Network/IPC interception ships with the future
 *   network-plugin slice; the Playwright transport will expose `page.route()`
 *   then but not yet.
 * - `canControlClock: false` — Clock control ships with the future clock-plugin
 *   slice.
 * - `supportsMainEval: true` — `electronApp.evaluate()`.
 * - `supportsRendererEval: true` — `page.evaluate()`.
 *
 * @module
 */

import { randomUUID } from 'node:crypto'

import { StagewrightError } from '../errors/registry.js'
import type {
  AttachOptions,
  ConsoleStream,
  ITransport,
  InjectOptions,
  IpcChannel,
  LaunchOptions,
  ScreenshotOptions,
  StopOptions,
  TransportCapabilities,
  TransportId,
  TransportSession,
  WindowDescriptor,
  WindowRef,
} from './types.js'

const TRANSPORT_ID: TransportId = 'playwright-electron'

/**
 * Local opaque interfaces describing the slice of Playwright's API we use. We
 * avoid `import type { ElectronApplication } from 'playwright'` because the
 * optional peerDep may not be installed at typecheck time on consumer projects.
 */
interface PWPage {
  url(): string
  title(): Promise<string>
  evaluate<T = unknown>(fn: string, arg?: unknown): Promise<T>
  screenshot(opts?: {
    fullPage?: boolean
    clip?: ScreenshotOptions['clip']
    type?: 'png' | 'jpeg'
    quality?: number
  }): Promise<Buffer>
  isVisible(selector: string): Promise<boolean>
}

interface PWElectronApp {
  windows(): readonly PWPage[]
  firstWindow(): Promise<PWPage>
  evaluate<T = unknown>(fn: string, arg?: unknown): Promise<T>
  close(): Promise<void>
  process(): { pid: number | undefined; kill(signal: string): boolean }
}

interface PWElectron {
  launch(opts: {
    executablePath?: string
    args?: readonly string[]
    cwd?: string
    env?: Record<string, string>
    timeout?: number
  }): Promise<PWElectronApp>
}

interface PWModule {
  _electron?: PWElectron
  default?: { _electron?: PWElectron }
}

export interface PlaywrightElectronTransportOptions {
  readonly loadElectron?: () => Promise<PWElectron>
}

export interface PlaywrightLaunchOptions {
  readonly executablePath?: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: Record<string, string>
  readonly timeout?: number
}

async function loadPlaywrightElectron(): Promise<PWElectron> {
  let mod: PWModule
  try {
    mod = (await import('playwright')) as PWModule
  } catch (cause) {
    throw new StagewrightError(
      'TRANSPORT_UNSUPPORTED',
      'Playwright peer dependency is not installed. Install with: pnpm add -D playwright',
      {
        transport: TRANSPORT_ID,
        cause: cause instanceof Error ? cause.message : String(cause),
      },
    )
  }
  const electron = mod._electron ?? mod.default?._electron
  if (!electron) {
    throw new StagewrightError(
      'TRANSPORT_UNSUPPORTED',
      'The installed playwright build does not expose the experimental _electron API. Upgrade to playwright >= 1.49.',
      { transport: TRANSPORT_ID },
    )
  }
  return electron
}

function mergeEnv(
  env: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  if (env === undefined) return undefined
  const base = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  return { ...base, ...env }
}

export function buildPlaywrightLaunchOptions(opts: LaunchOptions): PlaywrightLaunchOptions {
  if (opts.appPath === undefined && opts.executablePath === undefined) {
    throw new StagewrightError('BAD_ARGUMENT', 'launch requires appPath or executablePath.', {
      transport: TRANSPORT_ID,
    })
  }

  const args = opts.appPath !== undefined ? [opts.appPath, ...(opts.args ?? [])] : opts.args
  const env = mergeEnv(opts.env)

  return {
    ...(opts.executablePath !== undefined ? { executablePath: opts.executablePath } : {}),
    ...(args !== undefined ? { args } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
  }
}

class PlaywrightSession implements TransportSession {
  public readonly id: string
  public readonly transport: TransportId = TRANSPORT_ID
  public readonly ipc: IpcChannel = { transport: TRANSPORT_ID }
  public readonly console: ConsoleStream = { transport: TRANSPORT_ID }

  private app: PWElectronApp | null
  private disposed = false
  private readonly windowIds = new WeakMap<PWPage, string>()
  private nextWindowId = 0

  constructor(app: PWElectronApp) {
    this.id = `pw-${randomUUID()}`
    this.app = app
  }

  private requireRunning(): PWElectronApp {
    if (this.disposed || this.app === null) {
      throw new StagewrightError(
        'NOT_RUNNING',
        'PlaywrightElectronTransport session has been disposed.',
        {
          transport: TRANSPORT_ID,
          sessionId: this.id,
        },
      )
    }
    return this.app
  }

  async evaluate<T = unknown>(
    target: 'main' | 'renderer',
    body: string,
    arg?: unknown,
  ): Promise<T> {
    const app = this.requireRunning()
    // Playwright's electronApp.evaluate and page.evaluate both call the page
    // function with positional arguments. Main process: pageFunction(electronApp, arg).
    // Renderer: pageFunction(arg). We wrap the agent-supplied body in a function
    // string with the correct positional parameter names so the body can reference
    // `electronApp` (main) or `arg` (both) directly.
    //
    // Security note: this transport does NOT validate body content. The dispatcher
    // is responsible for calling validateEvalContent (see errors/operation-type.ts)
    // before invoking this method. Direct callers (tests, application code) that
    // bypass the dispatcher inherit the responsibility for validating untrusted
    // payloads. The real eval_main/eval_renderer tool implementations will land a
    // more robust protocol than string concatenation; tracked for the read+wait+eval
    // tool slice.
    if (target === 'main') {
      const wrapped = `async (electronApp, arg) => { ${body} }`
      return app.evaluate<T>(wrapped, arg)
    }
    const page = await app.firstWindow()
    const wrapped = `async (arg) => { ${body} }`
    return page.evaluate<T>(wrapped, arg)
  }

  async screenshot(target: WindowRef, opts: ScreenshotOptions = {}): Promise<Buffer> {
    const app = this.requireRunning()
    const page = await this.resolveWindow(app, target)
    const playwrightOpts: Parameters<PWPage['screenshot']>[0] = {}
    if (opts.fullPage !== undefined) playwrightOpts.fullPage = opts.fullPage
    if (opts.clip !== undefined) playwrightOpts.clip = opts.clip
    if (opts.format !== undefined) playwrightOpts.type = opts.format
    if (opts.quality !== undefined) playwrightOpts.quality = opts.quality
    return page.screenshot(playwrightOpts)
  }

  async windowsList(): Promise<readonly WindowDescriptor[]> {
    const app = this.requireRunning()
    const pages = app.windows()
    const descriptors: WindowDescriptor[] = []
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i]
      if (page === undefined) continue
      const title = await page.title().catch(() => '')
      const url = page.url()
      descriptors.push({
        id: this.idForWindow(page),
        index: i,
        title,
        ...(url ? { url } : {}),
        visible: true,
        focused: i === 0,
      })
    }
    return descriptors
  }

  private async resolveWindow(app: PWElectronApp, ref: WindowRef): Promise<PWPage> {
    const pages = app.windows()
    if (pages.length === 0) {
      throw new StagewrightError('REF_NOT_FOUND', 'No windows are open in the Electron app.', {
        transport: TRANSPORT_ID,
        ref,
      })
    }
    if (ref.kind === 'index') {
      const page = pages[ref.index]
      if (page === undefined) {
        throw new StagewrightError(
          'REF_NOT_FOUND',
          `Window index ${ref.index} is out of range (have ${pages.length} windows).`,
          { transport: TRANSPORT_ID, ref },
        )
      }
      return page
    }
    if (ref.kind === 'title') {
      const matcher =
        ref.pattern instanceof RegExp ? ref.pattern : new RegExp(`^${escapeRegex(ref.pattern)}$`)
      for (const page of pages) {
        const title = await page.title().catch(() => '')
        if (matcher.test(title)) return page
      }
      throw new StagewrightError(
        'REF_NOT_FOUND',
        `No window matched title pattern ${String(ref.pattern)}.`,
        { transport: TRANSPORT_ID, ref },
      )
    }
    for (const page of pages) {
      if (this.idForWindow(page) === ref.id) {
        return page
      }
    }
    throw new StagewrightError(
      'REF_NOT_FOUND',
      `Window id "${ref.id}" was not produced by this session.`,
      { transport: TRANSPORT_ID, ref },
    )
  }

  private idForWindow(page: PWPage): string {
    const existing = this.windowIds.get(page)
    if (existing !== undefined) return existing
    const id = `${this.id}-window-${this.nextWindowId}`
    this.nextWindowId += 1
    this.windowIds.set(page, id)
    return id
  }

  async dispose(): Promise<void> {
    // Idempotent — second and subsequent calls are no-ops, never throw.
    if (this.disposed) return
    this.disposed = true
    const app = this.app
    this.app = null
    if (app === null) return
    try {
      await app.close()
    } catch {
      // Closing twice or against a dead process is a benign condition during
      // shutdown. Swallow so callers can `dispose()` defensively.
    }
  }

  async forceKill(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const app = this.app
    this.app = null
    if (app === null) return

    try {
      app.process().kill('SIGKILL')
    } catch {
      // If the process is already gone, app.close() below still releases any
      // remaining Playwright-side resources.
    }
    try {
      await app.close()
    } catch {
      // A killed process can make Playwright close() reject. Force-kill should
      // remain best-effort and idempotent.
    }
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export class PlaywrightElectronTransport implements ITransport {
  public readonly id: TransportId = TRANSPORT_ID
  private readonly loadElectron: () => Promise<PWElectron>

  constructor(opts: PlaywrightElectronTransportOptions = {}) {
    this.loadElectron = opts.loadElectron ?? loadPlaywrightElectron
  }

  public readonly capabilities: TransportCapabilities = {
    canLaunch: true,
    // Playwright's _electron does not expose an attach API in its public
    // surface. Attach is provided by CDPTransport. Deviation from PLAN.md
    // noted in the ADR.
    canAttach: false,
    canInject: false,
    canIntercept: false,
    canControlClock: false,
    supportsMainEval: true,
    supportsRendererEval: true,
  }

  async launch(opts: LaunchOptions): Promise<TransportSession> {
    const electron = await this.loadElectron()
    const launchOpts = buildPlaywrightLaunchOptions(opts)
    let app: PWElectronApp
    try {
      app = await electron.launch(launchOpts)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      const isTimeout = /timeout/i.test(message)
      throw new StagewrightError(
        isTimeout ? 'LAUNCH_TIMEOUT' : 'INTERNAL_ERROR',
        `Playwright launch failed: ${message}`,
        { transport: TRANSPORT_ID, appPath: opts.appPath ?? opts.executablePath ?? '' },
      )
    }
    return new PlaywrightSession(app)
  }

  attach(_opts: AttachOptions): Promise<TransportSession> {
    return Promise.reject(
      new StagewrightError(
        'TRANSPORT_UNSUPPORTED',
        'PlaywrightElectronTransport does not support attach; use CDPTransport for attach-to-running.',
        { transport: TRANSPORT_ID, capability: 'canAttach' },
      ),
    )
  }

  inject(_opts: InjectOptions): Promise<TransportSession> {
    return Promise.reject(
      new StagewrightError(
        'TRANSPORT_UNSUPPORTED',
        'PlaywrightElectronTransport does not support inject; use InjectorTransport.',
        { transport: TRANSPORT_ID, capability: 'canInject' },
      ),
    )
  }

  async stop(session: TransportSession, _opts?: StopOptions): Promise<void> {
    await session.dispose()
  }

  async forceKill(session: TransportSession): Promise<void> {
    if (session instanceof PlaywrightSession) {
      await session.forceKill()
      return
    }
    await session.dispose()
  }
}
