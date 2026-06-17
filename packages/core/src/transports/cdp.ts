/**
 * CDPTransport — raw Chrome DevTools Protocol transport for attaching to an
 * already-running Electron app started with `--remote-debugging-port` (or
 * `--inspect`-adjacent CDP endpoints). Implements the connection-pool design
 * from ADR-003: one WebSocket per target (the browser endpoint plus one per
 * page target, opened lazily), a pending map keyed by request id, per-method
 * timeouts, an enabled-domain cache, and `awaitPromise` evaluation — all in
 * {@link CdpConnection}.
 *
 * Capability matrix:
 *
 * - `canLaunch: false` — CDP requires an existing process to connect to.
 * - `canAttach: true` — attach is the primary purpose.
 * - `canInject: false` — InjectorTransport handles the no-pre-flag case.
 * - `canIntercept: false` — the CDP Network domain COULD serve network capture, but
 *   the seam (`startNetworkCapture`/`networkEvents`/`stopNetworkCapture`) is not wired
 *   here yet, so those methods reject with `NOT_IMPLEMENTED`. The capability stays
 *   honest-false (it now has a consumer — the network plugin gate) and flips to true
 *   when the seam lands over the CDP Network domain.
 * - `canControlClock: true` — CDP exposes `Emulation.setVirtualTimePolicy`.
 * - `supportsMainEval: true` — `Runtime.evaluate` against the browser target.
 * - `supportsRendererEval: true` — `Runtime.evaluate` against a page target.
 * - `supportsInteraction: true` — pointer/keyboard input synthesised through
 *   `Input.dispatch*` at eval-resolved element centres, value-setting via
 *   renderer evals, file inputs via `DOM.setFileInputFiles` (see
 *   `cdp-interaction.ts` for the synthesis rules and known deviations from the
 *   Playwright transport).
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
import {
  CHECKED_STATE_BODY,
  FILL_BODY,
  FOCUS_BODY,
  RESOLVE_POINT_BODY,
  SELECT_OPTION_BODY,
  VIEWPORT_CENTER_BODY,
  parseKeyChord,
  statusToError,
  type ParsedKey,
  type ResolvedPoint,
} from './cdp-interaction.js'
import { copyDialogPolicy, resolveDialogResponse } from './dialog-policy.js'
// The scroll-into-view body is transport-neutral renderer code; it lives next to
// the Playwright bodies for historical reasons but has no Playwright coupling.
import { buildScrollIntoViewBody } from './playwright-electron-bodies.js'
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
  InjectOptions,
  InteractionOptions,
  ITransport,
  IpcChannel,
  LaunchOptions,
  NetworkCaptureFilter,
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
} from './types.js'

const TRANSPORT_ID: TransportId = 'cdp'

/** Default budget for a graceful `Browser.close` before escalating. */
const STOP_GRACEFUL_BUDGET_MS = 10_000
/** Budget for the `/json/version` + `/json/list` HTTP discovery probes. */
const DISCOVERY_TIMEOUT_MS = 5_000
/** Max console entries retained per session (matches the Playwright transport). */
const CONSOLE_CAP = 1000
/** Max dialog events retained per session (matches the Playwright transport). */
const DIALOG_CAP = 200

/** Fetches and JSON-parses an HTTP discovery endpoint, bounded. Injectable seam. */
export type FetchJson = (url: string, timeoutMs: number) => Promise<unknown>

/** Sends SIGKILL to a pid. Injectable seam so unit tests never kill a real process. */
export type KillProcess = (pid: number) => void

const defaultFetchJson: FetchJson = async (url, timeoutMs) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`)
  }
  return response.json()
}

const defaultKillProcess: KillProcess = (pid) => {
  process.kill(pid, 'SIGKILL')
}

function formatLoopbackHostForHttp(host: string): string {
  return host === '::1' ? '[::1]' : host
}

function httpBaseFromCdpWebSocket(parsed: URL): string {
  const protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
  return `${protocol}//${parsed.host}`
}

