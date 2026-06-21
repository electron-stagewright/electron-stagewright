/**
 * PlaywrightElectronTransport — the default, uses Playwright's experimental
 * `_electron.launch()` API. Playwright is declared as an OPTIONAL peer
 * dependency, so this module never imports it statically; the SDK is loaded
 * lazily inside `launch()`. Consumers that install `@electron-stagewright/core`
 * without `playwright` can still import the package and inspect the capability
 * matrix; only invoking `launch()` will surface a `TRANSPORT_UNSUPPORTED` error
 * with a clear remediation hint.
 *
 * ## Capability decisions
 *
 * - `canLaunch: true` — Playwright `_electron.launch()` is the primary purpose.
 * - `canAttach: false` — Playwright's `_electron` does NOT expose an attach API
 *   in the published surface; attach is provided by CDPTransport instead. The
 *   capability matrix reflects the upstream API rather than the broader
 *   Stagewright transport contract.
 * - `canInject: false` — Injector is its own transport.
 * - `canIntercept: true` — renderer network traffic is observable via Playwright's
 *   `page.on('requestfinished'|'requestfailed')` (the capture seam) AND modifiable via
 *   `page.route` (the stub seam: fulfill/abort) — both halves of "intercept".
 * - `canControlClock: true` — deterministic virtual time via Playwright's `page.clock` (install /
 *   freeze / advance / resume); the clock seam's first consumer (the clock plugin, ADR-017).
 * - `canAccessStorage: true` — cookies + the storage snapshot via the page `BrowserContext` (the
 *   storage seam, ADR-018).
 * - `canAccessNativeUI: true` — read/invoke native UI (application menu, notification capture, and
 *   launch-time tray read + event invocation) via the transport-owned native-UI seam (ADR-019/020).
 * - `supportsMainEval: true` — `electronApp.evaluate()`.
 * - `supportsRendererEval: true` — `page.evaluate()`.
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { StagewrightError } from '../errors/registry.js'
import {
  NOTIFICATION_REGISTRY_GLOBAL,
  TRAY_REGISTRY_GLOBAL,
  buildInstrumentationShim,
} from './native-instrumentation.js'
import type {
  EvalPayload,
  PWConsoleMessage,
  PWCookie,
  PWDialog,
  PWElectron,
  PWElectronApp,
  PWModule,
  PWPage,
  PWRequest,
  PWResponse,
  PWRoute,
} from './playwright-electron-api.js'
import { copyDialogPolicy, resolveDialogResponse } from './dialog-policy.js'
import {
  bodyCapturePlan,
  bodyContentTypeAllowed,
  captureBodyField,
  copyNetworkFilter,
  copyNetworkStub,
  headerValue,
  matchesNetworkFilter,
  type BodyCapturePlan,
} from './network-filter.js'
import {
  EDITABLE_SIGNATURE_BODY,
  TYPE_EFFECT_SETTLE_MS,
  buildScrollIntoViewBody,
} from './playwright-electron-bodies.js'
import type {
  AttachOptions,
  ClickOptions,
  ConsoleEntry,
  ConsoleLogsResult,
  ConsoleStream,
  DialogEvent,
  DialogEventsOptions,
  DialogEventsResult,
  DialogPolicy,
  ITransport,
  InjectOptions,
  InteractionOptions,
  ClockInstallOptions,
  ClockTime,
  CookieFilter,
  IpcChannel,
  LaunchOptions,
  MenuInvokeResult,
  NativeMenu,
  NativeMenuItem,
  NativeNotification,
  NativeTray,
  NetworkCaptureFilter,
  NetworkEvent,
  NetworkEventsOptions,
  NetworkEventsResult,
  NetworkStub,
  NotificationCaptureFilter,
  PressOptions,
  ScreenshotOptions,
  ScrollOptions,
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
  WindowRef,
} from './types.js'

const TRANSPORT_ID: TransportId = 'playwright-electron'

/**
 * Default budget for a graceful `stop` before escalating to SIGKILL. A hung app
 * (dead renderer, dev-server-backed session) can ignore `app.close()` far past
 * the dispatcher's operation timeout; this bound guarantees a stop always
 * resolves with the process reaped.
 */
const STOP_GRACEFUL_BUDGET_MS = 10_000
/** Bounded wait for Playwright's close() to settle after an escalation SIGKILL. */
const POST_KILL_SETTLE_MS = 5_000

/**
 * Resolve `true` when `ms` elapses before `settled` resolves. `settled` must
 * never reject (callers attach their own catch). The timer never keeps the
 * process alive.
 */
