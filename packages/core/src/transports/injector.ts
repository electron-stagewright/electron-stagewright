/**
 * InjectorTransport — attach to a running Electron app that was NOT started
 * with a debug flag, by triggering the Node inspector in its main process
 * (the "attach without restart" workflow from ADR-003).
 *
 * ## How inject works
 *
 * 1. `process._debugProcess(pid)` tells the target Node/Electron process to
 *    open its inspector on the default port (9229). On POSIX this is reliable
 *    (a SIGUSR1 under the hood); on Windows the underlying debug-attach API is
 *    unreliable on some Node/Electron combinations.
 * 2. The flow then ALWAYS polls `http://127.0.0.1:9229/json/list` (bounded) —
 *    this doubles as the Windows fallback: an inspector that is ALREADY
 *    listening (an app started with `--inspect`, or a previously injected one)
 *    is discovered even when step 1 failed or did nothing.
 * 3. The discovered target must belong to `pid`: the Node inspector embeds the
 *    pid in its target title (`electron[12345]`). Attaching to a DIFFERENT
 *    process's inspector on a shared default port would be a silent
 *    catastrophe, so a pid mismatch is an explicit `INJECT_FAILED`.
 * 4. A {@link CdpConnection} opens to the target's `webSocketDebuggerUrl`. The
 *    session speaks the Node inspector protocol: MAIN-process
 *    `Runtime.evaluate` (with the command-line API so `require` resolves),
 *    console capture, and a window list read through the Electron API.
 *
 * Capability matrix:
 *
 * - `canLaunch: false` — Injector hooks an existing process; it does not spawn.
 * - `canAttach: true` — connect to an already-listening Node inspector port.
 * - `canInject: true` — the primary purpose.
 * - `canIntercept: false` — the Node inspector exposes no renderer network stream.
 * - `canControlClock: false` — renderer clock control lives on the Playwright launch transport.
 * - `supportsMainEval: true` — Node inspector `Runtime.evaluate`.
 * - `supportsRendererEval: false` — renderer access requires the CDP browser
 *   endpoint, which the Node inspector does not surface.
 * - `supportsInteraction: false` — no renderer, no input synthesis.
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import process from 'node:process'

import { StagewrightError } from '../errors/registry.js'
import {
  CdpConnection,
  evaluateExpression,
  remoteObjectToText,
  type WebSocketFactory,
} from './cdp-connection.js'
import { copyDialogPolicy } from './dialog-policy.js'
import type { FetchJson, KillProcess } from './cdp.js'
import { assertLoopbackAttachTarget } from './loopback.js'
import type {
  AttachOptions,
  ClockInstallOptions,
  ClockTime,
  ConsoleEntry,
  ConsoleLogsResult,
  ConsoleStream,
  CookieFilter,
  DialogEventsOptions,
  DialogEventsResult,
  DialogPolicy,
  InjectOptions,
  ITransport,
  IpcChannel,
  LaunchOptions,
  MenuInvokeResult,
  NativeMenu,
  NativeNotification,
  NativeTray,
  NetworkCaptureFilter,
  NetworkEventsOptions,
  NetworkEventsResult,
  NetworkStub,
  NotificationCaptureFilter,
  StopOptions,
  StopResult,
  StorageCookie,
  StorageSnapshot,
  TransportCapabilities,
  TransportId,
  TransportSession,
  TrayEventName,
  TrayInvokeResult,
  WindowDescriptor,
} from './types.js'

const TRANSPORT_ID: TransportId = 'injector'

/** The Node inspector's default port — where `process._debugProcess` opens it. */
const DEFAULT_INSPECTOR_PORT = 9229
/** Default budget for the inspector to appear after the debug trigger. */
const INJECT_DISCOVERY_BUDGET_MS = 10_000
/** Pause between discovery polls. */
const DISCOVERY_POLL_MS = 200
/** Budget for one `/json/list` probe. */
const LIST_PROBE_TIMEOUT_MS = 1_000
/** Default budget for a graceful quit before escalating to SIGKILL. */
const STOP_GRACEFUL_BUDGET_MS = 10_000
/** Pause between process-liveness probes while waiting for a quit to land. */
const EXIT_POLL_MS = 100
/** Max console entries retained (matches the other transports). */
const CONSOLE_CAP = 1000

/** Triggers the target process's inspector. Injectable seam for tests. */
export type DebugProcessTrigger = (pid: number) => void

/** Probes whether a pid is alive (`kill(pid, 0)`). Injectable seam for tests. */
export type ProcessAliveProbe = (pid: number) => boolean