function unsupported(method: string, capability: keyof TransportCapabilities): StagewrightError {
  return new StagewrightError('TRANSPORT_UNSUPPORTED', `CDPTransport does not support ${method}.`, {
    transport: TRANSPORT_ID,
    method,
    capability,
  })
}

/**
 * For a capability CDP genuinely has but whose seam is not wired yet (network capture). Distinct from
 * {@link unsupported}: the transport CAN do this, it just is not implemented here, so the agent learns
 * it is a temporary gap (a follow-up), not a permanent transport limitation.
 */
function notImplemented(method: string): StagewrightError {
  return new StagewrightError(
    'NOT_IMPLEMENTED',
    `CDPTransport does not yet implement ${method}; network capture over the CDP Network domain is a planned follow-up.`,
    { transport: TRANSPORT_ID, method },
  )
}

/** One entry from the `/json/list` discovery endpoint. */
interface CdpTargetInfo {
  readonly id: string
  readonly type: string
  readonly title: string
  readonly url: string
  readonly webSocketDebuggerUrl: string
}

/** Shape of `Runtime.consoleAPICalled` event params (the slice we read). */
interface ConsoleApiCalledParams {
  readonly type?: string
  readonly args?: readonly { readonly value?: unknown; readonly description?: string }[]
}

/** Shape of `Page.javascriptDialogOpening` event params (the slice we read). */
interface DialogOpeningParams {
  readonly type?: string
  readonly message?: string
  readonly defaultPrompt?: string
}

/** Validated target list from `/json/list` — non-page targets filtered out. */
function asPageTargets(value: unknown): readonly CdpTargetInfo[] {
  if (!Array.isArray(value)) return []
  const targets: CdpTargetInfo[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const t = entry as Partial<CdpTargetInfo>
    if (t.type !== 'page') continue
    if (typeof t.id !== 'string' || typeof t.webSocketDebuggerUrl !== 'string') continue
    targets.push({
      id: t.id,
      type: t.type,
      title: typeof t.title === 'string' ? t.title : '',
      url: typeof t.url === 'string' ? t.url : '',
      webSocketDebuggerUrl: t.webSocketDebuggerUrl,
    })
  }
  return targets
}

/** Dependency seams threaded from the transport into each session. */
interface CdpSessionDeps {
  readonly wsFactory: WebSocketFactory | undefined
  readonly fetchJson: FetchJson
  readonly killProcess: KillProcess
  readonly defaultMethodTimeoutMs: number | undefined
}

class CdpSession implements TransportSession {
  public readonly id: string
  public readonly transport: TransportId = TRANSPORT_ID
  public readonly ipc: IpcChannel = { transport: TRANSPORT_ID }
  public readonly console: ConsoleStream = { transport: TRANSPORT_ID }

  readonly #browser: CdpConnection
  readonly #httpBase: string
  readonly #deps: CdpSessionDeps
  readonly #pid: number | undefined
  /** The per-target connection pool: one WebSocket per page target, opened lazily. */
  readonly #pool = new Map<string, CdpConnection>()
  /** In-flight opens so two concurrent calls never double-connect one target. */
  readonly #opening = new Map<string, Promise<CdpConnection>>()
  #disposed = false

  readonly #consoleBuffer: ConsoleEntry[] = []
  #consoleOverflow = 0
  readonly #dialogBuffer: DialogEvent[] = []
  #dialogOverflow = 0
  #dialogPolicy: DialogPolicy = { action: 'dismiss' }