function timedOut(settled: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(true), ms)
    timer.unref?.()
    void settled.then(() => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

/** Remove the launch-shim temp dir (best-effort, idempotent — a no-op when not instrumented). */
async function removeShimDir(shimDir: string | undefined): Promise<void> {
  if (shimDir === undefined) return
  await rm(shimDir, { recursive: true, force: true }).catch(() => undefined)
}

/** Sleep helper for the window-recovery poll loop. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * Total request duration in ms from Playwright's resource timing, or undefined when unavailable.
 * `timing().responseEnd` is the offset from request start; `-1` means "not measured".
 */
function safeDurationMs(request: PWRequest): number | undefined {
  try {
    const responseEnd = request.timing().responseEnd
    return responseEnd >= 0 ? responseEnd : undefined
  } catch {
    return undefined
  }
}

/**
 * Capture the request body (synchronously, from `postData()`) into the event's `requestBody*` fields,
 * gated by the request's content-type. Returns an empty object when there is no body, the content-type
 * is not text-ish, or `postData()` throws — body capture never blocks recording the event.
 */
function requestBodyFields(
  request: PWRequest,
  requestHeaders: Record<string, string>,
  plan: BodyCapturePlan,
): Pick<NetworkEvent, 'requestBody' | 'requestBodyBytes' | 'requestBodyTruncated'> {
  let postData: string | null
  try {
    postData = request.postData()
  } catch {
    return {}
  }
  if (postData === null || postData === '') return {}
  if (!bodyContentTypeAllowed(headerValue(requestHeaders, 'content-type'), plan.contentTypes)) {
    return {}
  }
  const captured = captureBodyField(Buffer.from(postData, 'utf8'), plan.mode, plan.maxBytes)
  return {
    ...(captured.body !== undefined ? { requestBody: captured.body } : {}),
    requestBodyBytes: captured.bytes,
    ...(captured.truncated ? { requestBodyTruncated: true } : {}),
  }
}

/**
 * Capture the response body (awaiting `response.body()`) into the event's `responseBody*` fields, gated
 * by the response content-type. Returns an empty object when the content-type is not text-ish or the
 * body read throws (already-consumed / no body) — a body failure records the event WITHOUT a body.
 */
async function responseBodyFields(
  response: PWResponse,
  responseHeaders: Record<string, string>,
  plan: BodyCapturePlan,
): Promise<Pick<NetworkEvent, 'responseBody' | 'responseBodyBytes' | 'responseBodyTruncated'>> {
  if (!bodyContentTypeAllowed(headerValue(responseHeaders, 'content-type'), plan.contentTypes)) {
    return {}
  }
  let buf: Buffer
  try {
    buf = await response.body()
  } catch {
    return {}
  }
  const captured = captureBodyField(buf, plan.mode, plan.maxBytes)
  return {
    ...(captured.body !== undefined ? { responseBody: captured.body } : {}),
    responseBodyBytes: captured.bytes,
    ...(captured.truncated ? { responseBodyTruncated: true } : {}),
  }
}

/** A registered stub plus its remaining-use budget (`Infinity` when {@link NetworkStub.times} is unset). */
interface ActiveStub {
  readonly stub: NetworkStub
  remaining: number
}

/** Map a Playwright cookie to the JSON-serialisable {@link StorageCookie} (conditional for exactOptional). */
function pwCookieToStorage(c: PWCookie): StorageCookie {
  return {
    name: c.name,
    value: c.value,
    ...(c.domain !== undefined ? { domain: c.domain } : {}),
    ...(c.path !== undefined ? { path: c.path } : {}),
    ...(c.expires !== undefined ? { expires: c.expires } : {}),
    ...(c.httpOnly !== undefined ? { httpOnly: c.httpOnly } : {}),
    ...(c.secure !== undefined ? { secure: c.secure } : {}),
    ...(c.sameSite !== undefined ? { sameSite: c.sameSite } : {}),
  }
}

/** Map a {@link StorageCookie} (agent input) onto a Playwright cookie for `addCookies`. */
function storageCookieToPw(c: StorageCookie): PWCookie {
  return {
    name: c.name,
    value: c.value,
    ...(c.url !== undefined ? { url: c.url } : {}),
    ...(c.domain !== undefined ? { domain: c.domain } : {}),
    ...(c.path !== undefined ? { path: c.path } : {}),
    ...(c.expires !== undefined ? { expires: c.expires } : {}),
    ...(c.httpOnly !== undefined ? { httpOnly: c.httpOnly } : {}),
    ...(c.secure !== undefined ? { secure: c.secure } : {}),
    ...(c.sameSite !== undefined ? { sameSite: c.sameSite } : {}),
  }
}

/** Map the transport-neutral interaction options onto Playwright's action options. */
function toActionOptions(opts: InteractionOptions): { force?: boolean; timeout?: number } {
  return {
    ...(opts.force !== undefined ? { force: opts.force } : {}),
    ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
  }
}

/** Map {@link ClickOptions} onto Playwright's click options (adds button + clickCount). */
function toClickOptions(opts: ClickOptions): {
  force?: boolean
  timeout?: number
  button?: 'left' | 'right' | 'middle'
  clickCount?: number
} {
  return {
    ...toActionOptions(opts),
    ...(opts.button !== undefined ? { button: opts.button } : {}),
    ...(opts.clickCount !== undefined ? { clickCount: opts.clickCount } : {}),
  }
}

/** Map the transport-neutral timeout option onto Playwright APIs that lack `force`. */
function toTimeoutOptions(opts: { readonly timeoutMs?: number }): { timeout?: number } {
  return {
    ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
  }
}

export interface PlaywrightElectronTransportOptions {
  readonly loadElectron?: () => Promise<PWElectron>
  /**
   * Override for the window-recovery budget (how long a session waits for a
   * window to (re)appear when Playwright's known list is empty). Primarily a
   * test seam; defaults to 10s.
   */
  readonly windowRecoveryBudgetMs?: number
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
  /** True when this session was launched with `instrumentNative` (the tray hook is in place). */
  private readonly instrumented: boolean
  /** Temp dir holding the launch shim, removed on dispose; undefined when not instrumented. */
  private readonly shimDir: string | undefined

  /** Max console entries retained; older ones are dropped and counted in `#consoleOverflow`. */
  static readonly #CONSOLE_CAP = 1000
  private readonly consoleBuffer: ConsoleEntry[] = []
  private consoleOverflow = 0

  /** Max dialog events retained; older ones are dropped and counted in `dialogOverflow`. */
  static readonly #DIALOG_CAP = 200
  private readonly dialogBuffer: DialogEvent[] = []
  private dialogOverflow = 0
  /**
   * Active dialog auto-response policy. Defaults to `dismiss` so that — the moment
   * a `dialog` listener is attached (which stops Playwright's own auto-dismiss) —
   * every dialog is still resolved and the renderer never hangs, even before the
   * agent arms anything.
   */
  private dialogPolicy: DialogPolicy = { action: 'dismiss' }

  /** Pages that already have console/dialog/network listeners, so re-attach is a no-op. */
  private readonly capturedPages = new WeakSet<PWPage>()

  /** Max network events retained; older ones are dropped and counted in `networkOverflow`. */
  static readonly #NETWORK_CAP = 1000
  private readonly networkBuffer: NetworkEvent[] = []
  private networkOverflow = 0
  /**
   * The active capture filter, or `null` when not capturing. Network listeners attach alongside the
   * console/dialog ones (so current and future windows are covered with no extra bookkeeping) but
   * stay inert until armed — they record only while this is non-null, so `stopNetworkCapture` is just
   * nulling it, with no fragile per-page listener detach.
   */
  private networkFilter: NetworkCaptureFilter | null = null

  /**
   * Active network stubs (first registered match wins) and the pages a catch-all interceptor is
   * attached to. The route is attached lazily on the first stub and removed when the last is cleared,
   * so non-stubbed traffic is never intercepted once stubbing is off. `routeHandler` is a single stable
   * reference so `page.route` / `page.unroute` pair up.
   */
  private networkStubs: ActiveStub[] = []
  private readonly stubbedPages = new Set<PWPage>()
  private readonly routeHandler = (route: PWRoute): Promise<void> => this.handleRoute(route)

  /** Window-recovery budget — how long `activePage` waits for a window to (re)appear. */
  private readonly windowRecoveryBudgetMs: number

  constructor(
    app: PWElectronApp,
    initialPage?: PWPage,
    windowRecoveryBudgetMs?: number,
    instrumentation?: { readonly instrumented: boolean; readonly shimDir?: string },
  ) {
    this.id = `pw-${randomUUID()}`
    this.app = app
    this.instrumented = instrumentation?.instrumented ?? false
    this.shimDir = instrumentation?.shimDir
    this.windowRecoveryBudgetMs =
      windowRecoveryBudgetMs ?? PlaywrightSession.#WINDOW_RECOVERY_BUDGET_MS
    // Best-effort console + dialog capture across EVERY window: the launch-time
    // window(s) and any window the app opens later (the `window` event). A failure
    // to attach is non-fatal — the buffers simply stay empty. When the caller
    // already resolved the first window (launch does), reuse it so we make no
    // extra firstWindow() call.
    if (initialPage !== undefined) this.attachCaptureTo(initialPage)
    try {
      for (const page of app.windows()) this.attachCaptureTo(page)
      app.on?.('window', (page) => this.attachCaptureTo(page))
    } catch {
      // Event capture is best-effort; a dead app handle is not an error here.
    }
  }

  /** Attach console + dialog + network listeners to `page` exactly once (later windows included). */
  private attachCaptureTo(page: PWPage): void {
    if (this.capturedPages.has(page)) return
    this.capturedPages.add(page)
    const windowId = this.idForWindow(page)
    try {
      page.on('console', (message) => this.pushConsole(message, windowId))
      page.on('dialog', (dialog) => {
        // `handleDialog` is fire-and-forget; a malformed dialog handle (a throwing
        // getter) would otherwise surface as an unhandled rejection and, under Node's
        // default `--unhandled-rejections=throw`, terminate the whole server. Swallow
        // here so one bad dialog can never take down every live session.
        void this.handleDialog(dialog, windowId).catch(() => {})
      })
      // Network listeners attach unconditionally but are inert until capture is armed (they early-out
      // on a null filter). `requestfinished` reads the response (async); `requestfailed` is sync.
      page.on('requestfinished', (request) => {
        void this.recordRequestFinished(request, windowId).catch(() => {})
      })
      page.on('requestfailed', (request) => this.recordRequestFailed(request, windowId))
    } catch {
      // A page that refuses listeners (already closed) is skipped, not fatal.
    }
    // A window opened while stubbing is active needs the interceptor too (best-effort, async).
    if (this.networkStubs.length > 0) void this.attachStubRouteTo(page).catch(() => {})
  }

  /** Resolve a native JS dialog per the active policy and record what happened. */
  private async handleDialog(dialog: PWDialog, windowId: string): Promise<void> {
    // Read the dialog's fields BEFORE responding — accept()/dismiss() can
    // invalidate the handle.
    const type = dialog.type()
    const message = dialog.message()
    const defaultValue = dialog.defaultValue()
    const policy = this.dialogPolicy
    const { action, promptText } = resolveDialogResponse(policy, type)

    // A one-shot policy reverts to the safe default after a single dialog, so a
    // lingering `accept` cannot silently confirm a later, unexpected dialog.
    if (policy.oneShot === true) {
      this.dialogPolicy = { action: 'dismiss' }
    }

    try {
      if (action === 'accept') {
        await dialog.accept(promptText)
      } else {
        await dialog.dismiss()
      }
    } catch {
      // The dialog may already be handled or the page may have closed mid-flight;
      // recording the event is still useful for post-mortem, so swallow and fall
      // through to push it.
    }

    this.pushDialog({
      type,
      message,
      action,
      ...(defaultValue !== '' ? { defaultValue } : {}),
      ...(promptText !== undefined ? { promptText } : {}),
      timestamp: Date.now(),
      windowId,
    })
  }

  /** Append a captured dialog event, dropping the oldest when the buffer is full. */
  private pushDialog(entry: DialogEvent): void {
    this.dialogBuffer.push(entry)
    if (this.dialogBuffer.length > PlaywrightSession.#DIALOG_CAP) {
      this.dialogBuffer.shift()
      this.dialogOverflow += 1
    }
  }

  /** Append a captured console message, dropping the oldest when the buffer is full. */
  private pushConsole(message: PWConsoleMessage, windowId: string): void {
    const loc = message.location()
    const entry: ConsoleEntry = {
      type: message.type(),
      text: message.text(),
      timestamp: Date.now(),
      windowId,
      ...(loc.url !== undefined || loc.lineNumber !== undefined
        ? {
            location: {
              ...(loc.url !== undefined ? { url: loc.url } : {}),
              ...(loc.lineNumber !== undefined ? { line: loc.lineNumber } : {}),
              ...(loc.columnNumber !== undefined ? { column: loc.columnNumber } : {}),
            },
          }
        : {}),
    }
    this.consoleBuffer.push(entry)
    if (this.consoleBuffer.length > PlaywrightSession.#CONSOLE_CAP) {
      this.consoleBuffer.shift()
      this.consoleOverflow += 1
    }
  }

  async consoleLogs(): Promise<ConsoleLogsResult> {
    this.requireRunning()
    return { entries: [...this.consoleBuffer], overflowed: this.consoleOverflow }
  }

  async setDialogPolicy(policy: DialogPolicy): Promise<void> {
    this.requireRunning()
    this.dialogPolicy = copyDialogPolicy(policy)
  }

  async dialogEvents(opts: DialogEventsOptions = {}): Promise<DialogEventsResult> {
    this.requireRunning()
    // Snapshot the buffer (a copy) BEFORE an optional clear, so the returned
    // entries survive the flush.
    const result: DialogEventsResult = {
      entries: [...this.dialogBuffer],
      overflowed: this.dialogOverflow,
      policy: copyDialogPolicy(this.dialogPolicy),
    }
    if (opts.clear === true) {
      this.dialogBuffer.length = 0
      this.dialogOverflow = 0
    }
    return result
  }

  /** Record a completed request when capturing and its method+URL match the active filter. */
  private async recordRequestFinished(request: PWRequest, windowId: string): Promise<void> {
    const filter = this.networkFilter
    if (filter === null) return
    const method = request.method()
    const url = request.url()
    if (!matchesNetworkFilter({ method, url }, filter)) return
    // Read the synchronous request fields BEFORE the first await (the response) — the
    // event-capture lesson from the console/dialog buffers, applied defensively here too.
    const resourceType = request.resourceType()
    const requestHeaders = request.headers()
    const durationMs = safeDurationMs(request)
    const bodyPlan = bodyCapturePlan(filter)
    const requestBody =
      bodyPlan !== null ? requestBodyFields(request, requestHeaders, bodyPlan) : {}
    const response = await request.response()
    // stopNetworkCapture() / startNetworkCapture() can run during the await above. If the armed filter
    // changed, this in-flight response belongs to a capture that is no longer active — drop it rather
    // than push a ghost into a buffer that stop cleared (or a re-arm replaced).
    if (this.networkFilter !== filter) return
    const status = response?.status()
    const responseHeaders = response?.headers()
    let responseBody: Pick<
      NetworkEvent,
      'responseBody' | 'responseBodyBytes' | 'responseBodyTruncated'
    > = {}
    if (bodyPlan !== null && response !== null && responseHeaders !== undefined) {
      responseBody = await responseBodyFields(response, responseHeaders, bodyPlan)
      // The body read is a SECOND await — re-check the armed filter once more before the push, so a
      // capture stopped/re-armed mid-body-read cannot land a ghost in the cleared buffer.
      if (this.networkFilter !== filter) return
    }
    this.pushNetwork({
      method,
      url,
      resourceType,
      ...(status !== undefined ? { status, ok: status >= 200 && status < 300 } : {}),
      requestHeaders,
      ...requestBody,
      ...(responseHeaders !== undefined ? { responseHeaders } : {}),
      ...responseBody,
      ...(durationMs !== undefined ? { durationMs } : {}),
      timestamp: Date.now(),
      windowId,
    })
  }

  /** Record a failed request when capturing and its method+URL match the active filter. */
  private recordRequestFailed(request: PWRequest, windowId: string): void {
    const filter = this.networkFilter
    if (filter === null) return
    const method = request.method()
    const url = request.url()
    if (!matchesNetworkFilter({ method, url }, filter)) return
    const requestHeaders = request.headers()
    const durationMs = safeDurationMs(request)
    const bodyPlan = bodyCapturePlan(filter)
    // A failed request still has a request body (the POST payload), so capture it on this path too.
    const requestBody =
      bodyPlan !== null ? requestBodyFields(request, requestHeaders, bodyPlan) : {}
    this.pushNetwork({
      method,
      url,
      resourceType: request.resourceType(),
      requestHeaders,
      ...requestBody,
      failure: request.failure()?.errorText ?? 'request failed',
      ...(durationMs !== undefined ? { durationMs } : {}),
      timestamp: Date.now(),
      windowId,
    })
  }

  /** Append a captured network event, dropping the oldest when the buffer is full. */
  private pushNetwork(entry: NetworkEvent): void {
    this.networkBuffer.push(entry)
    if (this.networkBuffer.length > PlaywrightSession.#NETWORK_CAP) {
      this.networkBuffer.shift()
      this.networkOverflow += 1
    }
  }

  async startNetworkCapture(filter: NetworkCaptureFilter): Promise<void> {
    this.requireRunning()
    this.networkFilter = copyNetworkFilter(filter)
    this.networkBuffer.length = 0
    this.networkOverflow = 0
  }

  async networkEvents(opts: NetworkEventsOptions = {}): Promise<NetworkEventsResult> {
    this.requireRunning()
    const result: NetworkEventsResult = {
      events: [...this.networkBuffer],
      overflowed: this.networkOverflow,
    }
    if (opts.clear === true) {
      this.networkBuffer.length = 0
      this.networkOverflow = 0
    }
    return result
  }

  async stopNetworkCapture(): Promise<void> {
    this.requireRunning()
    this.networkFilter = null
    this.networkBuffer.length = 0
    this.networkOverflow = 0
  }

  /**
   * The catch-all interceptor: fulfill/abort the first matching active stub (honouring `times` and
   * `delayMs`), else let the request continue. MUST resolve the route on every path — a route left
   * unresolved hangs the request — so a thrown handler falls back to `continue()`.
   */
  private async handleRoute(route: PWRoute): Promise<void> {
    let consumedFiniteStub = false
    try {
      this.pruneExpiredStubs()
      const request = route.request()
      const url = request.url()
      const method = request.method()
      const active = this.networkStubs.find(
        (entry) => entry.remaining > 0 && matchesNetworkFilter({ url, method }, entry.stub),
      )
      if (active === undefined) {
        if (this.networkStubs.length === 0) await this.detachStubRoutes()
        await route.continue()
        return
      }
      if (Number.isFinite(active.remaining)) {
        active.remaining -= 1
        consumedFiniteStub = true
      }
      if (active.stub.delayMs !== undefined && active.stub.delayMs > 0) {
        await delay(active.stub.delayMs)
      }
      if (active.stub.abort !== undefined) {
        await route.abort(active.stub.abort)
        return
      }
      const fulfill = active.stub.fulfill ?? {}
      await route.fulfill({
        ...(fulfill.status !== undefined ? { status: fulfill.status } : {}),
        ...(fulfill.headers !== undefined ? { headers: fulfill.headers } : {}),
        ...(fulfill.contentType !== undefined ? { contentType: fulfill.contentType } : {}),
        ...(fulfill.body !== undefined ? { body: fulfill.body } : {}),
      })
    } catch {
      // Never leave a route unresolved: fall back to live traffic.
      try {
        await route.continue()
      } catch {
        // The route was already resolved, or the page went away — nothing left to do.
      }
    } finally {
      if (consumedFiniteStub) await this.detachStubRoutesIfIdle()
    }
  }

  /** Drop spent finite-use stubs so `times` expiry really turns interception off when idle. */
  private pruneExpiredStubs(): void {
    this.networkStubs = this.networkStubs.filter((entry) => entry.remaining > 0)
  }

  /** Remove the catch-all route once no active stubs remain (including all-expired `times` stubs). */
  private async detachStubRoutesIfIdle(): Promise<void> {
    this.pruneExpiredStubs()
    if (this.networkStubs.length === 0) await this.detachStubRoutes()
  }

  /** Attach the catch-all interceptor to `page` exactly once. */
  private async attachStubRouteTo(page: PWPage): Promise<void> {
    if (this.stubbedPages.has(page)) return
    this.stubbedPages.add(page)
    try {
      await page.route('**/*', this.routeHandler)
    } catch {
      // A page that refuses the route (already closed) is dropped, not fatal.
      this.stubbedPages.delete(page)
    }
  }

  /** Remove the interceptor from every routed page and forget them (called when the last stub clears). */
  private async detachStubRoutes(): Promise<void> {
    const pages = [...this.stubbedPages]
    this.stubbedPages.clear()
    for (const page of pages) {
      try {
        await page.unroute('**/*', this.routeHandler)
      } catch {
        // The page is closed or was never routed — nothing to undo.
      }
    }
  }

  async stubNetwork(stub: NetworkStub): Promise<void> {
    const app = this.requireRunning()
    this.pruneExpiredStubs()
    const wasEmpty = this.networkStubs.length === 0
    this.networkStubs.push({ stub: copyNetworkStub(stub), remaining: stub.times ?? Infinity })
    if (wasEmpty) {
      try {
        for (const page of app.windows()) await this.attachStubRouteTo(page)
      } catch {
        // Best-effort across windows; a dead handle is not fatal to registering the stub.
      }
    }
  }

  async clearNetworkStubs(url?: string): Promise<void> {
    this.requireRunning()
    this.networkStubs =
      url === undefined ? [] : this.networkStubs.filter((entry) => !entry.stub.urls.includes(url))
    if (this.networkStubs.length === 0) await this.detachStubRoutes()
  }

  // --- Clock control: Playwright's page.clock over the active window (ADR-017). ---

  async installClock(options: ClockInstallOptions = {}): Promise<void> {
    this.requireRunning()
    const clock = (await this.activePage()).clock
    await clock.install(options.time !== undefined ? { time: options.time } : {})
  }

  async setFixedTime(time: ClockTime): Promise<void> {
    this.requireRunning()
    const clock = (await this.activePage()).clock
    // Playwright's setFixedTime only pins Date while real-time timers keep firing. The Stagewright
    // seam promises a true hold: Date is set to the instant AND the fake timer queue stays paused
    // until advance/runFor/resume moves it again.
    await clock.setSystemTime(time)
    await clock.pauseAt(time)
  }

  async setSystemTime(time: ClockTime): Promise<void> {
    this.requireRunning()
    const clock = (await this.activePage()).clock
    await clock.setSystemTime(time)
    await clock.resume()
  }

  async advanceClock(ms: number): Promise<void> {
    this.requireRunning()
    await (await this.activePage()).clock.fastForward(ms)
  }

  async runClockFor(ms: number): Promise<void> {
    this.requireRunning()
    await (await this.activePage()).clock.runFor(ms)
  }

  async pauseClockAt(time: ClockTime): Promise<void> {
    this.requireRunning()
    await (await this.activePage()).clock.pauseAt(time)
  }

  async resumeClock(): Promise<void> {
    this.requireRunning()
    await (await this.activePage()).clock.resume()
  }

  // --- Storage: Playwright's BrowserContext cookies + storageState (ADR-018, no eval). ---

  async getCookies(filter?: CookieFilter): Promise<readonly StorageCookie[]> {
    this.requireRunning()
    const ctx = (await this.activePage()).context()
    const raw = await ctx.cookies(filter?.urls !== undefined ? [...filter.urls] : undefined)
    const cookies = raw.map(pwCookieToStorage)
    return filter?.name !== undefined ? cookies.filter((c) => c.name === filter.name) : cookies
  }

  async setCookie(cookie: StorageCookie): Promise<void> {
    this.requireRunning()
    const ctx = (await this.activePage()).context()
    await ctx.addCookies([storageCookieToPw(cookie)])
  }

  async clearCookies(filter?: CookieFilter): Promise<void> {
    this.requireRunning()
    const ctx = (await this.activePage()).context()
    if (filter === undefined || (filter.urls === undefined && filter.name === undefined)) {
      await ctx.clearCookies()
      return
    }
    if (filter.urls === undefined && filter.name !== undefined) {
      await ctx.clearCookies({ name: filter.name })
      return
    }
    // URL-scoped (optionally + name): read the matching cookies and clear each precisely by
    // name/domain/path, since Playwright's clearCookies has no URL option.
    for (const c of await this.getCookies(filter)) {
      await ctx.clearCookies({
        name: c.name,
        ...(c.domain !== undefined ? { domain: c.domain } : {}),
        ...(c.path !== undefined ? { path: c.path } : {}),
      })
    }
  }

  async storageSnapshot(): Promise<StorageSnapshot> {
    this.requireRunning()
    const ctx = (await this.activePage()).context()
    const state = await ctx.storageState()
    return {
      cookies: state.cookies.map(pwCookieToStorage),
      origins: state.origins.map((o) => ({
        origin: o.origin,
        localStorage: o.localStorage.map((e) => ({ name: e.name, value: e.value })),
      })),
    }
  }

  // --- Native UI: read/invoke the application menu from the main process (ADR-019, no agent eval). ---

  async getApplicationMenu(): Promise<NativeMenu | null> {
    const app = this.requireRunning()
    // The serializer runs in the Electron MAIN process via Playwright's electronApp.evaluate. It MUST be
    // fully self-contained (no closure refs) — Playwright source-extracts the function — so the recursive
    // walker is declared inline. It reads only the data fields (the click handler and Electron-internal
    // refs are never touched), so the result is JSON-serialisable, and surfaces `role` so role-based
    // items with no explicit label stay findable.
    return app.evaluate<NativeMenu | null>((electron) => {
      const menuModule = (electron as { Menu?: { getApplicationMenu?: () => unknown } }).Menu
      const root =
        menuModule !== undefined && typeof menuModule.getApplicationMenu === 'function'
          ? menuModule.getApplicationMenu()
          : null
      if (root === null || root === undefined) return null
      interface RawItem {
        id?: unknown
        label?: unknown
        role?: unknown
        type?: unknown
        accelerator?: unknown
        enabled?: unknown
        visible?: unknown
        checked?: unknown
        sublabel?: unknown
        toolTip?: unknown
        submenu?: { items?: unknown } | undefined
      }
      const str = (v: unknown): string => (typeof v === 'string' ? v : '')
      function serializeItem(raw: RawItem): NativeMenuItem {
        const rawType = str(raw.type)
        const type: NativeMenuItem['type'] =
          rawType === 'separator' ||
          rawType === 'submenu' ||
          rawType === 'checkbox' ||
          rawType === 'radio' ||
          rawType === 'header' ||
          rawType === 'palette'
            ? rawType
            : 'normal'
        const item: {
          id?: string
          label: string
          role?: string
          type: NativeMenuItem['type']
          accelerator?: string
          enabled: boolean
          visible: boolean
          checked?: boolean
          sublabel?: string
          toolTip?: string
          submenu?: NativeMenuItem[]
        } = {
          label: str(raw.label),
          type,
          enabled: raw.enabled !== false,
          visible: raw.visible !== false,
        }
        if (typeof raw.id === 'string' && raw.id !== '') item.id = raw.id
        if (typeof raw.role === 'string' && raw.role !== '') item.role = raw.role
        if (typeof raw.accelerator === 'string' && raw.accelerator !== '')
          item.accelerator = raw.accelerator
        if (item.type === 'checkbox' || item.type === 'radio') item.checked = raw.checked === true
        if (typeof raw.sublabel === 'string' && raw.sublabel !== '') item.sublabel = raw.sublabel
        if (typeof raw.toolTip === 'string' && raw.toolTip !== '') item.toolTip = raw.toolTip
        const subItems = raw.submenu?.items
        if (Array.isArray(subItems)) item.submenu = subItems.map((s) => serializeItem(s as RawItem))
        return item
      }
      const items = (root as { items?: unknown }).items
      return { items: Array.isArray(items) ? items.map((i) => serializeItem(i as RawItem)) : [] }
    })
  }

  async invokeApplicationMenuItem(path: readonly string[]): Promise<MenuInvokeResult> {
    const app = this.requireRunning()
    // The walker runs in the Electron MAIN process via electronApp.evaluate and MUST be self-contained
    // (no closure refs). It resolves the path in the LIVE menu (matching each segment by label OR role,
    // like the read), refuses a disabled item, then calls the app's own `click` handler. A throwing
    // handler is re-surfaced as a clean error rather than a raw app stack.
    return app.evaluate<MenuInvokeResult>(
      (electron, payload) => {
        const mod = electron as {
          Menu?: { getApplicationMenu?: () => unknown }
          BrowserWindow?: { getFocusedWindow?: () => unknown; getAllWindows?: () => unknown[] }
        }
        const segments = ((payload?.arg as { path?: readonly string[] } | undefined)?.path ??
          []) as readonly string[]
        const root =
          mod.Menu !== undefined && typeof mod.Menu.getApplicationMenu === 'function'
            ? mod.Menu.getApplicationMenu()
            : null
        if (root === null || root === undefined) return { invoked: false, reason: 'not_found' }
        interface RawItem {
          label?: unknown
          role?: unknown
          type?: unknown
          enabled?: unknown
          click?: unknown
          submenu?: unknown
        }
        const submenuItems = (raw: RawItem): readonly unknown[] | null => {
          const submenu = raw.submenu
          if (submenu === null || typeof submenu !== 'object') return null
          const nested = (submenu as { items?: unknown }).items
          return Array.isArray(nested) ? nested : null
        }
        const isElectronMenuItem = (raw: RawItem): boolean => {
          const keys = Object.keys(raw as Record<string, unknown>)
          return keys.includes('commandId') || keys.includes('userAccelerator')
        }
        const hasAppDefinedClick = (raw: RawItem): boolean => {
          if (typeof raw.click !== 'function') return false
          if (!isElectronMenuItem(raw)) return true
          // Electron installs a default MenuItem.click wrapper on every item. When the app supplied a
          // click option, Electron preserves that option's property slot before its default fields; the
          // default-only wrapper is appended after userAccelerator. This keeps `no_handler` honest instead
          // of treating every inert normal item as successfully invoked.
          const keys = Object.keys(raw as Record<string, unknown>)
          const clickIndex = keys.indexOf('click')
          const submenuIndex = keys.indexOf('submenu')
          return clickIndex !== -1 && submenuIndex !== -1 && clickIndex < submenuIndex
        }
        let items: unknown = (root as { items?: unknown }).items
        let item: RawItem | null = null
        for (const seg of segments) {
          const arr = Array.isArray(items) ? (items as RawItem[]) : []
          item = arr.find((i) => i.label === seg || i.role === seg) ?? null
          if (item === null) return { invoked: false, reason: 'not_found' }
          if (item.enabled === false) return { invoked: false, reason: 'disabled' }
          items = submenuItems(item) ?? []
        }
        if (item === null) return { invoked: false, reason: 'not_found' }
        if (typeof item.role === 'string' && item.role !== '')
          return { invoked: false, reason: 'role' }
        if (item.type === 'submenu' || submenuItems(item) !== null)
          return { invoked: false, reason: 'submenu' }
        if (item.type === 'separator') return { invoked: false, reason: 'separator' }
        if (hasAppDefinedClick(item)) {
          // In parallel smoke runs the app may not be frontmost, so Electron can report no focused
          // window even though the menu belongs to a live single-window app. Fall back to the first app
          // window so handlers that use their `window` argument remain deterministic.
          const focusedWindow =
            mod.BrowserWindow !== undefined &&
            typeof mod.BrowserWindow.getFocusedWindow === 'function'
              ? mod.BrowserWindow.getFocusedWindow()
              : undefined
          const windows =
            mod.BrowserWindow !== undefined && typeof mod.BrowserWindow.getAllWindows === 'function'
              ? mod.BrowserWindow.getAllWindows()
              : []
          const win = focusedWindow ?? windows[0]
          const focusedWebContents =
            win !== null &&
            typeof win === 'object' &&
            'webContents' in win &&
            (win as { webContents?: unknown }).webContents !== undefined
              ? (win as { webContents?: unknown }).webContents
              : undefined
          const clickFn = item.click as (
            event: unknown,
            focusedWindow: unknown,
            focusedWebContents: unknown,
          ) => void
          try {
            clickFn({}, win ?? undefined, focusedWebContents)
          } catch (err) {
            throw new Error(
              'menu item handler threw: ' + (err instanceof Error ? err.message : String(err)),
            )
          }
          const label = typeof item.label === 'string' ? item.label : ''
          return typeof item.role === 'string' && item.role !== ''
            ? { invoked: true, label, role: item.role }
            : { invoked: true, label }
        }
        return { invoked: false, reason: 'no_handler' }
      },
      { body: '', arg: { path } },
    )
  }

  // --- Native notifications: capture each shown notification via a main-process prototype hook. ---

  async startNotificationCapture(filter?: NotificationCaptureFilter): Promise<void> {
    const app = this.requireRunning()
    const titleContains = filter?.titleContains
    // Adopt-or-install. When the session was launched with `instrumentNative`, the launch shim already
    // installed the notification hook at t=0 (so startup notifications are already buffered) — arming just
    // ADOPTS that state: it sets the read-time filter, snapshots `armedSeq` (records before it are t=0 /
    // beforeArm), re-activates, and NEVER re-patches or resets the buffer. Otherwise it installs the hook
    // inline now. The inline installer MUST mirror NOTIFICATION_HOOK_BODY's record shape exactly (same
    // fields, same `_seq`/`needle`/`armedSeq`/`active` state) so `capturedNotifications` reads either path
    // identically — keep the two in sync. Self-contained (B5); records UNFILTERED (the filter applies at
    // read time). A prototype patch (not a constructor swap) survives `const { Notification } = require(...)`.
    await app.evaluate<void>(
      (electron, payload) => {
        const arg = payload?.arg as { key?: string; titleContains?: unknown } | undefined
        const key = arg?.key ?? ''
        const g = globalThis as unknown as Record<string, unknown>
        if (g[key] === undefined) {
          const proto = (electron as { Notification?: { prototype?: Record<string, unknown> } })
            .Notification?.prototype
          if (proto !== undefined && typeof proto['show'] === 'function') {
            const CAP = 1000
            const buffer: Array<Record<string, unknown>> = []
            const origShow = proto['show'] as (...args: unknown[]) => unknown
            const st: {
              buffer: Array<Record<string, unknown>>
              origShow: (...args: unknown[]) => unknown
              patchedShow?: (...args: unknown[]) => unknown
              active: boolean
              needle?: string
              nextSeq: number
              armedSeq?: number
            } = { buffer, origShow, active: true, nextSeq: 0 }
            const patchedShow = function (this: Record<string, unknown>, ...a: unknown[]): unknown {
              const result = origShow.apply(this, a)
              if (!st.active) return result
              try {
                const title = typeof this['title'] === 'string' ? (this['title'] as string) : ''
                const rec: Record<string, unknown> = { title, at: Date.now(), _seq: st.nextSeq++ }
                if (typeof this['body'] === 'string' && this['body'] !== '')
                  rec['body'] = this['body']
                if (typeof this['subtitle'] === 'string' && this['subtitle'] !== '')
                  rec['subtitle'] = this['subtitle']
                if (typeof this['silent'] === 'boolean') rec['silent'] = this['silent']
                const u = this['urgency']
                if (u === 'normal' || u === 'critical' || u === 'low') rec['urgency'] = u
                buffer.push(rec)
                if (buffer.length > CAP) buffer.shift()
              } catch {
                // Recording must never break the app's own notification.
              }
              return result
            }
            st.patchedShow = patchedShow
            proto['show'] = patchedShow
            g[key] = st
          }
        }
        const state = g[key] as
          | { needle?: unknown; active?: boolean; nextSeq?: number; armedSeq?: number }
          | undefined
        if (state !== undefined) {
          state.needle = typeof arg?.titleContains === 'string' ? arg.titleContains : undefined
          state.active = true
          state.armedSeq = typeof state.nextSeq === 'number' ? state.nextSeq : 0
        }
      },
      { body: '', arg: { key: NOTIFICATION_REGISTRY_GLOBAL, titleContains } },
    )
  }

  async capturedNotifications(): Promise<readonly NativeNotification[]> {
    const app = this.requireRunning()
    return app.evaluate<NativeNotification[]>(
      (_electron, payload) => {
        const key = (payload?.arg as { key?: string } | undefined)?.key ?? ''
        const state = (globalThis as unknown as Record<string, unknown>)[key] as
          | { buffer?: unknown; needle?: unknown; armedSeq?: unknown }
          | undefined
        const buffer = state?.buffer
        if (!Array.isArray(buffer)) return []
        // The hook records UNFILTERED; apply `titleContains` here so pre-arm (t=0) and post-arm records
        // filter uniformly. Rebuild each output object (the internal `_seq` never crosses the wire) and tag
        // a record shown before the arm snapshot as `beforeArm`.
        const needle = typeof state?.needle === 'string' ? (state.needle as string) : undefined
        const armedSeq =
          typeof state?.armedSeq === 'number' ? (state.armedSeq as number) : undefined
        const out: NativeNotification[] = []
        for (const raw of buffer as Array<Record<string, unknown>>) {
          const title = typeof raw['title'] === 'string' ? (raw['title'] as string) : ''
          if (needle !== undefined && !title.includes(needle)) continue
          const rec: Record<string, unknown> = {
            title,
            at: typeof raw['at'] === 'number' ? raw['at'] : 0,
          }
          // Mirror the recorders' emptiness guard so the reader stays in sync with the record shape.
          if (typeof raw['body'] === 'string' && raw['body'] !== '') rec['body'] = raw['body']
          if (typeof raw['subtitle'] === 'string' && raw['subtitle'] !== '')
            rec['subtitle'] = raw['subtitle']
          if (typeof raw['silent'] === 'boolean') rec['silent'] = raw['silent']
          const u = raw['urgency']
          if (u === 'normal' || u === 'critical' || u === 'low') rec['urgency'] = u
          if (
            armedSeq !== undefined &&
            typeof raw['_seq'] === 'number' &&
            (raw['_seq'] as number) < armedSeq
          ) {
            rec['beforeArm'] = true
          }
          out.push(rec as unknown as NativeNotification)
        }
        return out
      },
      { body: '', arg: { key: NOTIFICATION_REGISTRY_GLOBAL } },
    )
  }

  async stopNotificationCapture(): Promise<void> {
    const app = this.requireRunning()
    await app.evaluate<void>(
      (electron, payload) => {
        const key = (payload?.arg as { key?: string } | undefined)?.key ?? ''
        const g = globalThis as unknown as Record<string, unknown>
        const state = g[key] as
          | { origShow?: unknown; patchedShow?: unknown; active?: boolean }
          | undefined
        if (state === undefined) return
        state.active = false
        // Restore the original show only when it is still OUR patch (never clobber a later app patch
        // stacked on top), then drop the buffer. On an instrumented session this also tears down the
        // launch-installed t=0 hook — a subsequent re-arm installs fresh (t=0 is already past).
        const proto = (electron as { Notification?: { prototype?: Record<string, unknown> } })
          .Notification?.prototype
        if (
          proto !== undefined &&
          typeof state.origShow === 'function' &&
          typeof state.patchedShow === 'function' &&
          proto['show'] === state.patchedShow
        ) {
          proto['show'] = state.origShow
        }
        delete g[key]
      },
      { body: '', arg: { key: NOTIFICATION_REGISTRY_GLOBAL } },
    )
  }

  // --- Native trays: read the launch-time instrumentation registry (ADR-020). ---

  async getTrays(): Promise<readonly NativeTray[] | null> {
    const app = this.requireRunning()
    // Not launched with instrumentNative -> the tray hook was never installed, so trays are invisible
    // (no registry). Signal that distinctly (the plugin maps null to native.NOT_INSTRUMENTED).
    if (!this.instrumented) return null
    return app.evaluate<NativeTray[]>(
      (_electron, payload) => {
        const key = (payload?.arg as { key?: string } | undefined)?.key ?? ''
        const registry = (globalThis as unknown as Record<string, unknown>)[key]
        if (!Array.isArray(registry)) return []
        // The shim stores { inst, rec } entries; the rec is the JSON-serialisable NativeTray.
        return registry
          .map((entry) => (entry as { rec?: unknown }).rec)
          .filter((rec): rec is NativeTray => rec !== null && typeof rec === 'object')
      },
      { body: '', arg: { key: TRAY_REGISTRY_GLOBAL } },
    )
  }

  async invokeTrayEvent(id: number, event: TrayEventName): Promise<TrayInvokeResult | null> {
    const app = this.requireRunning()
    // Like getTrays, an uninstrumented session has no tray registry to act on -> null (the plugin maps
    // null to native.NOT_INSTRUMENTED).
    if (!this.instrumented) return null
    // The body runs in the Electron MAIN process via electronApp.evaluate and MUST be self-contained (B5,
    // no closure refs). It finds the live Tray by its registry id, refuses when the tray is gone or has no
    // listener for the event, synthesizes the (event, bounds, position) args a real tray click carries,
    // then emits — re-surfacing a throwing app handler as a clean error rather than a raw stack.
    return app.evaluate<TrayInvokeResult>(
      (_electron, payload) => {
        const arg = payload?.arg as { key?: string; id?: number; event?: string } | undefined
        const key = arg?.key ?? ''
        const targetId = arg?.id
        const eventName = arg?.event ?? ''
        if (typeof targetId !== 'number') return { emitted: false, reason: 'not_found' }
        const registry = (globalThis as unknown as Record<string, unknown>)[key]
        if (!Array.isArray(registry)) return { emitted: false, reason: 'not_found' }
        const entry = registry.find(
          (e) => (e as { rec?: { id?: unknown } }).rec?.id === targetId,
        ) as { inst?: unknown; rec?: unknown } | undefined
        if (entry === undefined || entry.inst === null || typeof entry.inst !== 'object') {
          return { emitted: false, reason: 'not_found' }
        }
        const inst = entry.inst as {
          emit?: (event: string, ...args: unknown[]) => boolean
          listenerCount?: (event: string) => number
          getBounds?: () => unknown
        }
        if (typeof inst.emit !== 'function') return { emitted: false, reason: 'not_found' }
        // Use the tray's real bounds when available so a handler that positions a popup/window at the tray
        // behaves faithfully; getBounds can throw on a destroyed tray / headless platform, so fall back.
        let bounds: unknown = { x: 0, y: 0, width: 0, height: 0 }
        try {
          if (typeof inst.getBounds === 'function') {
            const b = inst.getBounds()
            if (b !== null && typeof b === 'object') bounds = b
          }
        } catch {
          // Fall back to zero bounds.
        }
        // EventEmitter.emit returns true iff the event had listeners — the honest source of truth for "did
        // the app's handler run?". A false return means the tray registered no handler for this event, so
        // the fire was inert: report no_listener rather than claim a successful fire (the tray analog of
        // menu no_handler). Our event set never includes 'error', so emit-with-no-listeners is a safe no-op
        // (it does not throw). A throwing handler is re-surfaced as a clean error, not a raw app stack.
        let hadListeners: boolean
        try {
          hadListeners = inst.emit(eventName, {}, bounds, { x: 0, y: 0 }) === true
        } catch (err) {
          throw new Error(
            'tray handler threw: ' + (err instanceof Error ? err.message : String(err)),
          )
        }
        if (!hadListeners) return { emitted: false, reason: 'no_listener' }
        // Read the tray's record back AFTER the handler ran (the setter patches keep `rec` current), so a
        // handler that mutated its own tray is observable in one call. Re-find the registry entry instead
        // of using the pre-emit reference: the handler might have called tray.destroy(), which removes the
        // entry and should be reported as `tray: null` rather than a stale pre-destroy record.
        const afterEntry = registry.find(
          (e) => (e as { rec?: { id?: unknown } }).rec?.id === targetId,
        ) as { rec?: unknown } | undefined
        const rec = afterEntry?.rec
        const tray = rec !== null && typeof rec === 'object' ? (rec as NativeTray) : null
        return { emitted: true, id: targetId, event: eventName as TrayEventName, tray }
      },
      { body: '', arg: { key: TRAY_REGISTRY_GLOBAL, id, event } },
    )
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
    const payload: EvalPayload = arg === undefined ? { body } : { body, arg }
    // Playwright serialises a function plus one argument into the target context.
    // Main process receives (electron module namespace, payload); renderer receives
    // (payload). The payload body is still executed dynamically, but the wrapper is
    // actually invoked by Playwright instead of being treated as a passive string.
    //
    // Security note: this transport does NOT validate body content. The dispatcher
    // is responsible for calling validateEvalContent (see errors/operation-type.ts)
    // before invoking this method. Direct callers (tests, application code) that
    // bypass the dispatcher inherit the responsibility for validating untrusted
    // payloads. Prefer structured function serialization at any public API boundary
    // that accepts untrusted JavaScript.
    if (target === 'main') {
      return app.evaluate<T>(
        (electronApp, input) =>
          Function(
            'electronApp',
            'arg',
            `"use strict"; return (async () => { ${input.body} })()`,
          )(electronApp, input.arg),
        payload,
      )
    }
    const page = await this.activePage()
    return page.evaluate<T>(
      (input) =>
        Function('arg', `"use strict"; return (async () => { ${input.body} })()`)(input.arg),
      payload,
    )
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

  /** Default window-recovery budget (see {@link activePage}). */
  static readonly #WINDOW_RECOVERY_BUDGET_MS = 10_000
  /** Per-attempt slice for waiting on a `window` event during recovery. */
  static readonly #WINDOW_RECOVERY_SLICE_MS = 1_000
  /** Pause between known-list re-checks when `firstWindow` rejects immediately. */
  static readonly #WINDOW_RECOVERY_POLL_MS = 100

  /** The pages Playwright currently tracks that are not closed. */
  private openPages(app: PWElectronApp): readonly PWPage[] {
    return app.windows().filter((page) => page.isClosed === undefined || !page.isClosed())
  }

  /**
   * The active window that interaction targets — the first non-closed known
   * window. When the known list is momentarily empty (seen after an in-page
   * modal confirm: Playwright drops the page and `firstWindow()` blocks 30s
   * waiting for a NEW `window` event that never fires), this alternates short
   * `firstWindow` waits with re-checks of the known list, so a window that
   * Playwright re-registers WITHOUT an event is still found. Bounded by the
   * window-recovery budget; a session that truly has no window fails with a
   * registered code instead of hanging.
   */
  private async activePage(): Promise<PWPage> {
    const app = this.requireRunning()
    const known = this.openPages(app)[0]
    if (known !== undefined) return known
    const deadline = Date.now() + this.windowRecoveryBudgetMs
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      const attemptStarted = Date.now()
      try {
        const page = await app.firstWindow({
          timeout: Math.min(remaining, PlaywrightSession.#WINDOW_RECOVERY_SLICE_MS),
        })
        if (page.isClosed === undefined || !page.isClosed()) return page
      } catch {
        // Slice elapsed (or firstWindow rejected outright) — re-check the known
        // list below. Pause briefly when the rejection was immediate so a
        // hard-failing firstWindow cannot spin this loop hot.
        if (Date.now() - attemptStarted < PlaywrightSession.#WINDOW_RECOVERY_POLL_MS) {
          await delay(PlaywrightSession.#WINDOW_RECOVERY_POLL_MS)
        }
      }
      const reappeared = this.openPages(app)[0]
      if (reappeared !== undefined) return reappeared
    }
    throw new StagewrightError(
      'REF_NOT_FOUND',
      `No windows are open in the Electron app (waited ${this.windowRecoveryBudgetMs}ms for one to appear).`,
      { transport: TRANSPORT_ID, sessionId: this.id },
    )
  }

  async click(selector: string, opts: ClickOptions = {}): Promise<void> {
    await (await this.activePage()).click(selector, toClickOptions(opts))
  }

  async fill(selector: string, value: string, opts: InteractionOptions = {}): Promise<void> {
    const before = await this.readEditableSignature(selector, 0)
    await (await this.activePage()).fill(selector, value, toActionOptions(opts))
    await this.assertTyped(selector, value, before)
  }

  async hover(selector: string, opts: InteractionOptions = {}): Promise<void> {
    await (await this.activePage()).hover(selector, toActionOptions(opts))
  }

  async press(key: string, opts: PressOptions = {}): Promise<void> {
    const page = await this.activePage()
    if (opts.selector === undefined) {
      await page.keyboard.press(key)
      return
    }
    if (opts.force === true) {
      // Editor-aware path: focus the (possibly offscreen / aria-hidden) selector — focus
      // tolerates non-visible elements — then emit the key globally so editors like Monaco
      // receive it. Avoids page.press' visibility actionability (ELEMENT_NOT_VISIBLE).
      await page.focus(opts.selector, toTimeoutOptions(opts))
      await page.keyboard.press(key)
      return
    }
    await page.press(opts.selector, key, toTimeoutOptions(opts))
  }

  async typeText(text: string, opts: PressOptions = {}): Promise<void> {
    const page = await this.activePage()
    if (opts.selector === undefined) {
      await page.keyboard.type(text)
      return
    }
    if (opts.force === true) {
      // See press(): focus tolerates offscreen / aria-hidden inputs, then type globally. But a
      // focused-yet-inert input (e.g. a modern Monaco editor's hidden textarea, whose real input
      // is an EditContext element) silently swallows the keystrokes — so verify the content
      // actually changed and surface TYPE_NO_EFFECT instead of a false success.
      const before = await this.readEditableSignature(opts.selector, 0)
      await page.focus(opts.selector, toTimeoutOptions(opts))
      await page.keyboard.type(text)
      await this.assertTyped(opts.selector, text, before)
      return
    }
    // page.type focuses the selector and emits a real keystroke per character.
    const before = await this.readEditableSignature(opts.selector, 0)
    await page.type(opts.selector, text, toTimeoutOptions(opts))
    await this.assertTyped(opts.selector, text, before)
  }

  /** Read an element's editable content (value or textContent), or null when absent. */
  private async readEditableSignature(selector: string, settleMs: number): Promise<string | null> {
    return this.evaluate<string | null>('renderer', EDITABLE_SIGNATURE_BODY, { selector, settleMs })
  }

  /**
   * After a fill/type, confirm the text landed: the editable content changed, or already equals
   * the typed text (an idempotent re-fill). When non-empty text leaves the content unchanged and
   * not equal to it, the target ignored the input — throw `TYPE_NO_EFFECT`.
   *
   * Deliberately errs toward NOT throwing — a missed swallow is cheaper than a false rejection
   * that blocks a type that actually worked:
   * - empty text is a no-op (clearing / typing nothing is a legitimate no-change);
   * - an unreadable signature (`null`: the element is gone, or not reachable via
   *   `document.querySelector` — e.g. inside a shadow root Playwright pierced but our eval cannot)
   *   skips the check rather than risk a spurious failure;
   * - an editor whose model updates asynchronously gets {@link TYPE_EFFECT_SETTLE_MS} to settle
   *   before the re-read. A model slower than that settle is the residual false-negative this
   *   check accepts to keep the common (synchronous) case honest.
   */
  private async assertTyped(selector: string, text: string, before: string | null): Promise<void> {
    if (text.length === 0) return
    const after = await this.readEditableSignature(selector, TYPE_EFFECT_SETTLE_MS)
    if (after === null) return
    const landed = after !== before || after === text
    if (!landed) {
      throw new StagewrightError(
        'TYPE_NO_EFFECT',
        `Text did not land in "${selector}": its editable content did not change. The target ` +
          "likely ignores input routed to it (a code editor's hidden textarea). Click the " +
          'editor content area, then type into the active element with no selector.',
        { selector },
      )
    }
  }

  async selectOption(
    selector: string,
    values: readonly string[],
    opts: InteractionOptions = {},
  ): Promise<readonly string[]> {
    return (await this.activePage()).selectOption(selector, values, toActionOptions(opts))
  }

  async setChecked(
    selector: string,
    checked: boolean,
    opts: InteractionOptions = {},
  ): Promise<void> {
    const page = await this.activePage()
    if (checked) {
      await page.check(selector, toActionOptions(opts))
    } else {
      await page.uncheck(selector, toActionOptions(opts))
    }
  }

  async setInputFiles(
    selector: string,
    paths: readonly string[],
    opts: InteractionOptions = {},
  ): Promise<void> {
    await (await this.activePage()).setInputFiles(selector, paths, toTimeoutOptions(opts))
  }

  async dragTo(source: string, target: string, opts: InteractionOptions = {}): Promise<void> {
    await (await this.activePage()).dragAndDrop(source, target, toActionOptions(opts))
  }

  async scroll(opts: ScrollOptions = {}): Promise<void> {
    const page = await this.activePage()
    if (opts.selector !== undefined) {
      // Scroll the element into view via the renderer; avoids needing a separate
      // Playwright locator API in the minimal page surface. The body reports
      // whether the element was found so a no-match surfaces as SELECTOR_NO_MATCH
      // instead of resolving silently — every other interaction method rejects on
      // a missing target, and scroll must not diverge or the tool layer would
      // report a phantom success it cannot diagnose.
      const found = await page.evaluate<boolean>(
        (input) =>
          Function('arg', `"use strict"; return (async () => { ${input.body} })()`)(input.arg),
        {
          body: buildScrollIntoViewBody(),
          arg: { selector: opts.selector, timeoutMs: opts.timeoutMs },
        },
      )
      if (!found) {
        throw new StagewrightError(
          'SELECTOR_NO_MATCH',
          `scroll target "${opts.selector}" matched no element.`,
          { transport: TRANSPORT_ID, selector: opts.selector },
        )
      }
      return
    }
    await page.mouse.wheel(opts.dx ?? 0, opts.dy ?? 0)
  }

  private async resolveWindow(app: PWElectronApp, ref: WindowRef): Promise<PWPage> {
    let pages = app.windows()
    if (pages.length === 0) {
      // A modal swap / navigation can momentarily empty the known list — give the
      // window-recovery path a chance before concluding none exist.
      try {
        await this.activePage()
      } catch {
        // Fall through to the precise REF_NOT_FOUND below.
      }
      pages = app.windows()
    }
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
    // Idempotent — second and subsequent calls are no-ops, never throw. Routes
    // through the bounded graceful close so a hung app cannot wedge shutdown.
    await this.stopGracefully({})
  }

  /**
   * Bounded graceful shutdown with SIGKILL escalation. Closes the app within
   * `opts.timeoutMs` (default {@link STOP_GRACEFUL_BUDGET_MS}); when the close
   * does not settle in time — a hung renderer, a dev-server-backed session —
   * SIGKILLs the process so the caller never inherits an orphan it has no
   * handle to. Idempotent: a second call is a no-op reporting no escalation.
   */
  async stopGracefully(opts: StopOptions): Promise<StopResult> {
    if (this.disposed) return { escalated: false }
    this.disposed = true
    // Remove the launch shim temp dir exactly once (idempotent; no-op when not instrumented). Awaited —
    // a temp-dir rm is fast and best-effort (never rejects), so it cannot wedge the bounded shutdown.
    await removeShimDir(this.shimDir)
    const app = this.app
    this.app = null
    if (app === null) return { escalated: false }

    if (opts.force === true) {
      try {
        app.process().kill('SIGKILL')
      } catch {
        // If the process is already gone, close() below still releases any
        // remaining Playwright-side resources.
      }
      try {
        await app.close()
      } catch {
        // A killed process can make Playwright close() reject. Force-kill stays
        // best-effort and idempotent.
      }
      return { escalated: true }
    }

    const budget = opts.timeoutMs ?? STOP_GRACEFUL_BUDGET_MS
    // Closing twice or against a dead process is benign during shutdown; the
    // guarded promise never rejects so the timeout race below stays clean.
    const closing = app.close().catch(() => {})
    if (!(await timedOut(closing, budget))) return { escalated: false }

    // Graceful close exceeded its budget — escalate so the process is always
    // reaped, then give Playwright a bounded window (never longer than the
    // graceful budget itself) to settle its handle.
    try {
      app.process().kill('SIGKILL')
    } catch {
      // Process already gone — the close() above will settle on its own.
    }
    await timedOut(closing, Math.min(POST_KILL_SETTLE_MS, budget))
    return { escalated: true }
  }

  async forceKill(): Promise<void> {
    await this.stopGracefully({ force: true })
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export class PlaywrightElectronTransport implements ITransport {
  public readonly id: TransportId = TRANSPORT_ID
  private readonly loadElectron: () => Promise<PWElectron>
  private readonly windowRecoveryBudgetMs: number | undefined

  constructor(opts: PlaywrightElectronTransportOptions = {}) {
    this.loadElectron = opts.loadElectron ?? loadPlaywrightElectron
    this.windowRecoveryBudgetMs = opts.windowRecoveryBudgetMs
  }

  public readonly capabilities: TransportCapabilities = {
    canLaunch: true,
    // Playwright's _electron does not expose an attach API in its public
    // surface. Attach is provided by CDPTransport.
    canAttach: false,
    canInject: false,
    // Renderer network traffic is observable via page.on(requestfinished|requestfailed) and modifiable
    // via page.route; the network capture and stubbing seams consume this capability.
    canIntercept: true,
    canControlClock: true,
    canAccessStorage: true,
    // The application menu is readable from the main process via electronApp.evaluate (a fixed serializer,
    // not agent JS), so the native-UI read seam is honestly implemented here.
    canAccessNativeUI: true,
    supportsMainEval: true,
    supportsRendererEval: true,
    supportsInteraction: true,
  }

  async launch(opts: LaunchOptions): Promise<TransportSession> {
    if (opts.instrumentNative === true && opts.appPath === undefined) {
      throw new StagewrightError(
        'BAD_ARGUMENT',
        'instrumentNative requires appPath; executablePath-only launches cannot be wrapped with launch-time native instrumentation.',
        { transport: TRANSPORT_ID },
      )
    }
    const electron = await this.loadElectron()
    // Launch-time native instrumentation (ADR-020): when opted in (and we own the main entry), launch a
    // generated shim main that installs the Tray hook before the app's real main, so a startup-created
    // tray is observable. The real main is embedded in the shim; the shim replaces appPath as args[0].
    let shimDir: string | undefined
    let effectiveOpts = opts
    if (opts.instrumentNative === true && opts.appPath !== undefined) {
      shimDir = await mkdtemp(join(tmpdir(), 'sw-instrument-'))
      const shimPath = join(shimDir, 'stagewright-shim.cjs')
      await writeFile(shimPath, buildInstrumentationShim(opts.appPath), 'utf8')
      effectiveOpts = { ...opts, appPath: shimPath }
    }
    const launchOpts = buildPlaywrightLaunchOptions(effectiveOpts)
    let app: PWElectronApp
    try {
      app = await electron.launch(launchOpts)
    } catch (cause) {
      await removeShimDir(shimDir)
      const message = cause instanceof Error ? cause.message : String(cause)
      const isTimeout = /timeout/i.test(message)
      throw new StagewrightError(
        isTimeout ? 'LAUNCH_TIMEOUT' : 'INTERNAL_ERROR',
        `Playwright launch failed: ${message}`,
        { transport: TRANSPORT_ID, appPath: opts.appPath ?? opts.executablePath ?? '' },
      )
    }
    let initialPage: PWPage
    try {
      initialPage = await app.firstWindow(
        opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : undefined,
      )
    } catch (cause) {
      try {
        await app.close()
      } catch {
        // A failed launch can leave the app half-open; closing is best-effort.
      }
      await removeShimDir(shimDir)
      const message = cause instanceof Error ? cause.message : String(cause)
      const isTimeout = /timeout/i.test(message)
      throw new StagewrightError(
        isTimeout ? 'LAUNCH_TIMEOUT' : 'INTERNAL_ERROR',
        `Playwright did not report an initial window: ${message}`,
        { transport: TRANSPORT_ID, appPath: opts.appPath ?? opts.executablePath ?? '' },
      )
    }
    // Reuse the window we already awaited for console capture, so launch makes a
    // single firstWindow() call rather than one here and one in the session.
    return new PlaywrightSession(app, initialPage, this.windowRecoveryBudgetMs, {
      instrumented: shimDir !== undefined,
      ...(shimDir !== undefined ? { shimDir } : {}),
    })
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

  async stop(session: TransportSession, opts?: StopOptions): Promise<StopResult> {
    if (session instanceof PlaywrightSession) {
      return session.stopGracefully(opts ?? {})
    }
    await session.dispose()
    return { escalated: false }
  }

  async forceKill(session: TransportSession): Promise<void> {
    if (session instanceof PlaywrightSession) {
      await session.forceKill()
      return
    }
    await session.dispose()
  }
}