const defaultFetchJson: FetchJson = async (url, timeoutMs) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`)
  }
  return response.json()
}

const defaultDebugProcess: DebugProcessTrigger = (pid) => {
  const trigger = (process as unknown as { _debugProcess?: (pid: number) => void })._debugProcess
  if (typeof trigger !== 'function') {
    throw new Error('process._debugProcess is not available in this Node build')
  }
  trigger(pid)
}

const defaultKillProcess: KillProcess = (pid) => {
  process.kill(pid, 'SIGKILL')
}

const defaultProcessAlive: ProcessAliveProbe = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function formatLoopbackHostForHttp(host: string): string {
  return host === '::1' ? '[::1]' : host
}

function unsupported(method: string, capability: keyof TransportCapabilities): StagewrightError {
  return new StagewrightError(
    'TRANSPORT_UNSUPPORTED',
    `InjectorTransport does not support ${method}.`,
    { transport: TRANSPORT_ID, method, capability },
  )
}

function notImplemented(method: string): StagewrightError {
  return new StagewrightError(
    'NOT_IMPLEMENTED',
    `InjectorTransport does not implement ${method}; it drives the MAIN process only.`,
    { transport: TRANSPORT_ID, method },
  )
}

/** One entry from the Node inspector's `/json/list`. */
interface NodeInspectorTarget {
  readonly title: string
  readonly webSocketDebuggerUrl: string
}

/** Validated target list from a Node inspector `/json/list` response. */
function asNodeTargets(value: unknown): readonly NodeInspectorTarget[] {
  if (!Array.isArray(value)) return []
  const targets: NodeInspectorTarget[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const t = entry as Partial<NodeInspectorTarget>
    if (typeof t.webSocketDebuggerUrl !== 'string' || t.webSocketDebuggerUrl === '') continue
    targets.push({
      title: typeof t.title === 'string' ? t.title : '',
      webSocketDebuggerUrl: t.webSocketDebuggerUrl,
    })
  }
  return targets
}

/** Sleep helper for the discovery/exit polls. The timer never holds the process open. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** Shape of `Runtime.consoleAPICalled` event params (the slice we read). */
interface ConsoleApiCalledParams {
  readonly type?: string
  readonly args?: readonly { readonly value?: unknown; readonly description?: string }[]
}

/**
 * Main-process body: enumerate the Electron windows. Runs with the inspector's
 * command-line API so `require` resolves; a non-Electron Node process (or an
 * app before ready) reports an empty list rather than failing the call.
 */
const WINDOWS_LIST_BODY = `
try {
  const electron = require('electron');
  return electron.BrowserWindow.getAllWindows().map((win, index) => ({
    id: String(win.id),
    index,
    title: win.getTitle(),
    visible: win.isVisible(),
    focused: win.isFocused(),
  }));
} catch {
  return [];
}
`

/** Main-process body: ask the app to quit gracefully. */
const QUIT_BODY = `
try {
  require('electron').app.quit();
  return true;
} catch {
  return false;
}
`

/** Main-process body: read the pid owned by the Node inspector target. */
const PROCESS_PID_BODY = `
return process.pid;
`

/** Dependency seams threaded from the transport into each session. */
interface InjectorSessionDeps {
  readonly killProcess: KillProcess
  readonly processAlive: ProcessAliveProbe
}

class InjectorSession implements TransportSession {
  public readonly id: string
  public readonly transport: TransportId = TRANSPORT_ID
  public readonly ipc: IpcChannel = { transport: TRANSPORT_ID }
  public readonly console: ConsoleStream = { transport: TRANSPORT_ID }

  readonly #conn: CdpConnection
  readonly #deps: InjectorSessionDeps
  readonly #pid: number | undefined
  #disposed = false

  readonly #consoleBuffer: ConsoleEntry[] = []
  #consoleOverflow = 0
  /**
   * Stored for contract parity; the main process raises no JS dialogs, so the
   * event buffer is always empty.
   */
  #dialogPolicy: DialogPolicy = { action: 'dismiss' }

  constructor(conn: CdpConnection, deps: InjectorSessionDeps, pid?: number) {
    this.id = `inj-${randomUUID()}`
    this.#conn = conn
    this.#deps = deps
    this.#pid = pid
    conn.on('Runtime.consoleAPICalled', (params) => {
      this.#pushConsole((params ?? {}) as ConsoleApiCalledParams)
    })
    void conn.enable('Runtime').catch(() => {
      // Console capture is best-effort; eval still works without the enable.
    })
  }

  #pushConsole(params: ConsoleApiCalledParams): void {
    const text = (params.args ?? [])
      .map(remoteObjectToText)
      .filter((t) => t !== '')
      .join(' ')
    this.#consoleBuffer.push({ type: params.type ?? 'log', text, timestamp: Date.now() })
    if (this.#consoleBuffer.length > CONSOLE_CAP) {
      this.#consoleBuffer.shift()
      this.#consoleOverflow += 1
    }
  }

  #requireRunning(): void {
    if (this.#disposed) {
      throw new StagewrightError('NOT_RUNNING', 'InjectorTransport session has been disposed.', {
        transport: TRANSPORT_ID,
        sessionId: this.id,
      })
    }
  }

  async evaluate<T = unknown>(
    target: 'main' | 'renderer',
    body: string,
    arg?: unknown,
  ): Promise<T> {
    this.#requireRunning()
    if (target === 'renderer') {
      throw unsupported('evaluate(renderer)', 'supportsRendererEval')
    }
    // The Node inspector context has no global `require`; the command-line API
    // exposes it, which is what makes Electron main-process drives possible.
    return evaluateExpression<T>(this.#conn, body, arg, { includeCommandLineAPI: true })
  }

  async windowsList(): Promise<readonly WindowDescriptor[]> {
    this.#requireRunning()
    const windows = await evaluateExpression<readonly WindowDescriptor[]>(
      this.#conn,
      WINDOWS_LIST_BODY,
      undefined,
      { includeCommandLineAPI: true },
    )
    return Array.isArray(windows) ? windows : []
  }

  screenshot(): Promise<Buffer> {
    return Promise.reject(notImplemented('screenshot'))
  }

  async consoleLogs(): Promise<ConsoleLogsResult> {
    this.#requireRunning()
    return { entries: [...this.#consoleBuffer], overflowed: this.#consoleOverflow }
  }

  async setDialogPolicy(policy: DialogPolicy): Promise<void> {
    this.#requireRunning()
    this.#dialogPolicy = copyDialogPolicy(policy)
  }

  async dialogEvents(_opts: DialogEventsOptions = {}): Promise<DialogEventsResult> {
    this.#requireRunning()
    return { entries: [], overflowed: 0, policy: copyDialogPolicy(this.#dialogPolicy) }
  }

  // --- Network capture surface: the Node inspector sees no renderer network (canIntercept: false). ---

  startNetworkCapture(_filter: NetworkCaptureFilter): Promise<void> {
    return Promise.reject(notImplemented('startNetworkCapture'))
  }
  networkEvents(_opts?: NetworkEventsOptions): Promise<NetworkEventsResult> {
    return Promise.reject(notImplemented('networkEvents'))
  }
  stopNetworkCapture(): Promise<void> {
    return Promise.reject(notImplemented('stopNetworkCapture'))
  }
  stubNetwork(_stub: NetworkStub): Promise<void> {
    return Promise.reject(notImplemented('stubNetwork'))
  }
  clearNetworkStubs(_url?: string): Promise<void> {
    return Promise.reject(notImplemented('clearNetworkStubs'))
  }

  // --- Clock seam: no renderer clock to control (canControlClock: false). ---

  installClock(_options?: ClockInstallOptions): Promise<void> {
    return Promise.reject(notImplemented('installClock'))
  }
  setFixedTime(_time: ClockTime): Promise<void> {
    return Promise.reject(notImplemented('setFixedTime'))
  }
  setSystemTime(_time: ClockTime): Promise<void> {
    return Promise.reject(notImplemented('setSystemTime'))
  }
  advanceClock(_ms: number): Promise<void> {
    return Promise.reject(notImplemented('advanceClock'))
  }
  runClockFor(_ms: number): Promise<void> {
    return Promise.reject(notImplemented('runClockFor'))
  }
  pauseClockAt(_time: ClockTime): Promise<void> {
    return Promise.reject(notImplemented('pauseClockAt'))
  }
  resumeClock(): Promise<void> {
    return Promise.reject(notImplemented('resumeClock'))
  }

  // --- Storage seam: no renderer storage to access (canAccessStorage: false). ---

  getCookies(_filter?: CookieFilter): Promise<readonly StorageCookie[]> {
    return Promise.reject(notImplemented('getCookies'))
  }
  setCookie(_cookie: StorageCookie): Promise<void> {
    return Promise.reject(notImplemented('setCookie'))
  }
  clearCookies(_filter?: CookieFilter): Promise<void> {
    return Promise.reject(notImplemented('clearCookies'))
  }
  storageSnapshot(): Promise<StorageSnapshot> {
    return Promise.reject(notImplemented('storageSnapshot'))
  }

  // --- Native UI seam: not implemented on the injector stub (canAccessNativeUI: false). ---

  getApplicationMenu(): Promise<NativeMenu | null> {
    return Promise.reject(notImplemented('getApplicationMenu'))
  }
  invokeApplicationMenuItem(_path: readonly string[]): Promise<MenuInvokeResult> {
    return Promise.reject(notImplemented('invokeApplicationMenuItem'))
  }
  startNotificationCapture(_filter?: NotificationCaptureFilter): Promise<void> {
    return Promise.reject(notImplemented('startNotificationCapture'))
  }
  capturedNotifications(): Promise<readonly NativeNotification[]> {
    return Promise.reject(notImplemented('capturedNotifications'))
  }
  stopNotificationCapture(): Promise<void> {
    return Promise.reject(notImplemented('stopNotificationCapture'))
  }
  getTrays(): Promise<readonly NativeTray[] | null> {
    return Promise.reject(notImplemented('getTrays'))
  }
  invokeTrayEvent(_id: number, _event: TrayEventName): Promise<TrayInvokeResult | null> {
    return Promise.reject(notImplemented('invokeTrayEvent'))
  }

  // --- Interaction surface: the main process has no renderer to drive. ---

  click(): Promise<void> {
    return Promise.reject(notImplemented('click'))
  }
  fill(): Promise<void> {
    return Promise.reject(notImplemented('fill'))
  }
  hover(): Promise<void> {
    return Promise.reject(notImplemented('hover'))
  }
  press(): Promise<void> {
    return Promise.reject(notImplemented('press'))
  }
  typeText(): Promise<void> {
    return Promise.reject(notImplemented('typeText'))
  }
  selectOption(): Promise<readonly string[]> {
    return Promise.reject(notImplemented('selectOption'))
  }
  setChecked(): Promise<void> {
    return Promise.reject(notImplemented('setChecked'))
  }
  setInputFiles(): Promise<void> {
    return Promise.reject(notImplemented('setInputFiles'))
  }
  dragTo(): Promise<void> {
    return Promise.reject(notImplemented('dragTo'))
  }
  scroll(): Promise<void> {
    return Promise.reject(notImplemented('scroll'))
  }

  /** Poll the pid until it exits or the budget runs out. True = process is gone. */
  async #waitForExit(budgetMs: number): Promise<boolean> {
    if (this.#pid === undefined) return true
    const deadline = Date.now() + budgetMs
    while (Date.now() < deadline) {
      if (!this.#deps.processAlive(this.#pid)) return true
      await delay(EXIT_POLL_MS)
    }
    return !this.#deps.processAlive(this.#pid)
  }

  #kill(): boolean {
    if (this.#pid === undefined) return false
    try {
      this.#deps.killProcess(this.#pid)
      return true
    } catch {
      return false
    }
  }

  /**
   * Bounded graceful stop: ask the app to quit via the Electron API, then poll
   * the pid; when it survives the budget, escalate to SIGKILL so the caller
   * never inherits an orphan. Without a pid (an attach to a pre-enabled
   * inspector), the quit is best-effort and there is nothing to escalate to.
   */
  async stopGracefully(opts: StopOptions): Promise<StopResult> {
    if (this.#disposed) return { escalated: false }
    this.#disposed = true
    let escalated = false
    if (opts.force === true) {
      escalated = this.#kill()
    } else {
      try {
        await evaluateExpression(this.#conn, QUIT_BODY, undefined, {
          includeCommandLineAPI: true,
          timeoutMs: 3_000,
        })
      } catch {
        // A connection that drops mid-quit usually IS the app exiting.
      }
      const dead = await this.#waitForExit(opts.timeoutMs ?? STOP_GRACEFUL_BUDGET_MS)
      if (!dead) {
        escalated = this.#kill()
        await this.#waitForExit(2_000)
      }
    }
    this.#conn.close()
    return { escalated }
  }

  async dispose(): Promise<void> {
    // Idempotent. Disposing DETACHES (closes the inspector socket) without
    // stopping the app — the injector did not start the process, so plain
    // disposal must not kill it. `stop` is the explicit quit path.
    if (this.#disposed) return
    this.#disposed = true
    this.#conn.close()
  }

  async forceKill(): Promise<void> {
    await this.stopGracefully({ force: true })
  }
}

/** Options accepted by {@link InjectorTransport} — dependency seams for tests. */
export interface InjectorTransportOptions {
  /** WebSocket factory override. Defaults to the global WebSocket. */
  readonly wsFactory?: WebSocketFactory
  /** Discovery fetcher override. Defaults to global `fetch` with a bounded signal. */
  readonly fetchJson?: FetchJson
  /** Inspector trigger override. Defaults to `process._debugProcess`. */
  readonly debugProcess?: DebugProcessTrigger
  /** SIGKILL sender override. Defaults to `process.kill(pid, 'SIGKILL')`. */
  readonly killProcess?: KillProcess
  /** Liveness probe override. Defaults to `process.kill(pid, 0)`. */
  readonly processAlive?: ProcessAliveProbe
  /** Inspector port override. Defaults to 9229 (where `_debugProcess` opens it). */
  readonly inspectorPort?: number
  /** Discovery poll pause override (test speed). */
  readonly pollIntervalMs?: number
}

export class InjectorTransport implements ITransport {
  public readonly id: TransportId = TRANSPORT_ID
  public readonly capabilities: TransportCapabilities = {
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
  }

  readonly #wsFactory: WebSocketFactory | undefined
  readonly #fetchJson: FetchJson
  readonly #debugProcess: DebugProcessTrigger
  readonly #sessionDeps: InjectorSessionDeps
  readonly #inspectorPort: number
  readonly #pollIntervalMs: number

  constructor(opts: InjectorTransportOptions = {}) {
    this.#wsFactory = opts.wsFactory
    this.#fetchJson = opts.fetchJson ?? defaultFetchJson
    this.#debugProcess = opts.debugProcess ?? defaultDebugProcess
    this.#sessionDeps = {
      killProcess: opts.killProcess ?? defaultKillProcess,
      processAlive: opts.processAlive ?? defaultProcessAlive,
    }
    this.#inspectorPort = opts.inspectorPort ?? DEFAULT_INSPECTOR_PORT
    this.#pollIntervalMs = opts.pollIntervalMs ?? DISCOVERY_POLL_MS
  }

  launch(_opts: LaunchOptions): Promise<TransportSession> {
    return Promise.reject(unsupported('launch', 'canLaunch'))
  }

  /**
   * Attach to an ALREADY-listening Node inspector (an app started with
   * `--inspect`). Requires an explicit port or cdpUrl — there is no implicit
   * network probing from a bare call. When a pid is supplied, ownership is
   * verified before the session can later use that pid for stop escalation.
   */
  async attach(opts: AttachOptions): Promise<TransportSession> {
    // Re-assert the loopback invariant at the transport boundary — the tool schema
    // also enforces it, but a direct API caller must not be able to point the
    // inspector handshake at an arbitrary host (see transports/loopback.ts).
    assertLoopbackAttachTarget(TRANSPORT_ID, opts)
    if (opts.cdpUrl !== undefined) {
      const conn = await this.#open(opts.cdpUrl, opts.timeoutMs)
      await this.#verifyConnectedPid(conn, opts.pid)
      return new InjectorSession(conn, this.#sessionDeps, opts.pid)
    }
    if (opts.port === undefined) {
      throw new StagewrightError(
        'BAD_ARGUMENT',
        'Injector attach needs port or cdpUrl (the Node inspector endpoint).',
        { transport: TRANSPORT_ID },
      )
    }
    const host = opts.host ?? '127.0.0.1'
    const targets = await this.#listTargets(host, opts.port)
    const first =
      opts.pid === undefined ? targets[0] : targets.find((t) => t.title.includes(`[${opts.pid}]`))
    if (first === undefined) {
      const sawForeignTarget = opts.pid !== undefined && targets.length > 0
      throw new StagewrightError(
        'INJECT_FAILED',
        sawForeignTarget
          ? `The inspector on port ${opts.port} belongs to another process (${targets.map((t) => t.title).join(', ')}), not pid ${opts.pid}.`
          : `No Node inspector target at http://${formatLoopbackHostForHttp(host)}:${opts.port}/json/list.`,
        {
          transport: TRANSPORT_ID,
          port: opts.port,
          ...(opts.pid !== undefined ? { pid: opts.pid, seen: targets.map((t) => t.title) } : {}),
        },
      )
    }
    const conn = await this.#open(first.webSocketDebuggerUrl, opts.timeoutMs)
    return new InjectorSession(conn, this.#sessionDeps, opts.pid)
  }

  /**
   * Inject into a running process: trigger its inspector, then poll the
   * default inspector port until a target owned by `pid` appears. The poll
   * doubles as the Windows fallback (see the module doc).
   */
  async inject(opts: InjectOptions): Promise<TransportSession> {
    if (!Number.isInteger(opts.pid) || opts.pid <= 0) {
      throw new StagewrightError('BAD_ARGUMENT', `inject needs a positive pid; got ${opts.pid}.`, {
        transport: TRANSPORT_ID,
      })
    }

    let triggerError: string | undefined
    try {
      this.#debugProcess(opts.pid)
    } catch (cause) {
      // Windows unreliability (or a Node build without _debugProcess): fall
      // through to discovery — an already-listening inspector still attaches.
      triggerError = cause instanceof Error ? cause.message : String(cause)
    }

    const deadline = Date.now() + (opts.timeoutMs ?? INJECT_DISCOVERY_BUDGET_MS)
    let lastSeenTitles: readonly string[] = []
    for (;;) {
      let targets: readonly NodeInspectorTarget[] = []
      try {
        targets = await this.#listTargets('127.0.0.1', this.#inspectorPort)
      } catch {
        // Inspector not up yet — keep polling until the deadline.
      }
      const owned = targets.find((t) => t.title.includes(`[${opts.pid}]`))
      if (owned !== undefined) {
        const conn = await this.#open(owned.webSocketDebuggerUrl, undefined)
        return new InjectorSession(conn, this.#sessionDeps, opts.pid)
      }
      lastSeenTitles = targets.map((t) => t.title)
      if (Date.now() >= deadline) break
      await delay(this.#pollIntervalMs)
    }

    const foreign = lastSeenTitles.length > 0
    const missingMessage =
      `No inspector appeared for pid ${opts.pid} on port ${this.#inspectorPort}.` +
      (triggerError !== undefined
        ? ` The debug trigger also failed (${triggerError}) — on Windows, start the app with --inspect=${this.#inspectorPort} and retry, or use electron_attach.`
        : ' Verify the pid belongs to an Electron/Node process.')
    throw new StagewrightError(
      'INJECT_FAILED',
      foreign
        ? `The inspector on port ${this.#inspectorPort} belongs to another process (${lastSeenTitles.join(', ')}), not pid ${opts.pid}.`
        : missingMessage,
      { transport: TRANSPORT_ID, pid: opts.pid, port: this.#inspectorPort },
    )
  }

  async #listTargets(host: string, port: number): Promise<readonly NodeInspectorTarget[]> {
    const listed = await this.#fetchJson(
      `http://${formatLoopbackHostForHttp(host)}:${port}/json/list`,
      LIST_PROBE_TIMEOUT_MS,
    )
    return asNodeTargets(listed)
  }

  #open(wsUrl: string, timeoutMs: number | undefined): Promise<CdpConnection> {
    return CdpConnection.open(wsUrl, {
      ...(this.#wsFactory !== undefined ? { factory: this.#wsFactory } : {}),
      ...(timeoutMs !== undefined ? { connectTimeoutMs: timeoutMs } : {}),
    })
  }

  async #verifyConnectedPid(conn: CdpConnection, pid: number | undefined): Promise<void> {
    if (pid === undefined) return
    let actual: unknown
    try {
      actual = await evaluateExpression(conn, PROCESS_PID_BODY, undefined, {
        includeCommandLineAPI: true,
        timeoutMs: 3_000,
      })
    } catch (cause) {
      conn.close()
      throw new StagewrightError(
        'INJECT_FAILED',
        `Could not verify that the inspector target belongs to pid ${pid}.`,
        {
          transport: TRANSPORT_ID,
          pid,
          cause: cause instanceof Error ? cause.message : String(cause),
        },
      )
    }
    if (actual !== pid) {
      conn.close()
      throw new StagewrightError(
        'INJECT_FAILED',
        `Inspector target pid ${String(actual)} does not match requested pid ${pid}.`,
        { transport: TRANSPORT_ID, pid, actual },
      )
    }
  }

  async stop(session: TransportSession, opts?: StopOptions): Promise<StopResult> {
    if (session instanceof InjectorSession) {
      return session.stopGracefully(opts ?? {})
    }
    await session.dispose()
    return { escalated: false }
  }

  async forceKill(session: TransportSession): Promise<void> {
    if (session instanceof InjectorSession) {
      await session.forceKill()
      return
    }
    await session.dispose()
  }
}
