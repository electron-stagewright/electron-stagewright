/**
 * Test doubles for the transport layer. A `FakeSession` / `FakeTransport` pair
 * implements the real `ITransport` / `TransportSession` contracts in-memory so
 * the server, dispatcher, session manager, and lifecycle tools can be exercised
 * without launching a real Electron app.
 *
 * Not a test file — it has no `.test.` segment, so vitest's default glob does not
 * pick it up.
 */

import { matchesNetworkFilter } from '../../src/transports/network-filter.js'
import type {
  ClickOptions,
  ConsoleEntry,
  ConsoleLogsResult,
  DialogEvent,
  DialogEventsOptions,
  DialogEventsResult,
  DialogPolicy,
  ITransport,
  InteractionOptions,
  NetworkCaptureFilter,
  NetworkEvent,
  NetworkEventsOptions,
  NetworkEventsResult,
  NetworkStub,
  PressOptions,
  ScreenshotOptions,
  ScrollOptions,
  StopOptions,
  StopResult,
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
  supportsInteraction: true,
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
  /**
   * When set, every interaction method (click/fill/.../scroll/typeText) rejects
   * with this error before recording — used to exercise `diagnoseInteractionError`
   * mapping (e.g. a Playwright-like "element is not enabled" message → ELEMENT_DISABLED).
   */
  readonly interactionError?: Error
  /** Canned console buffer returned by `consoleLogs` (oldest first). */
  readonly consoleEntries?: readonly ConsoleEntry[]
  /** Canned dropped-entry count returned by `consoleLogs`. */
  readonly consoleOverflowed?: number
  /** Canned dialog buffer returned by `dialogEvents` (oldest first). */
  readonly dialogEntries?: readonly DialogEvent[]
  /** Canned dropped-event count returned by `dialogEvents`. */
  readonly dialogOverflowed?: number
  /** Initial dialog policy returned by `dialogEvents` (defaults to `{ action: 'dismiss' }`). */
  readonly dialogPolicy?: DialogPolicy
  /** Buffer returned by `screenshot` (defaults to an empty buffer). */
  readonly screenshotResult?: Buffer
  /** Cap for the simulated network ring buffer (default 1000); set small to exercise overflow. */
  readonly networkCap?: number
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
  readonly #interactionError?: Error
  readonly #consoleEntries: readonly ConsoleEntry[]
  readonly #consoleOverflowed: number
  readonly #dialogEntries: DialogEvent[]
  #dialogOverflowed: number
  #dialogPolicy: DialogPolicy = { action: 'dismiss' }

  #networkCapturing = false
  #networkFilter: NetworkCaptureFilter | undefined = undefined
  readonly #networkBuffer: NetworkEvent[] = []
  #networkOverflow = 0
  readonly #networkCap: number

  #copyDialogPolicy(policy: DialogPolicy): DialogPolicy {
    return {
      action: policy.action,
      ...(policy.promptText !== undefined ? { promptText: policy.promptText } : {}),
      ...(policy.perType !== undefined ? { perType: { ...policy.perType } } : {}),
      ...(policy.oneShot !== undefined ? { oneShot: policy.oneShot } : {}),
    }
  }

  constructor(opts: FakeSessionOptions = {}) {
    this.id = opts.id ?? `fake-${Math.random().toString(36).slice(2, 10)}`
    this.transport = opts.transport ?? 'playwright-electron'
    this.ipc = { transport: this.transport }
    this.console = { transport: this.transport }
    this.#evaluate = opts.evaluate ?? (async () => undefined)
    this.#windows = opts.windows ?? []
    if (opts.windowsError !== undefined) this.#windowsError = opts.windowsError
    if (opts.interactionError !== undefined) this.#interactionError = opts.interactionError
    this.#consoleEntries = opts.consoleEntries ?? []
    this.#consoleOverflowed = opts.consoleOverflowed ?? 0
    this.#dialogEntries = [...(opts.dialogEntries ?? [])]
    this.#dialogOverflowed = opts.dialogOverflowed ?? 0
    if (opts.dialogPolicy !== undefined)
      this.#dialogPolicy = this.#copyDialogPolicy(opts.dialogPolicy)
    this.#screenshotResult = opts.screenshotResult ?? Buffer.alloc(0)
    this.#networkCap = opts.networkCap ?? 1000
  }

  async consoleLogs(): Promise<ConsoleLogsResult> {
    return { entries: this.#consoleEntries, overflowed: this.#consoleOverflowed }
  }

  /** Records each `setDialogPolicy` call so tool tests can assert the forwarded policy. */
  readonly dialogPolicyCalls: DialogPolicy[] = []

  async setDialogPolicy(policy: DialogPolicy): Promise<void> {
    this.dialogPolicyCalls.push(this.#copyDialogPolicy(policy))
    this.#dialogPolicy = this.#copyDialogPolicy(policy)
  }

  async dialogEvents(opts: DialogEventsOptions = {}): Promise<DialogEventsResult> {
    const result: DialogEventsResult = {
      entries: [...this.#dialogEntries],
      overflowed: this.#dialogOverflowed,
      policy: this.#copyDialogPolicy(this.#dialogPolicy),
    }
    if (opts.clear === true) {
      this.#dialogEntries.length = 0
      this.#dialogOverflowed = 0
    }
    return result
  }

  async startNetworkCapture(filter: NetworkCaptureFilter): Promise<void> {
    this.#networkCapturing = true
    this.#networkFilter = filter
    this.#networkBuffer.length = 0
    this.#networkOverflow = 0
  }

  async networkEvents(opts: NetworkEventsOptions = {}): Promise<NetworkEventsResult> {
    const result: NetworkEventsResult = {
      events: [...this.#networkBuffer],
      overflowed: this.#networkOverflow,
    }
    if (opts.clear === true) {
      this.#networkBuffer.length = 0
      this.#networkOverflow = 0
    }
    return result
  }

  async stopNetworkCapture(): Promise<void> {
    this.#networkCapturing = false
    this.#networkFilter = undefined
    this.#networkBuffer.length = 0
    this.#networkOverflow = 0
  }

  /**
   * Test seam: simulate the app emitting one network event while capturing. Applies the armed filter
   * exactly as the real transport does at record time — an event before start, after stop, or outside
   * the allowlist is ignored — so a plugin test drives realistic capture without launching Electron.
   */
  emitNetwork(event: NetworkEvent): void {
    if (!this.#networkCapturing || this.#networkFilter === undefined) return
    if (!matchesNetworkFilter(event, this.#networkFilter)) return
    this.#networkBuffer.push(event)
    if (this.#networkBuffer.length > this.#networkCap) {
      this.#networkBuffer.shift()
      this.#networkOverflow += 1
    }
  }

  /** Recorded stub registrations and `clearNetworkStubs` calls, for asserting plugin orchestration. */
  readonly networkStubCalls: NetworkStub[] = []
  readonly clearNetworkStubsCalls: Array<string | undefined> = []

  async stubNetwork(stub: NetworkStub): Promise<void> {
    this.networkStubCalls.push(stub)
  }

  async clearNetworkStubs(url?: string): Promise<void> {
    this.clearNetworkStubsCalls.push(url)
  }

  /** Recorded screenshot calls, for asserting window targeting / clip / format. */
  readonly screenshotCalls: { readonly target: WindowRef; readonly opts?: ScreenshotOptions }[] = []
  readonly #screenshotResult: Buffer

  /** Throw the configured interaction error, if any, before recording a call. */
  #failIfConfigured(): void {
    if (this.#interactionError !== undefined) throw this.#interactionError
  }

  async evaluate<T = unknown>(
    target: 'main' | 'renderer',
    body: string,
    arg?: unknown,
  ): Promise<T> {
    return (await this.#evaluate(target, body, arg)) as T
  }

  async screenshot(target: WindowRef, opts?: ScreenshotOptions): Promise<Buffer> {
    this.screenshotCalls.push({ target, ...(opts !== undefined ? { opts } : {}) })
    return this.#screenshotResult
  }

  async windowsList(): Promise<readonly WindowDescriptor[]> {
    if (this.#windowsError !== undefined) throw this.#windowsError
    return this.#windows
  }

  /** Recorded interaction calls, in order, for assertions in interaction-tool tests. */
  readonly interactions: { readonly method: string; readonly args: readonly unknown[] }[] = []

  async click(selector: string, opts?: ClickOptions): Promise<void> {
    this.#failIfConfigured()
    this.interactions.push({ method: 'click', args: [selector, opts] })
  }

  async fill(selector: string, value: string, opts?: InteractionOptions): Promise<void> {
    this.#failIfConfigured()
    this.interactions.push({ method: 'fill', args: [selector, value, opts] })
  }

  async hover(selector: string, opts?: InteractionOptions): Promise<void> {
    this.#failIfConfigured()
    this.interactions.push({ method: 'hover', args: [selector, opts] })
  }

  async press(key: string, opts?: PressOptions): Promise<void> {
    this.#failIfConfigured()
    this.interactions.push({ method: 'press', args: [key, opts] })
  }

  async typeText(text: string, opts?: PressOptions): Promise<void> {
    this.#failIfConfigured()
    this.interactions.push({ method: 'typeText', args: [text, opts] })
  }

  async selectOption(
    selector: string,
    values: readonly string[],
    opts?: InteractionOptions,
  ): Promise<readonly string[]> {
    this.#failIfConfigured()
    this.interactions.push({ method: 'selectOption', args: [selector, values, opts] })
    return values
  }

  async setChecked(selector: string, checked: boolean, opts?: InteractionOptions): Promise<void> {
    this.#failIfConfigured()
    this.interactions.push({ method: 'setChecked', args: [selector, checked, opts] })
  }

  async setInputFiles(
    selector: string,
    paths: readonly string[],
    opts?: InteractionOptions,
  ): Promise<void> {
    this.#failIfConfigured()
    this.interactions.push({ method: 'setInputFiles', args: [selector, paths, opts] })
  }

  async dragTo(source: string, target: string, opts?: InteractionOptions): Promise<void> {
    this.#failIfConfigured()
    this.interactions.push({ method: 'dragTo', args: [source, target, opts] })
  }

  async scroll(opts?: ScrollOptions): Promise<void> {
    this.#failIfConfigured()
    this.interactions.push({ method: 'scroll', args: [opts] })
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

  async stop(session: TransportSession, _opts?: StopOptions): Promise<StopResult> {
    this.stopCount += 1
    await session.dispose()
    return { escalated: false }
  }

  async forceKill(session: TransportSession): Promise<void> {
    this.forceKillCount += 1
    await session.dispose()
  }
}