  constructor(browser: CdpConnection, httpBase: string, deps: CdpSessionDeps, pid?: number) {
    this.id = `cdp-${randomUUID()}`
    this.#browser = browser
    this.#httpBase = httpBase
    this.#deps = deps
    this.#pid = pid
    this.#browser.onClose(() => {
      // Browser endpoint gone → the whole session's transport is gone.
      for (const conn of this.#pool.values()) conn.close()
      this.#pool.clear()
    })
  }

  /** Open (or reuse) the pooled connection for one page target. */
  async connectionFor(target: CdpTargetInfo): Promise<CdpConnection> {
    this.#requireRunning()
    const existing = this.#pool.get(target.id)
    if (existing !== undefined && !existing.closed) return existing
    const inFlight = this.#opening.get(target.id)
    if (inFlight !== undefined) return inFlight
    const opening = (async () => {
      const conn = await CdpConnection.open(target.webSocketDebuggerUrl, {
        ...(this.#deps.wsFactory !== undefined ? { factory: this.#deps.wsFactory } : {}),
        ...(this.#deps.defaultMethodTimeoutMs !== undefined
          ? { defaultTimeoutMs: this.#deps.defaultMethodTimeoutMs }
          : {}),
      })
      // A dispose that ran while this open was in flight already swept the
      // pool; re-inserting would leak a live socket past the session's end.
      if (this.#disposed) {
        conn.close()
        throw new StagewrightError('NOT_RUNNING', 'CDPTransport session has been disposed.', {
          transport: TRANSPORT_ID,
          sessionId: this.id,
        })
      }
      conn.onClose(() => {
        if (this.#pool.get(target.id) === conn) this.#pool.delete(target.id)
      })
      this.#pool.set(target.id, conn)
      await this.#attachCapture(conn, target.id)
      return conn
    })()
    this.#opening.set(target.id, opening)
    try {
      return await opening
    } finally {
      this.#opening.delete(target.id)
    }
  }

  /** Console + dialog capture for one target. Best-effort: enable failures are non-fatal. */
  async #attachCapture(conn: CdpConnection, targetId: string): Promise<void> {
    conn.on('Runtime.consoleAPICalled', (params) => {
      this.#pushConsole((params ?? {}) as ConsoleApiCalledParams, targetId)
    })
    conn.on('Page.javascriptDialogOpening', (params) => {
      void this.#handleDialog(conn, (params ?? {}) as DialogOpeningParams, targetId).catch(() => {})
    })
    try {
      await conn.enable('Runtime')
      await conn.enable('Page')
    } catch {
      // Capture is best-effort — a target that refuses an enable still evals.
    }
  }

  #pushConsole(params: ConsoleApiCalledParams, windowId: string): void {
    const text = (params.args ?? [])
      .map(remoteObjectToText)
      .filter((t) => t !== '')
      .join(' ')
    this.#consoleBuffer.push({
      type: params.type ?? 'log',
      text,
      timestamp: Date.now(),
      windowId,
    })
    if (this.#consoleBuffer.length > CONSOLE_CAP) {
      this.#consoleBuffer.shift()
      this.#consoleOverflow += 1
    }
  }

  async #handleDialog(
    conn: CdpConnection,
    params: DialogOpeningParams,
    windowId: string,
  ): Promise<void> {
    const type = params.type ?? 'alert'
    const message = params.message ?? ''
    const defaultValue = params.defaultPrompt ?? ''
    const policy = this.#dialogPolicy
    const { action, promptText } = resolveDialogResponse(policy, type)
    if (policy.oneShot === true) {
      this.#dialogPolicy = { action: 'dismiss' }
    }
    try {
      await conn.send('Page.handleJavaScriptDialog', {
        accept: action === 'accept',
        ...(promptText !== undefined ? { promptText } : {}),
      })
    } catch {
      // The dialog may already be handled or the target may have gone away;
      // recording the event is still useful for post-mortem.
    }
    this.#dialogBuffer.push({
      type,
      message,
      action,
      ...(defaultValue !== '' ? { defaultValue } : {}),
      ...(promptText !== undefined ? { promptText } : {}),
      timestamp: Date.now(),
      windowId,
    })
    if (this.#dialogBuffer.length > DIALOG_CAP) {
      this.#dialogBuffer.shift()
      this.#dialogOverflow += 1
    }
  }

  #requireRunning(): void {
    if (this.#disposed) {
      throw new StagewrightError('NOT_RUNNING', 'CDPTransport session has been disposed.', {
        transport: TRANSPORT_ID,
        sessionId: this.id,
      })
    }
  }

  /** Current page targets from the discovery endpoint. */
  async #listTargets(): Promise<readonly CdpTargetInfo[]> {
    this.#requireRunning()
    let listed: unknown
    try {
      listed = await this.#deps.fetchJson(`${this.#httpBase}/json/list`, DISCOVERY_TIMEOUT_MS)
    } catch (cause) {
      throw new StagewrightError(
        'CDP_DISCONNECTED',
        `Could not list CDP targets at ${this.#httpBase}/json/list.`,
        { cause: cause instanceof Error ? cause.message : String(cause) },
      )
    }
    return asPageTargets(listed)
  }

  async #firstTarget(): Promise<CdpTargetInfo> {
    const targets = await this.#listTargets()
    const first = targets[0]
    if (first === undefined) {
      throw new StagewrightError('REF_NOT_FOUND', 'No page targets are open in the attached app.', {
        transport: TRANSPORT_ID,
        sessionId: this.id,
      })
    }
    return first
  }

  async #resolveTarget(ref: WindowRef): Promise<CdpTargetInfo> {
    const targets = await this.#listTargets()
    if (targets.length === 0) {
      throw new StagewrightError('REF_NOT_FOUND', 'No page targets are open in the attached app.', {
        transport: TRANSPORT_ID,
        ref,
      })
    }
    if (ref.kind === 'index') {
      const target = targets[ref.index]
      if (target === undefined) {
        throw new StagewrightError(
          'REF_NOT_FOUND',
          `Window index ${ref.index} is out of range (have ${targets.length} targets).`,
          { transport: TRANSPORT_ID, ref },
        )
      }
      return target
    }
    if (ref.kind === 'title') {
      const matcher =
        ref.pattern instanceof RegExp
          ? ref.pattern
          : new RegExp(`^${ref.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
      const matched = targets.find((t) => matcher.test(t.title))
      if (matched !== undefined) return matched
      throw new StagewrightError(
        'REF_NOT_FOUND',
        `No window matched title pattern ${String(ref.pattern)}.`,
        { transport: TRANSPORT_ID, ref },
      )
    }
    const byId = targets.find((t) => t.id === ref.id)
    if (byId !== undefined) return byId
    throw new StagewrightError(
      'REF_NOT_FOUND',
      `Window id "${ref.id}" did not match any CDP page target.`,
      { transport: TRANSPORT_ID, ref },
    )
  }

  async evaluate<T = unknown>(
    target: 'main' | 'renderer',
    body: string,
    arg?: unknown,
  ): Promise<T> {
    this.#requireRunning()
    if (target === 'main') {
      return evaluateExpression<T>(this.#browser, body, arg)
    }
    const conn = await this.#pageConnection()
    return evaluateExpression<T>(conn, body, arg)
  }

  /** The pooled connection for the first (active) page target. */
  async #pageConnection(): Promise<CdpConnection> {
    const page = await this.#firstTarget()
    return this.connectionFor(page)
  }

  async screenshot(target: WindowRef, opts: ScreenshotOptions = {}): Promise<Buffer> {
    this.#requireRunning()
    const info = await this.#resolveTarget(target)
    const conn = await this.connectionFor(info)
    try {
      await conn.enable('Page')
    } catch {
      // captureScreenshot itself fails with a precise error if Page is unusable.
    }
    const result = await conn.send<{ readonly data?: string }>('Page.captureScreenshot', {
      format: opts.format ?? 'png',
      ...(opts.quality !== undefined ? { quality: opts.quality } : {}),
      ...(opts.clip !== undefined ? { clip: { ...opts.clip, scale: 1 } } : {}),
      ...(opts.fullPage === true ? { captureBeyondViewport: true } : {}),
    })
    if (typeof result.data !== 'string') {
      throw new StagewrightError('INTERNAL_ERROR', 'Page.captureScreenshot returned no data.', {
        transport: TRANSPORT_ID,
      })
    }
    return Buffer.from(result.data, 'base64')
  }

  async windowsList(): Promise<readonly WindowDescriptor[]> {
    const targets = await this.#listTargets()
    return targets.map((t, i) => ({
      id: t.id,
      index: i,
      title: t.title,
      ...(t.url !== '' ? { url: t.url } : {}),
      visible: true,
      focused: i === 0,
    }))
  }

  async consoleLogs(): Promise<ConsoleLogsResult> {
    this.#requireRunning()
    return { entries: [...this.#consoleBuffer], overflowed: this.#consoleOverflow }
  }

  async setDialogPolicy(policy: DialogPolicy): Promise<void> {
    this.#requireRunning()
    this.#dialogPolicy = copyDialogPolicy(policy)
  }

  async dialogEvents(opts: DialogEventsOptions = {}): Promise<DialogEventsResult> {
    this.#requireRunning()
    const result: DialogEventsResult = {
      entries: [...this.#dialogBuffer],
      overflowed: this.#dialogOverflow,
      policy: copyDialogPolicy(this.#dialogPolicy),
    }
    if (opts.clear === true) {
      this.#dialogBuffer.length = 0
      this.#dialogOverflow = 0
    }
    return result
  }

  // --- Network capture surface: declared via canIntercept but not yet wired (see module doc). ---

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

  // --- Interaction surface: Input.dispatch* synthesis (see cdp-interaction.ts). ---

  /**
   * Resolve a selector to its centre point on the active page with a light
   * actionability check. `force` bypasses the visibility/disabled refusals
   * (the element must still exist).
   */
  async #interactionPoint(
    selector: string,
    opts: InteractionOptions = {},
  ): Promise<{ readonly conn: CdpConnection; readonly x: number; readonly y: number }> {
    const conn = await this.#pageConnection()
    const point = await evaluateExpression<ResolvedPoint>(conn, RESOLVE_POINT_BODY, { selector })
    if (point.status !== 'ok') throw statusToError(point.status, selector)
    if (opts.force !== true) {
      if (point.visible !== true) {
        throw new StagewrightError('ELEMENT_NOT_VISIBLE', `"${selector}" is not visible.`, {
          selector,
        })
      }
      if (point.disabled === true) {
        throw new StagewrightError('ELEMENT_DISABLED', `"${selector}" is disabled.`, { selector })
      }
    }
    return { conn, x: point.x ?? 0, y: point.y ?? 0 }
  }

  /** Focus `selector` on `conn` (eval focus tolerates offscreen/hidden elements). */
  async #focus(conn: CdpConnection, selector: string): Promise<void> {
    const result = await evaluateExpression<{ readonly status: string }>(conn, FOCUS_BODY, {
      selector,
    })
    if (result.status !== 'ok') throw statusToError(result.status, selector)
  }

  /** Dispatch one keyDown/keyUp pair for a parsed chord. */
  async #pressParsed(conn: CdpConnection, parsed: ParsedKey): Promise<void> {
    await conn.send('Input.dispatchKeyEvent', {
      type: parsed.text !== undefined ? 'keyDown' : 'rawKeyDown',
      modifiers: parsed.modifiers,
      key: parsed.key,
      code: parsed.code,
      windowsVirtualKeyCode: parsed.windowsVirtualKeyCode,
      ...(parsed.text !== undefined ? { text: parsed.text, unmodifiedText: parsed.text } : {}),
    })
    await conn.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      modifiers: parsed.modifiers,
      key: parsed.key,
      code: parsed.code,
      windowsVirtualKeyCode: parsed.windowsVirtualKeyCode,
    })
  }

  async click(selector: string, opts: ClickOptions = {}): Promise<void> {
    this.#requireRunning()
    const { conn, x, y } = await this.#interactionPoint(selector, opts)
    const button = opts.button ?? 'left'
    const clickCount = opts.clickCount ?? 1
    await conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
    for (let i = 1; i <= clickCount; i++) {
      await conn.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button,
        clickCount: i,
      })
      await conn.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button,
        clickCount: i,
      })
    }
  }

  async hover(selector: string, opts: InteractionOptions = {}): Promise<void> {
    this.#requireRunning()
    const { conn, x, y } = await this.#interactionPoint(selector, opts)
    await conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  }

  async fill(selector: string, value: string, _opts: InteractionOptions = {}): Promise<void> {
    this.#requireRunning()
    const conn = await this.#pageConnection()
    const result = await evaluateExpression<{ readonly status: string }>(conn, FILL_BODY, {
      selector,
      value,
    })
    if (result.status !== 'ok') throw statusToError(result.status, selector)
  }

  async press(key: string, opts: PressOptions = {}): Promise<void> {
    this.#requireRunning()
    const conn = await this.#pageConnection()
    if (opts.selector !== undefined) await this.#focus(conn, opts.selector)
    await this.#pressParsed(conn, parseKeyChord(key))
  }

  async typeText(text: string, opts: PressOptions = {}): Promise<void> {
    this.#requireRunning()
    const conn = await this.#pageConnection()
    if (opts.selector !== undefined) await this.#focus(conn, opts.selector)
    for (const ch of text) {
      if (ch === '\n' || ch === '\r') {
        await this.#pressParsed(conn, parseKeyChord('Enter'))
        continue
      }
      await conn.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: ch,
        text: ch,
        unmodifiedText: ch,
      })
      await conn.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
    }
  }

  async selectOption(
    selector: string,
    values: readonly string[],
    _opts: InteractionOptions = {},
  ): Promise<readonly string[]> {
    this.#requireRunning()
    const conn = await this.#pageConnection()
    const result = await evaluateExpression<{
      readonly status: string
      readonly selected?: readonly string[]
    }>(conn, SELECT_OPTION_BODY, { selector, values })
    if (result.status !== 'ok') throw statusToError(result.status, selector)
    return result.selected ?? []
  }

  async setChecked(
    selector: string,
    checked: boolean,
    opts: InteractionOptions = {},
  ): Promise<void> {
    this.#requireRunning()
    const conn = await this.#pageConnection()
    const state = await evaluateExpression<{
      readonly status: string
      readonly checked?: boolean
      readonly disabled?: boolean
    }>(conn, CHECKED_STATE_BODY, { selector })
    if (state.status !== 'ok') throw statusToError(state.status, selector)
    if (state.disabled === true && opts.force !== true) {
      throw new StagewrightError('ELEMENT_DISABLED', `"${selector}" is disabled.`, { selector })
    }
    // Already in the requested state — a real click would TOGGLE it wrong.
    if (state.checked === checked) return
    await this.click(selector, opts)
  }

  async setInputFiles(
    selector: string,
    paths: readonly string[],
    _opts: InteractionOptions = {},
  ): Promise<void> {
    this.#requireRunning()
    const conn = await this.#pageConnection()
    try {
      await conn.enable('DOM')
    } catch {
      // DOM.getDocument below fails with a precise error if the domain is unusable.
    }
    const doc = await conn.send<{ readonly root?: { readonly nodeId?: number } }>(
      'DOM.getDocument',
      {},
    )
    const rootId = doc.root?.nodeId
    if (typeof rootId !== 'number') {
      throw new StagewrightError('INTERNAL_ERROR', 'DOM.getDocument returned no root node.', {
        transport: TRANSPORT_ID,
      })
    }
    const found = await conn.send<{ readonly nodeId?: number }>('DOM.querySelector', {
      nodeId: rootId,
      selector,
    })
    if (typeof found.nodeId !== 'number' || found.nodeId === 0) {
      throw new StagewrightError('SELECTOR_NO_MATCH', `"${selector}" matched no element.`, {
        selector,
      })
    }
    await conn.send('DOM.setFileInputFiles', { files: [...paths], nodeId: found.nodeId })
  }

  async dragTo(source: string, target: string, opts: InteractionOptions = {}): Promise<void> {
    this.#requireRunning()
    const from = await this.#interactionPoint(source, opts)
    await from.conn.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from.x,
      y: from.y,
      button: 'none',
    })
    await from.conn.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: from.x,
      y: from.y,
      button: 'left',
      clickCount: 1,
    })
    try {
      const to = await this.#interactionPoint(target, opts)
      await to.conn.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: to.x,
        y: to.y,
        button: 'left',
      })
      await to.conn.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: to.x,
        y: to.y,
        button: 'left',
        clickCount: 1,
      })
    } catch (err) {
      // The button is already synthesised DOWN; leaving it held would corrupt
      // every later pointer interaction on the page. Release where the drag
      // started, then surface the original failure.
      try {
        await from.conn.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: from.x,
          y: from.y,
          button: 'left',
          clickCount: 1,
        })
      } catch {
        // Releasing on a target that just died is best-effort.
      }
      throw err
    }
  }

  async scroll(opts: ScrollOptions = {}): Promise<void> {
    this.#requireRunning()
    const conn = await this.#pageConnection()
    if (opts.selector !== undefined) {
      const found = await evaluateExpression<boolean>(conn, buildScrollIntoViewBody(), {
        selector: opts.selector,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      })
      if (!found) {
        throw new StagewrightError(
          'SELECTOR_NO_MATCH',
          `scroll target "${opts.selector}" matched no element.`,
          { transport: TRANSPORT_ID, selector: opts.selector },
        )
      }
      return
    }
    const centre = await evaluateExpression<{ readonly x: number; readonly y: number }>(
      conn,
      VIEWPORT_CENTER_BODY,
    )
    await conn.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: centre.x,
      y: centre.y,
      deltaX: opts.dx ?? 0,
      deltaY: opts.dy ?? 0,
    })
  }

  /**
   * Bounded graceful stop: ask the app to exit via `Browser.close`; when the
   * call times out (a hung app) escalate to SIGKILL — possible only when the
   * attach supplied a pid, since CDP itself has no process handle.
   */
  async stopGracefully(opts: StopOptions): Promise<StopResult> {
    if (this.#disposed) return { escalated: false }
    this.#disposed = true
    let escalated = false
    if (opts.force === true) {
      escalated = this.#kill()
    } else {
      try {
        await this.#browser.send('Browser.close', undefined, {
          timeoutMs: opts.timeoutMs ?? STOP_GRACEFUL_BUDGET_MS,
        })
      } catch (err) {
        // A socket that drops right after Browser.close IS a successful close.
        // Only a TIMEOUT means the app ignored the request — escalate when we
        // hold a pid; without one, releasing the connections is all CDP can do.
        if (err instanceof StagewrightError && err.code === 'CDP_TIMEOUT') {
          escalated = this.#kill()
        }
      }
    }
    this.#closeAll()
    return { escalated }
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

  #closeAll(): void {
    for (const conn of this.#pool.values()) conn.close()
    this.#pool.clear()
    this.#browser.close()
  }

  async dispose(): Promise<void> {
    // Idempotent — releases every pooled connection without touching the app.
    if (this.#disposed) return
    this.#disposed = true
    this.#closeAll()
  }

  async forceKill(): Promise<void> {
    await this.stopGracefully({ force: true })
  }
}

/** Options accepted by {@link CDPTransport} — dependency seams for tests. */
export interface CDPTransportOptions {
  /** WebSocket factory override. Defaults to the global WebSocket. */
  readonly wsFactory?: WebSocketFactory
  /** Discovery fetcher override. Defaults to global `fetch` with a bounded signal. */
  readonly fetchJson?: FetchJson
  /** SIGKILL sender override (used by stop escalation). Defaults to `process.kill`. */
  readonly killProcess?: KillProcess
  /** Default per-method CDP timeout override. */
  readonly defaultMethodTimeoutMs?: number
}

export class CDPTransport implements ITransport {
  public readonly id: TransportId = TRANSPORT_ID
  public readonly capabilities: TransportCapabilities = {
    canLaunch: false,
    canAttach: true,
    canInject: false,
    // The CDP Network domain COULD serve network capture, but the seam is not wired here yet, and
    // `canIntercept` now has a consumer (the network plugin gate) — so it stays honest-false until the
    // seam lands, rather than advertising a capability whose methods reject at runtime. Flip to true
    // when the CDP network-capture seam is implemented.
    canIntercept: false,
    canControlClock: true,
    supportsMainEval: true,
    supportsRendererEval: true,
    supportsInteraction: true,
  }

  readonly #deps: CdpSessionDeps

  constructor(opts: CDPTransportOptions = {}) {
    this.#deps = {
      wsFactory: opts.wsFactory,
      fetchJson: opts.fetchJson ?? defaultFetchJson,
      killProcess: opts.killProcess ?? defaultKillProcess,
      defaultMethodTimeoutMs: opts.defaultMethodTimeoutMs,
    }
  }

  launch(_opts: LaunchOptions): Promise<TransportSession> {
    return Promise.reject(unsupported('launch', 'canLaunch'))
  }

  async attach(opts: AttachOptions): Promise<TransportSession> {
    let httpBase: string
    let browserWsUrl: string

    if (opts.cdpUrl !== undefined) {
      let parsed: URL
      try {
        parsed = new URL(opts.cdpUrl)
      } catch {
        throw new StagewrightError('BAD_ARGUMENT', `Invalid CDP URL: ${opts.cdpUrl}`, {
          transport: TRANSPORT_ID,
        })
      }
      httpBase = httpBaseFromCdpWebSocket(parsed)
      browserWsUrl = opts.cdpUrl
    } else if (opts.port !== undefined) {
      const host = opts.host ?? '127.0.0.1'
      httpBase = `http://${formatLoopbackHostForHttp(host)}:${opts.port}`
      let version: unknown
      try {
        version = await this.#deps.fetchJson(`${httpBase}/json/version`, DISCOVERY_TIMEOUT_MS)
      } catch (cause) {
        throw new StagewrightError(
          'CDP_DISCONNECTED',
          `Could not reach the CDP endpoint at ${httpBase}/json/version. Is the app running with --remote-debugging-port?`,
          { cause: cause instanceof Error ? cause.message : String(cause) },
        )
      }
      const wsUrl = (version as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl
      if (typeof wsUrl !== 'string' || wsUrl === '') {
        throw new StagewrightError(
          'CDP_DISCONNECTED',
          `${httpBase}/json/version did not expose a webSocketDebuggerUrl.`,
          { transport: TRANSPORT_ID },
        )
      }
      browserWsUrl = wsUrl
    } else {
      throw new StagewrightError(
        'BAD_ARGUMENT',
        'CDP attach needs port (plus optional host) or cdpUrl; a pid alone is not attachable over CDP.',
        { transport: TRANSPORT_ID },
      )
    }

    const browser = await CdpConnection.open(browserWsUrl, {
      ...(this.#deps.wsFactory !== undefined ? { factory: this.#deps.wsFactory } : {}),
      ...(this.#deps.defaultMethodTimeoutMs !== undefined
        ? { defaultTimeoutMs: this.#deps.defaultMethodTimeoutMs }
        : {}),
      ...(opts.timeoutMs !== undefined ? { connectTimeoutMs: opts.timeoutMs } : {}),
    })
    const session = new CdpSession(browser, httpBase, this.#deps, opts.pid)

    // Open pooled connections for the targets that already exist so console and
    // dialog capture aggregates across every current window from attach onward.
    // Best-effort: a target that refuses must not fail the attach.
    try {
      const targets = asPageTargets(
        await this.#deps.fetchJson(`${httpBase}/json/list`, DISCOVERY_TIMEOUT_MS),
      )
      await Promise.allSettled(targets.map((t) => session.connectionFor(t)))
    } catch {
      // Discovery hiccups at attach time are tolerated; windowsList retries.
    }

    return session
  }

  inject(_opts: InjectOptions): Promise<TransportSession> {
    return Promise.reject(unsupported('inject', 'canInject'))
  }

  async stop(session: TransportSession, opts?: StopOptions): Promise<StopResult> {
    if (session instanceof CdpSession) {
      return session.stopGracefully(opts ?? {})
    }
    await session.dispose()
    return { escalated: false }
  }

  async forceKill(session: TransportSession): Promise<void> {
    if (session instanceof CdpSession) {
      await session.forceKill()
      return
    }
    await session.dispose()
  }
}
