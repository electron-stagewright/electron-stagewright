/**
 * Test doubles for the transport layer. A `FakeSession` / `FakeTransport` pair
 * implements the real `ITransport` / `TransportSession` contracts in-memory so
 * the server, dispatcher, session manager, and lifecycle tools can be exercised
 * without launching a real Electron app.
 *
 * Not a test file — it has no `.test.` segment, so vitest's default glob does not
 * pick it up.
 */

import type {
  ITransport,
  ScreenshotOptions,
  StopOptions,
  TransportCapabilities,
  TransportId,
  TransportSession,
  WindowDescriptor,
  WindowRef,
} from '../../src/transports/index.js'

const FULL_CAPS: TransportCapabilities = {
  canLaunch: true,
  canAttach: true,
  canInject: true,
  canIntercept: true,
  canControlClock: true,
  supportsMainEval: true,
  supportsRendererEval: true,
}

/** Evaluate implementation: receives target/body/arg, returns the probe result. */
export type FakeEvaluate = (
  target: 'main' | 'renderer',
  body: string,
  arg?: unknown,
) => Promise<unknown>

export interface FakeSessionOptions {
  readonly id?: string
  readonly transport?: TransportId
  readonly evaluate?: FakeEvaluate
  readonly windows?: readonly WindowDescriptor[]
  /** When set, `windowsList` rejects with this error (to exercise post-register cleanup). */
  readonly windowsError?: Error
}

/** In-memory {@link TransportSession}. Tracks dispose calls for idempotency tests. */
export class FakeSession implements TransportSession {
  readonly id: string
  readonly transport: TransportId
  readonly ipc: { readonly transport: TransportId }
  readonly console: { readonly transport: TransportId }

  disposeCount = 0
  readonly #evaluate: FakeEvaluate
  readonly #windows: readonly WindowDescriptor[]
  readonly #windowsError?: Error

  constructor(opts: FakeSessionOptions = {}) {
    this.id = opts.id ?? `fake-${Math.random().toString(36).slice(2, 10)}`
    this.transport = opts.transport ?? 'playwright-electron'
    this.ipc = { transport: this.transport }
    this.console = { transport: this.transport }
    this.#evaluate = opts.evaluate ?? (async () => undefined)
    this.#windows = opts.windows ?? []
    if (opts.windowsError !== undefined) this.#windowsError = opts.windowsError
  }

  async evaluate<T = unknown>(
    target: 'main' | 'renderer',
    body: string,
    arg?: unknown,
  ): Promise<T> {
    return (await this.#evaluate(target, body, arg)) as T
  }

  async screenshot(_target: WindowRef, _opts?: ScreenshotOptions): Promise<Buffer> {
    return Buffer.alloc(0)
  }

  async windowsList(): Promise<readonly WindowDescriptor[]> {
    if (this.#windowsError !== undefined) throw this.#windowsError
    return this.#windows
  }

  async dispose(): Promise<void> {
    this.disposeCount += 1
  }
}

export interface FakeTransportOptions {
  readonly id?: TransportId
  readonly capabilities?: TransportCapabilities
  readonly session?: FakeSession
  /** When set, `launch` rejects with this error (to exercise launch-error diagnosis). */
  readonly launchError?: Error
}

/** In-memory {@link ITransport}. Tracks stop/forceKill calls and disposes its session. */
export class FakeTransport implements ITransport {
  readonly id: TransportId
  readonly capabilities: TransportCapabilities
  readonly session: FakeSession

  stopCount = 0
  forceKillCount = 0
  launchCount = 0
  attachCount = 0
  injectCount = 0

  readonly #launchError?: Error

  constructor(opts: FakeTransportOptions = {}) {
    this.id = opts.id ?? 'playwright-electron'
    this.capabilities = opts.capabilities ?? FULL_CAPS
    this.session = opts.session ?? new FakeSession({ transport: this.id })
    if (opts.launchError !== undefined) this.#launchError = opts.launchError
  }

  async launch(): Promise<TransportSession> {
    this.launchCount += 1
    if (this.#launchError !== undefined) throw this.#launchError
    return this.session
  }

  async attach(): Promise<TransportSession> {
    this.attachCount += 1
    return this.session
  }

  async inject(): Promise<TransportSession> {
    this.injectCount += 1
    return this.session
  }

  async stop(session: TransportSession, _opts?: StopOptions): Promise<void> {
    this.stopCount += 1
    await session.dispose()
  }

  async forceKill(session: TransportSession): Promise<void> {
    this.forceKillCount += 1
    await session.dispose()
  }
}
